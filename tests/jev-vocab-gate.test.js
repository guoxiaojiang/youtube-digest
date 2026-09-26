const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/**
 * Sandbox for the Jev vocab gate + priority picks helpers.
 */
function loadJevVocabHelpers({ settings = {}, fetchImpl = fetch } = {}) {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval() {},
    clearInterval() {},
    IntersectionObserver: class {},
    CSS: { escape: (value) => value },
    fetch: fetchImpl,
    AbortController,
    window: { getSelection: () => null, close() {} },
    document: {
      addEventListener() {},
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => ({}),
    },
    chrome: {
      runtime: {
        onMessage: listeners,
        sendMessage: () => Promise.resolve({}),
      },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      tabs: { onUpdated: listeners, onActivated: listeners, onRemoved: listeners },
      storage: {
        local: {
          get: async () => ({ ytd_settings: settings }),
        },
      },
    },
    YTD_SETTINGS: { STORAGE_KEY: "ytd_settings", normalize: (value) => value },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("sidepanel.js"), sandbox);
  return sandbox.__YTD_JEV_VOCAB_TESTING__;
}

test("vocab gate and picks are wired in the panel", () => {
  const html = read("sidepanel.html");
  const js = read("sidepanel.js");
  assert.match(html, /id="vocabPicks"/);
  assert.match(js, /judgeVocabGate\(selectedText, transcriptContext\)/);
  assert.match(js, /rankVocabPriority\(currentVocabItems\)/);
  assert.match(js, /gate && gate\.text === selectedText && !gate\.worthy/);
  assert.match(js, /vocab-pick-chip/);
});

test("summarizeVocabPicks filters by threshold, sorts, and caps at five", () => {
  const { summarizeVocabPicks } = loadJevVocabHelpers();
  const items = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"].map(
    (word, index) => ({ word, chinese: `义${index}`, timestampSeconds: index * 10 }),
  );
  const answers = {
    p_0: { noul: 0.9 },
    p_1: { noul: 0.3 }, // below threshold
    p_2: { noul: 0.7 },
    p_3: { noul: 0.85 },
    p_4: { noul: 0.6 },
    p_5: { noul: 0.75 },
    p_6: { noul: 0.65 },
  };
  const picks = summarizeVocabPicks({ answers }, items);
  // Six words pass 0.55; only the top five are returned, sorted by priority.
  assert.equal(picks.length, 5);
  assert.equal(picks[0].word, "alpha");
  assert.equal(picks[1].word, "delta");
  assert.equal(picks[2].word, "zeta");
  assert.equal(picks[3].word, "gamma");
  assert.equal(picks[4].word, "eta");
  assert.equal(picks[0].timestampSeconds, 0);
});

test("judgeVocabGate skips the request when the rule pre-filter fails", async () => {
  let calls = 0;
  const { judgeVocabGate, isVocabCandidate } = loadJevVocabHelpers({
    settings: { jevApiKey: "jv_test_key" },
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ answers: {} }) };
    },
  });
  // A whole sentence fails the free rule check -> no Jev call at all.
  const sentence = "This is a full sentence that should never reach Jev.";
  assert.equal(isVocabCandidate(sentence), false);
  await judgeVocabGate(sentence, "context");
  assert.equal(calls, 0);
});

test("judgeVocabGate skips the request without a Jev key", async () => {
  let calls = 0;
  const { judgeVocabGate } = loadJevVocabHelpers({
    settings: {},
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ answers: {} }) };
    },
  });
  await judgeVocabGate("quantum entanglement", "context");
  assert.equal(calls, 0);
});

test("judgeVocabGate posts the documented payload for a plausible selection", async () => {
  const calls = [];
  const { judgeVocabGate } = loadJevVocabHelpers({
    settings: { jevApiKey: "jv_test_key" },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          answers: { worth_card: { type: "noul", noul: 0.82 } },
        }),
      };
    },
  });

  await judgeVocabGate("quantum entanglement", "Entropy and quantum entanglement are related.");
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, "jev-latest");
  assert.equal(body.questions.worth_card.type, "noul");
  assert.equal(body.state.selected_text, "quantum entanglement");
  assert.match(body.state.passage, /Entropy/);
});

test("rankVocabPriority fires one request for the whole list and never throws", async () => {
  const calls = [];
  const { rankVocabPriority } = loadJevVocabHelpers({
    settings: { jevApiKey: "jv_test_key" },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const answers = {};
      ["alpha", "beta", "gamma"].forEach((_, index) => {
        answers[`p_${index}`] = { type: "noul", noul: 0.9 - index * 0.1 };
      });
      return {
        ok: true,
        status: 200,
        json: async () => ({ answers }),
      };
    },
  });

  const items = [
    { word: "alpha", chinese: "甲", timestampSeconds: 0 },
    { word: "beta", chinese: "乙", timestampSeconds: 10 },
    { word: "gamma", chinese: "丙", timestampSeconds: 20 },
  ];
  await rankVocabPriority(items);

  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(Object.keys(body.questions), ["p_0", "p_1", "p_2"]);
  assert.deepEqual(body.state.words, ["alpha", "beta", "gamma"]);
});

test("rankVocabPriority is a no-op without a key or empty items", async () => {
  let calls = 0;
  const helpers = loadJevVocabHelpers({
    settings: {},
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ answers: {} }) };
    },
  });
  await helpers.rankVocabPriority([{ word: "alpha" }]);
  await helpers.rankVocabPriority([]);
  assert.equal(calls, 0);
});
