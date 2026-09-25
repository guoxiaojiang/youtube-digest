/**
 * SIDE PANEL LOGIC
 *
 * Handles the UI for YouTube Digest: video detection, transcript analysis,
 * rendering results, and export features.
 */

const DEBUG = false;
const debugLog = (...args) => {
  if (DEBUG) console.log(...args);
};

// ============================================================
// STATE
// ============================================================

let currentVideoId = null;
let currentVideoUrl = null;
// The tab ID that "owns" the current learning session. Used to scope
// session storage so two tabs showing the same video stay isolated.
let currentOwnerTabId = null;
let currentAnalysis = null;
let currentTranscript = null;
let currentTranscriptText = null; // Plain text (for display/export)
let currentTranscriptTimestamped = null; // With timestamps for AI analysis
let currentTranscriptLanguage = null;
let currentVideoTitle = "";
let currentChannelName = "";
let currentVideoDescription = "";
let currentVideoDuration = 0;
let isAnalysisLoading = false; // Track if analysis is in progress
let youtubeTabId = null; // Store the YouTube tab ID for reliable messaging
let errorAction = null;

// --- Vocabulary state ---
let currentVocabItems = null;
let isVocabLoading = false;
let explainRequestId = null; // Discards deltas from a superseded Explain request.

// --- Translation state ---
// The public transcript control intentionally supports only the original
// subtitles, Chinese, and an aligned source + Chinese view.
let currentTranscriptMode = "original";
let translationGeneration = 0; // Invalidates responses from older UI modes/videos.
let translationWorkCount = 0;
let transcriptScrollObserver = null;
// Stable keys include the video, source mode, language, and semantic segment ID.
let transcriptParagraphCache = new Map();
const TRANSLATION_MESSAGE_TIMEOUT_MS = 130_000;

/**
 * Prevent a stopped service worker or dead message channel from leaving the
 * transcript queue stuck forever. The underlying Chrome message cannot be
 * cancelled, so settled guards deliberately ignore any late response.
 */
function sendTranslationMessage(message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutId;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      callback(value);
    };

    timeoutId = setTimeout(() => {
      finish(
        reject,
        new Error(
          "Translation request timed out after 130 seconds. Please Retry.",
        ),
      );
    }, TRANSLATION_MESSAGE_TIMEOUT_MS);

    let messagePromise;
    try {
      messagePromise = chrome.runtime.sendMessage(message);
    } catch (error) {
      finish(reject, error);
      return;
    }

    Promise.resolve(messagePromise).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error),
    );
  });
}

// --- Auto-scroll state (follow video playback in transcript) ---
let autoScrollEnabled = true; // True = scroll transcript to follow video playback
let jumpNextHighlightWithoutAnimation = false; // Set when transcript re-renders (tab switch, cache reload) so the first highlight jumps to the current line instantly, no smooth animation.
let autoScrollInterval = null; // setInterval ID for polling video time
let anchorSettleUntil = 0; // Timestamp until which our own smooth scroll is still animating
let userScrollListenersBound = false; // Guards one-time binding of the user-intent listeners

// Auto-scroll is only released by real user input (wheel, touch drag, scroll
// keys, scrollbar drag) — never by scroll events, because our own smooth
// scrolling emits those too and a long animation outlives any time window.
const SCROLL_INTENT_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

// How far the spoken line may drift from the middle before we re-center it,
// and how long a smooth re-center is given to land before the next attempt.
const ANCHOR_TOLERANCE_PX = 56;
const ANCHOR_SETTLE_MS = 700;

// Last playback position reported by the YouTube tab. Translation uses this to
// start where the viewer actually is instead of at the top of the video.
let lastKnownPlaybackSeconds = 0;

// Translation window around the playback position: a couple of segments behind
// for context, and a longer run ahead since that is where playback is heading.
const TRANSLATION_LOOKBEHIND_SEGMENTS = 2;
const TRANSLATION_LOOKAHEAD_SEGMENTS = 6;

// ============================================================
// TRANSCRIPT GROUPING
// ============================================================

const TRANSCRIPT_SEGMENT_LIMITS = Object.freeze({
  minChars: 60,
  idealChars: 180,
  maxChars: 320,
  maxSeconds: 20,
});

function normalizeCaptionText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, "$1$2")
    .replace(/([，。；：！？])\s+(?=[\u3400-\u9fff])/g, "$1")
    .replace(/\s+([,.;:!?，。；：！？])/g, "$1")
    .trim();
}

/**
 * Splits a single oversized thought at the strongest nearby punctuation.
 * Word boundaries are the final safety valve for captions with no punctuation.
 */
function splitOversizedThought(text, maxChars) {
  const parts = [];
  let rest = normalizeCaptionText(text);

  while (rest.length > maxChars) {
    const windowText = rest.slice(0, maxChars + 1);
    const lowerBound = Math.floor(maxChars * 0.55);
    let cut = -1;

    for (const pattern of [/[;:；：]\s*/g, /[,，]\s*/g, /\s/g]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(windowText))) {
        if (match.index >= lowerBound) cut = match.index + match[0].length;
      }
      if (cut > 0) break;
    }

    if (cut <= 0) cut = maxChars;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) parts.push(rest);
  return parts;
}

/**
 * Reconstructs complete sentences across raw caption boundaries. Each segment
 * keeps the timestamp of the first caption that contributed text. Character
 * and time limits prevent a malformed Supadata entry from becoming one giant
 * row while punctuation remains the preferred boundary.
 */
function groupTranscriptEntries(entries, limits = TRANSCRIPT_SEGMENT_LIMITS) {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  const pieces = [];
  entries.forEach((entry, entryIndex) => {
    const text = normalizeCaptionText(entry?.text);
    if (!text) return;
    const start = Number.isFinite(Number(entry.start)) ? Number(entry.start) : 0;
    const duration = Math.max(0, Number(entry.duration) || 0);
    const sentenceParts =
      text.match(/[^.!?;:,。！？；：，]+(?:[.!?;:,。！？；：，]+["')\]”’）】」』]*|$)/g) ||
      [text];
    let consumedChars = 0;

    sentenceParts.forEach((sentencePart) => {
      const cleanPart = normalizeCaptionText(sentencePart);
      if (!cleanPart) return;
      const oversizedParts = splitOversizedThought(cleanPart, limits.maxChars);
      oversizedParts.forEach((part, partIndex) => {
        const ratio = text.length ? Math.min(1, consumedChars / text.length) : 0;
        pieces.push({
          text: part,
          start: start + duration * ratio,
          semanticEnd:
            /[.!?。！？]["')\]”’）】」』]*$/.test(part) ||
            oversizedParts.length > 1,
          clauseEnd: /[;:,；：，]["')\]”’）】」』]*$/.test(part),
          sourceOrder: `${entryIndex}:${partIndex}`,
        });
        consumedChars += part.length + 1;
      });
    });
  });

  const grouped = [];
  let current = null;

  const flush = () => {
    if (!current || !current.text.trim()) return;
    const index = grouped.length;
    const text = normalizeCaptionText(current.text);
    grouped.push({
      id: `segment-${index}-${Math.round(current.start * 1000)}`,
      start: current.start,
      text,
      texts: [text],
    });
    current = null;
  };

  pieces.forEach((piece) => {
    if (!current) current = { start: piece.start, text: "" };
    current.text = normalizeCaptionText(`${current.text} ${piece.text}`);
    const elapsed = Math.max(0, piece.start - current.start);
    const comfortablySized = current.text.length >= limits.minChars;
    const reachedIdeal = current.text.length >= limits.idealChars;
    const atNaturalBoundary =
      piece.semanticEnd ||
      (piece.clauseEnd &&
        (reachedIdeal ||
          current.text.length >= limits.maxChars ||
          elapsed >= limits.maxSeconds));
    const reachedGuardrail =
      atNaturalBoundary &&
      (current.text.length >= limits.maxChars || elapsed >= limits.maxSeconds);
    const reachedHardGuardrail =
      current.text.length >= Math.round(limits.maxChars * 1.2) ||
      elapsed >= limits.maxSeconds + 5;

    if (
      (atNaturalBoundary && (comfortablySized || elapsed >= 8)) ||
      (atNaturalBoundary && reachedIdeal) ||
      reachedGuardrail ||
      reachedHardGuardrail
    ) {
      flush();
    }
  });
  flush();

  return grouped;
}

// ============================================================
// INITIALIZATION
// ============================================================

document.addEventListener("DOMContentLoaded", async () => {
  setupEventListeners();
  await evictOldCacheEntries(20);

  const configStatus = await chrome.runtime.sendMessage({
    action: "checkConfig",
  });

  if (!configStatus.hasSupadataKey || !configStatus.hasAiKey) {
    showConfigError(configStatus);
    return;
  }

  await checkCurrentTab();
});

// Listen for messages from the Digest button on YouTube page
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "startDigestFromButton") {
    // Load the digest for the current video. Served from cache when we've
    // seen this video before (no API calls); fetched fresh otherwise.
    // (This used to force-clear the cache on every click, which silently
    // burned a transcript credit + analysis tokens per click.)
    // A deliberate Digest-button click is the only path that re-enables
    // auto-scroll — tab activation and URL changes must not force it.
    autoScrollEnabled = true;
    checkCurrentTab();
    sendResponse({ success: true });
  }
  if (message.action === "transcriptProgress") {
    // Background is telling us the transcript fetch status changed
    updateLoading(message.title, message.subtitle);
    sendResponse({ success: true });
  }
  if (message.action === "noteSaved") {
    // Refresh notes list when a new note is saved
    const filterAll = document
      .getElementById("notesFilterAll")
      ?.classList.contains("active");
    loadNotes(filterAll ? null : currentVideoId);
    sendResponse({ success: true });
  }
  return false;
});

// ============================================================
// FOLLOW THE ACTIVE TAB
// ============================================================
// The panel watches which tab is in front of it and reacts:
//   - Front tab is NOT YouTube  -> the panel closes itself (window.close()).
//     We do this OURSELVES rather than relying only on the background
//     script's per-tab enable/disable, because Chrome doesn't reliably
//     apply per-tab panel state to tabs spawned in unusual ways (e.g. a
//     link opened from another app) — which let the panel linger on
//     non-YouTube pages.
//   - Front tab IS YouTube but on a different video -> refresh the digest.
//     YouTube is a single-page app (clicking a video swaps content without
//     a reload), so we track URL changes; startDigest() caches per video,
//     making re-checks instant and free for already-digested videos.
//
// Everything is scoped to the window this panel lives in: tab switches in
// OTHER browser windows must not close this panel or hijack its content.

let navigationRefreshTimer = null;
let panelWindowId = null;
chrome.windows.getCurrent().then((w) => {
  panelWindowId = w.id;
});

function scheduleDigestRefresh() {
  // Small delay lets YouTube finish rendering the new video's title and
  // description before we read them. Also collapses rapid-fire URL events
  // into a single refresh.
  clearTimeout(navigationRefreshTimer);
  navigationRefreshTimer = setTimeout(() => {
    checkCurrentTab();
  }, 600);
}

function panelIsShowingResults() {
  const results = document.getElementById("resultsState");
  return results && results.style.display !== "none";
}

/**
 * Reacts to the URL now in front of the panel: close on non-YouTube,
 * refresh the digest when the video changed.
 */
function handleFrontTabUrl(url) {
  if (!(url || "").startsWith("https://www.youtube.com")) {
    // Panel is a YouTube-only tool — remove itself from non-YouTube tabs.
    window.close();
    return;
  }

  const newVideoId = extractVideoId(url);
  // Refresh when the video changed, or when we're not currently showing
  // results (e.g. user went home, then clicked back into the same video).
  if (newVideoId !== currentVideoId || !panelIsShowingResults()) {
    scheduleDigestRefresh();
  }
}

// Fires when a tab's URL changes — including YouTube's no-reload navigation.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url || !tab.active) return;
  if (panelWindowId !== null && tab.windowId !== panelWindowId) return;
  handleFrontTabUrl(changeInfo.url);
});

// Fires when a different tab comes to the front — switching tabs, or a new
// tab being opened (including ones opened by clicking links in other apps).
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (panelWindowId !== null && windowId !== panelWindowId) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    // Brand-new tabs may not have committed their URL yet — fall back to
    // the pending one so we judge where the tab is actually going.
    handleFrontTabUrl(tab.url || tab.pendingUrl || "");
  } catch (e) {
    // Tab closed before we could read it — nothing to do.
  }
});

function setupEventListeners() {
  // Tab switching
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  // Error retry
  document.getElementById("errorBtn").addEventListener("click", () => {
    if (errorAction) {
      errorAction();
      return;
    }
    if (currentVideoId) {
      startDigest(currentVideoId, currentVideoUrl);
    }
  });

  document.getElementById("settingsBtn")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "openOptions" });
  });

  // Transcript actions
  document
    .getElementById("copyTranscriptBtn")
    ?.addEventListener("click", copyTranscript);
  document
    .getElementById("exportTranscriptBtn")
    ?.addEventListener("click", exportTranscript);
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    button.addEventListener("click", () => {
      handleTranscriptModeChange(button.dataset.transcriptMode);
    });
  });

  // Follow playback button — re-enables auto-scroll after user scrolled away
  document
    .getElementById("followPlaybackBtn")
    ?.addEventListener("click", () => {
      autoScrollEnabled = true;
      syncFollowPlaybackButton();
      // Jump straight back to the line currently being spoken. We scroll
      // directly (not via playbackTrackingTick) because the tick skips
      // entries that are already highlighted — and the current line almost
      // always IS highlighted, which made this button appear to do nothing.
      if (!scrollToActiveEntry()) {
        playbackTrackingTick(); // No highlight yet — let a tick establish one
      }
      // Translation now prioritizes wherever playback is, not the video start.
      requestTranslationAroundPlayback();
    });

  // Notes filter buttons
  document.getElementById("notesFilterThis")?.addEventListener("click", () => {
    setNotesFilter(false);
    loadNotes(currentVideoId);
  });
  document.getElementById("notesFilterAll")?.addEventListener("click", () => {
    setNotesFilter(true);
    loadNotes(null); // Load all notes
  });

  // Vocabulary
  document.getElementById("findVocabBtn")?.addEventListener("click", () => {
    triggerVocabulary();
  });
  document
    .getElementById("exportVocabCardsBtn")
    ?.addEventListener("click", exportVocabCards);
  // Delegated handler for the CTA button that lives inside the vocab list,
  // since the list innerHTML is rebuilt on every state change.
  document.getElementById("vocabList")?.addEventListener("click", (event) => {
    if (event.target?.id === "findVocabCtaBtn") triggerVocabulary();
  });
}

function setNotesFilter(showAll) {
  const thisVideoButton = document.getElementById("notesFilterThis");
  const allNotesButton = document.getElementById("notesFilterAll");
  thisVideoButton?.classList.toggle("active", !showAll);
  thisVideoButton?.setAttribute("aria-pressed", String(!showAll));
  allNotesButton?.classList.toggle("active", showAll);
  allNotesButton?.setAttribute("aria-pressed", String(showAll));
}

// ============================================================
// VIDEO DETECTION
// ============================================================

