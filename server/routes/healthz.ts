import { defineHandler } from "nitro/h3";
import { healthReport } from "~/health";

/**
 * Liveness and process identity.
 *
 * Always answers 200, even when degraded. A health endpoint that returns 500
 * on a database problem forces the caller to parse an error page to learn what
 * broke; returning the report with `status: "degraded"` keeps the diagnosis in
 * the body where it is machine-readable.
 *
 * `cache-control: no-store` is not optional here — a cached health check is
 * worse than none, because it reports the uptime of a process that may no
 * longer exist.
 */
export default defineHandler(() => {
  return new Response(`${JSON.stringify(healthReport(), null, 2)}\n`, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
});
