/**
 * A `Sleep` that records instead of waiting.
 *
 * Retry and throttle paths are specified in seconds, so testing them against a
 * real clock costs real seconds. Substituting this keeps every assertion the
 * wall-clock version made -- and adds one it could not: the exact ladder of
 * durations the code asked for.
 *
 * `yieldToLoop` is on by default so the substitute still returns a promise that
 * settles on a later tick. A synchronously-resolved sleep would let some
 * interleavings that cannot happen in production happen in tests.
 */
import type { Now, Sleep } from "~/core/clock";

export interface RecordingClock {
  sleep: Sleep;
  /**
   * Virtual wall clock, advanced by exactly the durations `sleep` was asked
   * for and by nothing else.
   *
   * Pass this wherever the code under test reads the time, alongside `sleep`.
   * Code that stores `now() + waitMs` and later sleeps `deadline - now()` is
   * otherwise measuring how long the *test* took: the recorded wait comes back
   * as 999 instead of 1000 whenever the machine is cold or loaded.
   */
  now: Now;
  /** Every duration passed to `sleep`, in call order. */
  readonly waits: readonly number[];
  /** Sum of all requested waits -- the wall time this test did not spend. */
  totalMs(): number;
  reset(): void;
}

export function recordingClock(opts: { yieldToLoop?: boolean; start?: number } = {}): RecordingClock {
  const yieldToLoop = opts.yieldToLoop ?? true;
  const start = opts.start ?? 1_700_000_000_000;
  const waits: number[] = [];
  let clock = start;

  return {
    sleep: async (ms: number) => {
      waits.push(ms);
      // Time only moves because something slept, so a duration stored as an
      // absolute deadline reads back as exactly the duration that was stored.
      clock += ms;
      if (yieldToLoop) await Promise.resolve();
    },
    now: () => clock,
    waits,
    totalMs: () => waits.reduce((a, b) => a + b, 0),
    reset: () => {
      waits.length = 0;
      clock = start;
    },
  };
}