async function checkCurrentTab() {
  try {
    // Try multiple strategies to find the YouTube tab
    let tab = null;

    // Strategy 1: Active tab in last focused window
    let tabs = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (tabs[0]?.url?.includes("youtube.com")) {
      tab = tabs[0];
    }

    // Strategy 2: Any active YouTube tab
    if (!tab) {
      tabs = await chrome.tabs.query({
        url: "https://www.youtube.com/*",
        active: true,
      });
      if (tabs[0]) tab = tabs[0];
    }

    // Strategy 3: Any YouTube tab (last resort)
    if (!tab) {
      tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
      if (tabs[0]) tab = tabs[0];
    }

    debugLog("[YouTube Digest Panel] Found tab:", tab?.id, tab?.url);

    if (!tab?.url) {
      showState("welcome");
      return;
    }

    // Store the tab ID for reliable messaging later
    youtubeTabId = tab.id;
    currentOwnerTabId = tab.id;

    const videoId = extractVideoId(tab.url);

    if (videoId) {
      currentVideoUrl = tab.url;

      try {
        // Route through background script for reliable message passing
        const result = await chrome.runtime.sendMessage({
          action: "relayToContent",
          payload: { action: "getVideoInfo" },
        });
        debugLog("[YouTube Digest Panel] getVideoInfo result:", result);
        if (result.success && result.response) {
          currentVideoTitle = result.response.title || "";
          currentChannelName = result.response.channelName || "";
          currentVideoDescription = result.response.description || "";
          currentVideoDuration = result.response.duration || 0;
        }
      } catch (e) {
        console.error("[YouTube Digest Panel] getVideoInfo error:", e);
        currentVideoTitle = "";
        currentChannelName = "";
        currentVideoDescription = "";
        currentVideoDuration = 0;
      }

      startDigest(videoId, tab.url);
    } else {
      showState("welcome");
    }
  } catch (error) {
    console.error("Tab check error:", error);
    showState("welcome");
  }
}

function extractVideoId(url) {
  try {
    const urlObj = new URL(url);

    if (
      urlObj.hostname.includes("youtube.com") &&
      urlObj.searchParams.has("v")
    ) {
      return urlObj.searchParams.get("v");
    }

    if (urlObj.hostname === "youtu.be") {
      return urlObj.pathname.slice(1);
    }

    if (urlObj.pathname.startsWith("/embed/")) {
      return urlObj.pathname.split("/")[2];
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================================
// DIGEST PIPELINE
// ============================================================

async function startDigest(videoId, videoUrl) {
  // Check if we already have this video loaded in memory
  if (videoId === currentVideoId && currentAnalysis) {
    showState("results");
    return;
  }

  // Every video change invalidates observer work and in-flight translations.
  if (videoId !== currentVideoId) {
    translationGeneration += 1;
    if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
    transcriptScrollObserver = null;
    // The previous video's position must not seed this one: the seek lands on
    // the last segment starting at or before it, so carrying a large value into
    // a shorter video starts translating at its END instead of where playback
    // actually is. Zero seeds the opening until the first tracking tick lands.
    lastKnownPlaybackSeconds = 0;
  }

  // Check cache for this video
  const cached = await loadFromCache(videoId);
  if (cached) {
    debugLog("Loading from cache:", videoId);
    currentVideoId = videoId;
    currentVideoUrl = videoUrl;
    currentAnalysis = cached.analysis || null;
    currentTranscript = cached.transcript;
    currentTranscriptText = cached.transcriptText;
    currentTranscriptTimestamped = cached.transcriptTimestamped;
    currentTranscriptLanguage = cached.transcriptLanguage || null;
    isAnalysisLoading = false;

    // Restore translations and vocabulary from the tab-scoped session store.
    // This must happen before renderTranscript() so Chinese/bilingual rows
    // display immediately without queuing fresh API calls.
    const session = await loadSessionState(currentOwnerTabId, videoId);
    if (session) {
      // Restore the user's chosen transcript view (original / zh / bilingual)
      // so a side-panel reload after tab/app switching doesn't silently fall
      // back to the original-language default.
      if (["original", "zh", "bilingual"].includes(session.transcriptMode)) {
        currentTranscriptMode = session.transcriptMode;
        setTranscriptModeButtons(session.transcriptMode);
      }
      for (const [key, value] of Object.entries(session.translations || {})) {
        transcriptParagraphCache.set(key, value);
      }
      if (Array.isArray(session.vocabItems) && session.vocabItems.length) {
        currentVocabItems = session.vocabItems;
        const tab = document.getElementById("vocabTab");
        if (tab) tab.textContent = `Vocab (${currentVocabItems.length})`;
        const btn = document.getElementById("findVocabBtn");
        if (btn) btn.textContent = `Re-extract (${currentVocabItems.length})`;
        const status = document.getElementById("vocabStatus");
        if (status) status.textContent = `Done. Extracted ${currentVocabItems.length} words from the full video.`;
        updateVocabList(currentVocabItems);
        updateVocabExportButton();
      }
    }

    if (currentVideoTitle || currentChannelName) {
      const videoInfo = document.getElementById("videoInfo");
      document.getElementById("videoTitle").textContent = currentVideoTitle;
      document.getElementById("videoChannel").textContent = currentChannelName;
      videoInfo.style.display = "block";
    }

    // Always render transcript first. The re-render wipes the previously
    // highlighted row, so the next tick treats the current playback line as
    // "newly highlighted". Set the flag so the resulting jump is INSTANT
    // (no smooth animation) — user should land at the current line but not
    // see a scroll animation on tab switch.
    jumpNextHighlightWithoutAnimation = true;
    renderTranscript();

    // Render analysis if we have it cached
    if (currentAnalysis) {
      renderAnalysisResults(currentAnalysis);
      highlightMomentsOnPage(currentAnalysis.keyMoments);
    }

    showState("results");
    document.getElementById("tabsNav").style.display = "flex";

    // Load notes for this video
    loadNotes(videoId);

    // Setup explain feature
    setupExplainFeature();
    if (currentTranscriptMode !== "original") translateTranscript();
    return;
  }

  currentVideoId = videoId;
  currentVideoUrl = videoUrl;
  currentAnalysis = null;
  currentTranscript = null;
  currentTranscriptText = null;
  currentTranscriptTimestamped = null;
  currentTranscriptLanguage = null;
  isAnalysisLoading = false;
  currentVocabItems = null;
  isVocabLoading = false;
  // Clear any leftover session state from a previous video on this tab.
  clearSessionState(currentOwnerTabId, currentVideoId);
  resetVocabUI();

  if (currentVideoTitle || currentChannelName) {
    const videoInfo = document.getElementById("videoInfo");
    document.getElementById("videoTitle").textContent = currentVideoTitle;
    document.getElementById("videoChannel").textContent = currentChannelName;
    videoInfo.style.display = "block";
  }

  showState("loading");
  updateLoading("Fetching transcript", "");

  const transcriptResult = await chrome.runtime.sendMessage({
    action: "fetchTranscript",
    videoId: videoId,
  });

  if (!transcriptResult.success) {
    if (transcriptResult.error === "NO_SUPADATA_KEY") {
      showError(
        "API key missing",
        "Add your Supadata API key in YouTube Digest Settings.",
      );
      return;
    }
    showError(
      "No transcript found",
      transcriptResult.message || transcriptResult.error,
    );
    return;
  }

  currentTranscript = transcriptResult.transcript;
  currentTranscriptText = transcriptResult.transcriptText;
  currentTranscriptTimestamped = transcriptResult.transcriptTextTimestamped;
  currentTranscriptLanguage = transcriptResult.language || null;

  // Render transcript immediately (no LLM needed)
  renderTranscript();
  showState("results");
  document.getElementById("tabsNav").style.display = "flex";

  // Load notes for this video
  loadNotes(videoId);

  // Setup explain feature for text selection
  setupExplainFeature();
  if (currentTranscriptMode !== "original") translateTranscript();

  // Save transcript to cache (without analysis)
  await saveToCache(videoId);

  // DON'T run LLM analysis automatically - wait for user to click Overview tab
  // This saves tokens when user just wants to see the transcript
}

// ============================================================
// RENDERING
// ============================================================

/**
 * Renders the analysis results into the Overview tab.
 * Shows chapters and key quotes only.
 */
function renderAnalysisResults(analysis) {
  // Chapters
  const chapterList = document.getElementById("chapterList");
  chapterList.innerHTML = "";
  (analysis.chapters || []).forEach((chapter) => {
    const li = document.createElement("li");
    li.className = "chapter-item";
    li.dataset.seconds = chapter.timestampSeconds;
    li.innerHTML = `
      <span class="chapter-timestamp">${escapeHtml(chapter.timestamp)}</span>
      <div class="chapter-content">
        <span class="chapter-title">${escapeHtml(chapter.title)}</span>
        ${chapter.titleZh ? `<span class="chapter-title-zh">${escapeHtml(chapter.titleZh)}</span>` : ""}
        <span class="chapter-summary">${escapeHtml(chapter.summary || "")}</span>
        ${chapter.summaryZh ? `<span class="chapter-summary-zh">${escapeHtml(chapter.summaryZh)}</span>` : ""}
      </div>
    `;
    li.addEventListener("click", () => {
      debugLog(
        "[YouTube Digest Panel] Chapter clicked:",
        chapter.timestamp,
        chapter.timestampSeconds,
      );
      seekTo(chapter.timestampSeconds);
    });
    chapterList.appendChild(li);
  });

  // Quotes - sort by timestamp (chronological order)
  const quotesList = document.getElementById("quotesList");
  quotesList.innerHTML = "";
  const sortedQuotes = [...(analysis.keyQuotes || [])].sort(
    (a, b) => (a.timestampSeconds || 0) - (b.timestampSeconds || 0),
  );
  sortedQuotes.forEach((quote) => {
    const div = document.createElement("div");
    div.className = "quote-item";
    div.dataset.seconds = quote.timestampSeconds;
    div.innerHTML = `
      <div class="quote-text">${escapeHtml(quote.quote)}</div>
      ${quote.quoteZh ? `<div class="quote-text-zh">${escapeHtml(quote.quoteZh)}</div>` : ""}
      <div class="quote-meta">
        <span class="quote-timestamp">${escapeHtml(quote.timestamp)}</span>
        <div class="quote-actions">
          <button class="quote-save-note-btn" title="Save this quote as a note">📝 Note</button>
          <button class="quote-copy-btn" title="Copy this quote">⧉ Copy</button>
        </div>
      </div>
    `;
    div.addEventListener("click", () => {
      debugLog(
        "[YouTube Digest Panel] Quote clicked:",
        quote.timestamp,
        quote.timestampSeconds,
      );
      seekTo(quote.timestampSeconds);
    });

    const quoteCopyBtn = div.querySelector(".quote-copy-btn");
    quoteCopyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(quote.quote);
        quoteCopyBtn.textContent = "✓ Copied";
        setTimeout(() => {
          quoteCopyBtn.textContent = "⧉ Copy";
        }, 1500);
      } catch (err) {
        console.error("Copy failed:", err);
      }
    });

    const quoteSaveNoteBtn = div.querySelector(".quote-save-note-btn");
    quoteSaveNoteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await saveQuoteAsNote(quote, quoteSaveNoteBtn);
    });

    quotesList.appendChild(div);
  });
}

/**
 * Saves a key quote as a timestamped note.
 */
async function saveQuoteAsNote(quote, btn) {
  if (!currentVideoId) return;

  const originalText = btn.textContent;
  btn.textContent = "Saving...";
  btn.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({
      action: "saveNote",
      videoId: currentVideoId,
      timestamp: quote.timestampSeconds,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
    });

    if (result.success) {
      btn.textContent = "✓ Saved";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
      // Refresh notes list if on Notes tab
      loadNotes(currentVideoId);
    } else {
      console.error("[YouTube Digest] Save quote as note failed:", result.error);
      btn.textContent = "Error";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
    }
  } catch (error) {
    console.error("[YouTube Digest] Save quote as note error:", error);
    btn.textContent = "Error";
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 1500);
  }
}

/**
 * Legacy function for backwards compatibility with cached data.
 * Renders both transcript and analysis.
 */
function renderResults(analysis) {
  renderAnalysisResults(analysis);

  renderTranscript();

  document.getElementById("tabsNav").style.display = "flex";

  // Setup explain feature for text selection
  setupExplainFeature();
}

/**
 * Returns true while the user has a range of text selected.
 * Transcript row clicks must not seek in that state: the click emitted after
 * selection mouseup belongs to the selection/explain interaction, not playback.
 */
function hasNonCollapsedTextSelection() {
  const selection = window.getSelection();
  return Boolean(
    selection && selection.rangeCount > 0 && !selection.isCollapsed,
  );
}

/**
 * Preserves normal row-click seeking while keeping text selection inert.
 */
function seekFromTranscriptEntryClick(event, seconds) {
  if (hasNonCollapsedTextSelection()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  seekTo(seconds);
}

function renderTranscript() {
  if (!currentTranscript) return;

  const transcriptList = document.getElementById("transcriptList");
  transcriptList.innerHTML = "";

  // Show a small badge indicating the transcript came from the video's
  // existing subtitles. (We no longer AI-transcribe audio, so subtitles
  // are the only source.)
  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();

  const badge = document.createElement("div");
  badge.id = "transcriptSourceBadge";
  badge.className = "transcript-source-badge";
  badge.innerHTML = `<span class="source-dot source-dot--subs"></span> From video subtitles · ${escapeHtml(getOriginalTranscriptLabel())}`;
  transcriptList.parentElement.insertBefore(badge, transcriptList);

  // Group entries using smart sentence-boundary + time-guardrail logic
  const grouped = groupTranscriptEntries(currentTranscript);

  grouped.forEach((group) => {
    const div = document.createElement("div");
    div.className = "transcript-entry";
    div.dataset.seconds = group.start;

    const minutes = Math.floor(group.start / 60);
    const seconds = Math.floor(group.start % 60);
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

    div.innerHTML = `
      <span class="transcript-time">${timestamp}</span>
      <span class="transcript-text">${renderSubtitleInlineMarkup(group.text)}</span>
    `;

    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, group.start),
    );
    transcriptList.appendChild(div);
  });

  // Start tracking video playback for auto-scroll
  startPlaybackTracking();
}

function copyTranscript() {
  copyToClipboardWithFeedback(currentTranscriptText || "", "copyTranscriptBtn");
}

