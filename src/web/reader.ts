/** Device-local reading state. Emitted verbatim for older e-reader browsers. */
export const READER_JS = `
(function () {
  "use strict";
  if (!document.querySelector || !window.addEventListener) return;
  function connection() {
    var node = document.querySelector("[data-connection-status]");
    if (!node || typeof navigator.onLine !== "boolean") return;
    node.textContent = navigator.onLine ? "Network available" : "Offline — only downloaded pages are available";
    node.setAttribute("title", "Browser connection status; a connected network may not have internet access.");
    node.removeAttribute("hidden");
  }
  connection();
  window.addEventListener("online", connection);
  window.addEventListener("offline", connection);
  var PREFIX = "hopds-reader-v1:";
  var storage;
  try {
    storage = window.localStorage;
    storage.getItem(PREFIX + "probe");
  } catch (error) {
    var unavailable = document.querySelector("[data-reader-unavailable]");
    if (unavailable) unavailable.removeAttribute("hidden");
    return;
  }

  function read(id) {
    try {
      var value = JSON.parse(storage.getItem(PREFIX + id) || "null");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch (error) { return {}; }
  }

  function write(id, value) {
    try {
      storage.setItem(PREFIX + id, JSON.stringify(value));
      return true;
    } catch (error) {
      var status = document.querySelector("[data-reader-status]");
      if (status) status.textContent = "Could not save on this device. Browser storage may be full.";
      return false;
    }
  }

  function controls(id, title) {
    var box = document.createElement("div");
    box.className = "reader-actions";
    box.setAttribute("data-reader-story", id);
    box.setAttribute("data-reader-title", title);
    var save = document.createElement("button");
    save.className = "btn";
    save.type = "button";
    save.setAttribute("data-reader-save", "");
    var seen = document.createElement("button");
    seen.className = "btn";
    seen.type = "button";
    seen.setAttribute("data-reader-read", "");
    box.appendChild(save);
    box.appendChild(seen);
    return box;
  }

  var library = document.querySelector("[data-reader-library]");
  function renderLibrary() {
    if (!library) return;
    while (library.firstChild) library.removeChild(library.firstChild);
    var entries = [];
    try {
      for (var i = 0; i < storage.length; i++) {
        var key = storage.key(i);
        if (!key || key.indexOf(PREFIX) !== 0) continue;
        var id = key.slice(PREFIX.length);
        if (!/^\\d+$/.test(id)) continue;
        var value = read(id);
        if (value.saved === true) entries.push({ id: id, value: value });
      }
    } catch (error) { return; }
    entries.sort(function (a, b) { return (Number(b.value.savedAt) || 0) - (Number(a.value.savedAt) || 0); });
    for (var n = 0; n < entries.length; n++) {
      var item = entries[n];
      var li = document.createElement("li");
      li.setAttribute("data-reader-row", item.id);
      var link = document.createElement("a");
      link.className = "story-link";
      link.href = "/story/" + item.id;
      var body = document.createElement("span");
      body.className = "story-body";
      var title = document.createElement("span");
      title.className = "story-title";
      title.textContent = typeof item.value.title === "string" ? item.value.title : "Story " + item.id;
      body.appendChild(title);
      var state = document.createElement("span");
      state.className = "story-meta";
      state.setAttribute("data-reader-state", item.id);
      body.appendChild(state);
      var offline = document.createElement("span");
      offline.className = "story-meta";
      offline.setAttribute("data-offline-status", link.getAttribute("href"));
      offline.textContent = "Offline availability not verified";
      body.appendChild(offline);
      link.appendChild(body);
      li.appendChild(link);
      li.appendChild(controls(item.id, title.textContent));
      library.appendChild(li);
    }
    var empty = document.querySelector("[data-reader-empty]");
    if (empty) empty.hidden = entries.length > 0;
  }

  function refresh() {
    var boxes = document.querySelectorAll("[data-reader-story]");
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      var value = read(box.getAttribute("data-reader-story"));
      var save = box.querySelector("[data-reader-save]");
      var seen = box.querySelector("[data-reader-read]");
      box.removeAttribute("hidden");
      if (save) {
        save.textContent = value.saved === true ? "Remove from saved" : "Save for later";
        save.setAttribute("aria-pressed", String(value.saved === true));
      }
      if (seen) {
        seen.textContent = value.read === true ? "Mark unread" : "Mark read";
        seen.setAttribute("aria-pressed", String(value.read === true));
      }
    }
    var states = document.querySelectorAll("[data-reader-state]");
    for (var j = 0; j < states.length; j++) {
      var entry = read(states[j].getAttribute("data-reader-state"));
      states[j].textContent = (entry.read === true ? "Read" : "Unread") + (entry.saved === true ? " · Saved for later" : "");
      states[j].removeAttribute("hidden");
    }
  }

  function changed() {
    var active = document.activeElement;
    var focusId;
    var focusAction;
    if (library && active && library.contains(active) && active.closest) {
      var box = active.closest("[data-reader-story]");
      if (box) {
        focusId = box.getAttribute("data-reader-story");
        focusAction = active.hasAttribute("data-reader-read") ? "[data-reader-read]" : "[data-reader-save]";
      }
    }
    renderLibrary();
    refresh();
    if (focusId) {
      var replacement = library.querySelector('[data-reader-story="' + focusId + '"] ' + focusAction)
        || library.querySelector("button");
      if (!replacement) {
        replacement = document.querySelector("[data-reader-empty]");
        if (replacement) replacement.setAttribute("tabindex", "-1");
      }
      if (replacement && replacement.focus) replacement.focus();
    }
    // The offline shim scans dynamically populated saved-story rows too.
    var event = document.createEvent("Event");
    event.initEvent("reader-updated", false, false);
    document.dispatchEvent(event);
  }

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (target && target.nodeType === 3) target = target.parentNode;
    if (!target || !target.closest) return;
    var button = target.closest("[data-reader-save], [data-reader-read]");
    if (!button) return;
    var box = button.closest("[data-reader-story]");
    if (!box) return;
    var id = box.getAttribute("data-reader-story");
    var value = read(id);
    value.title = box.getAttribute("data-reader-title") || "Story " + id;
    if (button.hasAttribute("data-reader-save")) {
      value.saved = value.saved !== true;
      if (value.saved) value.savedAt = Date.now();
    } else value.read = value.read !== true;
    if (!write(id, value)) return;
    changed();
    var status = document.querySelector("[data-reader-status]");
    if (status) status.textContent = button.hasAttribute("data-reader-save")
      ? (value.saved ? "Saved for later on this device. Offline downloads are separate." : "Removed from saved stories.")
      : (value.read ? "Marked read." : "Marked unread.");
  });
  window.addEventListener("storage", function (event) {
    if (!event.key || event.key.indexOf(PREFIX) === 0) changed();
  });
  window.addEventListener("pageshow", changed);
  changed();

  var story = document.querySelector("[data-reading-story]");
  if (!story) return;
  var storyId = story.getAttribute("data-reading-story");
  var articleNodes = document.querySelectorAll(".article p, .article h2, .article h3, .article pre, .article blockquote, .article img");
  var comments = document.querySelectorAll(".comments details[id]");
  var initial = read(storyId).position;
  var ready = false;
  var touched = false;
  var timer;
  var historyVisit = false;
  try {
    var navigation = window.performance && window.performance.getEntriesByType("navigation")[0];
    historyVisit = navigation && navigation.type === "back_forward";
  } catch (error) {}
  function touch() { touched = true; }
  window.addEventListener("touchstart", touch);
  window.addEventListener("wheel", touch);
  window.addEventListener("keydown", touch);
  window.addEventListener("mousedown", touch);

  function closedIds() {
    var ids = [];
    for (var i = 0; i < comments.length; i++) {
      if (comments[i].open === false) ids.push(comments[i].id);
    }
    return ids;
  }

  // Restore the shape before measuring, but never hide a fragment destination.
  if (initial && !window.location.hash && !historyVisit && Array.isArray(initial.closed)) {
    for (var c = 0; c < comments.length; c++) {
      if (initial.closed.indexOf(comments[c].id) !== -1) comments[c].open = false;
    }
  }

  function savePosition() {
    if (!ready) return;
    var y = window.pageYOffset || document.documentElement.scrollTop || 0;
    var position = { y: y, closed: closedIds() };
    var nearest = -Infinity;
    function consider(node, kind, key) {
      if (!node.getBoundingClientRect || (node.getClientRects && !node.getClientRects().length)) return;
      var top = node.getBoundingClientRect().top;
      if (top <= 0 && top > nearest) {
        nearest = top;
        position.kind = kind;
        position.key = key;
        position.offset = top;
      }
    }
    for (var a = 0; a < articleNodes.length; a++) consider(articleNodes[a], "article", a);
    for (var b = 0; b < comments.length; b++) consider(comments[b], "comment", comments[b].id);
    // Read again before writing: another tab or a button may have changed flags.
    var value = read(storyId);
    value.position = position;
    write(storyId, value);
  }

  function restore() {
    if (ready) return;
    if (initial && !window.location.hash && !historyVisit && !touched) {
      var node = initial.kind === "article" ? articleNodes[initial.key] : document.getElementById(initial.key);
      var y = typeof initial.y === "number" && isFinite(initial.y) ? initial.y : 0;
      if (node && node.getBoundingClientRect && typeof initial.offset === "number" && isFinite(initial.offset)) {
        y = (window.pageYOffset || 0) + node.getBoundingClientRect().top - initial.offset;
      }
      window.scrollTo(0, Math.max(0, y));
    }
    ready = true;
  }
  function loaded() {
    // Fonts can change paragraph heights after load. Wait if supported, but
    // never let a stalled font keep progress recording disabled indefinitely.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(restore, restore);
    else restore();
    setTimeout(restore, 1500);
  }
  if (document.readyState === "complete") loaded();
  else window.addEventListener("load", loaded);
  window.addEventListener("scroll", function () {
    clearTimeout(timer);
    timer = setTimeout(savePosition, 400);
  });
  document.addEventListener("toggle", function () {
    clearTimeout(timer);
    timer = setTimeout(savePosition, 400);
  }, true);
  window.addEventListener("pagehide", savePosition);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") savePosition();
  });
})();
`;
