import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { APP_JS } from "~/web/sw";

const PREFIX = "hopds-reader-v1:";
const actions = `<div data-reader-story="1" data-reader-title="A story" hidden>
  <button data-reader-save></button><button data-reader-read></button></div>
  <span data-reader-state="1" hidden></span><p data-reader-status></p>`;
const reading = `<header data-reading-story="1"></header><article class="article"><p>First</p><p>Second</p></article>
  <section class="comments"><details id="c1" open><summary>One</summary><p>Text</p></details>
  <details id="c2" open><summary>Two</summary><p>Text</p></details></section>`;

function page(options: {
  markup?: string;
  data?: Map<string, string>;
  blocked?: boolean;
  quota?: boolean;
  hash?: string;
  navigation?: string;
  loading?: boolean;
  cached?: Record<string, number>;
} = {}) {
  const { document, Event } = parseHTML(`<html><body>
    <p data-connection-status hidden></p>${options.markup ?? actions}</body></html>`);
  const data = options.data ?? new Map<string, string>();
  const handlers: Record<string, Array<(event: any) => void>> = {};
  const swHandlers: Record<string, Array<(event: any) => void>> = {};
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 0;
  const scrolls: number[] = [];
  const storage = {
    get length() { return data.size; },
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    getItem(key: string) {
      if (options.blocked) throw new Error("blocked");
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (options.quota) throw new Error("quota");
      data.set(key, value);
    },
    removeItem: (key: string) => data.delete(key),
  };
  const caches = {
    match: async (url: string) => {
      const stamp = options.cached?.[url];
      return stamp === undefined ? undefined : new Response("saved", { headers: { "x-hopds-cached": String(stamp) } });
    },
  };
  const window = {
    localStorage: storage,
    pageYOffset: 0,
    location: { hash: options.hash ?? "" },
    performance: { getEntriesByType: () => [{ type: options.navigation ?? "navigate" }] },
    addEventListener: (type: string, fn: (event: any) => void) => { (handlers[type] ??= []).push(fn); },
    scrollTo: (_x: number, y: number) => { scrolls.push(y); window.pageYOffset = y; },
    caches,
  };
  const navigator: { onLine: boolean; serviceWorker?: unknown } = { onLine: true };
  if (options.cached) navigator.serviceWorker = {
    register: async () => ({}),
    addEventListener: (type: string, fn: (event: any) => void) => { (swHandlers[type] ??= []).push(fn); },
  };
  Object.defineProperty(document, "readyState", { value: options.loading ? "loading" : "complete" });
  for (const element of document.querySelectorAll("details")) {
    Object.defineProperty(element, "open", {
      get: () => element.hasAttribute("open"),
      set: (open: boolean) => open ? element.setAttribute("open", "") : element.removeAttribute("open"),
    });
  }
  const nodes = document.querySelectorAll(".article p, .comments details");
  nodes.forEach((node, index) => {
    (node as any).getBoundingClientRect = () => ({ top: (index + 1) * 500 - window.pageYOffset });
  });
  new Function("window", "document", "navigator", "caches", "setTimeout", "clearTimeout", APP_JS)(
    window, document, navigator, caches,
    (fn: () => void, ms: number) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; },
    (id: number) => timers.delete(id),
  );
  return {
    document, window, navigator, data, scrolls,
    fire: (type: string, event: any = {}) => { for (const fn of handlers[type] ?? []) fn(event); },
    message: (data: unknown) => { for (const fn of swHandlers.message ?? []) fn({ data }); },
    click: (selector: string) => document.querySelector(selector)!.dispatchEvent(new Event("click", { bubbles: true })),
    state: () => JSON.parse(data.get(PREFIX + "1") || "{}"),
    flushTimers: () => {
      const pending = Array.from(timers.values());
      timers.clear();
      for (const timer of pending) timer.fn();
    },
  };
}

function stored(value: unknown) { return new Map([[PREFIX + "1", JSON.stringify(value)]]); }
async function microtasks() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