function exportTranscript() {
  const videoUrl = `https://youtube.com/watch?v=${currentVideoId}`;
  const title = escapeHtml(currentVideoTitle || "Untitled");
  const channel = escapeHtml(currentChannelName || "");
  const exportDate = new Date().toLocaleDateString(undefined, {
    year: "numeric", month: "long", day: "numeric",
  });

  // Build transcript rows from the active display mode (original / zh / bilingual)
  const segments = getActiveTranscriptSegments();
  let rowsHtml = "";
  if (segments.length) {
    for (const seg of segments) {
      const mins = Math.floor((seg.start || 0) / 60);
      const secs = Math.floor((seg.start || 0) % 60);
      const ts = `${mins}:${String(secs).padStart(2, "0")}`;
      const tsUrl = `${videoUrl}&t=${seg.start || 0}s`;
      const orig = escapeHtml(seg.text || "");
      const zh = transcriptParagraphCache.get(
        transcriptTranslationCacheKey ? transcriptTranslationCacheKey(seg) : "",
      );

      if (currentTranscriptMode === "bilingual" && zh) {
        rowsHtml += `
          <div class="row bilingual">
            <a class="ts" href="${tsUrl}" target="_blank">${ts}</a>
            <div class="lines">
              <div class="orig">${orig}</div>
              <div class="zh">${escapeHtml(zh)}</div>
            </div>
          </div>`;
      } else if (currentTranscriptMode === "zh" && zh) {
        rowsHtml += `
          <div class="row">
            <a class="ts" href="${tsUrl}" target="_blank">${ts}</a>
            <div class="lines"><div class="zh">${escapeHtml(zh)}</div></div>
          </div>`;
      } else {
        rowsHtml += `
          <div class="row">
            <a class="ts" href="${tsUrl}" target="_blank">${ts}</a>
            <div class="lines"><div class="orig">${orig}</div></div>
          </div>`;
      }
    }
  } else {
    rowsHtml = `<p style="color:#999">No transcript available.</p>`;
  }

  // Chapters section (if analysis is available)
  let chaptersHtml = "";
  if (currentAnalysis?.chapters?.length) {
    chaptersHtml = `<section class="chapters">
      <h2>Chapters</h2>
      <ol>`;
    for (const ch of currentAnalysis.chapters) {
      const tsUrl = `${videoUrl}&t=${ch.timestampSeconds}s`;
      chaptersHtml += `
        <li>
          <a href="${tsUrl}" target="_blank" class="ch-ts">${escapeHtml(ch.timestamp)}</a>
          <strong>${escapeHtml(ch.title)}</strong>
          ${ch.summary ? `<span class="ch-summary"> — ${escapeHtml(ch.summary)}</span>` : ""}
        </li>`;
    }
    chaptersHtml += `</ol></section>`;
  }

  // Vocabulary section (if available)
  let vocabHtml = "";
  if (currentVocabItems?.length) {
    vocabHtml = `<section class="vocab">
      <h2>Vocabulary</h2>
      <table>
        <thead><tr><th>Word</th><th>中文</th><th>Sentence</th><th>Time</th></tr></thead>
        <tbody>`;
    for (const item of currentVocabItems) {
      const tsUrl = `${videoUrl}&t=${item.timestampSeconds}s`;
      const highlighted = escapeHtml(item.sentence).replace(
        new RegExp(`(${escapeHtml(item.word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"),
        "<mark>$1</mark>",
      );
      vocabHtml += `
        <tr>
          <td class="vw">${escapeHtml(item.word)}</td>
          <td class="vzh">${escapeHtml(item.chinese || "")}</td>
          <td class="vs">${highlighted}</td>
          <td><a href="${tsUrl}" target="_blank">${escapeHtml(item.timestamp)}</a></td>
        </tr>`;
    }
    vocabHtml += `</tbody></table></section>`;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --ink: #1a1510;
    --ink2: #4a4035;
    --muted: #8a7d70;
    --accent: #c8674f;
    --bg: #faf8f5;
    --rule: #e8e0d5;
    --zh-ink: #2d4a2d;
    --font-body: system-ui, "Segoe UI", Helvetica, Arial, sans-serif;
    --font-mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    --font-zh: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  }

  body {
    font-family: var(--font-body);
    font-size: 15px;
    line-height: 1.7;
    color: var(--ink);
    background: var(--bg);
    padding: 0;
  }

  /* ── Page layout ── */
  .page {
    max-width: 780px;
    margin: 0 auto;
    padding: 48px 32px 80px;
  }

  /* ── Header ── */
  header {
    margin-bottom: 40px;
    padding-bottom: 24px;
    border-bottom: 2px solid var(--ink);
  }
  .label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 8px;
  }
  h1 {
    font-size: 26px;
    font-weight: 700;
    line-height: 1.25;
    color: var(--ink);
    margin-bottom: 10px;
  }
  .meta {
    font-size: 13px;
    color: var(--muted);
    display: flex;
    flex-wrap: wrap;
    gap: 0 20px;
  }
  .meta a { color: var(--accent); text-decoration: none; }
  .meta a:hover { text-decoration: underline; }

  /* ── Sections ── */
  section { margin-top: 44px; }
  section + section { margin-top: 44px; }
  h2 {
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.10em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 16px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--rule);
  }

  /* ── Chapters ── */
  .chapters ol {
    list-style: none;
    counter-reset: ch;
    padding: 0;
  }
  .chapters li {
    counter-increment: ch;
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 8px 0;
    border-bottom: 1px solid var(--rule);
    font-size: 14px;
  }
  .chapters li::before {
    content: counter(ch, decimal-leading-zero);
    font-variant-numeric: tabular-nums;
    font-size: 11px;
    color: var(--muted);
    flex-shrink: 0;
    width: 22px;
  }
  .ch-ts {
    font-family: var(--font-mono);
    font-size: 11.5px;
    color: var(--accent);
    text-decoration: none;
    flex-shrink: 0;
  }
  .ch-ts:hover { text-decoration: underline; }
  .ch-summary { color: var(--ink2); font-weight: 400; }

  /* ── Transcript rows ── */
  .transcript .row {
    display: flex;
    gap: 16px;
    padding: 7px 0;
    border-bottom: 1px solid var(--rule);
    page-break-inside: avoid;
  }
  .ts {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--accent);
    text-decoration: none;
    flex-shrink: 0;
    width: 40px;
    padding-top: 2px;
    line-height: 1.7;
  }
  .ts:hover { text-decoration: underline; }
  .lines { flex: 1; min-width: 0; }
  .orig {
    font-size: 14.5px;
    line-height: 1.65;
    color: var(--ink);
  }
  .zh {
    font-family: var(--font-zh), var(--font-body);
    font-size: 13.5px;
    line-height: 1.75;
    color: var(--zh-ink);
  }
  .bilingual .zh { margin-top: 2px; }

  /* ── Vocabulary table ── */
  .vocab table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13.5px;
  }
  .vocab th {
    text-align: left;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    padding: 6px 8px 6px 0;
    border-bottom: 1px solid var(--rule);
  }
  .vocab td {
    vertical-align: top;
    padding: 8px 8px 8px 0;
    border-bottom: 1px solid var(--rule);
    line-height: 1.55;
  }
  .vw {
    font-weight: 700;
    color: var(--accent);
    white-space: nowrap;
    padding-right: 12px !important;
  }
  .vzh {
    font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    color: var(--ink2);
    white-space: nowrap;
    padding-right: 12px !important;
  }
  .vs { color: var(--ink2); }
  mark {
    background: transparent;
    font-weight: 700;
    color: var(--accent);
  }
  .vocab a { color: var(--muted); text-decoration: none; font-family: var(--font-mono); font-size: 11px; }
  .vocab a:hover { text-decoration: underline; }

  /* ── Footer ── */
  footer {
    margin-top: 56px;
    padding-top: 16px;
    border-top: 1px solid var(--rule);
    font-size: 12px;
    color: var(--muted);
  }
  footer a { color: var(--muted); }

  /* ── Print ── */
  @media print {
    body { background: #fff; }
    .page { padding: 0; max-width: 100%; }
    header { border-bottom-color: #000; }
    a { color: inherit !important; text-decoration: none !important; }
    .ts, .ch-ts { color: #555 !important; }
    .vw { color: #333 !important; }
    mark { font-weight: 700; }
    @page { margin: 18mm 20mm; }
  }
</style>
</head>
<body>
<div class="page">

  <header>
    <div class="label">YouTube Digest</div>
    <h1>${title}</h1>
    <div class="meta">
      ${channel ? `<span>${channel}</span>` : ""}
      <a href="${videoUrl}" target="_blank">${videoUrl}</a>
      <span>${exportDate}</span>
    </div>
  </header>

  ${chaptersHtml}

  <section class="transcript">
    <h2>Transcript${currentTranscriptMode === "zh" ? " · 中文" : currentTranscriptMode === "bilingual" ? " · Bilingual" : ""}</h2>
    ${rowsHtml}
  </section>

  ${vocabHtml}

  <footer>Exported by <a href="https://github.com/zarazhangrui/youtube-digest">YouTube Digest</a></footer>

</div>
</body>
</html>`;

  const filename = `${sanitizeFilename(currentVideoTitle)}-transcript.html`;
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ============================================================
// UI STATE MANAGEMENT
// ============================================================

function showState(state) {
  document.getElementById("welcomeState").style.display =
    state === "welcome" ? "flex" : "none";
  document.getElementById("loadingState").style.display =
    state === "loading" ? "block" : "none";
  document.getElementById("errorState").style.display =
    state === "error" ? "block" : "none";
  const uploadEl = document.getElementById("uploadState");
  if (uploadEl) uploadEl.style.display = "none"; // Upload state removed — always hidden
  document.getElementById("resultsState").style.display =
    state === "results" ? "block" : "none";

  // The tab bar only belongs on the results view. We toggle it HERE, in one
  // place, so it tracks the view automatically. Previously each caller had to
  // remember to re-show it after showState("results"), and one path forgot —
  // which is why the tabs could vanish when re-opening an already-analyzed video.
  document.getElementById("tabsNav").style.display =
    state === "results" ? "flex" : "none";

  if (state !== "results") {
    stopPlaybackTracking();
  }
}

function updateLoading(title, subtitle) {
  document.getElementById("loadingText").textContent = title;
  document.getElementById("loadingSubtext").textContent = subtitle;
}

function showError(title, message) {
  errorAction = null;
  showState("error");
  document.getElementById("errorTitle").textContent = title;
  document.getElementById("errorMessage").textContent = message;
  document.getElementById("errorBtn").textContent = "Try Again";
}

function showConfigError(configStatus) {
  const missingKeys = [];
  if (!configStatus.hasSupadataKey) missingKeys.push("Supadata");
  if (!configStatus.hasAiKey) missingKeys.push("AI provider");

  showState("error");
  document.getElementById("errorTitle").textContent = "API Keys Missing";
  document.getElementById("errorMessage").textContent =
    `Add your ${missingKeys.join(" and ")} API key${missingKeys.length === 1 ? "" : "s"} in YouTube Digest Settings.`;
  document.getElementById("errorBtn").textContent = "Open Settings";
  errorAction = () => chrome.runtime.sendMessage({ action: "openOptions" });
}

// ============================================================
// TAB SWITCHING
// ============================================================

function switchTab(tabName) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });

  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === tabName);
  });

  // Start/stop playback tracking based on which tab is active
  if (tabName === "transcript") {
    startPlaybackTracking();
  } else {
    stopPlaybackTracking();
  }

  // Lazy-load LLM analysis when user switches to Overview tab
  if (tabName === "overview" && !currentAnalysis && !isAnalysisLoading) {
    triggerAnalysis();
  }
  // Vocabulary is user-initiated only — the panel shows an Extract button
  // and does nothing until the user clicks it.
}

// ============================================================
// OVERVIEW ANALYSIS (sidepanel-side, streamed)
// ============================================================
// Runs the AI call directly from the sidepanel instead of the background
// service worker. This avoids Chrome killing long-running message channels
// ("The message port closed before a response was received") when the
// service worker suspends. The SSE stream lets us render chapters and
// quotes as soon as each complete JSON object arrives, so the user sees
// progressive results instead of a blank "Loading" until the whole JSON
// finishes.

const ANALYSIS_MAX_TOKENS = 8192;
const ANALYSIS_HARD_TIMEOUT_MS = 300_000;
const ANALYSIS_FIRST_TOKEN_TIMEOUT_MS = 180_000;

// Cached analysis.md content so we don't re-fetch the prompt file on every
// Overview tab open.
const analysisPromptCache = { markdown: null };

async function loadAnalysisPromptSection(heading, variables = {}) {
  if (!analysisPromptCache.markdown) {
    const response = await fetch(chrome.runtime.getURL("prompts/analysis.md"));
    if (!response.ok) throw new Error("Could not load prompt file: analysis.md");
    analysisPromptCache.markdown = await response.text();
  }
  const markdown = analysisPromptCache.markdown;
  const marker = `## ${heading}`;
  const markerIndex = markdown.indexOf(marker);
  if (markerIndex === -1)
    throw new Error(`Prompt section not found: analysis.md#${heading}`);
  const sectionStart = markerIndex + marker.length;
  const nextSection = markdown.indexOf("\n## ", sectionStart);
  const section = markdown.slice(
    sectionStart,
    nextSection === -1 ? markdown.length : nextSection,
  );
  const fenceMatch = section.match(/```(?:[A-Za-z0-9_-]+)?\n([\s\S]*?)\n```/);
  if (!fenceMatch)
    throw new Error(`Prompt section not found: analysis.md#${heading}`);
  let prompt = fenceMatch[1];
  for (const [key, value] of Object.entries(variables)) {
    prompt = prompt.split(`{${key}}`).join(String(value ?? ""));
  }
  return prompt;
}

/**
 * Extracts complete JSON object literals from a streaming accumulation of
 * text, scanning inside a named top-level array. Returns the newly parsed
 * items and the character position up to which we've emitted, so the next
 * call can resume without re-emitting.
 *
 * Works on partial text: an object whose closing brace hasn't arrived yet is
 * simply skipped, and the caller waits for more deltas.
 */
