// Printable vocabulary cards.
//
// Opened in a tab by the side panel with ?key=<session-storage-key>. The panel
// writes the word list into chrome.storage.session first so nothing large has
// to travel through the URL. The left half hides the meaning (recall drill),
// the right half hides the word (dictation drill).
//
// Both halves live in ONE table row per word rather than two side-by-side
// tables, because a word's meaning cell can be four lines tall while its word
// cell is one: separate tables would let row 7 sit at a different height on
// each side, and the two halves must stay readable as a single numbered list.

// A sheet is filled by estimated printed height, not by a fixed row count: a
// word with four senses is four lines tall while most are one, so counting rows
// alone either overflows the page or leaves most of it blank. The figures are
// millimetres measured from a rendered A4 sheet at the styles below — padding
// and the header row are already subtracted from the body budget, and it is
// left slightly short so a font substitution cannot push a row over the edge.
const SHEET_BODY_MM = 236;
const ROW_BASE_MM = 5.1;
const MEANING_LINE_MM = 4.9;
// Pure safety net: with the budget above this is never the binding limit.
const MAX_ROWS_PER_SHEET = 30;

// A sense too long for the meaning column wraps, so it prints as two lines
// while `senses` still counts it as one. The column is 28.5% of the 187mm
// print content width less its cell padding; a full-width CJK glyph at
// 11.5px is about 3.04mm, and Latin letters average a little over half that.
const MEANING_CHARS_PER_LINE = 15;
const LATIN_CHAR_WEIGHT = 0.55;

// Printable area of one A4 page, matching the @page rule in vocab-cards.html.
const PAGE_HEIGHT_MM = 297;
const PAGE_MARGIN_MM = 11.5;
// Absorbs sub-pixel rounding between our measurement and the print layout.
const PAGE_SAFETY_MM = 5;

// Inline so the saved standalone file stays self-contained and the print
// stylesheet never waits on a network request.
const CALENDAR_ICON = `<svg class="cal" viewBox="0 0 16 16" aria-hidden="true">
  <rect x="1.5" y="3" width="13" height="11.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/>
  <path d="M1.5 6.5h13" stroke="currentColor" stroke-width="1.2"/>
  <path d="M5 1.5v2.5M11 1.5v2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
</svg>`;

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

function sanitizeFilename(str) {
  return (str || "untitled")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .substring(0, 50)
    .toLowerCase();
}

/**
 * How many printed lines one sense occupies. CJK glyphs are full-width and
 * Latin ones roughly half, so the two are weighted rather than counted alike.
 */
const FULL_WIDTH_CHAR = /[　-〿㐀-鿿＀-￯]/;

function senseLineCount(text) {
  let width = 0;
  for (const char of String(text)) {
    width += FULL_WIDTH_CHAR.test(char) ? 1 : LATIN_CHAR_WEIGHT;
  }
  return Math.max(1, Math.ceil(width / MEANING_CHARS_PER_LINE));
}

/** Estimated printed height of one word's row, in millimetres. */
function rowHeightMm(item) {
  const senses = meaningLines(item);
  const lines = senses.reduce((total, line) => total + senseLineCount(line), 0);
  return ROW_BASE_MM + Math.max(1, lines) * MEANING_LINE_MM;
}

/**
 * Groups words into sheets that each fill about one page. A word too tall for
 * an empty sheet still gets its own sheet rather than being dropped.
 */
function paginate(items, options = {}) {
  const costOf = options.costOf || rowHeightMm;
  const budget = options.budget > 0 ? options.budget : SHEET_BODY_MM;
  const pages = [];
  let page = [];
  let used = 0;
  for (const item of items) {
    const cost = costOf(item);
    if (page.length && (used + cost > budget || page.length >= MAX_ROWS_PER_SHEET)) {
      pages.push(page);
      page = [];
      used = 0;
    }
    page.push(item);
    used += cost;
  }
  if (page.length) pages.push(page);
  return pages;
}

/**
 * One printed line per part of speech. The side panel now sends `senses`, an
 * already-split array of dictionary entries. Older payloads (and any word whose
 * dictionary lookup failed) carry only the single contextual gloss in `chinese`,
 * which is split on part-of-speech markers if it happens to contain them.
 */
function meaningLines(item) {
  if (Array.isArray(item?.senses) && item.senses.length) {
    return item.senses.map((line) => String(line).trim()).filter(Boolean);
  }
  const text = (item?.chinese || "").trim();
  if (!text) return [];
  const parts = text
    .split(/\s*(?=(?:n|v|vt|vi|adj|adv|prep|conj|pron|int|num|art|abbr)\.\s*(?:\s*(?:n|v|vt|vi|adj|adv)\.)*\s)/i)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts : [text];
}

