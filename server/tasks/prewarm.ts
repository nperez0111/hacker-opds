import { defineTask } from "nitro/task";
import pLimit from "p-limit";

import { buildEditionEpub, editionsNeedingDigest } from "~/build/edition";
import { buildStoryEpub } from "~/build/story";
import { config } from "~/config";
import { dueEditions, getEditionStories, ingestEdition } from "~/core/edition";
import { HnThrottled } from "~/core/hn-html";
import { errFields, log } from "~/log";

/**
 * Digests built per run.
 *
 * A deployment starting against a populated volume could have a week of
 * editions all wanting one at once; each is a few seconds of CPU and tens of
 * megabytes of zip, and there is no reason to do them all in the first tick.
 * At three an hour the backlog clears within a morning.
 */
const DIGESTS_PER_RUN = 3;

/**
 * Nightly prewarm.
 *
 * Runs hourly rather than once a day, and works out for itself which editions
 * are due. Two reasons:
 *
 *   1. Nitro's `scheduledTasks` has no timezone option — cron fires in the
 *      process's local time. Rather than depend on `TZ` being right, the task
 *      asks `dueEditions()` which days have closed and are not yet ingested.
 *   2. It catches up after downtime. A daily cron that fires while the
 *      container is restarting silently loses that edition forever.
 *
 * Nitro dedupes task invocations by name, so two overlapping runs collapse into
 * one — which is exactly the behaviour wanted for a singleton job. (Per-story
 * builds cannot use tasks for the same reason: the dedupe ignores the payload.)
 */
export default defineTask({
  meta: {
    name: "prewarm",
    description: "Ingest closed editions, pre-build their story EPUBs and the daily digest",
  },
  async run() {
    const cfg = config();
    const due = dueEditions();

    const ingested: string[] = [];
    let built = 0;
    let failed = 0;
    let deferred = 0;

    for (const date of due) {
      const rows = await ingestEdition(date);
      ingested.push(date);
      log("prewarm").info({ date, stories: rows.length }, `ingested ${date}`);

      // Article fetches dominate the wall time here and each one is already
      // rate-limited per host inside the fetcher, so a small pool is plenty.
      const limit = pLimit(cfg.fetchConcurrency);
      const stories = getEditionStories(date);

      await Promise.all(
        stories.map((story) =>
          limit(async () => {
            try {
              await buildStoryEpub(story.id);
              built += 1;
            } catch (err) {
              // Being throttled is not a failure of this story. Nothing here
              // is urgent - the task runs hourly, so leaving it for the next
              // pass is strictly better than pounding on a site that has just
              // asked us to stop.
              if (err instanceof HnThrottled) {
                deferred += 1;
                return;
              }
              // A single unbuildable story must not abort the edition. The
              // failure is already recorded in the builds ledger; the story
              // simply stays absent from the catalog until a later attempt.
              failed += 1;
              log("prewarm").error(
                { storyId: story.id, ...errFields(err) },
                `story ${story.id} failed`,
              );
            }
          }),
        ),
      );

      log("prewarm").info({ date, built, failed, deferred }, `finished ${date}`);
    }

    if (deferred > 0) {
      log("prewarm").warn(
        { deferred },
        `${deferred} stories deferred by hacker news rate limiting; retrying next run`,
      );
    }

    // Digests are a separate, independently self-determining pass rather than
    // a step inside the loop above. An edition is only ready for one once every
    // story has been built, which is frequently not true on the pass that
    // ingested it -- a throttled story defers to a later run, and the loop above
    // never revisits an edition it has already ingested. Asking the database
    // which editions are complete makes the two concerns independent, catches
    // up after downtime, and costs one query when there is nothing to do.
    //
    // Keyed coalescing inside `buildEditionEpub`, not a task: Nitro dedupes
    // tasks by name and would collapse two dates into one run.
    const digests: string[] = [];
    for (const date of editionsNeedingDigest().slice(0, DIGESTS_PER_RUN)) {
      try {
        const row = await buildEditionEpub(date);
        digests.push(date);
        log("prewarm").info({ date, bytes: row.bytes }, `built digest for ${date}`);
      } catch (err) {
        if (err instanceof HnThrottled) {
          deferred += 1;
          continue;
        }
        // One bad edition must not stop the others, and the failure is already
        // in the builds ledger.
        log("prewarm").error({ date, ...errFields(err) }, `digest ${date} failed`);
      }
    }

    return { result: { ingested, built, failed, deferred, digests } };
  },
});