describe("device-local reading state", () => {
  test("save for later and read/unread are independent and persist across visits", () => {
    const first = page();
    first.click("[data-reader-save]");
    expect(first.state().saved).toBe(true);
    expect(first.state().read).toBeUndefined();
    first.click("[data-reader-read]");
    expect(first.state().read).toBe(true);
    const next = page({ data: first.data });
    expect(next.document.querySelector("[data-reader-state]")!.textContent).toBe("Read · Saved for later");
    next.click("[data-reader-read]");
    expect(next.state().read).toBe(false);
    expect(next.state().saved).toBe(true);
    next.click("[data-reader-save]");
    expect(next.state().saved).toBe(false);
  });

  test("opening and scrolling never silently changes an explicit unread flag", () => {
    const p = page({ markup: actions + reading, data: stored({ read: false }) });
    p.window.pageYOffset = 700;
    p.fire("pagehide");
    expect(p.state().position.y).toBe(700);
    expect(p.state().read).toBe(false);
  });

  test("the queue renders saved stories safely, newest first, and removes them immediately", () => {
    const data = stored({ saved: true, savedAt: 1, title: "<img src=x onerror=evil()>" });
    data.set(PREFIX + "2", JSON.stringify({ saved: true, savedAt: 2, title: "Second" }));
    data.set(PREFIX + "3", JSON.stringify({ read: true, title: "Not saved" }));
    data.set(PREFIX + "bad-id", JSON.stringify({ saved: true, title: "Invalid" }));
    const p = page({ markup: '<ul data-reader-library></ul><p data-reader-empty hidden></p>', data });
    const links = p.document.querySelectorAll(".story-link");
    expect(links.length).toBe(2);
    expect(links[0]!.getAttribute("href")).toBe("/story/2");
    expect(p.document.querySelector("img")).toBeNull();
    expect(links[1]!.textContent).toContain("<img src=x onerror=evil()>");
    p.click('[data-reader-story="2"] [data-reader-save]');
    expect(p.document.querySelectorAll(".story-link").length).toBe(1);
    p.click('[data-reader-story="1"] [data-reader-save]');
    expect(p.document.querySelector("[data-reader-empty]")!.hasAttribute("hidden")).toBe(false);
  });

  test("storage events and bfcache pageshow refresh the visible read state", () => {
    const p = page();
    p.data.set(PREFIX + "1", JSON.stringify({ read: true }));
    p.fire("storage", { key: PREFIX + "1" });
    expect(p.document.querySelector("[data-reader-state]")!.textContent).toBe("Read");
    p.data.clear();
    p.fire("pageshow", { persisted: true });
    expect(p.document.querySelector("[data-reader-state]")!.textContent).toBe("Unread");
  });

  test("malformed local state does not break controls", () => {
    const p = page({ data: new Map([[PREFIX + "1", "{bad json"]]) });
    p.click("[data-reader-save]");
    expect(p.state().saved).toBe(true);
  });

  test("blocked storage leaves controls hidden and explains the missing queue", () => {
    const p = page({ blocked: true, markup: actions + '<p data-reader-unavailable hidden></p>' });
    expect(p.document.querySelector("[data-reader-story]")!.hasAttribute("hidden")).toBe(true);
    expect(p.document.querySelector("[data-reader-unavailable]")!.hasAttribute("hidden")).toBe(false);
  });

  test("a full storage quota still permits reading existing saved state", () => {
    const p = page({ quota: true, data: stored({ saved: true, read: true }) });
    expect(p.document.querySelector("[data-reader-state]")!.textContent).toBe("Read · Saved for later");
    p.click("[data-reader-read]");
    expect(p.state().read).toBe(true);
    expect(p.document.querySelector("[data-reader-status]")!.textContent).toContain("Could not save");
  });
});

