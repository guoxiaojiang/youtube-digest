const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.resolve(__dirname, "..", "sidepanel.js"),
  "utf8",
);

test("all timestamped transcript row clicks use the selection-aware seek helper", () => {
  assert.match(
    source,
    /function hasNonCollapsedTextSelection\(\)[\s\S]*?selection\.rangeCount > 0 && !selection\.isCollapsed/,
  );
  assert.match(
    source,
    /function seekFromTranscriptEntryClick\(event, seconds\)[\s\S]*?if \(hasNonCollapsedTextSelection\(\)\) \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?event\.stopPropagation\(\);[\s\S]*?return;[\s\S]*?\}[\s\S]*?seekTo\(seconds\);/,
  );

  const guardedRowHandlers = source.match(
    /div\.addEventListener\("click", \(event\) =>\s+seekFromTranscriptEntryClick\(event, group\.start\),\s+\);/g,
  );
  assert.equal(
    guardedRowHandlers?.length,
    1,
    "raw transcript rows must use the guard",
  );
  assert.match(
    source,
    /div\.addEventListener\("click", \(event\) =>\s+seekFromTranscriptEntryClick\(event, segment\.start\),\s+\);/,
    "translated-only and bilingual rows must use the guard",
  );
  assert.doesNotMatch(
    source,
    /div\.addEventListener\("click", \(\) => seekTo\(group\.start\)\);/,
  );
});

test("Explain asks for a Chinese meaning and an English explanation", () => {
  const prompt = fs.readFileSync(
    path.resolve(__dirname, "..", "prompts", "explain.md"),
    "utf8",
  );
  // Markers, not JSON: a partial JSON object cannot be parsed mid-stream and
  // would surface as raw braces in the modal.
  assert.match(prompt, /@@CN@@/);
  assert.match(prompt, /@@EN@@/);
  assert.ok(
    prompt.indexOf("@@CN@@") < prompt.indexOf("@@EN@@"),
    "the Chinese section must come first so early tokens are the Chinese meaning",
  );

  const background = fs.readFileSync(
    path.resolve(__dirname, "..", "background.js"),
    "utf8",
  );
  assert.match(
    background,
    /handleExplainSelection\([\s\S]*?stream: true/,
    "the explanation request must stream",
  );
  assert.match(
    background,
    /handleExplainSelection\([\s\S]*?const sections = parseExplanation\(explanation\)[\s\S]*?\.\.\.sections,/,
    "the handler must return the split Chinese and English sections",
  );
  assert.match(
    background,
    /function parseExplanation\([\s\S]*?return \{ chinese[\s\S]*?english/,
    "parseExplanation must split the marked text into both fields",
  );
  assert.match(
    background,
    /handleExplainSelection\([\s\S]*?action: "explainProgress"[\s\S]*?\.\.\.parseExplanation\(accumulated\)/,
    "each delta must broadcast re-parsed sections so no marker leaks to the UI",
  );
});

test("the Explain modal renders the Chinese meaning above the English text", () => {
  const zhIndex = source.indexOf('explain-section-label">中文');
  const enIndex = source.indexOf('explain-section-label">English');
  assert.ok(zhIndex !== -1, "the modal must label the Chinese section");
  assert.ok(enIndex !== -1, "the modal must label the English section");
  assert.ok(zhIndex < enIndex, "Chinese must be rendered before English");
  assert.match(
    source,
    /function renderExplanationBody\(result\)[\s\S]*?result\.explanation/,
    "renderExplanationBody must fall back to the combined explanation",
  );
  assert.match(source, /contentDiv\.innerHTML = renderExplanationBody\(result\)/);
});

test("the Explain tooltip preserves selection and contains pointer events", () => {
  assert.match(
    source,
    /tooltip\.addEventListener\("mousedown", \(event\) => \{\s+event\.preventDefault\(\);\s+event\.stopPropagation\(\);/,
  );
  assert.match(
    source,
    /tooltip\.addEventListener\("mouseup", \(event\) => \{\s+event\.stopPropagation\(\);/,
  );
  assert.match(
    source,
    /\.addEventListener\("click", async \(event\) => \{\s+event\.preventDefault\(\);\s+event\.stopPropagation\(\);/,
  );
});

const vm = require("node:vm");

/**
 * Loads sidepanel.js in a sandbox to exercise the Explain-to-Vocab helpers
 * directly, following the pattern in vocab-cards.test.js.
 */
function loadSelectionHelpers() {
  const listeners = { addListener() {}, removeListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    fetch: () => Promise.resolve({}),
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
      createElement: () => ({
        set textContent(_v) {},
        get innerHTML() {
          return "";
        },
      }),
    },
    chrome: {
      runtime: { onMessage: listeners, sendMessage: () => Promise.resolve({}) },
      windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
      tabs: { onUpdated: listeners, onActivated: listeners, onRemoved: listeners },
      storage: { local: { get: async () => ({}), set: async () => {} } },
    },
    YTD_SETTINGS: {
      STORAGE_KEY: "ytd_settings",
      normalize: () => ({}),
      chatCompletionsUrl: () => "https://provider.test/chat/completions",
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  return sandbox.__YTD_TRANSCRIPT_TESTING__;
}

test("only word and short-phrase selections offer a Vocab card", () => {
  const { isVocabCandidate } = loadSelectionHelpers();
  assert.equal(isVocabCandidate("Norwegian"), true);
  assert.equal(isVocabCandidate("  observatory  "), true);
  assert.equal(isVocabCandidate("take for granted"), true);
  assert.equal(isVocabCandidate(""), false);
  assert.equal(isVocabCandidate("   "), false);
  assert.equal(
    isVocabCandidate("They built the observatory at the top of the hill"),
    false,
    "a long run of words has no single headword",
  );
  assert.equal(
    isVocabCandidate("This is a sentence."),
    false,
    "terminal punctuation marks a sentence, not a term",
  );
});

test("a Vocab card built from Explain carries the surrounding sentence", () => {
  const { findSentenceForSelection } = loadSelectionHelpers();
  assert.equal(
    findSentenceForSelection("nothing here"),
    "nothing here",
    "with no transcript loaded the selection stands in for the sentence",
  );
});

test("the Explain modal wires an Add to Vocab action into its footer", () => {
  assert.match(source, /<div class="explain-modal-footer" id="explainFooter">/);
  assert.match(
    source,
    /contentDiv\.innerHTML = renderExplanationBody\(result\);[\s\S]{0,120}?setupAddToVocabButton\(selectedText, result\);/,
    "the button must be wired in right after a successful explanation renders",
  );
  assert.match(
    source,
    /function setupAddToVocabButton\([\s\S]*?if \(!footer \|\| !isVocabCandidate\(selectedText\)\) return;/,
    "sentence selections must not get the button",
  );
  assert.match(
    source,
    /function setupAddToVocabButton\([\s\S]*?normalizeVocabItem\(\s*\{ word, chinese: result\?\.chinese \|\| "", sentence \}/,
    "the card must reuse normalizeVocabItem for timestamp resolution",
  );
  assert.match(
    source,
    /function setupAddToVocabButton\([\s\S]*?Already in Vocab/,
    "an existing word must not be added twice",
  );
  // Scoped to the function body so a call in some other function cannot
  // stand in for the one this feature needs.
  const setupBody = source.match(
    /function setupAddToVocabButton\([\s\S]*?\n\}\n/,
  )?.[0];
  assert.ok(setupBody, "setupAddToVocabButton must exist");
  assert.match(
    setupBody,
    /updateVocabList\(currentVocabItems\)[\s\S]*?saveSessionState\(\)/,
    "the new card must render and persist",
  );
});