function extractCompletedJsonArrayItems(fullText, arrayName, emittedCharPos) {
  const items = [];
  const escapedName = arrayName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const arrayMatch = fullText.match(new RegExp(`"${escapedName}"\\s*:\\s*\\[`));
  if (!arrayMatch) return { items, newPos: emittedCharPos };

  const arrStart = arrayMatch.index + arrayMatch[0].length;
  let scan = Math.max(emittedCharPos, arrStart);

  while (scan < fullText.length) {
    while (scan < fullText.length && /[\s,]/.test(fullText[scan])) scan++;
    if (scan >= fullText.length) break;
    if (fullText[scan] === "]") break;
    if (fullText[scan] !== "{") {
      scan++;
      continue;
    }

    // Walk to the matching closing brace, respecting strings and escapes.
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    for (let i = scan; i < fullText.length; i++) {
      const c = fullText[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break; // object not yet complete — wait for more data

    const objText = fullText.slice(scan, end + 1);
    try {
      items.push(JSON.parse(objText));
    } catch {
      // Malformed object literal — skip it.
    }
    scan = end + 1;
    emittedCharPos = scan;
  }

  return { items, newPos: emittedCharPos };
}

/**
 * Sidepanel-side equivalent of background.js validateAndFixTimestamps.
 * Rebuilds the supported schema from untrusted model output and derives
 * display timestamps from validated numeric seconds.
 */
function validateAnalysisTimestamps(analysis, maxSeconds) {
  const safeMax =
    Number.isFinite(Number(maxSeconds)) && Number(maxSeconds) > 0
      ? Number(maxSeconds)
      : Number.MAX_SAFE_INTEGER;
  const formatTimestamp = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, "0")}`;
  };
  const safeString = (value, maxLength) =>
    typeof value === "string" ? value.trim().slice(0, maxLength) : "";
  const safeSeconds = (value) => {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > safeMax) return null;
    return Math.floor(seconds);
  };

  const chapters = (Array.isArray(analysis?.chapters) ? analysis.chapters : [])
    .slice(0, 100)
    .map((chapter) => {
      const seconds = safeSeconds(chapter?.timestampSeconds);
      const title = safeString(chapter?.title, 300);
      if (seconds === null || !title) return null;
      return {
        title,
        titleZh: safeString(chapter?.titleZh, 300),
        summary: safeString(chapter?.summary, 1500),
        summaryZh: safeString(chapter?.summaryZh, 1500),
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyQuotes = (Array.isArray(analysis?.keyQuotes) ? analysis.keyQuotes : [])
    .slice(0, 50)
    .map((quote) => {
      const seconds = safeSeconds(quote?.timestampSeconds);
      const text = safeString(quote?.quote, 3000);
      if (seconds === null || !text) return null;
      return {
        quote: text,
        quoteZh: safeString(quote?.quoteZh, 3000),
        timestampSeconds: seconds,
        timestamp: formatTimestamp(seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  const keyMoments = (Array.isArray(analysis?.keyMoments) ? analysis.keyMoments : [])
    .map(safeSeconds)
    .filter((seconds) => seconds !== null)
    .slice(0, 100);

  return { chapters, keyQuotes, keyMoments };
}

/**
 * Triggers the LLM analysis (lazy-loaded when user clicks Overview tab).
 *
 * Streams directly from the sidepanel (not via the background service
 * worker) and renders each chapter/quote as soon as its JSON object
 * completes. This avoids the MV3 service-worker message-channel timeout
 * that previously left the Overview tab stuck on "Loading" until it failed.
 */
async function triggerAnalysis() {
  if (!currentTranscriptTimestamped || isAnalysisLoading || currentAnalysis)
    return;

  isAnalysisLoading = true;

  const chapterList = document.getElementById("chapterList");
  const quotesList = document.getElementById("quotesList");
  if (chapterList)
    chapterList.innerHTML =
      '<li class="chapter-item" style="color: var(--text-muted); border: none;">Loading chapters…</li>';
  if (quotesList)
    quotesList.innerHTML =
      '<div class="quote-item" style="color: var(--text-muted); border-left-color: var(--border);">Loading quotes…</div>';

  const controller = new AbortController();
  const hardTimeoutId = setTimeout(
    () => controller.abort(),
    ANALYSIS_HARD_TIMEOUT_MS,
  );
  let firstTokenTimeoutId;

  // Accumulated streamed items. We render these incrementally; at the end
  // we run validateAnalysisTimestamps over the full set and re-render.
  const streamedChapters = [];
  const streamedQuotes = [];
  let chaptersEmittedPos = 0;
  let quotesEmittedPos = 0;
  let sawFirstToken = false;

  const renderStreamed = () => {
    if (!streamedChapters.length && !streamedQuotes.length) return;
    renderAnalysisResults({
      chapters: streamedChapters,
      keyQuotes: streamedQuotes,
    });
  };

  try {
    // Load settings
    const stored = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
    const settings = YTD_SETTINGS.normalize(stored[YTD_SETTINGS.STORAGE_KEY]);
    if (!settings.aiApiKey) {
      showAnalysisError("TokenDance API key not configured. Open Settings.");
      isAnalysisLoading = false;
      return;
    }

    // Compute duration context (same logic as background.js)
    let lastTranscriptSeconds = 0;
    const stampMatches =
      currentTranscriptTimestamped.match(/\[(\d+):(\d{2})\]/g) || [];
    if (stampMatches.length) {
      const last = stampMatches[stampMatches.length - 1].match(
        /\[(\d+):(\d{2})\]/,
      );
      lastTranscriptSeconds = parseInt(last[1]) * 60 + parseInt(last[2]);
    }
    const effectiveSeconds = Math.max(
      Math.floor(currentVideoDuration || 0),
      lastTranscriptSeconds,
    );
    const durationMinutes = Math.floor(effectiveSeconds / 60);
    const durationSeconds = Math.floor(effectiveSeconds % 60);
    const durationFormatted = `${durationMinutes}:${String(durationSeconds).padStart(2, "0")}`;
    const maxTimestampSeconds = effectiveSeconds;
    const lateThresholdSeconds = Math.floor(effectiveSeconds * 0.75);
    const lateThreshold = `${Math.floor(lateThresholdSeconds / 60)}:${String(
      lateThresholdSeconds % 60,
    ).padStart(2, "0")}`;

    const promptVariables = {
      durationFormatted,
      lateThreshold,
      maxTimestampSeconds,
      videoTitle: currentVideoTitle || "Unknown",
      channelName: currentChannelName || "Unknown",
      videoDescription: currentVideoDescription || "No description available",
      transcriptText: currentTranscriptTimestamped,
    };
    const systemPrompt = await loadAnalysisPromptSection(
      "System prompt",
      promptVariables,
    );
    const userPrompt = await loadAnalysisPromptSection(
      "User prompt",
      promptVariables,
    );

    firstTokenTimeoutId = setTimeout(
      () => controller.abort(),
      ANALYSIS_FIRST_TOKEN_TIMEOUT_MS,
    );

    const response = await fetch(YTD_SETTINGS.chatCompletionsUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.aiApiKey}`,
      },
      body: JSON.stringify({
        model: settings.aiModel,
        max_tokens: ANALYSIS_MAX_TOKENS,
        temperature: 0.3,
        stream: true,
        // Overview is a structured extraction task — no chain-of-thought
        // needed. Disabling reasoning speeds up the first token substantially.
        enable_thinking: false,
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }

    // Stream the SSE response
    const reader = response.body?.getReader?.();
    const decoder = new TextDecoder();
    let fullText = "";
    let sseBuffer = "";

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        const frames = sseBuffer.split("\n\n");
        sseBuffer = frames.pop() || "";
        for (const frame of frames) {
          for (const line of frame.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const evt = JSON.parse(payload);
              const delta = evt.choices?.[0]?.delta?.content;
              if (typeof delta === "string" && delta) {
                if (!sawFirstToken) {
                  sawFirstToken = true;
                  clearTimeout(firstTokenTimeoutId);
                }
                fullText += delta;
              }
            } catch {
              /* ignore malformed frame */
            }
          }
        }

        // Incrementally extract and render completed chapters/quotes
        const chResult = extractCompletedJsonArrayItems(
          fullText,
          "chapters",
          chaptersEmittedPos,
        );
        if (chResult.items.length) {
          streamedChapters.push(...chResult.items);
          chaptersEmittedPos = chResult.newPos;
        }
        const qResult = extractCompletedJsonArrayItems(
          fullText,
          "keyQuotes",
          quotesEmittedPos,
        );
        if (qResult.items.length) {
          streamedQuotes.push(...qResult.items);
          quotesEmittedPos = qResult.newPos;
        }
        if (chResult.items.length || qResult.items.length) {
          renderStreamed();
        }
      }
    } else {
      // Fallback: non-streaming environment — read whole body as JSON.
      const data = await response.json();
      fullText = data.choices?.[0]?.message?.content || "";
    }

    // Final parse: try the full JSON, fall back to loose parsing (strip
    // fences / prose, isolate outer object, remove trailing commas).
    let finalAnalysis;
    try {
      finalAnalysis = JSON.parse(fullText);
    } catch {
      let cleaned = fullText.trim();
      if (cleaned.startsWith("```")) {
        cleaned = cleaned
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/```\s*$/i, "");
      }
      const firstBrace = cleaned.indexOf("{");
      const lastBrace = cleaned.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        cleaned = cleaned.slice(firstBrace, lastBrace + 1);
      }
      try {
        finalAnalysis = JSON.parse(cleaned);
      } catch {
        finalAnalysis = JSON.parse(cleaned.replace(/,(\s*[}\]])/g, "$1"));
      }
    }

    // If the final parse gave us more than what we streamed (e.g. the model
    // emitted chapters after keyQuotes, or the stream was truncated), merge.
    if (
      Array.isArray(finalAnalysis?.chapters) &&
      finalAnalysis.chapters.length > streamedChapters.length
    ) {
      streamedChapters.length = 0;
      streamedChapters.push(...finalAnalysis.chapters);
    }
    if (
      Array.isArray(finalAnalysis?.keyQuotes) &&
      finalAnalysis.keyQuotes.length > streamedQuotes.length
    ) {
      streamedQuotes.length = 0;
      streamedQuotes.push(...finalAnalysis.keyQuotes);
    }
    const keyMoments = Array.isArray(finalAnalysis?.keyMoments)
      ? finalAnalysis.keyMoments
      : [];

    const validated = validateAnalysisTimestamps(
      { chapters: streamedChapters, keyQuotes: streamedQuotes, keyMoments },
      maxTimestampSeconds,
    );

    if (!validated.chapters.length && !validated.keyQuotes.length) {
      throw new Error("AI returned no valid chapters or quotes.");
    }

    currentAnalysis = validated;
    renderAnalysisResults(currentAnalysis);
    highlightMomentsOnPage(currentAnalysis.keyMoments);
    await saveToCache(currentVideoId);
  } catch (error) {
    console.error("[YouTube Digest Panel] Analysis error:", error);
    const message =
      error.name === "AbortError"
        ? "Analysis timed out. The video may be too long — try a shorter video."
        : `Error: ${error.message}`;
    showAnalysisError(message);
  } finally {
    clearTimeout(hardTimeoutId);
    clearTimeout(firstTokenTimeoutId);
    isAnalysisLoading = false;
  }
}

/**
 * Chapters and quotes come from one request, so a failure has to clear BOTH
 * placeholders. Leaving "Loading quotes..." under the error message reads as a
 * half-finished request that is still running, and the Retry hint below it is
 * the only way back — clearing just one panel hides that.
 */
function showAnalysisError(message) {
  const chapterList = document.getElementById("chapterList");
  const quotesList = document.getElementById("quotesList");
  if (chapterList)
    chapterList.innerHTML = `<li class="chapter-item analysis-error">${escapeHtml(message)}</li>`;
  if (quotesList)
    quotesList.innerHTML = `<div class="quote-item analysis-error">Not loaded — reopen the Overview tab to retry.</div>`;
}

// ============================================================
// VOCABULARY EXTRACTION
// ============================================================

function resetVocabUI() {
  const section = document.getElementById("vocabSection");
  const status = document.getElementById("vocabStatus");
  const btn = document.getElementById("findVocabBtn");
  const list = document.getElementById("vocabList");
  const tab = document.getElementById("vocabTab");
  const progress = document.getElementById("vocabProgress");
  const fill = document.getElementById("vocabProgressFill");
  if (section) section.style.display = "";
  if (btn) { btn.disabled = false; btn.textContent = "Extract vocabulary"; }
  if (status) status.textContent = "";
  if (list) {
    list.innerHTML = `
      <div class="vocab-cta">
        <div class="vocab-cta-title">Extract learning words</div>
        <div class="vocab-cta-desc">
          Scan the full transcript, list unfamiliar English words with
          a Chinese meaning, and jump to the sentence in the video.
        </div>
        <button class="vocab-cta-btn" id="findVocabCtaBtn" type="button">Start extraction</button>
      </div>`;
  }
  if (tab) tab.textContent = "Vocab";
  if (progress) progress.style.display = "none";
  if (fill) fill.style.width = "0%";
  updateVocabExportButton();
}

// ============================================================
// VOCABULARY EXTRACTION (sidepanel-side, streamed by chunk)
// ============================================================
// Runs the AI calls directly from the sidepanel instead of the background
// service worker. This avoids Chrome killing long-running message channels
// ("The message channel closed before a response was received") when the
// service worker suspends. Each chunk renders as soon as it lands, so the
// user sees progressive results.

const VOCAB_CHUNK_SIZE = 5000;
const VOCAB_MAX_TOKENS = 16000;

function updateVocabProgress({ done, total, running }) {
  const progress = document.getElementById("vocabProgress");
  const fill = document.getElementById("vocabProgressFill");
  const text = document.getElementById("vocabProgressText");
  const tab = document.getElementById("vocabTab");
  if (!progress) return;
  if (!running) {
    progress.style.display = "none";
    if (tab) tab.textContent = "Vocab";
    return;
  }
  progress.style.display = "";
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  if (fill) fill.style.width = `${pct}%`;
  if (text) text.textContent = `Processing chunk ${done} / ${total} · ${pct}%`;
  if (tab) tab.textContent = `Vocab ${done}/${total}`;
}

async function triggerVocabulary() {
  if (isVocabLoading) return;
  // Already have results — just scroll them into view.
  if (currentVocabItems && currentVocabItems.length) {
    const section = document.getElementById("vocabSection");
    if (section) section.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (!currentTranscriptTimestamped) {
    const status = document.getElementById("vocabStatus");
    if (status) status.textContent = "No transcript available.";
    return;
  }

  isVocabLoading = true;
  currentVocabItems = [];
  const btn = document.getElementById("findVocabBtn");
  const status = document.getElementById("vocabStatus");
  if (btn) { btn.disabled = true; btn.textContent = "Extracting…"; }
  if (status) status.textContent = "";

  const chunks = splitTranscriptForVocab(currentTranscriptTimestamped, VOCAB_CHUNK_SIZE);
  const perChunkQuota = Math.max(6, Math.ceil(30 / Math.max(1, chunks.length)));
  const seenWords = new Set();

  updateVocabList([]);
  updateVocabProgress({ done: 0, total: chunks.length, running: true });

  let settings;
  try {
    const stored = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
    settings = YTD_SETTINGS.normalize(stored[YTD_SETTINGS.STORAGE_KEY]);
    if (!settings.aiApiKey) {
      if (status) status.textContent = "TokenDance API key not configured. Open Settings.";
      if (btn) { btn.disabled = false; btn.textContent = "Extract vocabulary"; }
      updateVocabProgress({ running: false });
      isVocabLoading = false;
      return;
    }
  } catch (err) {
    if (status) status.textContent = `Setup error: ${err.message}`;
    if (btn) { btn.disabled = false; btn.textContent = "Extract vocabulary"; }
    updateVocabProgress({ running: false });
    isVocabLoading = false;
    return;
  }

  for (let i = 0; i < chunks.length; i++) {
    let chunkItems = [];
    try {
      chunkItems = await extractVocabularyChunkFromSidepanel(
        chunks[i],
        currentVideoTitle,
        perChunkQuota,
        settings,
        (item) => {
          // Stream: item arrived mid-chunk. Add to global list right away.
          const key = item.word.toLowerCase();
          if (seenWords.has(key)) return;
          seenWords.add(key);
          currentVocabItems.push(item);
          currentVocabItems.sort((a, b) => a.timestampSeconds - b.timestampSeconds);
          updateVocabList(currentVocabItems);
        },
      );
    } catch (err) {
      console.warn(`[YouTube Digest Panel] Vocab chunk ${i} failed:`, err.message);
    }
    // Safety net: also handle any items that were only returned in the final
    // batch (e.g. non-streaming fallback path).
    for (const item of chunkItems) {
      const key = item.word.toLowerCase();
      if (seenWords.has(key)) continue;
      seenWords.add(key);
      currentVocabItems.push(item);
    }
    currentVocabItems.sort((a, b) => a.timestampSeconds - b.timestampSeconds);
    updateVocabList(currentVocabItems);
    updateVocabProgress({ done: i + 1, total: chunks.length, running: true });
  }

  updateVocabProgress({ running: false });
  if (currentVocabItems.length === 0) {
    if (status) status.textContent = "No vocabulary items were returned. Try again.";
  } else {
    if (status) status.textContent = `Done. Extracted ${currentVocabItems.length} words from the full video.`;
  }
  if (btn) {
    btn.disabled = false;
    btn.textContent = currentVocabItems.length
      ? `Re-extract (${currentVocabItems.length})`
      : "Extract vocabulary";
  }
  const tab = document.getElementById("vocabTab");
  if (tab) {
    tab.textContent = currentVocabItems.length
      ? `Vocab (${currentVocabItems.length})`
      : "Vocab";
  }
  // Persist the final vocabulary list so it survives tab switches.
  saveSessionState();
  isVocabLoading = false;
  updateVocabExportButton();
}

function splitTranscriptForVocab(transcriptText, maxChars) {
  const lines = String(transcriptText || "").split("\n");
  const chunks = [];
  let current = "";
  for (const line of lines) {
    if (!line) continue;
    if (current.length + line.length + 1 > maxChars && current) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? current + "\n" + line : line;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [""];
}

async function extractVocabularyChunkFromSidepanel(chunkText, videoTitle, maxItems, settings, onItem) {
  const systemPrompt = `You are a vocabulary extraction assistant for Chinese-speaking English learners. You will receive a timestamped English video transcript.

Your task:
1. Identify words or short phrases (1–3 words) that a learner at B1–B2 level might find unfamiliar or worth studying.
2. For each vocabulary item, find ONE specific sentence in the transcript that contains the word.
3. Copy the full sentence exactly as it appears in the transcript.
4. Use the timestamp of the line where the sentence begins (the [MM:SS] marker immediately before the sentence).
5. Provide a concise Simplified Chinese meaning for the word IN THE CONTEXT of the sentence (2–8 汉字, no pinyin, no English).

Selection criteria:
- Prefer low-frequency academic, technical, or idiomatic vocabulary over common everyday words.
- Do not include: articles, prepositions, pronouns, or basic high-frequency verbs (be, have, do, go, make, get).
- Include at most ${maxItems} items, each with a different vocabulary word.

Do not use any chain-of-thought or reasoning traces. Output only the final JSON.

Return a JSON object with this structure:
{"items":[{"word":"...","chinese":"...","sentence":"...","timestampSeconds":0,"timestamp":"0:00"},...]}

Field rules:
- word: the English vocabulary item.
- chinese: concise Simplified Chinese meaning of the word in this sentence's context.
- sentence: a complete sentence from the transcript; the word must appear verbatim in it.
- timestampSeconds: non-negative integer (seconds from video start).
- timestamp: "M:SS" or "MM:SS" format, matching timestampSeconds.`;

  const userPrompt = `Video: ${videoTitle || "Unknown"}\n\nTranscript:\n${chunkText}`;
  const mergedPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}`;

  const body = {
    model: settings.aiModel,
    max_tokens: VOCAB_MAX_TOKENS,
    temperature: 0.3,
    stream: true,
    // Vocabulary-only knobs. Non-vocab callers of this provider must not
    // inherit these: reasoning is disabled here to speed up a task that
    // does not need chain-of-thought, and the SSE stream lets us render
    // partial items as they arrive.
    enable_thinking: false,
    thinking: { type: "disabled" },
    messages: [{ role: "user", content: mergedPrompt }],
  };

  const response = await fetch(YTD_SETTINGS.chatCompletionsUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.aiApiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${errText.slice(0, 200)}`);
  }

  // Stream the SSE response, accumulating content deltas. As full item
  // objects appear inside "items":[...], emit them via onItem so the UI
  // renders live without waiting for the whole chunk to complete.
  const reader = response.body?.getReader?.();
  const decoder = new TextDecoder();
  let fullText = "";
  let sseBuffer = "";

  const localSeen = new Set();
  const items = [];
  let emittedCharPos = 0;

  const tryEmitItems = () => {
    // Find "items" : [ ... and start scanning object literals from there.
    const itemsMatch = fullText.match(/"items"\s*:\s*\[/);
    if (!itemsMatch) return;
    const arrStart = itemsMatch.index + itemsMatch[0].length;
    let scan = Math.max(emittedCharPos, arrStart);

    while (scan < fullText.length) {
      // Skip whitespace and commas.
      while (scan < fullText.length && /[\s,]/.test(fullText[scan])) scan++;
      if (scan >= fullText.length) break;
      // Stop if we've reached array end.
      if (fullText[scan] === "]") break;
      if (fullText[scan] !== "{") { scan++; continue; }

      // Walk forward to find the matching closing brace, respecting strings.
      let depth = 0;
      let inString = false;
      let escape = false;
      let end = -1;
      for (let i = scan; i < fullText.length; i++) {
        const c = fullText[i];
        if (escape) { escape = false; continue; }
        if (c === "\\") { escape = true; continue; }
        if (c === "\"") { inString = !inString; continue; }
        if (inString) continue;
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end === -1) break; // object not yet complete — wait for more data

      const objText = fullText.slice(scan, end + 1);
      try {
        const raw = JSON.parse(objText);
        const parsed = normalizeVocabItem(raw, localSeen);
        if (parsed) {
          items.push(parsed);
          if (typeof onItem === "function") onItem(parsed);
        }
      } catch {
        // Malformed object literal — skip it.
      }
      scan = end + 1;
      emittedCharPos = scan;
      if (items.length >= maxItems) break;
    }
  };

  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by blank lines; each "data: {...}" line is one JSON delta.
      const frames = sseBuffer.split("\n\n");
      sseBuffer = frames.pop() || "";
      for (const frame of frames) {
        for (const line of frame.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const evt = JSON.parse(payload);
            const delta = evt.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta) {
              fullText += delta;
            }
          } catch { /* ignore malformed frame */ }
        }
      }
      tryEmitItems();
      if (items.length >= maxItems) break;
    }
  } else {
    // Fallback: non-streaming environment. Read whole body as JSON.
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || "";
    if (text.trim()) {
      fullText = text;
      tryEmitItems();
    }
  }

  return items;
}

/**
 * Searches currentTranscript for the line that contains the vocabulary word
 * AND whose text is part of the given sentence. Returns that line's start
 * time (seconds), or null if no match is found.
 *
 * This is more accurate than trusting the AI's timestamp, because the AI
 * assigns the timestamp of the first line of a multi-line sentence even
 * when the word only appears in a later line.
 */
function findWordTimestampInTranscript(word, sentence) {
  if (!currentTranscript || !currentTranscript.length) return null;
  const wordLower = word.toLowerCase();
  const sentenceLower = sentence.toLowerCase();

  // Prefer lines that both contain the word and are a substring of the sentence.
  const strong = currentTranscript.filter((line) => {
    const t = line.text.toLowerCase();
    return t.includes(wordLower) && sentenceLower.includes(t);
  });
  if (strong.length) return strong[0].start;

  // Fallback: any line containing the word that overlaps with the sentence.
  const weak = currentTranscript.filter((line) =>
    line.text.toLowerCase().includes(wordLower),
  );
  if (!weak.length) return null;

  // Among weak matches, pick the one whose text has the most overlap with the sentence.
  let best = null;
  let bestOverlap = 0;
  for (const line of weak) {
    const words = line.text.toLowerCase().split(/\s+/);
    const overlap = words.filter((w) => sentenceLower.includes(w)).length;
    if (overlap > bestOverlap) { bestOverlap = overlap; best = line; }
  }
  return best ? best.start : weak[0].start;
}

function normalizeVocabItem(item, localSeen) {
  const word = typeof item?.word === "string" ? item.word.trim().slice(0, 100) : "";
  const chinese = typeof item?.chinese === "string" ? item.chinese.trim().slice(0, 100) : "";
  const sentence = typeof item?.sentence === "string" ? item.sentence.trim().slice(0, 1000) : "";
  const tsString = typeof item?.timestamp === "string" ? item.timestamp.trim() : "";
  if (!word || !sentence) return null;
  if (localSeen.has(word.toLowerCase())) return null;
  localSeen.add(word.toLowerCase());

  // First try: locate the exact transcript line that contains the word.
  // This is the most accurate because it avoids the AI mis-attributing a
  // multi-line sentence's timestamp to the first line when the word is later.
  let safeSeconds = findWordTimestampInTranscript(word, sentence) ?? -1;

  if (safeSeconds < 0) {
    // Second try: parse the "M:SS" string the AI copied from the [MM:SS] markers.
    const tsMatch = tsString.match(/^(\d+):(\d{2})$/);
    if (tsMatch) {
      safeSeconds = parseInt(tsMatch[1], 10) * 60 + parseInt(tsMatch[2], 10);
    } else {
      // Last resort: trust the AI's own arithmetic.
      const fallback = Math.floor(Number(item?.timestampSeconds));
      safeSeconds = Number.isFinite(fallback) && fallback >= 0 ? fallback : 0;
    }
  }

  const mins = Math.floor(safeSeconds / 60);
  const secs = safeSeconds % 60;
  const timestamp = `${mins}:${String(secs).padStart(2, "0")}`;
  return {
    word,
    chinese,
    sentence,
    timestampSeconds: safeSeconds,
    timestamp,
  };
}

function parseVocabJson(text) {
  let cleaned = (text || "").trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    return JSON.parse(cleaned.replace(/,(\s*[}\]])/g, "$1"));
  }
}

function updateVocabList(items) {
  const list = document.getElementById("vocabList");
  if (!list) return;

  if (!items || items.length === 0) {
    if (isVocabLoading) {
      list.innerHTML = '<div class="vocab-empty">Waiting for the first chunk…</div>';
    } else {
      list.innerHTML = `
        <div class="vocab-cta">
          <div class="vocab-cta-title">Extract learning words</div>
          <div class="vocab-cta-desc">
            Scan the full transcript, list unfamiliar English words with
            a Chinese meaning, and jump to the sentence in the video.
          </div>
          <button class="vocab-cta-btn" id="findVocabCtaBtn" type="button">Start extraction</button>
        </div>`;
    }
    return;
  }

  list.innerHTML = "";
  items.forEach((item) => {
    const div = document.createElement("div");
    div.className = "vocab-item";
    div.dataset.seconds = item.timestampSeconds;

    const escapedSentence = escapeHtml(item.sentence);
    const escapedWord = escapeHtml(item.word);
    const highlightedSentence = escapedSentence.replace(
      new RegExp(`(${escapedWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"),
      '<mark class="vocab-highlight">$1</mark>',
    );

    const chineseHtml = item.chinese
      ? `<span class="vocab-chinese">${escapeHtml(item.chinese)}</span>`
      : "";

    div.innerHTML = `
      <div class="vocab-header">
        <span class="vocab-word">${escapedWord}</span>
        ${chineseHtml}
      </div>
      <div class="vocab-sentence">${highlightedSentence}</div>
      <div class="vocab-meta">
        <span class="vocab-timestamp">${escapeHtml(item.timestamp)}</span>
      </div>
    `;
    div.addEventListener("click", () => seekTo(item.timestampSeconds));
    list.appendChild(div);
  });

  updateVocabExportButton();
}

// ============================================================
// VOCABULARY CARD EXPORT (printable HTML → PDF)
// ============================================================

// The panel stores one context-specific gloss per word ("灌木"), which is what a
// viewer needs mid-video. A printed dictation sheet needs the opposite: the
// word's common dictionary senses, grouped by part of speech, so the sheet is
// still useful weeks later without the video. Glosses are fetched once per word
// and cached across videos, since vocabulary repeats.
const GLOSS_CACHE_KEY = "ytd_vocab_glosses";
const GLOSS_CACHE_MAX = 2000;
const GLOSS_BATCH_SIZE = 40;
const GLOSS_MAX_TOKENS = 8000;
const GLOSS_MAX_SENSE_LINES = 4;
const GLOSS_MAX_LINE_CHARS = 60;

/** Only offer the export once there is a finished list worth printing. */
function updateVocabExportButton() {
  const btn = document.getElementById("exportVocabCardsBtn");
  if (!btn) return;
  const count = currentVocabItems?.length || 0;
  const ready = count > 0 && !isVocabLoading;
  btn.style.display = ready ? "" : "none";
  btn.textContent = `Export cards (${count})`;
}

async function loadGlossCache() {
  try {
    const stored = await chrome.storage.local.get(GLOSS_CACHE_KEY);
    const cache = stored[GLOSS_CACHE_KEY];
    return cache && typeof cache === "object" ? cache : {};
  } catch {
    return {};
  }
}

/**
 * Writes the gloss cache back, trimmed to the newest GLOSS_CACHE_MAX entries.
 * Object key order is insertion order, so slicing from the end keeps the words
 * looked up most recently.
 */
async function saveGlossCache(cache) {
  try {
    const keys = Object.keys(cache);
    let trimmed = cache;
    if (keys.length > GLOSS_CACHE_MAX) {
      trimmed = {};
      for (const key of keys.slice(-GLOSS_CACHE_MAX)) trimmed[key] = cache[key];
    }
    await chrome.storage.local.set({ [GLOSS_CACHE_KEY]: trimmed });
  } catch (err) {
    console.warn("[YouTube Digest] Gloss cache write failed:", err.message);
  }
}

/**
 * Cleans one dictionary sense line. Normalizes the part-of-speech prefix to
 * "abbr. " so the printed column aligns, and drops anything that arrived
 * without recognizable Chinese content.
 */
function normalizeGlossLine(text) {
  const line = String(text || "")
    .replace(/\s+/g, " ")
    .replace(/[;；]\s*$/, "")
    .trim();
  if (!line) return "";
  const withPos = line.replace(
    /^((?:n|v|vt|vi|adj|adv|prep|conj|pron|int|num|art|aux|abbr)\.(?:\s*(?:n|v|vt|vi|adj|adv|prep|conj|pron|int|num|art|aux|abbr)\.)*)\s*/i,
    (match, pos) => `${pos.replace(/\s*\./g, ". ").trim()} `,
  );
  return withPos.slice(0, GLOSS_MAX_LINE_CHARS);
}

/** Keeps only usable sense lines, capped so a row cannot overflow its cell. */
function normalizeGlossSenses(senses) {
  if (!Array.isArray(senses)) return [];
  const lines = [];
  for (const sense of senses) {
    const line = normalizeGlossLine(sense);
    if (line && !lines.includes(line)) lines.push(line);
    if (lines.length >= GLOSS_MAX_SENSE_LINES) break;
  }
  return lines;
}

/**
 * Asks the provider for dictionary senses for one batch of words. Returns a
 * Map of lowercase word to sense-line array; words the model skipped are simply
 * absent, and the caller falls back to the contextual gloss.
 */
async function fetchGlossBatch(words, settings) {
  const systemPrompt = `You are a bilingual dictionary for Chinese-speaking learners of English.

For each word you receive, return its common dictionary senses in Simplified Chinese.

Rules:
- Group senses by part of speech, most common part of speech first.
- Start every entry with its part-of-speech abbreviation followed by a period: n. v. vt. vi. adj. adv. prep. conj. pron. num. int. abbr.
- Separate senses inside one entry with "；".
- At most ${GLOSS_MAX_SENSE_LINES} entries per word, and at most 4 senses inside one entry.
- Simplified Chinese only. No pinyin, no English, no example sentences, no pronunciation.
- Return every word you were given, spelled exactly as given.

Do not use any chain-of-thought or reasoning traces. Output only the final JSON.

Return a JSON object with this structure:
{"items":[{"word":"bush","senses":["n. 灌木；丛林地带；浓密的毛发"]},{"word":"mustard","senses":["n. 芥末酱；芥菜","adj. 芥末黄的，褐黄色的"]}]}`;

  const userPrompt = `Words:\n${words.join("\n")}`;

  const response = await fetch(YTD_SETTINGS.chatCompletionsUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.aiApiKey}`,
    },
    body: JSON.stringify({
      model: settings.aiModel,
      max_tokens: GLOSS_MAX_TOKENS,
      temperature: 0.2,
      // Same rationale as vocabulary extraction: a dictionary lookup does not
      // need chain-of-thought, and disabling it keeps the export responsive.
      enable_thinking: false,
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: `${systemPrompt}\n\n---\n\n${userPrompt}` }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || "";
  const parsed = parseVocabJson(text);
  const glosses = new Map();
  for (const item of parsed?.items || []) {
    const word = typeof item?.word === "string" ? item.word.trim() : "";
    const senses = normalizeGlossSenses(item?.senses);
    if (word && senses.length) glosses.set(word.toLowerCase(), senses);
  }
  return glosses;
}

/**
 * Builds the printable rows: word plus dictionary sense lines. Cached words
 * cost nothing, uncached ones go out in batches, and any word still without a
 * dictionary entry keeps its contextual gloss so the sheet is never blank.
 */
async function buildVocabCardItems(items, onProgress) {
  const cache = await loadGlossCache();
  const missing = [];
  const seen = new Set();
  for (const item of items) {
    const key = item.word.toLowerCase();
    if (cache[key] || seen.has(key)) continue;
    seen.add(key);
    missing.push(item.word);
  }

  if (missing.length) {
    let settings = null;
    try {
      const stored = await chrome.storage.local.get(YTD_SETTINGS.STORAGE_KEY);
      settings = YTD_SETTINGS.normalize(stored[YTD_SETTINGS.STORAGE_KEY]);
    } catch {
      settings = null;
    }

    if (settings?.aiApiKey) {
      const batches = [];
      for (let i = 0; i < missing.length; i += GLOSS_BATCH_SIZE) {
        batches.push(missing.slice(i, i + GLOSS_BATCH_SIZE));
      }
      let fetched = 0;
      let cacheChanged = false;
      for (const batch of batches) {
        try {
          const glosses = await fetchGlossBatch(batch, settings);
          for (const [key, senses] of glosses) {
            cache[key] = senses;
            cacheChanged = true;
          }
        } catch (err) {
          // A failed batch is not fatal: those words fall back to their
          // contextual gloss and the rest of the sheet still prints.
          console.warn("[YouTube Digest] Gloss batch failed:", err.message);
        }
        fetched += batch.length;
        if (typeof onProgress === "function") onProgress(fetched, missing.length);
      }
      if (cacheChanged) await saveGlossCache(cache);
    }
  }

  return items.map((item) => ({
    word: item.word,
    chinese: item.chinese,
    senses: cache[item.word.toLowerCase()] || [],
  }));
}

/**
 * Hands the word list to vocab-cards.html through chrome.storage.session and
 * opens it in a tab, which renders the sheets and goes straight to the print
 * dialog so the whole export is one click plus Save as PDF. The payload goes
 * through session storage rather than the URL because a full list easily
 * exceeds what a query string can carry.
 */
async function exportVocabCards() {
  const items = currentVocabItems || [];
  if (!items.length) return;

  const btn = document.getElementById("exportVocabCardsBtn");
  const status = document.getElementById("vocabStatus");
  if (btn) { btn.disabled = true; btn.textContent = "Preparing…"; }

  try {
    const cardItems = await buildVocabCardItems(items, (done, total) => {
      if (btn) btn.textContent = `Looking up ${done}/${total}…`;
    });

    if (btn) btn.textContent = "Opening…";
    const key = `ytd_vocab_cards:${currentVideoId || "unknown"}:${Date.now()}`;
    await chrome.storage.session.set({
      [key]: {
        title: currentVideoTitle || "Vocabulary Cards",
        videoId: currentVideoId || "",
        exportDate: new Date().toLocaleDateString(undefined, {
          year: "numeric", month: "long", day: "numeric",
        }),
        items: cardItems,
      },
    });
    await chrome.tabs.create({
      url: chrome.runtime.getURL(
        `vocab-cards.html?key=${encodeURIComponent(key)}&print=1`,
      ),
    });
    if (status) status.textContent = "";
  } catch (err) {
    console.error("[YouTube Digest] Card export failed:", err);
    if (status) status.textContent = `Export failed: ${err.message}`;
  } finally {
    if (btn) btn.disabled = false;
    updateVocabExportButton();
  }
}

// ============================================================
// TIMESTAMP / SEEK
// ============================================================

async function seekTo(seconds) {
  debugLog("[YouTube Digest Panel] seekTo called with:", seconds);
  if (seconds === undefined || seconds === null) {
    debugLog("[YouTube Digest Panel] seekTo aborted - no seconds value");
    return;
  }

  const payload = {
    action: "seekTo",
    seconds: Number(seconds),
  };

  try {
    // Try direct messaging to the stored YouTube tab first (fastest/reliable)
    if (youtubeTabId) {
      try {
        await chrome.tabs.sendMessage(youtubeTabId, payload);
        debugLog("[YouTube Digest Panel] seekTo direct success");
        return;
      } catch (directErr) {
        debugLog(
          "[YouTube Digest Panel] Direct seekTo failed, falling back to relay:",
          directErr.message,
        );
      }
    }

    // Fallback: route through background script
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload,
    });
    debugLog("[YouTube Digest Panel] seekTo relay result:", result);
  } catch (error) {
    console.error("[YouTube Digest Panel] seekTo error:", error);
  }
}

/**
 * Plays a saved note at its timestamp.
 * - If the note belongs to the video currently open, we seek the player in place.
 * - If it belongs to a DIFFERENT video (e.g. viewing "All Notes"), seeking the
 *   current player would jump to the wrong content, so we open that video in a
 *   new tab at the right timestamp instead.
 */
function playNote(note) {
  if (note.videoId && note.videoId === currentVideoId) {
    seekTo(note.timestampSeconds);
  } else {
    // note.timestampedUrl already includes the &t=<seconds>s anchor
    chrome.tabs.create({ url: note.timestampedUrl });
  }
}

async function highlightMomentsOnPage(moments) {
  if (!moments || !moments.length) return;

  try {
    // Route through background script for reliable message passing
    await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload: {
        action: "highlightMoments",
        moments: moments,
        videoDuration: currentVideoDuration,
      },
    });
  } catch (error) {
    console.error("Highlight error:", error);
  }
}

// ============================================================
// UTILITY
// ============================================================

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

/**
 * Renders the small subset of inline formatting commonly present in subtitle
 * tracks and model translations. Everything is escaped first; only exact,
 * attribute-free allowlisted tags are restored as markup afterwards.
 */
function renderSubtitleInlineMarkup(text) {
  return escapeHtml(text).replace(
    /&lt;(\/?)(i|em|b|strong|u)&gt;|&lt;br(?:\s*\/)?&gt;/gi,
    (_match, closing, tagName) =>
      tagName ? `<${closing}${tagName.toLowerCase()}>` : "<br>",
  );
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.error("Copy failed:", error);
    return false;
  }
}

async function copyToClipboardWithFeedback(text, buttonId) {
  const btn = document.getElementById(buttonId);
  const original = btn.textContent;

  const success = await copyToClipboard(text);
  if (success) {
    btn.textContent = "✓ Copied";
    setTimeout(() => {
      btn.textContent = original;
    }, 2000);
  }
}

function downloadTextFile(text, filename) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function sanitizeFilename(str) {
  return (str || "untitled")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .substring(0, 50)
    .toLowerCase();
}

// ============================================================
// TEXT SELECTION — EXPLAIN FEATURE
// ============================================================

/**
 * Sets up text selection handling in the transcript.
 * When user selects text, shows an "Explain" button.
 */
function setupExplainFeature() {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  // Remove existing tooltip if any
  const existingTooltip = document.getElementById("explainTooltip");
  if (existingTooltip) existingTooltip.remove();

  // Create the explain tooltip/button
  const tooltip = document.createElement("div");
  tooltip.id = "explainTooltip";
  tooltip.className = "explain-tooltip";
  tooltip.innerHTML = `<button class="explain-btn">💡 Explain</button>`;
  tooltip.style.display = "none";
  document.body.appendChild(tooltip);

  let selectedText = "";

  // Interacting with Explain must preserve the transcript selection and stay
  // isolated from document/row click behavior.
  tooltip.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  tooltip.addEventListener("mouseup", (event) => {
    event.stopPropagation();
  });
  tooltip.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  // Listen for text selection
  document.addEventListener("mouseup", (e) => {
    const selection = window.getSelection();
    const text = selection.toString().trim();

    // Only show if selecting within transcript
    const isInTranscript = transcriptList.contains(selection.anchorNode);

    // Allow any selection length (removed 10+ char requirement)
    if (text.length > 0 && isInTranscript) {
      selectedText = text;

      // Position the tooltip near the selection
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      tooltip.style.display = "block";
      tooltip.style.top = `${rect.bottom + window.scrollY + 8}px`;
      tooltip.style.left = `${rect.left + rect.width / 2}px`;
    } else {
      tooltip.style.display = "none";
    }
  });

  // Hide tooltip when clicking elsewhere
  document.addEventListener("mousedown", (e) => {
    if (!tooltip.contains(e.target)) {
      tooltip.style.display = "none";
    }
  });

  // Handle explain button click
  tooltip
    .querySelector(".explain-btn")
    .addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!selectedText) return;

      tooltip.style.display = "none";
      await showExplanation(selectedText);
    });
}

/**
 * Shows the explanation modal and fetches it from the configured AI provider.
 */
async function showExplanation(selectedText) {
  // Create modal
  const modal = document.createElement("div");
  modal.id = "explainModal";
  modal.className = "explain-modal-overlay";
  modal.innerHTML = `
    <div class="explain-modal">
      <div class="explain-modal-header">
        <div class="explain-modal-title">Explain</div>
        <button class="explain-modal-close" id="closeExplain">✕</button>
      </div>
      <div class="explain-selected-text">"${escapeHtml(selectedText.substring(0, 200))}${selectedText.length > 200 ? "..." : ""}"</div>
      <div class="explain-modal-content" id="explanationContent">
        <div class="explain-loading">
          <div class="loading-bar"></div>
          <span>Analyzing...</span>
        </div>
      </div>
      <div class="explain-modal-footer" id="explainFooter"></div>
    </div>
  `;

  document.body.appendChild(modal);

  // Close handlers
  document
    .getElementById("closeExplain")
    .addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });

  // Get some context around the selection from the transcript
  const transcriptContext = getTranscriptContext(selectedText);

  // Tags this request so late deltas from an earlier selection are ignored.
  const requestId = `explain-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  explainRequestId = requestId;

  const onProgress = (message) => {
    if (message?.action !== "explainProgress") return;
    if (message.requestId !== explainRequestId) return;
    if (!message.chinese && !message.english) return;
    const div = document.getElementById("explanationContent");
    if (!div || !document.getElementById("explainModal")) return;
    div.innerHTML = renderExplanationBody(message);
  };
  chrome.runtime.onMessage.addListener(onProgress);

  // Fetch explanation
  try {
    const result = await chrome.runtime.sendMessage({
      action: "explainSelection",
      selectedText: selectedText,
      transcriptContext: transcriptContext,
      videoTitle: currentVideoTitle,
      requestId,
    });

    if (explainRequestId !== requestId) return;
    const contentDiv = document.getElementById("explanationContent");
    if (!contentDiv) return;
    if (result.success) {
      contentDiv.innerHTML = renderExplanationBody(result);
      // Only offered once the gloss exists, since the card stores it.
      setupAddToVocabButton(selectedText, result);
    } else {
      contentDiv.innerHTML = `<div class="explain-error">Failed to get explanation: ${escapeHtml(result.error)}</div>`;
    }
  } catch (error) {
    const contentDiv = document.getElementById("explanationContent");
    if (contentDiv) {
      contentDiv.innerHTML = `<div class="explain-error">Error: ${escapeHtml(error.message)}</div>`;
    }
  } finally {
    chrome.runtime.onMessage.removeListener(onProgress);
  }
}

/**
 * Recovers the two sections from a JSON-shaped explanation, for models that
 * answer with an object even though the prompt asks for marker-delimited text.
 *
 * @param {string} text
 * @returns {{chinese: string, english: string}|null} null when not JSON-shaped
 */
function salvageExplanationJson(text) {
  if (!text || !text.trim().startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text);
    const chinese = typeof parsed?.chinese === "string" ? parsed.chinese.trim() : "";
    const english = typeof parsed?.english === "string" ? parsed.english.trim() : "";
    if (!chinese && !english) return null;
    return { chinese, english };
  } catch {
    return null;
  }
}

