#!/usr/bin/env bun
/**
 * Manual edition ingest.
 *
 *   bun run scripts/ingest.ts             # yesterday, in the configured tz
 *   bun run scripts/ingest.ts 2026-08-16  # a specific day
 *   bun run scripts/ingest.ts 2026-08-16 --build   # also build every EPUB and the digest
 *
 * The scheduled `prewarm` task does this automatically; this exists for
 * backfilling a specific day and for poking at the pipeline during development.
 */
import pLimit from "p-limit";

import { buildEditionEpub } from "~/build/edition";
import { buildStoryEpub } from "~/build/story";
import { config } from "~/config";
import { getEditionStories, ingestEdition, shiftDate, today } from "~/core/edition";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const cfg = config();
const date = args.find((a) => !a.startsWith("--")) ?? shiftDate(today(cfg.editionTz), -1);

if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error(`Not a date: ${date}`);
  process.exit(1);
}

console.log(`Ingesting ${date} (${cfg.editionTz}) into ${cfg.dataDir}`);
const ingested = await ingestEdition(date);
console.log(`  ${ingested.length} stories`);

const stories = getEditionStories(date);
for (const s of stories.slice(0, 5)) {
  console.log(`  #${s.rank} ${s.points}pts ${s.num_comments}c  ${s.title}  [${s.domain ?? "text"}]`);
}
if (stories.length > 5) console.log(`  … and ${stories.length - 5} more`);

if (flags.has("--build")) {
  const limit = pLimit(cfg.fetchConcurrency);
  let ok = 0;
  let bad = 0;
  await Promise.all(
    stories.map((story) =>
      limit(async () => {
        try {
          const build = await buildStoryEpub(story.id);
          ok += 1;
          console.log(`  built ${story.id} (${build.bytes} bytes)`);
        } catch (err) {
          bad += 1;
          console.error(`  FAILED ${story.id}:`, err instanceof Error ? err.message : err);
        }
      }),
    ),
  );
  console.log(`Built ${ok}, failed ${bad}`);

  // The digest is only meaningful once every story is in it, so it is built
  // last and skipped if anything above failed - a day with a hole in it would
  // be cached and served as though it were complete.
  if (bad === 0 && ok > 0) {
    const digest = await buildEditionEpub(date, { force: true });
    console.log(`Built digest for ${date} (${digest.bytes} bytes)`);
  } else if (bad > 0) {
    console.log("Skipping the digest: not every story built.");
  }
}