/**
 * One row spanning both halves: word-only on the left for recall, meaning-only
 * on the right for dictation. The number is repeated on each half so a folded
 * or cut sheet still reads correctly.
 */
function renderRow(item, number) {
  const meaning = meaningLines(item)
    .map((line) => `<div class="meaning-line">${escapeHtml(line)}</div>`)
    .join("");
  return `
    <tr>
      <td class="c-idx">${number}</td>
      <td class="c-word">${escapeHtml(item.word)}</td>
      <td class="c-meaning"></td>
      <td class="c-check"><span class="box"></span></td>
      <td class="c-idx half-2">${number}</td>
      <td class="c-word"></td>
      <td class="c-meaning">${meaning}</td>
      <td class="c-check"><span class="box"></span></td>
    </tr>`;
}

function renderGrid(rows, startIndex) {
  const body = rows
    .map((item, i) => renderRow(item, startIndex + i + 1))
    .join("");
  return `
    <table class="grid">
      <thead>
        <tr>
          <th class="c-idx"></th>
          <th class="c-word">Word</th>
          <th class="c-meaning">Meaning</th>
          <th class="c-check"></th>
          <th class="c-idx half-2"></th>
          <th class="c-word">Word</th>
          <th class="c-meaning">Meaning</th>
          <th class="c-check"></th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>`;
}

/**
 * Millimetres per CSS pixel, read from the document instead of assuming 96dpi.
 */
function mmPerPx(doc) {
  const probe = doc.createElement("div");
  probe.style.cssText =
    "position:absolute;visibility:hidden;height:100mm;width:0;padding:0;border:0;";
  doc.body.appendChild(probe);
  const px = probe.getBoundingClientRect().height;
  probe.remove();
  return px > 0 ? 100 / px : 0;
}

const samePagination = (a, b) =>
  a.length === b.length && a.every((page, i) => page.length === b[i].length);

/**
 * Re-paginates using the heights the browser actually produced.
 *
 * The estimate in rowHeightMm cannot know the real wrap points, and when a sheet
 * ends up taller than one physical page the `page-break-after: always` on
 * `.sheet` pushes only the overflow onto the next page — printing one orphan row
 * followed by most of a page of white space. Measuring the rendered rows and
 * splitting against the true printable height removes that case; the estimate
 * stays as the first pass so the common path renders once.
 */
function repaginateFromMeasurements(container, items, estimated, renderPages) {
  const doc = container.ownerDocument;
  const scale = mmPerPx(doc);
  if (!scale) return null;

  const heightMm = (el) => (el ? el.getBoundingClientRect().height * scale : 0);

  const rows = Array.from(container.querySelectorAll(".grid tbody tr"));
  if (rows.length !== items.length) return null;

  // Rows measure the same on screen as in print: the table is 186mm wide inside
  // the screen sheet's padding, and 186mm inside the print page's content area.
  // The sheet element itself does not — `min-height: 297mm` and its 14mm
  // vertical padding are both dropped under @media print — so the page budget is
  // derived from the @page rule rather than read off the rendered sheet.
  const measured = new Map();
  rows.forEach((row, i) => measured.set(items[i], heightMm(row)));

  const overhead = Array.from(container.querySelectorAll(".sheet")).reduce(
    (worst, sheet) =>
      Math.max(
        worst,
        heightMm(sheet.querySelector(".sheet-head")) +
          heightMm(sheet.querySelector(".grid thead")),
      ),
    0,
  );

  const budget =
    PAGE_HEIGHT_MM - PAGE_MARGIN_MM * 2 - PAGE_SAFETY_MM - overhead;
  if (budget <= 0) return null;

  const pages = paginate(items, {
    budget,
    costOf: (item) => measured.get(item) ?? rowHeightMm(item),
  });
  if (samePagination(pages, estimated)) return null;
  renderPages(pages);
  return pages;
}

function renderSheets(container, { title, items, exportDate }) {
  const renderPages = (pages) =>
    renderPageSections(container, pages, { title, items, exportDate });
  const estimated = paginate(items);
  renderPages(estimated);
  repaginateFromMeasurements(container, items, estimated, renderPages);
}

