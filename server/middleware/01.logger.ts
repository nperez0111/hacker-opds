/**
 * Request logging.
 *
 * Three h3 v2 details this depends on, each of which quietly breaks the obvious
 * implementation:
 *
 * - `next()` resolves to the handler's *return value*, not a `Response`. For a
 *   404 it is a Symbol. Running it through `toResponse()` - the same call h3's
 *   own `onResponse` hook makes - is the only way to read an accurate status.
 * - `event.res.status` is `undefined` unless a handler set it explicitly, so
 *   `event.res.status ?? 200` logs 200 for every 404.
 * - `onResponse` does not fire when a handler throws. A `try`/`catch` around
 *   `toResponse(await next())` covers the success and error paths together.
 */
import { defineMiddleware, toResponse } from "nitro/h3";
import { errFields, log } from "~/log";

declare module "h3" {
  interface H3EventContext {
    requestId: string;
  }
}

/** Vite's dev-server chatter is not interesting; the app's own routes are. */
const IGNORED = /^\/(@|__|node_modules\/|favicon\.ico$)/;

function level(status: number): "info" | "warn" | "error" {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "info";
}

export default defineMiddleware(async (event, next) => {
  const path = event.url.pathname;
  if (IGNORED.test(path)) return next();

  const requestId = crypto.randomUUID().slice(0, 8);
  const method = event.req.method;
  const started = performance.now();

  event.context.requestId = requestId;
  // Must be set before `next()`: once the Response is materialised its headers
  // are frozen, and mutating them throws in dev but not in production - an
  // asymmetry that would pass a prod smoke test and break local development.
  event.res.headers.set("x-request-id", requestId);

  const finish = (status: number, extra: Record<string, unknown> = {}) => {
    const ms = Number((performance.now() - started).toFixed(1));
    log("http")[level(status)](
      { requestId, method, path, status, ms, ...extra },
      `${method} ${path} ${status} ${ms}ms`,
    );
  };

  try {
    const response = await toResponse(await next(), event);
    finish(response.status);
    return response;
  } catch (error) {
    const fields = errFields(error);
    const status = typeof fields.status === "number" ? fields.status : 500;
    // A 4xx is the app working correctly - a bad date, an unknown story. Its
    // stack trace is our own routing code and tells nobody anything, so keep
    // the reason and drop the noise. A 5xx is unexplained and gets everything.
    finish(
      status,
      status < 500 ? { reason: (error as Error)?.message ?? String(error) } : fields,
    );
    throw error;
  }
});