/**
 * Builds the modal body: the Simplified Chinese meaning first, then the English
 * explanation. Falls back to the combined `explanation` string when the model
 * did not return the split shape.
 */
function renderExplanationBody(result) {
  const toParagraphs = (text) =>
    escapeHtml(text).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br>");

  let chinese = (result.chinese || "").trim();
  let english = (result.english || "").trim();

  if (!chinese && !english) {
    const fallback = (result.explanation || "").trim();
    // Last resort: a model that answers in JSON despite the prompt must not put
    // braces on screen, so salvage the fields instead of printing the wrapper.
    const salvaged = salvageExplanationJson(fallback);
    if (salvaged) {
      chinese = salvaged.chinese;
      english = salvaged.english;
    } else {
      return `<div class="explain-text">${toParagraphs(fallback)}</div>`;
    }
  }

  const sections = [];
  if (chinese) {
    sections.push(`
      <div class="explain-section">
        <div class="explain-section-label">中文</div>
        <div class="explain-text explain-text-zh">${toParagraphs(chinese)}</div>
      </div>
    `);
  }
  if (english) {
    sections.push(`
      <div class="explain-section">
        <div class="explain-section-label">English</div>
        <div class="explain-text">${toParagraphs(english)}</div>
      </div>
    `);
  }
  return sections.join("");
}