function renderPageSections(container, pages, { title, items, exportDate }) {
  let startIndex = 0;
  container.innerHTML = pages
    .map((rows) => {
      const from = startIndex;
      startIndex += rows.length;
      return `
        <section class="sheet">
          <div class="sheet-head">
            <div class="sheet-head-left">
              <div class="sheet-title">${escapeHtml(title)}</div>
              <div class="sheet-date">
                ${CALENDAR_ICON}<span class="sheet-blank"></span>
              </div>
            </div>
            <div class="sheet-head-right">
              <span class="sheet-tag">纸上默写，耳边复习</span>
              <span class="sheet-meta">
                ${escapeHtml(exportDate)} · ${from + 1}–${from + rows.length} / ${items.length}
              </span>
            </div>
          </div>
          ${renderGrid(rows, from)}
        </section>`;
    })
    .join("");
}

/** Subfolder under the browser's download directory that collects the cards. */
const DOWNLOAD_SUBFOLDER = "vocabulary";

/**
 * Saves what is on screen as a standalone file: same markup, toolbar removed.
 *
 * chrome.downloads places the file in DOWNLOAD_SUBFOLDER; its filename is
 * resolved against the browser's own download directory and cannot escape it,
 * so the folder's parent follows Chrome's "Location" setting rather than
 * anything we choose here. Without the downloads permission (or in a plain tab)
 * we fall back to an anchor, which lands the file unfoldered.
 */
async function downloadStandalone(title) {
  const clone = document.documentElement.cloneNode(true);
  clone.querySelector("#toolbar")?.remove();
  clone.querySelectorAll("script").forEach((node) => node.remove());
  const html = `<!doctype html>\n${clone.outerHTML}`;
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const name = `${sanitizeFilename(title)}-vocab-cards.html`;

  try {
    if (globalThis.chrome?.downloads?.download) {
      await globalThis.chrome.downloads.download({
        url,
        filename: `${DOWNLOAD_SUBFOLDER}/${name}`,
        saveAs: false,
      });
      return;
    }
  } catch {
    // Fall through to the anchor path below.
  }

  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Opens the print dialog once layout has settled, so "Export cards" in the
 * panel leads straight to Save as PDF. Waiting on document.fonts matters: a
 * dialog opened before the CJK face is ready measures the fallback font and
 * can push a row onto the next page.
 */
async function autoPrint() {
  try {
    await document.fonts?.ready;
  } catch {
    // Font loading is best-effort; print with whatever is ready.
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  window.print();
}

async function init() {
  const sheets = document.getElementById("sheets");
  const params = new URLSearchParams(location.search);
  const key = params.get("key");

  let payload = null;
  if (key) {
    try {
      const result = await chrome.storage.session.get(key);
      payload = result[key] || null;
      await chrome.storage.session.remove(key);
    } catch (err) {
      console.warn("[YouTube Digest] Card payload load failed:", err.message);
    }
  }

  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (!items.length) {
    sheets.innerHTML =
      '<div class="empty">没有可导出的单词。请先在侧边栏提取单词，然后重新导出。</div>';
    document.getElementById("printBtn").disabled = true;
    document.getElementById("downloadBtn").disabled = true;
    return;
  }

  const title = payload.title || "Vocabulary Cards";
  const exportDate = payload.exportDate || "";

  document.title = `${title} · Vocabulary Cards`;
  document.getElementById("toolbarTitle").textContent = title;
  renderSheets(sheets, { title, items, exportDate });
  document.getElementById("toolbarHint").textContent =
    `${items.length} 词 · ${sheets.querySelectorAll(".sheet").length} 页`;

  document.getElementById("printBtn").addEventListener("click", () => window.print());
  document
    .getElementById("downloadBtn")
    .addEventListener("click", () => downloadStandalone(title));

  if (params.get("print") === "1") await autoPrint();
}

// Exported for tests; also lets the page be loaded in a DOM-less sandbox.
globalThis.__YTD_VOCAB_CARDS_TESTING__ = {
  meaningLines,
  paginate,
  rowHeightMm,
  renderRow,
  renderSheets,
  repaginateFromMeasurements,
  sanitizeFilename,
  SHEET_BODY_MM,
  MAX_ROWS_PER_SHEET,
  PAGE_HEIGHT_MM,
  PAGE_MARGIN_MM,
  PAGE_SAFETY_MM,
  downloadStandalone,
  DOWNLOAD_SUBFOLDER,
};

// The card page always has #sheets; a test sandbox does not, and must not run
// the loader.
if (document.getElementById("sheets")) init();
