const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/**
 * Sandbox for the Pause Insight (Jev) helpers. Mirrors loadSidepanelHelpers
 * in translation.test.js but also exposes chrome.storage.local and fetch so
 * callJevDecision can be exercised end to end.
 */
function loadPauseInsightHelpers({ settings = {}, fetchImpl = fetch } = {}) {
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
  return sandbox.__YTD_PAUSE_INSIGHT_TESTING__;
}

const TRANSCRIPT = [
  { start: 0, text: "Welcome back to the channel." },
  { start: 6, text: "Today we talk about thermodynamics." },
  { start: 12, text: "Entropy is the fascinating part here." },
  { start: 18, text: "Let me show you a quick example." },
  { start: 24, text: "That is why low heat always wins." },
];

test("pause insight card is wired in the panel and content script", () => {
  const html = read("sidepanel.html");
  const js = read("sidepanel.js");
  const content = read("content.js");
  assert.match(html, /id="pauseInsightCard"/);
  assert.match(html, /id="pauseInsightVocab"/);
  assert.match(html, /id="pauseInsightGotoBtn"/);
  assert.match(js, /action === "pauseDetected"/);
  assert.match(js, /jevtypesafeai\.com\/api\/v1\/decide/);
  assert.match(js, /goToPauseInsightCard/);
  assert.match(js, /scrollTo\(\{ top: 0/);
  assert.match(js, /autoScrollEnabled = false;/);
  assert.match(js, /showExplanation\(word\)/);
  assert.match(content, /action: "pauseDetected"/);
  assert.match(content, /addEventListener\("pause"/);
});

test("extractPauseContext slices the window around the pause point", () => {
  const { extractPauseContext } = loadPauseInsightHelpers();
  const ctx = extractPauseContext(TRANSCRIPT, 13, 6);
  // Entries with start in [7, 19]: 12 and 18.
  assert.equal(ctx.lines.length, 2);
  assert.equal(ctx.lines[0].start, 12);
  assert.ok(ctx.text.includes("Entropy"));
  assert.ok(ctx.text.includes("example"));
});

test("extractPauseContext anchors to the nearest line when paused in a gap", () => {
  const { extractPauseContext } = loadPauseInsightHelpers();
  const ctx = extractPauseContext(TRANSCRIPT, 21, 6);
  // No entry in [15, 27]; anchor to the last line <= 21 (start 18) plus a
  // neighbour before it.
  assert.ok(ctx.lines.length >= 2);
  assert.ok(ctx.lines.some((line) => line.start === 18));
  assert.ok(ctx.text.length > 0);
});

test("extractPauseContext handles empty input and caps output", () => {
  const { extractPauseContext } = loadPauseInsightHelpers();
  const empty = extractPauseContext([], 5);
  assert.equal(empty.lines.length, 0);
  assert.equal(empty.text, "");

  const dense = Array.from({ length: 30 }, (_, index) => ({
    start: index * 2,
    text: `line number ${index}`,
  }));
  const capped = extractPauseContext(dense, 15, 100);
  assert.ok(capped.lines.length <= 6);
  assert.ok(capped.text.length <= 480);
});

test("extractCandidateWords filters stop words, short words, and learned words", () => {
  const { extractCandidateWords } = loadPauseInsightHelpers();
  const words = extractCandidateWords(
    "The entropy concept is genuinely fascinating and quite fascinating to learn",
    ["fascinating"],
  );
  // the/is/and/to are stop words; fascinating is learned; entropy, concept,
  // genuinely, quite, learn survive.
  // Cross-realm arrays from the VM sandbox are not reference-equal, so assert
  // via string comparison rather than deep equality.
  assert.equal(words.join(","), "entropy,concept,genuinely,quite,learn");
});

test("extractCandidateWords dedupes and respects the candidate cap", () => {
  const { extractCandidateWords } = loadPauseInsightHelpers();
  // 25 distinct words, every one at least 4 letters long, none a stop word.
  const text = [
    "alpha beta gamma delta epsilon zeta theta iota kappa lambda",
    "omicron sigma upsilon omega candor dapper effigy guile hapless",
    "jovial knave larder mirth nuance onyx quill ravel sable trove",
  ].join(" ");
  const words = extractCandidateWords(text, []);
  assert.equal(words.length, 20);
  assert.equal(new Set(words).size, words.length);
});

test("buildPauseClassifyQuestions returns the four-way choice plus noul", () => {
  const { buildPauseClassifyQuestions } = loadPauseInsightHelpers();
  const questions = buildPauseClassifyQuestions();
  assert.equal(questions.content_type.type, "choice");
  for (const criterion of ["concept", "conclusion", "detail", "transition"]) {
    assert.ok(questions.content_type.criteria[criterion]);
  }
  assert.equal(questions.worth_note.type, "noul");
});

test("buildPauseVocabQuestions creates one noul per candidate", () => {
  const { buildPauseVocabQuestions } = loadPauseInsightHelpers();
  const questions = buildPauseVocabQuestions(["entropy", "genuinely"]);
  assert.deepEqual(Object.keys(questions), ["w_0", "w_1"]);
  assert.equal(questions.w_0.type, "noul");
  assert.match(questions.w_0.instructions, /"entropy"/);
});

test("summarizePauseInsight maps kinds, worthiness, and word threshold", () => {
  const { summarizePauseInsight } = loadPauseInsightHelpers();
  const classification = {
    answers: {
      content_type: {
        type: "choice",
        choice: "concept",
        probabilities: { concept: 0.9 },
      },
      worth_note: { type: "noul", noul: 0.92 },
    },
  };
  const vocabAnswers = {
    answers: {
      w_0: { type: "noul", noul: 0.85 },
      w_1: { type: "noul", noul: 0.4 },
    },
  };
  const insight = summarizePauseInsight(
    classification,
    vocabAnswers,
    ["entropy", "quite"],
  );
  assert.equal(insight.kind, "concept");
  assert.equal(insight.worthNote, true);
  assert.equal(insight.words.length, 1);
  assert.equal(insight.words[0].word, "entropy");
  assert.equal(insight.words[0].probability, 0.85);
});

test("summarizePauseInsight produces transition advice and degrades safely", () => {
  const { summarizePauseInsight } = loadPauseInsightHelpers();
  const transition = summarizePauseInsight(
    { answers: { content_type: { choice: "transition" }, worth_note: { noul: 0.9 } } },
    { answers: {} },
    ["word"],
  );
  assert.equal(transition.kind, "transition");
  assert.match(transition.message, /重要/);

  const degraded = summarizePauseInsight(
    { success: false, error: "NETWORK" },
    { answers: {} },
    ["word"],
  );
  assert.equal(degraded.kind, "transition");
  assert.equal(degraded.words.length, 0);
});

test("callJevDecision posts the documented payload and parses answers", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: "jev-latest",
        answers: {
          content_type: { type: "choice", choice: "conclusion", probabilities: { conclusion: 0.8 } },
          worth_note: { type: "noul", noul: 0.7 },
        },
        usage: { input_tokens: 100, cost_usd: 0.0001 },
      }),
    };
  };

  const { callJevDecision } = loadPauseInsightHelpers({
    settings: { jevApiKey: "jv_test_key" },
    fetchImpl,
  });

  const result = await callJevDecision({
    state: { video_title: "Thermo", passage: "Entropy matters." },
    questions: { worth_note: { type: "noul", instructions: "Worth a note?" } },
  });

  assert.equal(result.success, true);
  assert.equal(result.answers.worth_note.noul, 0.7);
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, "jev-latest");
  assert.equal(body.state.video_title, "Thermo");
  assert.equal(
    calls[0].options.headers.Authorization,
    "Bearer jv_test_key",
  );
});

test("callJevDecision returns NO_JEV_KEY without a key and maps 401", async () => {
  const noKey = loadPauseInsightHelpers({ settings: {} });
  const missing = await noKey.callJevDecision({
    state: ["x"],
    questions: { q: { type: "noul", instructions: "?" } },
  });
  assert.equal(missing.error, "NO_JEV_KEY");

  const rejected = loadPauseInsightHelpers({
    settings: { jevApiKey: "jv_bad" },
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => "no" }),
  });
  const unauthorized = await rejected.callJevDecision({
    state: ["x"],
    questions: { q: { type: "noul", instructions: "?" } },
  });
  assert.equal(unauthorized.error, "INVALID_JEV_KEY");
});