/**
 * Gets surrounding context from the transcript for the selected text.
 */
/**
 * A vocab card is only worth making for a word or a short phrase. A whole
 * sentence or paragraph selection has no single headword to file it under,
 * so the button stays hidden there.
 *
 * @param {string} text
 * @returns {boolean}
 */
function isVocabCandidate(text) {
  const trimmed = (text || "").trim();
  if (!trimmed || trimmed.length > 60) return false;
  if (/[.!?;]/.test(trimmed)) return false;
  const words = trimmed.split(/\s+/);
  return words.length >= 1 && words.length <= 4;
}

/**
 * Finds the transcript sentence containing the selection, so the card carries
 * the example sentence rather than the bare word.
 *
 * @param {string} selectedText
 * @returns {string} the selection itself when no sentence can be recovered
 */
function findSentenceForSelection(selectedText) {
  const fullText = currentTranscriptText || "";
  const index = fullText.indexOf(selectedText);
  if (index === -1) return selectedText;

  const before = fullText.slice(0, index);
  const start = Math.max(0, before.search(/[^.!?]*$/));
  const afterIndex = index + selectedText.length;
  const afterMatch = fullText.slice(afterIndex).match(/^[^.!?]*[.!?]?/);
  const end = afterIndex + (afterMatch ? afterMatch[0].length : 0);

  const sentence = fullText.slice(start, end).trim();
  return sentence.length >= selectedText.length ? sentence : selectedText;
}

/**
 * Renders the "Add to Vocab" action in the Explain modal footer and wires it to
 * append a card to the Vocab tab. Reuses normalizeVocabItem so the card gets
 * the same accurate timestamp resolution as extracted words.
 *
 * @param {string} selectedText
 * @param {{chinese?: string}} result the explanation, for the Chinese gloss
 */
function setupAddToVocabButton(selectedText, result) {
  const footer = document.getElementById("explainFooter");
  if (!footer || !isVocabCandidate(selectedText)) return;

  const word = selectedText.trim();
  const existing = (currentVocabItems || []).some(
    (item) => item.word?.toLowerCase() === word.toLowerCase(),
  );
  if (existing) {
    footer.innerHTML = `<div class="explain-vocab-done">Already in Vocab</div>`;
    return;
  }

  footer.innerHTML = `<button class="explain-vocab-btn" id="addToVocabBtn" type="button">+ Add to Vocab</button>`;
  document.getElementById("addToVocabBtn")?.addEventListener("click", () => {
    const sentence = findSentenceForSelection(word);
    const item = normalizeVocabItem(
      { word, chinese: result?.chinese || "", sentence },
      new Set(),
    );
    if (!item) {
      footer.innerHTML = `<div class="explain-vocab-done">Could not build a card for this selection</div>`;
      return;
    }

    if (!Array.isArray(currentVocabItems)) currentVocabItems = [];
    currentVocabItems.push(item);
    currentVocabItems.sort((a, b) => a.timestampSeconds - b.timestampSeconds);

    updateVocabList(currentVocabItems);
    const tab = document.getElementById("vocabTab");
    if (tab) tab.textContent = `Vocab (${currentVocabItems.length})`;
    const findBtn = document.getElementById("findVocabBtn");
    if (findBtn) findBtn.textContent = `Re-extract (${currentVocabItems.length})`;
    saveSessionState();

    footer.innerHTML = `<div class="explain-vocab-done">Added to Vocab</div>`;
  });
}

