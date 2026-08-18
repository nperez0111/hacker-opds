import { defineTask } from "nitro/task";
import pLimit from "p-limit";

import { reapStaleBuilds } from "~/build/artifacts";
import { buildEditionEpub, editionsNeedingDigest } from "~/build/edition";
import { buildStoryEpub, storiesNeedingBuild } from "~/build/story";
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
 * Ceiling on the catch-up sweep, in stories.
 *
 * One edition's worth per hour. Enough to clear a few days of backlog over a
 * morning, small enough that a week-deep hole does not turn into an hours-long
 * run of HN requests the moment the container comes back up.
 */
const SWEEP_BUILDS_PER_RUN = 30;

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

    // Before anything reads the ledger, not after. Both passes below treat a
    // `building` row as work in progress and skip it, so an abandoned one would
    // make this run repeat the previous run's mistake.
    const reaped = reapStaleBuilds();
    if (reaped.length > 0) {
      log("prewarm").warn(
        { builds: reaped.map((row) => `${row.kind}:${row.build_key}`) },
        `reaped ${reaped.length} abandoned build${reaped.length === 1 ? "" : "s"}`,
      );
    }

    const due = dueEditions();

    const ingested: string[] = [];
    let built = 0;
    let failed = 0;
    let deferred = 0;

    /**
     * Set the first time HN defers a build, and never cleared within a run.
     *
     * `hnMaxWaitMs` is a *per build* budget, so without this the throttle costs
     * are multiplied rather than shared: thirty stories against a host that is
     * refusing everything is thirty separate half-hour waits, four at a time,
     * which is most of a working day spent knocking on a door that has already
     * been closed. The cool-off inside the HN client parks the queue; this
     * parks the run. Nothing here is urgent -- the task is hourly.
     */
    let throttled = false;

    // Article fetches dominate the wall time and each is already rate-limited
    // per host inside the fetcher, so a small pool is plenty. One pool for the
    // whole run, shared by both passes.
    const limit = pLimit(cfg.fetchConcurrency);

    const buildOne = (storyId: number) =>
      limit(async () => {
        if (throttled) {
          deferred += 1;
          return;
        }
        try {
          await buildStoryEpub(storyId);
          built += 1;
        } catch (err) {
          // Being throttled is not a failure of this story. Nothing here is
          // urgent - the task runs hourly, so leaving it for the next pass is
          // strictly better than pounding on a site that has just asked us to
          // stop.
          if (err instanceof HnThrottled) {
            deferred += 1;
            throttled = true;
            return;
          }
          // A single unbuildable story must not abort the edition. The failure
          // is already recorded in the builds ledger; the story simply stays
          // absent from the catalog until a later attempt.
          failed += 1;
          log("prewarm").error({ storyId, ...errFields(err) }, `story ${storyId} failed`);
        }
      });

    for (const date of due) {
      // Deliberately not skipped when `throttled` is set. Ingest is one Algolia
      // request and touches HN not at all, so the day's metadata is still worth
      // having -- it is what makes the day appear in the catalog at all, and
      // the sweep will build its stories on a later run. `buildOne` below is
      // what stops once parked.
      const rows = await ingestEdition(date);
      ingested.push(date);
      log("prewarm").info({ date, stories: rows.length }, `ingested ${date}`);

      const stories = getEditionStories(date);
      await Promise.all(stories.map((story) => buildOne(story.id)));

      log("prewarm").info({ date, built, failed, deferred }, `finished ${date}`);
    }

    // Catch-up pass. The loop above only ever visits editions `dueEditions()`
    // returns, which excludes everything already ingested, so without this a
    // story that missed its one chance never got another. See
    // `storiesNeedingBuild`.
    const sweep = throttled ? [] : storiesNeedingBuild(7, SWEEP_BUILDS_PER_RUN);
    if (sweep.length > 0) {
      log("prewarm").info({ stories: sweep.length }, `sweeping ${sweep.length} unbuilt stories`);
      await Promise.all(sweep.map((storyId) => buildOne(storyId)));
      log("prewarm").info({ built, failed, deferred }, "finished sweep");
    }

    if (deferred > 0) {
      log("prewarm").warn(
        { deferred },
        `${deferred} stories deferred by hacker news rate limiting; retrying next run`,
      );
    }

    // Digests are a third self-determining pass. An edition is only ready for
    // one once every story has been built, which is frequently not true on the
    // pass that ingested it -- a throttled story defers to a later run. Asking
    // the database which editions are complete makes the passes independent,
    // catches up after downtime, and costs one query when there is nothing to
    // do.
    //
    // Keyed coalescing inside `buildEditionEpub`, not a task: Nitro dedupes
    // tasks by name and would collapse two dates into one run.
    const digests: string[] = [];
    for (const date of editionsNeedingDigest().slice(0, DIGESTS_PER_RUN)) {
      // Composing a digest can need comment trees the stories did not cache, so
      // a parked run stops here too rather than rediscovering the throttle.
      if (throttled) break;
      try {
        const row = await buildEditionEpub(date);
        digests.push(date);
        log("prewarm").info({ date, bytes: row.bytes }, `built digest for ${date}`);
      } catch (err) {
        if (err instanceof HnThrottled) {
          deferred += 1;
          throttled = true;
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