describe("reading position", () => {
  test("records a paragraph anchor, collapsed threads, and preserves flags", () => {
    const p = page({ markup: actions + reading, data: stored({ saved: true, read: true }) });
    p.window.pageYOffset = 1080;
    (p.document.getElementById("c2") as any).open = false;
    p.fire("scroll");
    p.flushTimers();
    expect(p.state().position).toEqual({ y: 1080, kind: "article", key: 1, offset: -80, closed: ["c2"] });
    expect(p.state().saved).toBe(true);
    expect(p.state().read).toBe(true);
  });

  test("restores the collapsed shape and semantic position despite changed pixel coordinates", () => {
    const p = page({ markup: reading, data: stored({ position: { y: 9999, kind: "comment", key: "c1", offset: -25, closed: ["c2"] } }) });
    expect((p.document.getElementById("c2") as any).open).toBe(false);
    expect(p.scrolls).toEqual([1525]);
    p.fire("pageshow", { persisted: true });
    expect(p.scrolls).toEqual([1525]);
  });

  test("falls back to the recorded scroll offset if the anchor disappeared", () => {
    const p = page({ markup: reading, data: stored({ position: { y: 400, kind: "comment", key: "gone" } }) });
    expect(p.scrolls).toEqual([400]);
  });

  test.each(["#comments", "#c2", "#top"])("fragment %s takes priority over automatic resume", (hash) => {
    const p = page({ markup: reading, hash, data: stored({ position: { y: 700, closed: ["c2"] } }) });
    expect(p.scrolls).toEqual([]);
    expect((p.document.getElementById("c2") as any).open).toBe(true);
  });

  test("history traversal leaves scroll restoration to the browser", () => {
    const p = page({ markup: reading, navigation: "back_forward", data: stored({ position: { y: 800 } }) });
    expect(p.scrolls).toEqual([]);
  });

  test("a reader who already started scrolling is not pulled back after load", () => {
    const p = page({ markup: reading, loading: true, data: stored({ position: { y: 800 } }) });
    p.fire("wheel");
    p.window.pageYOffset = 300;
    p.fire("load");
    expect(p.scrolls).toEqual([]);
    p.fire("pagehide");
    expect(p.state().position.y).toBe(300);
  });

  test("saving progress does not overwrite flags changed in another tab", () => {
    const p = page({ markup: reading });
    p.data.set(PREFIX + "1", JSON.stringify({ read: true, saved: true }));
    p.window.pageYOffset = 900;
    p.fire("pagehide");
    expect(p.state()).toMatchObject({ read: true, saved: true, position: { y: 900 } });
  });
});

describe("offline status", () => {
  test("network hints update without depending on writable local storage", () => {
    const p = page({ blocked: true });
    p.navigator.onLine = false;
    p.fire("offline");
    expect(p.document.querySelector("[data-connection-status]")!.textContent).toContain("Offline");
    p.navigator.onLine = true;
    p.fire("online");
    expect(p.document.querySelector("[data-connection-status]")!.textContent).toBe("Network available");
  });

  test("queue availability reflects actual unexpired cache entries, not bookmarks", async () => {
    const data = stored({ saved: true, title: "Not downloaded" });
    data.set(PREFIX + "2", JSON.stringify({ saved: true, title: "Downloaded" }));
    data.set(PREFIX + "3", JSON.stringify({ saved: true, title: "Expired" }));
    const p = page({ markup: '<ul data-reader-library></ul>', data, cached: {
      "/story/2": Date.now(), "/story/3": Date.now() - 31 * 86400000,
    } });
    await microtasks();
    expect(p.document.querySelector('[data-offline-status="/story/1"]')!.textContent).toBe("Not saved offline");
    expect(p.document.querySelector('[data-offline-status="/story/2"]')!.textContent).toBe("Available offline on this device");
    expect(p.document.querySelector('[data-offline-status="/story/3"]')!.textContent).toBe("Not saved offline");
  });

  test("worker cache notifications refresh availability after a download or eviction", async () => {
    const cached: Record<string, number> = {};
    const p = page({ markup: '<ul data-reader-library></ul>', data: stored({ saved: true }), cached });
    await microtasks();
    cached["/story/1"] = Date.now();
    p.message({ type: "cache-updated" });
    await microtasks();
    expect(p.document.querySelector("[data-offline-status]")!.textContent).toBe("Available offline on this device");
    delete cached["/story/1"];
    p.message({ type: "cache-updated" });
    await microtasks();
    expect(p.document.querySelector("[data-offline-status]")!.textContent).toBe("Not saved offline");
  });
});