function getTranscriptContext(selectedText) {
  const fullText = currentTranscriptText || "";
  const index = fullText.indexOf(selectedText);

  if (index === -1) return "";

  // Get 200 chars before and after
  const start = Math.max(0, index - 200);
  const end = Math.min(fullText.length, index + selectedText.length + 200);

  return fullText.substring(start, end);
}

// ============================================================
// CACHING
// ============================================================

/**
 * Saves the current digest results to persistent local storage.
 * Results survive browser restarts — reopening the same video loads from cache
 * without consuming API tokens or Supadata calls.
 * Cache expires after 30 days. Oldest entries evicted when > 20 videos cached.
 */
async function saveToCache(videoId) {
  if (!videoId || !currentTranscript) return;

  try {
    const cacheData = {
      analysis: currentAnalysis,
      transcript: currentTranscript,
      transcriptText: currentTranscriptText,
      transcriptTimestamped: currentTranscriptTimestamped,
      transcriptLanguage: currentTranscriptLanguage,
      videoTitle: currentVideoTitle,
      channelName: currentChannelName,
      timestamp: Date.now(),
    };

    await chrome.storage.local.set({ [`digest_${videoId}`]: cacheData });
    debugLog(
      "Saved to cache:",
      videoId,
      currentAnalysis ? "(with analysis)" : "(transcript only)",
    );

    // Evict old entries if we have more than 20 videos cached
    await evictOldCacheEntries(20);
  } catch (error) {
    console.error("Cache save error:", error);
  }
}

/**
 * Keeps the cache from growing unbounded.
 * Removes the oldest entries when we exceed maxEntries videos.
 *
 * @param {number} maxEntries - Maximum number of cached videos to keep
 */
async function evictOldCacheEntries(maxEntries) {
  try {
    const allData = await chrome.storage.local.get(null);
    let digestKeys = Object.keys(allData).filter((k) =>
      k.startsWith("digest_"),
    );
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const expired = digestKeys.filter((key) => {
      const timestamp = Number(allData[key]?.timestamp) || 0;
      return Date.now() - timestamp > THIRTY_DAYS;
    });
    if (expired.length) {
      await chrome.storage.local.remove(expired);
      const expiredSet = new Set(expired);
      digestKeys = digestKeys.filter((key) => !expiredSet.has(key));
    }

    if (digestKeys.length <= maxEntries) return;

    // Sort by timestamp (oldest first) and remove excess
    const sorted = digestKeys
      .map((k) => ({ key: k, ts: allData[k]?.timestamp || 0 }))
      .sort((a, b) => a.ts - b.ts);

    const toRemove = sorted
      .slice(0, sorted.length - maxEntries)
      .map((e) => e.key);
    if (toRemove.length > 0) {
      await chrome.storage.local.remove(toRemove);
      debugLog(`[YouTube Digest] Evicted ${toRemove.length} old cache entries`);
    }
  } catch (error) {
    console.error("Cache eviction error:", error);
  }
}

/**
 * Loads digest results from persistent local storage.
 * Returns null if not cached or expired (30-day expiry).
 */
async function loadFromCache(videoId) {
  if (!videoId) return null;

  try {
    const result = await chrome.storage.local.get(`digest_${videoId}`);
    const cached = result[`digest_${videoId}`];

    if (!cached) return null;

    // Cache expires after 30 days
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - cached.timestamp > THIRTY_DAYS) {
      await chrome.storage.local.remove(`digest_${videoId}`);
      return null;
    }

    return cached;
  } catch (error) {
    console.error("Cache load error:", error);
    return null;
  }
}

/**
 * Updates the cache after enhance or translation operations.
 */
async function updateCache() {
  if (currentVideoId) {
    await saveToCache(currentVideoId);
  }
}

// ============================================================
// SESSION STATE  (translations + vocabulary, tab-scoped)
// ============================================================
// Stores the learning results that are expensive to recreate (translated
// segments and extracted vocabulary) in chrome.storage.session so they
// survive side-panel reloads and tab-switching but are never kept across
// a browser restart. The background's tabs.onRemoved listener removes
// records as soon as the owning YouTube tab closes.

const SESSION_STATE_VERSION = 1;

function sessionStateKey(tabId, videoId) {
  return `ytd_tab_learning_state:${tabId}:${videoId}`;
}

// Debounce handle to coalesce rapid writes (streaming vocab, batched translations).
let sessionSaveTimer = null;

async function saveSessionState() {
  if (!currentOwnerTabId || !currentVideoId) return;
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(async () => {
    try {
      const translations = {};
      for (const [key, value] of transcriptParagraphCache.entries()) {
        if (key.startsWith(`${currentVideoId}:`)) translations[key] = value;
      }
      const record = {
        version: SESSION_STATE_VERSION,
        tabId: currentOwnerTabId,
        videoId: currentVideoId,
        transcriptMode: currentTranscriptMode,
        translations,
        vocabItems: currentVocabItems || [],
      };
      const key = sessionStateKey(currentOwnerTabId, currentVideoId);
      await chrome.storage.session.set({ [key]: record });
    } catch (err) {
      console.warn("[YouTube Digest] Session save failed:", err.message);
    }
  }, 300);
}

async function loadSessionState(tabId, videoId) {
  if (!tabId || !videoId) return null;
  try {
    const key = sessionStateKey(tabId, videoId);
    const result = await chrome.storage.session.get(key);
    const record = result[key];
    if (
      !record ||
      record.version !== SESSION_STATE_VERSION ||
      record.tabId !== tabId ||
      record.videoId !== videoId
    ) return null;
    return record;
  } catch (err) {
    console.warn("[YouTube Digest] Session load failed:", err.message);
    return null;
  }
}

async function clearSessionState(tabId, videoId) {
  if (!tabId || !videoId) return;
  try {
    await chrome.storage.session.remove(sessionStateKey(tabId, videoId));
  } catch { /* ignore */ }
}

// ============================================================
// NOTES
// ============================================================

/**
 * Loads and renders notes from storage.
 * @param {string|null} videoId - Filter by video ID, or null for all notes
 */
async function loadNotes(videoId) {
  try {
    const result = await chrome.runtime.sendMessage({
      action: "getNotes",
      videoId: videoId,
    });

    if (result.success) {
      renderNotes(result.notes, videoId);
    }
  } catch (error) {
    console.error("[YouTube Digest Panel] Load notes error:", error);
  }
}

/**
 * Renders the notes list in the Notes tab.
 */
function renderNotes(notes, filteredVideoId) {
  const notesList = document.getElementById("notesList");
  const notesIntro = document.getElementById("notesIntro");

  if (!notesList) return;

  notesList.innerHTML = "";

  if (!notes || notes.length === 0) {
    notesIntro.style.display = "block";
    notesIntro.textContent = filteredVideoId
      ? "No notes for this video yet. Hover over the video and click 📝 Note to save."
      : "No notes saved yet. Hover over a video and click 📝 Note to save.";
    return;
  }

  notesIntro.style.display = "none";

  notes.forEach((note) => {
    const noteEl = document.createElement("div");
    noteEl.className = "note-item";
    noteEl.innerHTML = `
      <div class="note-header">
        <span class="note-timestamp" data-url="${escapeHtml(note.timestampedUrl)}" data-seconds="${Number(note.timestampSeconds) || 0}">${escapeHtml(note.timestamp)}</span>
        ${!filteredVideoId ? `<span class="note-video-title">${escapeHtml(note.videoTitle)}</span>` : ""}
        <button class="note-delete" data-id="${escapeHtml(note.id)}" title="Delete note">✕</button>
      </div>
      <div class="note-text">"${escapeHtml(note.text)}"</div>
      <div class="note-actions">
        <button class="note-action-btn note-copy-text">⧉ Copy text</button>
        <button class="note-action-btn note-copy-link" data-url="${escapeHtml(note.timestampedUrl)}">🔗 Copy timestamp</button>
        <button class="note-action-btn note-play" data-seconds="${Number(note.timestampSeconds) || 0}">▶ Play</button>
      </div>
    `;

    // Timestamp click - play from this point (in this tab or a new one)
    noteEl.querySelector(".note-timestamp").addEventListener("click", () => {
      playNote(note);
    });

    // Delete button
    noteEl
      .querySelector(".note-delete")
      .addEventListener("click", async (e) => {
        e.stopPropagation();
        await deleteNote(note.id);
        loadNotes(filteredVideoId);
      });

    // Copy text button — copies just the note's text
    noteEl
      .querySelector(".note-copy-text")
      .addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(note.text);
          const btn = noteEl.querySelector(".note-copy-text");
          btn.textContent = "✓ Copied!";
          setTimeout(() => {
            btn.textContent = "⧉ Copy text";
          }, 2000);
        } catch (err) {
          console.error("Copy failed:", err);
        }
      });

    // Copy timestamp button — copies the timestamped YouTube link
    noteEl
      .querySelector(".note-copy-link")
      .addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(note.timestampedUrl);
          const btn = noteEl.querySelector(".note-copy-link");
          btn.textContent = "✓ Copied!";
          setTimeout(() => {
            btn.textContent = "🔗 Copy timestamp";
          }, 2000);
        } catch (err) {
          console.error("Copy failed:", err);
        }
      });

    // Play button (in this tab if it's the current video, else a new tab)
    noteEl.querySelector(".note-play").addEventListener("click", () => {
      playNote(note);
    });

    notesList.appendChild(noteEl);
  });
}

/**
 * Deletes a note by ID.
 */
async function deleteNote(noteId) {
  try {
    await chrome.runtime.sendMessage({
      action: "deleteNote",
      noteId: noteId,
    });
  } catch (error) {
    console.error("[YouTube Digest Panel] Delete note error:", error);
  }
}

// ============================================================
// AUTO-SCROLL — Follow video playback in transcript
// ============================================================
// While a video plays, the transcript automatically scrolls to show which
// 30-second chunk is currently being spoken. If the user manually scrolls
// (e.g., to read ahead), auto-scroll pauses and a "Follow playback" button
// appears so they can resume it. Highlight always stays active regardless.

/**
 * Starts polling the video's current time and highlighting/scrolling
 * to the matching transcript entry.
 */
function startPlaybackTracking() {
  if (!currentTranscript || !currentTranscript.length) return;

  syncFollowPlaybackButton();
  bindUserScrollIntentListeners();

  // Don't restart if already tracking (preserves user's auto-scroll state)
  if (autoScrollInterval) return;

  // Do NOT reset autoScrollEnabled here — the caller (startDigest or
  // Follow-playback button) is responsible for setting it to true when
  // appropriate. Switching back to the Transcript tab must not re-enable
  // auto-scroll if the user had already scrolled away.

  // Poll video time every 500ms
  autoScrollInterval = setInterval(() => playbackTrackingTick(), 500);
}

/**
 * The button is only an escape hatch shown while auto-scroll is off. While
 * following, it stays hidden — following is the state, not a pending action.
 */
function syncFollowPlaybackButton() {
  const button = document.getElementById("followPlaybackBtn");
  if (button) button.style.display = autoScrollEnabled ? "none" : "block";
}

/**
 * Binds the gestures that count as "the user took over scrolling". Bound once
 * on the content area, which outlives every transcript re-render.
 */
function bindUserScrollIntentListeners() {
  if (userScrollListenersBound) return;
  const contentArea = document.getElementById("contentArea");
  if (!contentArea) return;

  contentArea.addEventListener("wheel", releaseAutoScroll, { passive: true });
  contentArea.addEventListener("touchmove", releaseAutoScroll, { passive: true });
  contentArea.addEventListener("mousedown", onContentAreaPointerDown);
  contentArea.addEventListener("keydown", onContentAreaKeyDown);
  userScrollListenersBound = true;
}

/**
 * Stops playback tracking entirely. Called when leaving transcript tab,
 * starting a new digest, or leaving results state.
 */
function stopPlaybackTracking() {
  if (autoScrollInterval) {
    clearInterval(autoScrollInterval);
    autoScrollInterval = null;
  }
  anchorSettleUntil = 0;
  const followButton = document.getElementById("followPlaybackBtn");
  if (followButton) followButton.style.display = "none";

  // Remove active highlights
  document
    .querySelectorAll(".transcript-entry.active-playback")
    .forEach((el) => {
      el.classList.remove("active-playback");
    });
}

/**
 * One tick of the playback tracker. Gets current video time from the
 * YouTube tab and highlights + scrolls to the matching transcript entry.
 */
async function playbackTrackingTick() {
  try {
    const result = await chrome.runtime.sendMessage({
      action: "relayToContent",
      payload: { action: "getCurrentTime" },
    });

    if (!result.success || !result.response) return;

    const currentTime = result.response.currentTime || 0;
    lastKnownPlaybackSeconds = currentTime;
    highlightActiveEntry(currentTime);
    // Keep the translation window moving with playback so the viewer is never
    // waiting on segments they have already passed.
    requestTranslationAroundPlayback();
    // Re-anchor even when the highlight didn't move: rows above the spoken line
    // change height as translations stream in, which drifts it off-center.
    if (autoScrollEnabled) keepActiveEntryAnchored();
  } catch (error) {
    // Silently ignore — YouTube tab might be closed or navigated away
  }
}

/**
 * Nudges the spoken line back toward the middle of the viewport when it has
 * drifted past the tolerance. Does nothing while a previous smooth scroll is
 * still animating, so corrections never stack up and fight each other.
 */
function keepActiveEntryAnchored() {
  if (Date.now() < anchorSettleUntil) return;

  const contentArea = document.getElementById("contentArea");
  const activeEntry = document.querySelector(
    "#transcriptList .transcript-entry.active-playback",
  );
  if (!contentArea || !activeEntry) return;

  const viewport = contentArea.getBoundingClientRect();
  const row = activeEntry.getBoundingClientRect();
  const drift =
    (row.top + row.height / 2) - (viewport.top + viewport.height / 2);
  if (Math.abs(drift) <= ANCHOR_TOLERANCE_PX) return;

  anchorSettleUntil = Date.now() + ANCHOR_SETTLE_MS;
  activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
}

/**
 * Scrolls the transcript to the entry currently being spoken (the one
 * carrying the active-playback highlight). Returns false if nothing is
 * highlighted yet. Opens a settle window so the drift check doesn't fire
 * again while this animation is still running.
 */
function scrollToActiveEntry() {
  const activeEntry = document.querySelector(
    "#transcriptList .transcript-entry.active-playback",
  );
  if (!activeEntry) return false;

  anchorSettleUntil = Date.now() + ANCHOR_SETTLE_MS;
  activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
  return true;
}

/**
 * Finds the transcript entry matching the current playback time,
 * highlights it, and scrolls to it (if auto-scroll is enabled).
 *
 * @param {number} currentSeconds - Current video playback time in seconds
 */
