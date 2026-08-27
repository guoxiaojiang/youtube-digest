// Covers the two rules that decide when the transcript stops following
// playback, and the seek that a stale playback position would corrupt.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function loadSidepanelHelpers() {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    fetch: () => Promise.reject(new Error("no fetch")),
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval() {},
    clearInterval() {},
    IntersectionObserver: class {},
    CSS: { escape: (value) => value },
    window: { getSelection: () => null, close() {} },
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => ({ set textContent(_v) {}, get innerHTML() { return ""; } }),
    },
    chrome: {
      runtime: { onMessage: listeners, sendMessage: () => Promise.resolve({}) },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      tabs: { onUpdated: listeners, onActivated: listeners, onRemoved: listeners },
      storage: { local: { get: async () => ({}), set: async () => {} } },
    },
    YTD_SETTINGS: {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("sidepanel.js"), sandbox);
  return sandbox.__YTD_TRANSCRIPT_TESTING__;
}

/** Stand-ins for the elements a keydown can originate from. */
const el = (tagName, extra = {}) => ({ nodeType: 1, tagName, ...extra });
const CONTAINER = el("DIV");

test("scroll keys inside the transcript release following", () => {
  const { isScrollIntentKey } = loadSidepanelHelpers();
  for (const key of ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"]) {
    assert.equal(
      isScrollIntentKey(key, el("DIV"), CONTAINER),
      true,
      `${key} from a plain row must count as scrolling`,
    );
  }
  assert.equal(isScrollIntentKey(" ", CONTAINER, CONTAINER), true);
});

test("keys that do not scroll leave following alone", () => {
  const { isScrollIntentKey } = loadSidepanelHelpers();
  for (const key of ["a", "Enter", "Escape", "Tab", "Shift", "ArrowLeft", "ArrowRight"]) {
    assert.equal(isScrollIntentKey(key, el("DIV"), CONTAINER), false, key);
  }
});

test("typing in the note editor is not scrolling", () => {
  const { isScrollIntentKey } = loadSidepanelHelpers();
  for (const tag of ["TEXTAREA", "INPUT", "SELECT"]) {
    assert.equal(isScrollIntentKey(" ", el(tag), CONTAINER), false, `space in ${tag}`);
    assert.equal(isScrollIntentKey("ArrowDown", el(tag), CONTAINER), false, `arrow in ${tag}`);
    assert.equal(isScrollIntentKey("End", el(tag), CONTAINER), false, `End in ${tag}`);
  }
  assert.equal(
    isScrollIntentKey("PageDown", el("DIV", { isContentEditable: true }), CONTAINER),
    false,
  );
});

test("space on a focused control activates it rather than scrolling", () => {
  const { isScrollIntentKey } = loadSidepanelHelpers();
  assert.equal(isScrollIntentKey(" ", el("BUTTON"), CONTAINER), false);
  // Arrows still scroll from there — only Space is overloaded.
  assert.equal(isScrollIntentKey("ArrowDown", el("BUTTON"), CONTAINER), true);
});

test("text entry targets are recognised, non-elements are not", () => {
  const { isTextEntryTarget } = loadSidepanelHelpers();
  assert.equal(isTextEntryTarget(el("TEXTAREA")), true);
  assert.equal(isTextEntryTarget(el("DIV", { isContentEditable: true })), true);
  assert.equal(isTextEntryTarget(el("DIV")), false);
  assert.equal(isTextEntryTarget(el("SPAN", { isContentEditable: false })), false);
  assert.equal(isTextEntryTarget({ nodeType: 3 }), false, "a text node has no tagName");
  assert.equal(isTextEntryTarget(null), false);
});

test("a time past the end of a video clamps to its last segment", () => {
  const { findSegmentIndexForTime } = loadSidepanelHelpers();
  const segments = [{ start: 0 }, { start: 30 }, { start: 60 }];

  assert.equal(findSegmentIndexForTime(segments, 0), 0);
  assert.equal(findSegmentIndexForTime(segments, 45), 1);
  // Why the tracked position must be cleared when the video changes: an hour
  // carried over from a longer video would seed translation at the END here.
  assert.equal(findSegmentIndexForTime(segments, 3600), 2);
  // A fresh panel reports 0, which seeds the opening.
  assert.equal(findSegmentIndexForTime(segments, -5), 0);
  assert.equal(findSegmentIndexForTime([], 10), -1);
});
