import { describe, expect, test, beforeEach } from "bun:test";
import {
  coalesce,
  inflightCount,
  inflightKeys,
  isInflight,
  resetQueueForTests,
} from "~/build/queue";

/** Resolves after `ms`, letting us hold a build "open" while we race callers. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A promise plus its resolvers, so a test can decide when work finishes. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetQueueForTests();
});

describe("coalesce", () => {
  test("runs the work function exactly once for concurrent callers", async () => {
    let calls = 0;
    const gate = deferred<string>();
    const work = () => {
      calls++;
      return gate.promise;
    };

    const a = coalesce("story:1", work);
    const b = coalesce("story:1", work);
    const c = coalesce("story:1", work);

    gate.resolve("built");
    expect(await Promise.all([a, b, c])).toEqual(["built", "built", "built"]);
    expect(calls).toBe(1);
  });

  test("all concurrent callers receive the identical value", async () => {
    const artifact = { bytes: 123 };
    const gate = deferred<typeof artifact>();

    const a = coalesce("story:1", () => gate.promise);
    const b = coalesce("story:1", () => gate.promise);
    gate.resolve(artifact);

    const [ra, rb] = await Promise.all([a, b]);
    // Same reference, not merely a structural match.
    expect(ra).toBe(artifact);
    expect(rb).toBe(artifact);
  });

  test("different keys run independently", async () => {
    const started: string[] = [];
    const work = (id: string) => async () => {
      started.push(id);
      await sleep(5);
      return id;
    };

    const results = await Promise.all([
      coalesce("story:1", work("1")),
      coalesce("story:2", work("2")),
      coalesce("edition:2026-08-16", work("3")),
    ]);

    expect(results).toEqual(["1", "2", "3"]);
    expect(started.sort()).toEqual(["1", "2", "3"]);
  });

  test("a later call after settling runs the work again", async () => {
    let calls = 0;
    const work = async () => {
      calls++;
      return calls;
    };

    expect(await coalesce("story:1", work)).toBe(1);
    expect(await coalesce("story:1", work)).toBe(2);
    expect(calls).toBe(2);
  });

  test("the key is released once the work resolves", async () => {
    const gate = deferred<string>();
    const p = coalesce("story:7", () => gate.promise);

    expect(isInflight("story:7")).toBe(true);
    expect(inflightCount()).toBe(1);
    expect(inflightKeys()).toEqual(["story:7"]);

    gate.resolve("done");
    await p;

    expect(isInflight("story:7")).toBe(false);
    expect(inflightCount()).toBe(0);
  });

  test("the key is released even when the work rejects", async () => {
    const gate = deferred<string>();
    const p = coalesce("story:7", () => gate.promise);

    expect(isInflight("story:7")).toBe(true);

    gate.reject(new Error("extraction blew up"));
    await expect(p).rejects.toThrow("extraction blew up");

    expect(isInflight("story:7")).toBe(false);
    expect(inflightCount()).toBe(0);
  });

  test("a rejection propagates to every coalesced caller", async () => {
    const gate = deferred<string>();
    const a = coalesce("story:9", () => gate.promise);
    const b = coalesce("story:9", () => gate.promise);

    gate.reject(new Error("boom"));

    await expect(a).rejects.toThrow("boom");
    await expect(b).rejects.toThrow("boom");
  });

  test("a synchronous throw becomes a rejected promise, not an exception", () => {
    // If the IIFE wrapper were missing this would throw before returning,
    // and the key would leak because `.finally` was never attached.
    const p = coalesce("story:5", () => {
      throw new Error("sync failure");
    });

    expect(p).toBeInstanceOf(Promise);
    expect(p).rejects.toThrow("sync failure");
  });

  test("a synchronous throw still releases the key", async () => {
    const p = coalesce("story:5", () => {
      throw new Error("sync failure");
    });
    await expect(p).rejects.toThrow("sync failure");
    expect(isInflight("story:5")).toBe(false);
  });

  test("a failed build does not poison the key for later attempts", async () => {
    await expect(
      coalesce("story:1", async () => {
        throw new Error("transient network error");
      }),
    ).rejects.toThrow("transient");

    expect(await coalesce("story:1", async () => "recovered")).toBe("recovered");
  });

  test("a caller arriving mid-flight joins rather than starting a second run", async () => {
    let calls = 0;
    const gate = deferred<string>();
    const work = () => {
      calls++;
      return gate.promise;
    };

    const first = coalesce("story:1", work);
    await sleep(5); // let the first call settle into the map
    const second = coalesce("story:1", work);

    expect(calls).toBe(1);
    gate.resolve("ok");
    expect(await Promise.all([first, second])).toEqual(["ok", "ok"]);
  });

  test("tracks several distinct keys at once", async () => {
    const gates = ["a", "b", "c"].map(() => deferred<string>());
    const ps = gates.map((g, i) => coalesce(`k${i}`, () => g.promise));

    expect(inflightCount()).toBe(3);
    expect(inflightKeys().sort()).toEqual(["k0", "k1", "k2"]);

    gates.forEach((g, i) => g.resolve(String(i)));
    await Promise.all(ps);

    expect(inflightCount()).toBe(0);
  });
});