function highlightActiveEntry(currentSeconds) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return;

  const entries = transcriptList.querySelectorAll(".transcript-entry");
  if (entries.length === 0) return;

  // Find the entry whose time range contains the current playback time
  let activeEntry = null;
  entries.forEach((entry, index) => {
    const entrySeconds = parseInt(entry.dataset.seconds);
    const nextEntry = entries[index + 1];
    const nextSeconds = nextEntry
      ? parseInt(nextEntry.dataset.seconds)
      : Infinity;

    if (currentSeconds >= entrySeconds && currentSeconds < nextSeconds) {
      activeEntry = entry;
    }
  });

  if (!activeEntry) return;

  const moved = !activeEntry.classList.contains("active-playback");
  if (moved) {
    // Remove old highlight, add new one
    entries.forEach((e) => e.classList.remove("active-playback"));
    activeEntry.classList.add("active-playback");
  }

  if (!autoScrollEnabled) return;

  // On re-render (tab switch / cache reload), jump instantly to the current
  // playback row without the smooth animation. After the first jump, revert
  // to smooth follow-along.
  if (jumpNextHighlightWithoutAnimation) {
    jumpNextHighlightWithoutAnimation = false;
    anchorSettleUntil = 0;
    activeEntry.scrollIntoView({ behavior: "instant", block: "center" });
    return;
  }

  if (moved) {
    anchorSettleUntil = Date.now() + ANCHOR_SETTLE_MS;
    activeEntry.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

/**
 * Hands scrolling back to the user. Called only from real input gestures —
 * never from scroll events, which our own smooth animation also fires.
 */
function releaseAutoScroll() {
  if (!autoScrollEnabled || !autoScrollInterval) return;
  autoScrollEnabled = false;
  anchorSettleUntil = 0;
  syncFollowPlaybackButton();
}

/**
 * A press on the scrollbar gutter (past the content edge) is a drag-to-scroll,
 * so it releases following. Clicks inside the transcript are seeks and must not.
 */
function onContentAreaPointerDown(event) {
  if (event.button !== 0) return;
  // clientWidth excludes the scrollbar, so a press to the right of it is on
  // the scrollbar itself regardless of which child element was under it.
  const contentArea = event.currentTarget;
  const rect = contentArea.getBoundingClientRect();
  if (event.clientX > rect.left + contentArea.clientWidth) releaseAutoScroll();
}

/** True for anything that consumes typing keys itself, such as the note editor. */
function isTextEntryTarget(target) {
  if (!target || target.nodeType !== 1) return false;
  const tag = target.tagName;
  return (
    tag === "TEXTAREA" ||
    tag === "INPUT" ||
    tag === "SELECT" ||
    target.isContentEditable === true
  );
}

/**
 * Whether a keypress inside the content area was the user scrolling. The event
 * can bubble up from any focused descendant, so the target decides: in a text
 * field these keys are typing, and Space on a focused control activates it —
 * only the scroll container itself scrolls on Space.
 */
function isScrollIntentKey(key, target, container) {
  if (!SCROLL_INTENT_KEYS.has(key)) return false;
  if (isTextEntryTarget(target)) return false;
  if (key === " " && target !== container) return false;
  return true;
}

function onContentAreaKeyDown(event) {
  if (isScrollIntentKey(event.key, event.target, event.currentTarget)) {
    releaseAutoScroll();
  }
}

// ============================================================
// TRANSCRIPT MODE UI — Original / Chinese / aligned bilingual
// ============================================================

function getOriginalTranscriptLabel() {
  const language = String(currentTranscriptLanguage || "").trim();
  return /^[A-Za-z0-9-]{1,20}$/.test(language)
    ? `Original (${language})`
    : "Original";
}

function getActiveTranscriptSegments() {
  return groupTranscriptEntries(currentTranscript || []);
}

function transcriptTranslationCacheKey(segment) {
  return `${currentVideoId}:zh:semantic:${segment.id}`;
}

function setTranscriptModeButtons(mode) {
  document.querySelectorAll(".transcript-mode-btn").forEach((button) => {
    const active = button.dataset.transcriptMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

async function handleTranscriptModeChange(mode) {
  if (!["original", "zh", "bilingual"].includes(mode)) return;
  if (mode === currentTranscriptMode) return;

  currentTranscriptMode = mode;
  translationGeneration += 1;
  translationWorkCount = 0;
  setTranslatingSpinner(false);
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();
  transcriptScrollObserver = null;
  setTranscriptModeButtons(mode);
  // Persist the mode immediately so a tab/app switch (which can reload the
  // side panel) restores the user's chosen view instead of falling back to
  // the original-language default.
  saveSessionState();

  if (mode === "original") {
    renderTranscript();
    return;
  }

  await translateTranscript();
}

function renderTranscriptSegmentContent(segment, mode, translated, error) {
  const original = renderSubtitleInlineMarkup(segment.text);
  let translationHtml = "";
  if (translated) {
    translationHtml = renderSubtitleInlineMarkup(translated);
  } else if (error) {
    translationHtml = `${escapeHtml(error)}<button class="translation-retry-btn" type="button">Retry</button>`;
  } else {
    translationHtml = "Waiting for translation…";
  }

  if (mode === "bilingual") {
    return `<span class="transcript-copy"><span class="transcript-original">${original}</span><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
  }

  return `<span class="transcript-copy"><span class="transcript-translation ${translated ? "" : error ? "translation-error" : "translation-pending"}">${translationHtml}</span></span>`;
}

function renderTranscriptModeRows(segments, mode) {
  const transcriptList = document.getElementById("transcriptList");
  if (!transcriptList) return [];
  transcriptList.innerHTML = "";

  const existingBadge = document.getElementById("transcriptSourceBadge");
  if (existingBadge) existingBadge.remove();
  const badge = document.createElement("div");
  badge.id = "transcriptSourceBadge";
  badge.className = "transcript-source-badge";
  const originalLabel = getOriginalTranscriptLabel();
  const modeLabel =
    mode === "bilingual"
      ? `${originalLabel} + 简体中文`
      : `简体中文 · translated from ${originalLabel}`;
  badge.innerHTML = `<span class="source-dot source-dot--subs"></span> From video subtitles · ${modeLabel}`;
  transcriptList.parentElement.insertBefore(badge, transcriptList);

  const rows = [];
  segments.forEach((segment, index) => {
    const div = document.createElement("div");
    const cached = transcriptParagraphCache.get(
      transcriptTranslationCacheKey(segment),
    );
    div.className = `transcript-entry ${cached ? "translated" : "translating"}`;
    div.dataset.seconds = segment.start;
    div.dataset.segmentId = segment.id;
    div.dataset.segmentIndex = index;

    const minutes = Math.floor(segment.start / 60);
    const seconds = Math.floor(segment.start % 60);
    const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;
    div.innerHTML = `
      <span class="transcript-time">${timestamp}</span>
      ${renderTranscriptSegmentContent(segment, mode, cached, "")}
    `;
    div.addEventListener("click", (event) =>
      seekFromTranscriptEntryClick(event, segment.start),
    );
    transcriptList.appendChild(div);
    rows.push(div);
  });

  startPlaybackTracking();
  return rows;
}

/**
 * Rebuilds a provider response in source order. Unknown IDs are ignored and
 * missing IDs remain explicit errors, never positional guesses.
 */
function alignTranslatedSegmentBatch(sourceSegments, responseSegments) {
  const translatedById = new Map();
  if (Array.isArray(responseSegments)) {
    responseSegments.forEach((item) => {
      if (!item || typeof item.id !== "string" || typeof item.text !== "string")
        return;
      const text = item.text.trim();
      if (text && !translatedById.has(item.id)) {
        translatedById.set(item.id, text);
      }
    });
  }

  return sourceSegments.map((segment) => ({
    id: segment.id,
    text: translatedById.get(segment.id) || "",
    error: translatedById.has(segment.id) ? "" : "Translation unavailable.",
  }));
}

function updateTranslatedRow(segment, index, alignedItem, generation) {
  if (generation !== translationGeneration) return;
  const row = document.querySelector(
    `.transcript-entry[data-segment-id="${CSS.escape(segment.id)}"]`,
  );
  if (!row) return;

  if (alignedItem.text) {
    transcriptParagraphCache.set(
      transcriptTranslationCacheKey(segment),
      alignedItem.text,
    );
    saveSessionState();
  }

  const copy = row.querySelector(".transcript-copy");
  if (copy) {
    copy.outerHTML = renderTranscriptSegmentContent(
      segment,
      currentTranscriptMode,
      alignedItem.text,
      alignedItem.error,
    );
  }
  row.classList.toggle("translated", !!alignedItem.text);
  row.classList.toggle("translating", false);
  row.classList.toggle("translation-failed", !alignedItem.text);

  const retry = row.querySelector(".translation-retry-btn");
  if (retry) {
    ["mousedown", "mouseup"].forEach((eventName) => {
      retry.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    });
    retry.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      retryTranslationSegment(index, generation);
    });
  }
}

let activeTranslationQueue = null;

async function requestTranscriptTranslationBatch(
  indices,
  segments,
  generation,
  videoId,
  mode,
) {
  const sourceBatch = indices.map((index) => segments[index]);
  setTranslatingSpinner(true);
  try {
    const result = await sendTranslationMessage({
      action: "translateContent",
      content: {
        segments: sourceBatch.map(({ id, text }) => ({ id, text })),
      },
      contentType: "transcriptBatch",
      targetLanguage: "zh",
      videoTitle: currentVideoTitle,
    });

    const isStale =
      generation !== translationGeneration ||
      videoId !== currentVideoId ||
      mode !== currentTranscriptMode;
    if (isStale) return;

    const responseSegments = result?.success
      ? result.translatedContent?.segments
      : [];
    const aligned = alignTranslatedSegmentBatch(sourceBatch, responseSegments);
    aligned.forEach((item, batchIndex) => {
      if (!result?.success) {
        item.error = result?.error || "Translation failed.";
      }
      updateTranslatedRow(
        sourceBatch[batchIndex],
        indices[batchIndex],
        item,
        generation,
      );
    });
    await updateCache();
  } catch (error) {
    if (generation !== translationGeneration) return;
    sourceBatch.forEach((segment, batchIndex) => {
      updateTranslatedRow(
        segment,
        indices[batchIndex],
        { id: segment.id, text: "", error: error.message || "Translation failed." },
        generation,
      );
    });
  } finally {
    setTranslatingSpinner(false);
  }
}

function retryTranslationSegment(index, generation) {
  if (generation !== translationGeneration || !activeTranslationQueue) return;
  const row = document.querySelector(
    `.transcript-entry[data-segment-index="${index}"]`,
  );
  if (row) {
    row.classList.add("translating");
    row.classList.remove("translation-failed");
    const translation = row.querySelector(".transcript-translation");
    if (translation) {
      translation.className = "transcript-translation translation-pending";
      translation.textContent = "Retrying…";
    }
  }
  activeTranslationQueue.enqueue(index, true);
}

/**
 * Renders immediately, translates the first small batch, then observes the
 * remaining rows. Batches are sequential so the provider is never flooded.
 */
async function translateTranscript() {
  const segments = getActiveTranscriptSegments();
  if (!segments.length || currentTranscriptMode === "original") return;

  translationGeneration += 1;
  const generation = translationGeneration;
  const videoId = currentVideoId;
  const mode = currentTranscriptMode;
  if (transcriptScrollObserver) transcriptScrollObserver.disconnect();

  const rows = renderTranscriptModeRows(segments, mode);
  const queue = [];
  const queued = new Set();
  const inFlight = new Set();
  let processing = false;

  const processNext = async () => {
    if (processing || queue.length === 0 || generation !== translationGeneration)
      return;
    processing = true;
    // Batches are cut at dispatch time, so a segment promoted while an earlier
    // batch was in flight goes out in the very next request. Segments that got
    // cached while waiting (e.g. by an overlapping batch) are dropped here.
    const indices = queue.splice(0, 3).filter((index) => {
      queued.delete(index);
      return !transcriptParagraphCache.has(
        transcriptTranslationCacheKey(segments[index]),
      );
    });
    if (!indices.length) {
      processing = false;
      if (queue.length && generation === translationGeneration) processNext();
      return;
    }
    indices.forEach((index) => inFlight.add(index));
    try {
      await requestTranscriptTranslationBatch(
        indices,
        segments,
        generation,
        videoId,
        mode,
      );
    } finally {
      indices.forEach((index) => inFlight.delete(index));
      processing = false;
      if (queue.length && generation === translationGeneration) processNext();
    }
  };

  // priority=true puts the segment at the head of the queue: playback-window
  // work must not wait behind whatever the viewport queued earlier.
  const enqueue = (index, force = false, priority = false) => {
    if (!Number.isInteger(index) || !segments[index]) return;
    if (inFlight.has(index)) return;
    const cached = transcriptParagraphCache.has(
      transcriptTranslationCacheKey(segments[index]),
    );
    if (!force && cached) return;
    if (queued.has(index)) {
      if (!priority) return;
      // Already waiting, but now it is on-screen for playback — move it up.
      const position = queue.indexOf(index);
      if (position > 0) queue.splice(position, 1);
      else return;
    } else {
      queued.add(index);
    }
    if (priority) queue.unshift(index);
    else queue.push(index);
    // Let all entries reported in the same viewport turn collect before the
    // worker starts, producing one small contextual multi-segment request.
    Promise.resolve().then(processNext);
  };
  activeTranslationQueue = { enqueue, segments, generation };

  transcriptScrollObserver = new IntersectionObserver(
    (observerEntries) => {
      observerEntries
        .filter((entry) => entry.isIntersecting)
        .sort(
          (a, b) =>
            Number(a.target.dataset.segmentIndex) -
            Number(b.target.dataset.segmentIndex),
        )
        .forEach((entry) => enqueue(Number(entry.target.dataset.segmentIndex)));
    },
    {
      root: document.getElementById("contentArea"),
      rootMargin: "320px 0px",
      threshold: 0,
    },
  );

  rows.forEach((row) => {
    if (!row.classList.contains("translated")) transcriptScrollObserver.observe(row);
  });

  // Seed from wherever playback is, not from the top of the video. On a fresh
  // load lastKnownPlaybackSeconds is 0, which naturally seeds the opening.
  requestTranslationAroundPlayback();
}

/**
 * Queues the segments around the current playback position ahead of everything
 * else, so the line being spoken is translated first and the viewer is not
 * waiting for a sweep that started at the beginning of the video.
 */
function requestTranslationAroundPlayback() {
  if (!activeTranslationQueue) return;
  if (currentTranscriptMode === "original") return;
  const { enqueue, segments, generation } = activeTranslationQueue;
  if (generation !== translationGeneration || !segments?.length) return;

  const active = findSegmentIndexForTime(segments, lastKnownPlaybackSeconds);
  if (active === -1) return;

  const first = Math.max(0, active - TRANSLATION_LOOKBEHIND_SEGMENTS);
  const last = Math.min(
    segments.length - 1,
    active + TRANSLATION_LOOKAHEAD_SEGMENTS,
  );

  // Walk outward from the spoken segment so the closest lines land first, and
  // unshift in reverse so the final queue order runs forward through the window.
  const window = [];
  for (let index = active; index <= last; index += 1) window.push(index);
  for (let index = active - 1; index >= first; index -= 1) window.push(index);
  window.reverse().forEach((index) => enqueue(index, false, true));
}

/**
 * Index of the segment whose time range contains the given second, or -1 when
 * the segment list is empty. Times before the first segment resolve to it.
 */
function findSegmentIndexForTime(segments, seconds) {
  if (!segments.length) return -1;
  let match = 0;
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index].start <= seconds) match = index;
    else break;
  }
  return match;
}

function setTranslatingSpinner(show) {
  if (show) translationWorkCount += 1;
  else translationWorkCount = Math.max(0, translationWorkCount - 1);
  const isTranslating = translationWorkCount > 0;
  const spinner = document.getElementById("langSpinner");
  if (spinner) spinner.classList.toggle("visible", isTranslating);
}

// Pure helpers are exposed for the repository's Node tests. The extension does
// not read this object at runtime.
globalThis.__YTD_TRANSCRIPT_TESTING__ = {
  sendTranslationMessage,
  groupTranscriptEntries,
  splitOversizedThought,
  alignTranslatedSegmentBatch,
  renderSubtitleInlineMarkup,
  renderTranscriptSegmentContent,
  findSegmentIndexForTime,
  isScrollIntentKey,
  isTextEntryTarget,
  normalizeGlossLine,
  normalizeGlossSenses,
  fetchGlossBatch,
  buildVocabCardItems,
  isVocabCandidate,
  findSentenceForSelection,
};
