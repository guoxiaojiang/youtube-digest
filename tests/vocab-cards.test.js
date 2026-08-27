const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/** Minimal DOM stand-in: enough for escapeHtml, and no #sheets so init() stays off. */
function loadCardHelpers() {
  const sandbox = {
    console,
    document: {
      getElementById: () => null,
      createElement: () => {
        let value = "";
        return {
          set textContent(text) {
            value = String(text);
          },
          get innerHTML() {
            return value
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;");
          },
        };
      },
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("vocab-cards.js"), sandbox);
  return sandbox.__YTD_VOCAB_CARDS_TESTING__;
}

/**
 * Loads the card helpers with enough of a page to run downloadStandalone.
 * `downloads` is the chrome.downloads stub; pass null to drop the API entirely
 * and exercise the anchor fallback.
 */
function loadDownloadHelpers({ downloads } = {}) {
  const anchors = [];
  const element = () => ({
    cloneNode: () => element(),
    querySelector: () => null,
    querySelectorAll: () => [],
    outerHTML: "<html></html>",
  });
  const sandbox = {
    console,
    Blob: class {
      constructor(parts, options) {
        this.parts = parts;
        this.type = options?.type;
      }
    },
    URL: { createObjectURL: () => "blob:cards", revokeObjectURL() {} },
    document: {
      documentElement: element(),
      getElementById: () => null,
      createElement: () => {
        const a = { click() {} };
        anchors.push(a);
        return a;
      },
    },
  };
  if (downloads) sandbox.chrome = { downloads };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("vocab-cards.js"), sandbox);
  return { helpers: sandbox.__YTD_VOCAB_CARDS_TESTING__, anchors };
}

function loadSidepanelHelpers({
  fetchImpl = () => Promise.reject(new Error("no fetch")),
  localStore = {},
  settings = { aiApiKey: "test-key", aiModel: "test-model" },
} = {}) {
  const listeners = { addListener() {} };
  const sandbox = {
    console,
    URL,
    TextDecoder,
    TextEncoder,
    fetch: fetchImpl,
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
      storage: {
        local: {
          get: async (key) => (key in localStore ? { [key]: localStore[key] } : {}),
          set: async (entries) => Object.assign(localStore, entries),
        },
      },
    },
    YTD_SETTINGS: {
      STORAGE_KEY: "ytd_settings",
      normalize: () => settings,
      chatCompletionsUrl: () => "https://provider.test/chat/completions",
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read("sidepanel.js"), sandbox);
  return { helpers: sandbox.__YTD_TRANSCRIPT_TESTING__, localStore };
}

/** Provider reply shaped like the real chat-completions response. */
const glossReply = (items) => ({
  ok: true,
  json: async () => ({
    choices: [{ message: { content: JSON.stringify({ items }) } }],
  }),
});

const single = (word) => ({ word, senses: ["n. 测试"] });

/**
 * Arrays built inside the vm sandbox carry that realm's Array prototype, which
 * strict deepEqual treats as a different type. Copy into a host array first.
 */
const host = (value) => Array.from(value);

test("card meaning lines prefer the dictionary senses array", () => {
  const { meaningLines } = loadCardHelpers();
  assert.deepEqual(
    host(
      meaningLines({
        word: "mustard",
        chinese: "芥末",
        senses: ["n. 芥末酱；芥菜", "adj. 芥末黄的，褐黄色的"],
      }),
    ),
    ["n. 芥末酱；芥菜", "adj. 芥末黄的，褐黄色的"],
  );
});

test("card meaning lines fall back to the contextual gloss when senses are missing", () => {
  const { meaningLines } = loadCardHelpers();
  assert.deepEqual(host(meaningLines({ word: "bush", chinese: "灌木", senses: [] })), ["灌木"]);
  assert.deepEqual(host(meaningLines({ word: "bush", chinese: "灌木" })), ["灌木"]);
  assert.deepEqual(host(meaningLines({ word: "bush", chinese: "" })), []);
});

test("card meaning lines split a legacy gloss that carries part-of-speech markers", () => {
  const { meaningLines } = loadCardHelpers();
  assert.deepEqual(
    host(meaningLines({ word: "witness", chinese: "n. 目击者；证人 vt. 目击，目睹" })),
    ["n. 目击者；证人", "vt. 目击，目睹"],
  );
});

