/**
 * The one delay primitive the retry/backoff paths use.
 *
 * Exists so those paths can be handed a different implementation. Backoff
 * ladders here are measured in seconds -- 5s, 15s, 30s for an HN throttle --
 * which is correct against a live API and ruinous in a test suite that has to
 * prove the ladder is walked at all.
 *
 * The alternative, `mock.module`, is not usable: in Bun a module mock is
 * installed process-wide for the rest of the run and leaks into every later
 * test file. An explicit optional parameter is narrower, and it lets a test
 * assert on the durations that *would* have been slept, which is a stronger
 * check than watching a wall clock.
 *
 * Production callers pass nothing and get `Bun.sleep`.
 */
export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => Bun.sleep(ms);

/**
 * The matching wall-clock reader, for code that turns a duration into an
 * absolute deadline and later turns it back into a duration.
 *
 * A faked `Sleep` alone is not enough for those paths. `noteThrottle` stores
 * `now() + waitMs` and `hnSlot` then sleeps `deadline - now()`; with a real
 * clock the difference is the wait *minus however long the test itself took*,
 * so an assertion on the exact duration is a race the suite loses whenever the
 * machine is cold or busy. Substituting both makes the ladder exact.
 *
 * Production callers pass nothing and get `Date.now`.
 */
export type Now = () => number;