test("sheets are packed by estimated height, not by row count", () => {
  const { paginate, rowHeightMm, SHEET_BODY_MM } = loadCardHelpers();

  // Single-line rows: a sheet takes as many as the height budget allows.
  const short = Array.from({ length: 60 }, (_, i) => single(`w${i}`));
  const shortPages = host(paginate(short));
  for (const page of shortPages) {
    const used = page.reduce((sum, item) => sum + rowHeightMm(item), 0);
    assert.ok(used <= SHEET_BODY_MM, `sheet over budget: ${used}mm`);
  }

  // Four-sense rows are far taller, so the same budget fits noticeably fewer.
  const tall = Array.from({ length: 60 }, (_, i) => ({
    word: `t${i}`,
    senses: ["n. 一", "v. 二", "adj. 三", "adv. 四"],
  }));
  const tallPages = host(paginate(tall));
  assert.ok(
    tallPages[0].length < shortPages[0].length,
    "a sheet of four-line rows must hold fewer words than a sheet of one-line rows",
  );
  for (const page of tallPages) {
    const used = page.reduce((sum, item) => sum + rowHeightMm(item), 0);
    assert.ok(used <= SHEET_BODY_MM, `sheet over budget: ${used}mm`);
  }
});

test("pagination keeps every word and preserves order", () => {
  const { paginate } = loadCardHelpers();
  const items = Array.from({ length: 47 }, (_, i) => single(`w${i}`));
  const flattened = host(paginate(items)).flatMap((page) => host(page));
  assert.equal(flattened.length, items.length);
  assert.deepEqual(
    flattened.map((item) => item.word),
    items.map((item) => item.word),
  );
});

test("a word taller than an empty sheet still gets its own sheet", () => {
  const { paginate } = loadCardHelpers();
  const monster = {
    word: "monster",
    senses: Array.from({ length: 200 }, (_, i) => `n. 义项${i}`),
  };
  const pages = host(paginate([single("before"), monster, single("after")]));
  assert.equal(pages.flatMap((page) => host(page)).length, 3);
  assert.ok(pages.some((page) => host(page).includes(monster)));
});

test("a printed row repeats the number on both halves and splits word from meaning", () => {
  const { renderRow } = loadCardHelpers();
  const html = renderRow({ word: "clue", senses: ["n. 线索"] }, 7);
  // One row, so the two halves can never drift vertically apart.
  assert.equal(html.match(/<tr>/g).length, 1);
  assert.equal(html.match(/class="c-idx[^"]*">7</g).length, 2);
  // Recall half shows the word with an empty meaning; dictation half is the reverse.
  assert.match(html, /<td class="c-word">clue<\/td>\s*<td class="c-meaning"><\/td>/);
  assert.match(html, /<td class="c-word"><\/td>/);
  assert.match(html, /n\. 线索/);
  // The divider hangs off the second half's first column.
  assert.equal(html.match(/half-2/g).length, 1);
});

test("card rendering escapes word and meaning text", () => {
  const { renderRow } = loadCardHelpers();
  const html = renderRow(
    { word: "<img src=x onerror=alert(1)>", senses: ["n. <script>bad</script>"] },
    1,
  );
  assert.ok(!html.includes("<img"), "word markup must be escaped");
  assert.ok(!html.includes("<script>"), "meaning markup must be escaped");
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
});

test("gloss lines normalize the part-of-speech prefix and drop trailing separators", () => {
  const { helpers: { normalizeGlossLine } } = loadSidepanelHelpers();
  assert.equal(normalizeGlossLine("n.灌木；丛林地带"), "n. 灌木；丛林地带");
  assert.equal(normalizeGlossLine("  vt.   抢救，营救；  "), "vt. 抢救，营救");
  assert.equal(normalizeGlossLine("vt.vi. 刺入，插入"), "vt. vi. 刺入，插入");
  assert.equal(normalizeGlossLine("adj. 奇异的；"), "adj. 奇异的");
  assert.equal(normalizeGlossLine(""), "");
  assert.equal(normalizeGlossLine(null), "");
});

test("gloss lines keep a gloss that arrived without a part-of-speech marker", () => {
  const { helpers: { normalizeGlossLine } } = loadSidepanelHelpers();
  assert.equal(normalizeGlossLine("灌木；丛林地带"), "灌木；丛林地带");
});

test("gloss senses drop duplicates, blanks, and anything past the printable cap", () => {
  const { helpers: { normalizeGlossSenses } } = loadSidepanelHelpers();
  assert.deepEqual(
    host(normalizeGlossSenses(["n. 一", "", "  ", "n. 一", "v. 二"])),
    ["n. 一", "v. 二"],
  );
  assert.equal(
    normalizeGlossSenses(["n. 一", "v. 二", "adj. 三", "adv. 四", "prep. 五"]).length,
    4,
  );
  assert.deepEqual(host(normalizeGlossSenses("not an array")), []);
  assert.deepEqual(host(normalizeGlossSenses(undefined)), []);
});

test("a single gloss line cannot grow long enough to overflow its printed cell", () => {
  const { helpers: { normalizeGlossSenses } } = loadSidepanelHelpers();
  const [line] = normalizeGlossSenses([`n. ${"很".repeat(300)}`]);
  assert.ok(line.length <= 60, `line too long: ${line.length}`);
});

test("a dictionary batch turns a provider reply into printable sense lines", async () => {
  const requests = [];
  const { helpers } = loadSidepanelHelpers({
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return glossReply([
        { word: "bush", senses: ["n.灌木；丛林地带"] },
        { word: "mustard", senses: ["n. 芥末酱；芥菜", "adj. 芥末黄的"] },
        { word: "ignored", senses: [] },
      ]);
    },
  });

  const glosses = await helpers.fetchGlossBatch(["bush", "mustard"], {
    aiApiKey: "test-key",
    aiModel: "test-model",
  });

  assert.equal(requests.length, 1);
  assert.match(requests[0].body.messages[0].content, /bush\nmustard/);
  // Prefix normalization happens on the way in, so the printed column aligns.
  assert.deepEqual(host(glosses.get("bush")), ["n. 灌木；丛林地带"]);
  assert.deepEqual(host(glosses.get("mustard")), ["n. 芥末酱；芥菜", "adj. 芥末黄的"]);
  // A word with no usable senses is absent, letting the caller fall back.
  assert.equal(glosses.has("ignored"), false);
});

test("a failed batch keeps the contextual gloss so every word still prints", async () => {
  const { helpers } = loadSidepanelHelpers({
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => "boom" }),
  });

  const cards = host(
    await helpers.buildVocabCardItems([
      { word: "bush", chinese: "灌木" },
      { word: "clue", chinese: "线索" },
    ]),
  );

  assert.deepEqual(
    cards.map((card) => [card.word, card.chinese, host(card.senses).length]),
    [
      ["bush", "灌木", 0],
      ["clue", "线索", 0],
    ],
  );
});

test("dictionary senses are cached across exports and looked up only once", async () => {
  let calls = 0;
  const localStore = {};
  const first = loadSidepanelHelpers({
    localStore,
    fetchImpl: async () => {
      calls += 1;
      return glossReply([{ word: "bush", senses: ["n. 灌木"] }]);
    },
  });

  const cards = host(await first.helpers.buildVocabCardItems([{ word: "bush", chinese: "灌木" }]));
  assert.deepEqual(host(cards[0].senses), ["n. 灌木"]);
  assert.equal(calls, 1);

  // A second export over the same word reuses the stored gloss.
  const second = loadSidepanelHelpers({
    localStore,
    fetchImpl: async () => {
      calls += 1;
      return glossReply([]);
    },
  });
  const again = host(
    await second.helpers.buildVocabCardItems([{ word: "Bush", chinese: "灌木" }]),
  );
  assert.equal(calls, 1, "a cached word must not trigger another lookup");
  assert.deepEqual(host(again[0].senses), ["n. 灌木"]);
});

test("export works with no API key configured, falling back to contextual glosses", async () => {
  let called = false;
  const { helpers } = loadSidepanelHelpers({
    settings: { aiApiKey: "", aiModel: "test-model" },
    fetchImpl: async () => {
      called = true;
      return glossReply([]);
    },
  });

  const cards = host(await helpers.buildVocabCardItems([{ word: "bush", chinese: "灌木" }]));
  assert.equal(called, false, "no key means no provider request");
  assert.equal(cards[0].chinese, "灌木");
  assert.deepEqual(host(cards[0].senses), []);
});

test("a downloaded sheet lands in the vocabulary subfolder", async () => {
  const calls = [];
  const { helpers, anchors } = loadDownloadHelpers({
    downloads: { download: (options) => (calls.push(options), Promise.resolve(7)) },
  });

  await helpers.downloadStandalone("Economics of Generative AI");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].filename, "vocabulary/economics-of-generative-ai-vocab-cards.html");
  assert.equal(calls[0].saveAs, false);
  assert.equal(anchors.length, 0, "the anchor fallback must stay unused when the API works");
});

test("a download falls back to an anchor when the downloads API is unavailable", async () => {
  const { helpers, anchors } = loadDownloadHelpers({ downloads: null });

  await helpers.downloadStandalone("Deck");

  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].download, "deck-vocab-cards.html");
});

test("a rejected download still falls back rather than losing the file", async () => {
  const { helpers, anchors } = loadDownloadHelpers({
    downloads: { download: () => Promise.reject(new Error("denied")) },
  });

  await helpers.downloadStandalone("Deck");

  assert.equal(anchors.length, 1, "a rejected chrome.downloads call must reach the anchor path");
});
