// CleanSubs - Content Script v4.9.1
let currentSubtitles = [];
let stitchedSegments = [];
let translations = [];

// Master registry for clean event deduplication and zero-drift translation caching
const masterRawEventsMap = new Map();
const knownTranslations = new Map();
let currentVideoId = null;

let processedVideoId = null;
let activeRequestId = null;
let pendingVideoId = null;
let lastSentCount = 0;

let activePort = null;
let portPingInterval = null;
let workerListener = null;
let watchdogId = null;
let lastProgressAt = 0;

let syncTimerId = null;
let activeSubtitleIndex = -1;
let overlayTextEl = null;
let videoEl = null;

function isExtensionContextValid() {
  try {
    return typeof chrome !== "undefined" && !!chrome.runtime?.id;
  } catch (_) {
    return false;
  }
}

// Pure string-based entity decoder - 100% Trusted Types safe, 0 DOM sinks, 0 CSP violations
const HTML_ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&#039;": "'",
  "&nbsp;": " ",
  "&ndash;": "–",
  "&mdash;": "—",
  "&hellip;": "…",
  "&laquo;": "«",
  "&raquo;": "»",
  "&lsquo;": "‘",
  "&rsquo;": "’",
  "&ldquo;": "“",
  "&rdquo;": "”",
  "&auml;": "ä",
  "&ouml;": "ö",
  "&uuml;": "ü",
  "&Auml;": "Ä",
  "&Ouml;": "Ö",
  "&Uuml;": "Ü",
  "&szlig;": "ß",
  "&euro;": "€",
  "&copy;": "©",
  "&reg;": "®"
};

const ENTITY_REGEX = /&(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/g;

function decodeHtml(str) {
  if (!str || typeof str !== "string" || !str.includes("&")) return str || "";

  let decoded = str;
  for (let pass = 0; pass < 2; pass++) {
    if (!decoded.includes("&")) break;
    decoded = decoded.replace(ENTITY_REGEX, (match) => {
      const lower = match.toLowerCase();
      if (HTML_ENTITIES[match]) return HTML_ENTITIES[match];
      if (HTML_ENTITIES[lower]) return HTML_ENTITIES[lower];

      if (match.startsWith("&#") && !match.startsWith("&#x") && !match.startsWith("&#X")) {
        const code = parseInt(match.slice(2, -1), 10);
        if (!isNaN(code) && code >= 0 && code <= 0x10ffff) {
          try {
            return String.fromCodePoint(code);
          } catch (_) {
            return match;
          }
        }
      }

      if (match.startsWith("&#x") || match.startsWith("&#X")) {
        const code = parseInt(match.slice(3, -1), 16);
        if (!isNaN(code) && code >= 0 && code <= 0x10ffff) {
          try {
            return String.fromCodePoint(code);
          } catch (_) {
            return match;
          }
        }
      }

      return match;
    });
  }
  return decoded;
}

const SOUND_EFFECT_PATTERNS = [
  { re: /^\s*[[(]\s*(musik|music)\s*[\])]\s*$/i, out: "[Music]" },
  { re: /^\s*[[(]\s*(applaus|applause|beifall)\s*[\])]\s*$/i, out: "[Applause]" },
  { re: /^\s*[[(]\s*(lachen|gelächter|laughter)\s*[\])]\s*$/i, out: "[Laughter]" },
  { re: /^\s*[[(]\s*(stille|silence)\s*[\])]\s*$/i, out: "[Silence]" },
  { re: /^\s*[[(]\s*(seufzen|sigh)\s*[\])]\s*$/i, out: "[Sigh]" }
];

function getSoundEffectTranslation(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  for (const { re, out } of SOUND_EFFECT_PATTERNS) {
    if (re.test(t)) return out;
  }
  return null;
}

function getCurrentVideoId() {
  try {
    const matchShorts = window.location.pathname.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
    if (matchShorts && matchShorts[1]) return matchShorts[1];

    const matchEmbed = window.location.pathname.match(/\/embed\/([a-zA-Z0-9_-]+)/);
    if (matchEmbed && matchEmbed[1]) return matchEmbed[1];

    return new URLSearchParams(window.location.search).get("v") || "";
  } catch (_) {
    return "";
  }
}

function computeProportionalWords(text, startMs, durMs) {
  const tokens = String(text || "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const safeDur = Math.max(250, durMs);

  let totalWeight = 0;
  const weights = tokens.map((w) => {
    let weight = Math.max(1, w.length);
    if (/[,;]$/.test(w)) weight += 2;
    if (/[.!?…]$/.test(w)) weight += 3;
    totalWeight += weight;
    return weight;
  });

  const words = [];
  let currentStart = startMs;
  for (let i = 0; i < tokens.length; i++) {
    const fraction = weights[i] / totalWeight;
    const wordDur = Math.max(120, Math.round(fraction * safeDur));
    const wordEnd = i === tokens.length - 1 ? startMs + safeDur : currentStart + wordDur;
    words.push({
      text: tokens[i],
      startMs: currentStart,
      endMs: Math.max(currentStart + 100, wordEnd)
    });
    currentStart = wordEnd;
  }
  return words;
}

function parseJson3Segments(segs, eventStartMs, eventDurMs) {
  if (!Array.isArray(segs) || !segs.length) return [];
  const rawWords = [];

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const rawText = decodeHtml(s.utf8 || "").trim();
    if (!rawText) continue;

    const offset = Number(s.tOffsetMs) || 0;
    const wordStart = eventStartMs + offset;

    let nextOffset = eventDurMs;
    for (let j = i + 1; j < segs.length; j++) {
      if (Number.isFinite(segs[j].tOffsetMs) && segs[j].tOffsetMs > offset) {
        nextOffset = segs[j].tOffsetMs;
        break;
      }
    }
    const segmentDur = Math.max(120, nextOffset - offset);

    const subWords = rawText.split(/\s+/).filter(Boolean);
    if (subWords.length <= 1) {
      rawWords.push({
        text: rawText,
        startMs: wordStart,
        endMs: wordStart + segmentDur
      });
    } else {
      rawWords.push(...computeProportionalWords(rawText, wordStart, segmentDur));
    }
  }

  for (let i = 0; i < rawWords.length - 1; i++) {
    if (rawWords[i].endMs > rawWords[i + 1].startMs) {
      rawWords[i].endMs = rawWords[i + 1].startMs;
    }
  }
  return rawWords;
}

function parseFormat3Segments(innerXml, pStartMs, pDurMs) {
  const sTagRegex = /<s\b([^>]*)>([\s\S]*?)<\/s>/gi;
  const rawWords = [];
  let sMatch;
  const sItems = [];

  while ((sMatch = sTagRegex.exec(innerXml)) !== null) {
    const sAttrs = sMatch[1];
    const sText = decodeHtml(sMatch[2] || "").replace(/<[^>]+>/g, "").trim();
    if (!sText) continue;

    const tMatch = sAttrs.match(/\bt=['"]?(\d+)['"]?/i);
    const offsetMs = tMatch ? parseInt(tMatch[1], 10) : 0;
    sItems.push({ text: sText, offsetMs });
  }

  if (!sItems.length) return [];

  for (let i = 0; i < sItems.length; i++) {
    const cur = sItems[i];
    const wordStart = pStartMs + cur.offsetMs;
    const nextOffset = i + 1 < sItems.length ? sItems[i + 1].offsetMs : pDurMs;
    const dur = Math.max(120, nextOffset - cur.offsetMs);

    const subWords = cur.text.split(/\s+/).filter(Boolean);
    if (subWords.length <= 1) {
      rawWords.push({
        text: cur.text,
        startMs: wordStart,
        endMs: wordStart + dur
      });
    } else {
      rawWords.push(...computeProportionalWords(cur.text, wordStart, dur));
    }
  }

  for (let i = 0; i < rawWords.length - 1; i++) {
    if (rawWords[i].endMs > rawWords[i + 1].startMs) {
      rawWords[i].endMs = rawWords[i + 1].startMs;
    }
  }
  return rawWords;
}

function parseWebVtt(vttText) {
  const events = [];
  const lines = vttText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const timeRegex = /(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})/;

  let currentStartMs = null;
  let currentEndMs = null;
  let textLines = [];

  function flush() {
    if (currentStartMs !== null && textLines.length > 0) {
      const cleanText = decodeHtml(
        textLines
          .join(" ")
          .replace(/<[^>]+>/g, "")
          .trim()
      );
      if (cleanText) {
        const durMs = Math.max(250, (currentEndMs || currentStartMs + 2000) - currentStartMs);
        events.push({
          tStartMs: currentStartMs,
          dDurationMs: durMs,
          text: cleanText,
          words: computeProportionalWords(cleanText, currentStartMs, durMs)
        });
      }
    }
    currentStartMs = null;
    currentEndMs = null;
    textLines = [];
  }

  function parseTime(hours, mins, secs, ms) {
    const h = parseInt(hours || "0", 10);
    const m = parseInt(mins || "0", 10);
    const s = parseInt(secs || "0", 10);
    const milli = parseInt(ms || "0", 10);
    return (h * 3600 + m * 60 + s) * 1000 + milli;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const match = line.match(timeRegex);
    if (match) {
      flush();
      currentStartMs = parseTime(match[1], match[2], match[3], match[4]);
      currentEndMs = parseTime(match[5], match[6], match[7], match[8]);
    } else if (currentStartMs !== null) {
      if (line === "") {
        flush();
      } else if (!line.startsWith("NOTE") && !line.startsWith("STYLE") && !line.startsWith("REGION")) {
        textLines.push(line);
      }
    }
  }
  flush();
  return events;
}

function parseRawCaptionsPayload(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed || trimmed.length < 10) return [];
  const events = [];

  // 1. JSON format (fmt=json3)
  if (trimmed.startsWith("{")) {
    try {
      const data = JSON.parse(trimmed);

      for (const ev of data.events || []) {
        if (!ev.segs) continue;

        const startMs = Number(ev.tStartMs);
        if (!Number.isFinite(startMs)) continue;

        const text = ev.segs.map((s) => s.utf8 || "").join("").trim();

        if (text) {
          const cleanText = decodeHtml(text);
          const durMs = Number(ev.dDurationMs) || 2000;
          const parsedWords = parseJson3Segments(ev.segs, startMs, durMs);
          events.push({
            tStartMs: startMs,
            dDurationMs: durMs,
            text: cleanText,
            words: parsedWords.length > 0 ? parsedWords : computeProportionalWords(cleanText, startMs, durMs)
          });
        }
      }

      if (events.length > 0) return events;
    } catch (_) {}
  }

  // 2. WebVTT format (timestamps containing -->)
  if (trimmed.includes("-->")) {
    try {
      const vttEvents = parseWebVtt(trimmed);
      if (vttEvents.length > 0) return vttEvents;
    } catch (_) {}
  }

  // 3. Format 3 & Format 2 XML (<timedtext format="3"> or <p t="..." d="...">)
  if (trimmed.includes("<p ") || trimmed.includes("<p>")) {
    const pTagRegex = /<p\b([^>]*)(?:>([\s\S]*?)<\/p>|\/>)/gi;
    let pMatch;
    while ((pMatch = pTagRegex.exec(trimmed)) !== null) {
      const attrs = pMatch[1];
      const inner = pMatch[2] || "";

      const tMatch = attrs.match(/\bt=['"]?(\d+)['"]?/i);
      if (!tMatch) continue;
      const startMs = parseInt(tMatch[1], 10);

      const dMatch = attrs.match(/\bd=['"]?(\d+)['"]?/i);
      const durMs = dMatch ? parseInt(dMatch[1], 10) : 2000;

      const cleanText = decodeHtml(
        inner
          .replace(/<br\s*\/?>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      );
      if (cleanText) {
        const parsedWords = parseFormat3Segments(inner, startMs, durMs);
        events.push({
          tStartMs: startMs,
          dDurationMs: durMs,
          text: cleanText,
          words: parsedWords.length > 0 ? parsedWords : computeProportionalWords(cleanText, startMs, durMs)
        });
      }
    }
    if (events.length > 0) return events;
  }

  // 4. Format 1 XML (<transcript> or <text start="..." dur="...">)
  if (trimmed.includes("<text ") || trimmed.includes("<text>")) {
    const textTagRegex = /<text\b([^>]*)(?:>([\s\S]*?)<\/text>|\/>)/gi;
    let textMatch;
    while ((textMatch = textTagRegex.exec(trimmed)) !== null) {
      const attrs = textMatch[1];
      const inner = textMatch[2] || "";

      const startMatch = attrs.match(/\bstart=['"]?([\d.]+)['"]?/i);
      if (!startMatch) continue;
      const startSec = parseFloat(startMatch[1]);

      const durMatch = attrs.match(/\bdur=['"]?([\d.]+)['"]?/i);
      const durSec = durMatch ? parseFloat(durMatch[1]) : 2.0;

      const cleanText = decodeHtml(
        inner
          .replace(/<br\s*\/?>/gi, " ")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
      );
      if (cleanText) {
        const startMs = Math.round(startSec * 1000);
        const durMs = Math.round(durSec * 1000);
        events.push({
          tStartMs: startMs,
          dDurationMs: durMs,
          text: cleanText,
          words: computeProportionalWords(cleanText, startMs, durMs)
        });
      }
    }
    if (events.length > 0) return events;
  }

  return events;
}

function deduplicateGermanEvents(rawEvents) {
  if (!Array.isArray(rawEvents) || !rawEvents.length) return [];

  const sorted = [...rawEvents].sort(
    (a, b) => (Number(a.tStartMs) || 0) - (Number(b.tStartMs) || 0)
  );

  const clean = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    const curText = String(cur.text || "").replace(/\s+/g, " ").trim();
    if (!curText) continue;

    const cStart = Math.max(0, Number(cur.tStartMs) || 0);
    let cDur = Number(cur.dDurationMs);
    if (!Number.isFinite(cDur) || cDur < 250) cDur = 2000;
    if (cDur > 20000) cDur = 20000;

    const curWords = Array.isArray(cur.words) && cur.words.length > 0
      ? cur.words
      : computeProportionalWords(curText, cStart, cDur);

    const prev = clean.length > 0 ? clean[clean.length - 1] : null;
    if (prev) {
      const prevNorm = prev.text.toLowerCase();
      const curNorm = curText.toLowerCase();

      // 1. Identical text within 600ms -> merge duration
      if (prevNorm === curNorm && Math.abs(cStart - prev.tStartMs) < 600) {
        prev.dDurationMs = Math.max(prev.dDurationMs, cStart + cDur - prev.tStartMs);
        continue;
      }

      // 2. Rolling caption prefix: curText starts with prev.text within 1500ms
      if (curNorm.startsWith(prevNorm + " ") && cStart - prev.tStartMs < 1500) {
        clean[clean.length - 1] = {
          tStartMs: prev.tStartMs,
          dDurationMs: Math.max(prev.dDurationMs, cStart + cDur - prev.tStartMs),
          text: curText,
          words: curWords
        };
        continue;
      }

      // 3. Rolling caption suffix: prev.text ends with curText within 1500ms
      if (prevNorm.endsWith(" " + curNorm) && Math.abs(cStart - prev.tStartMs) < 1500) {
        continue;
      }
    }

    clean.push({
      tStartMs: cStart,
      dDurationMs: cDur,
      text: curText,
      words: curWords
    });
  }

  return clean;
}

function stitchGermanSegments(rawEvents) {
  if (!Array.isArray(rawEvents)) return [];

  const cleanEvents = deduplicateGermanEvents(rawEvents);
  if (!cleanEvents.length) return [];

  const stitched = [];
  let buffer = null;

  const MAX_GAP_MS = 450;
  const MAX_WORDS = 14;
  const END_TAIL_MS = 60;

  for (const item of cleanEvents) {
    const text = item.text;
    const start = item.tStartMs;
    const end = start + item.dDurationMs;
    const itemWords = Array.isArray(item.words) && item.words.length > 0
      ? item.words
      : computeProportionalWords(text, start, item.dDurationMs);

    if (!buffer) {
      buffer = { text, startMs: start, endMs: end, words: [...itemWords] };
      continue;
    }

    const pauseDuration = start - buffer.endMs;
    const endsWithTerminal = /[.!?…]$/.test(buffer.text);
    const wordCount = buffer.text.split(/\s+/).length;

    if (pauseDuration > MAX_GAP_MS || endsWithTerminal || wordCount >= MAX_WORDS) {
      buffer.endMs = Math.max(buffer.startMs + 250, buffer.endMs - END_TAIL_MS);
      if (buffer.endMs > start - 30) {
        buffer.endMs = Math.max(buffer.startMs + 250, start - 30);
      }
      stitched.push(buffer);
      buffer = { text, startMs: start, endMs: end, words: [...itemWords] };
      continue;
    }

    // Overlapping word boundary deduplication (e.g., "Leute" and "Leute willkommen")
    const bufWords = buffer.text.split(/\s+/);
    const itemWordsList = text.split(/\s+/);
    if (
      bufWords.length > 0 &&
      itemWordsList.length > 0 &&
      bufWords[bufWords.length - 1].toLowerCase() === itemWordsList[0].toLowerCase()
    ) {
      buffer.text += " " + itemWordsList.slice(1).join(" ");
      buffer.words.push(...itemWords.slice(1));
    } else {
      buffer.text += " " + text;
      buffer.words.push(...itemWords);
    }
    buffer.endMs = Math.max(buffer.endMs, end);
  }

  if (buffer) {
    buffer.endMs = Math.max(buffer.startMs + 250, buffer.endMs - END_TAIL_MS);
    stitched.push(buffer);
  }

  // Final monotonic clamp pass: guarantee strictly increasing non-overlapping intervals
  for (let i = 0; i < stitched.length - 1; i++) {
    const cur = stitched[i];
    const nxt = stitched[i + 1];
    if (cur.endMs >= nxt.startMs) {
      cur.endMs = Math.max(cur.startMs + 200, nxt.startMs - 30);
    }
  }

  // Final pass: clamp words within each segment boundary
  for (const seg of stitched) {
    if (Array.isArray(seg.words)) {
      for (let w = 0; w < seg.words.length; w++) {
        if (seg.words[w].endMs > seg.endMs) seg.words[w].endMs = seg.endMs;
        if (w < seg.words.length - 1 && seg.words[w].endMs > seg.words[w + 1].startMs) {
          seg.words[w].endMs = seg.words[w + 1].startMs;
        }
      }
    }
  }

  return stitched;
}

let currentFontSize = "normal";
let currentSubtitleMode = "bilingual";
let currentSubtitlePos = "bottom"; // 'bottom', 'top', 'custom'
let customPosCoords = null; // { leftPct, topPct }
let isDragging = false;
let overlayElements = null;
let extensionEnabled = true;

// Quiz / Reveal mode
let quizRevealed = false;

// Cue Loop mode
let isLooping = false;
let loopCueIndex = -1;

// Auto-Pause mode
let autoPauseEnabled = false;

// Vocabulary highlighting
let vocabWordsSet = new Set();

// Session stats
let sessionStats = { cuesSeen: new Set(), wordsSaved: 0 };

function updatePlayerBadge() {
  const badge = document.querySelector(".clean-subs-btn-badge");
  const btn = document.getElementById("clean-subs-player-btn");
  if (!badge) return;
  if (!extensionEnabled) {
    badge.textContent = "OFF";
    btn?.classList.add("disabled");
    return;
  }
  btn?.classList.remove("disabled");
  const modeLabels = { bilingual: "BI", english: "EN", german: "DE", quiz: "QZ" };
  badge.textContent = modeLabels[currentSubtitleMode] || "CS";
}

function updateContainerClasses() {
  const c = document.getElementById("clean-subs-container");
  if (c) {
    c.className = `font-${currentFontSize} mode-${currentSubtitleMode} pos-${currentSubtitlePos}`;
    if (currentSubtitlePos === "custom" && customPosCoords) {
      c.style.left = customPosCoords.leftPct + "%";
      c.style.top = customPosCoords.topPct + "%";
      c.style.bottom = "auto";
      c.style.transform = "none";
    } else {
      c.style.left = "";
      c.style.top = "";
      c.style.bottom = "";
      c.style.transform = "";
    }
  }
  updatePlayerBadge();
}

if (isExtensionContextValid()) {
  try {
    chrome.storage.local.get(["fontSize", "subtitleMode", "subtitlePosition", "customPosCoords", "extensionEnabled", "autoPauseEnabled", "karaokeHighlightEnabled", "vocabularyBank"], (res) => {
      if (res?.fontSize) currentFontSize = res.fontSize;
      if (res?.subtitleMode) currentSubtitleMode = res.subtitleMode;
      if (res?.subtitlePosition) currentSubtitlePos = res.subtitlePosition;
      if (res?.customPosCoords) customPosCoords = res.customPosCoords;
      extensionEnabled = res?.extensionEnabled !== false;
      autoPauseEnabled = res?.autoPauseEnabled === true;
      karaokeHighlightEnabled = res?.karaokeHighlightEnabled !== false;
      // Build vocab words set for highlighting
      if (Array.isArray(res?.vocabularyBank)) {
        vocabWordsSet = new Set();
        for (const item of res.vocabularyBank) {
          if (item.german) {
            for (const w of item.german.toLowerCase().split(/\s+/)) {
              if (w.length > 2) vocabWordsSet.add(w);
            }
          }
        }
      }
      updateContainerClasses();
    });
    chrome.storage.onChanged.addListener((changes) => {
      let shouldRebuild = false;
      if (changes.fontSize?.newValue) {
        currentFontSize = changes.fontSize.newValue;
        updateContainerClasses();
      }
      if (changes.subtitleMode?.newValue) {
        currentSubtitleMode = changes.subtitleMode.newValue;
        quizRevealed = false;
        updateContainerClasses();
        shouldRebuild = true;
      }
      if (changes.subtitlePosition?.newValue) {
        currentSubtitlePos = changes.subtitlePosition.newValue;
        updateContainerClasses();
      }
      if (changes.customPosCoords?.newValue) {
        customPosCoords = changes.customPosCoords.newValue;
        updateContainerClasses();
      }
      if (changes.extensionEnabled !== undefined) {
        extensionEnabled = changes.extensionEnabled.newValue !== false;
        if (!extensionEnabled) {
          hideOverlay();
          hideStatusToast();
        } else if (activeSubtitleIndex >= 0) {
          renderCue(activeSubtitleIndex);
        }
      }
      if (changes.autoPauseEnabled !== undefined) {
        autoPauseEnabled = changes.autoPauseEnabled.newValue === true;
      }
      if (changes.karaokeHighlightEnabled !== undefined) {
        karaokeHighlightEnabled = changes.karaokeHighlightEnabled.newValue !== false;
        if (!karaokeHighlightEnabled) {
          for (const item of activeCueWordElements) {
            item.span.classList.remove("word-active", "word-spoken", "word-upcoming");
          }
          lastActiveWordIndex = -1;
        } else if (activeSubtitleIndex >= 0) {
          const v = getCachedVideo();
          if (v) updateKaraokeWordHighlight(Number(v.currentTime || 0));
        }
      }
      if (changes.vocabularyBank?.newValue) {
        vocabWordsSet = new Set();
        if (Array.isArray(changes.vocabularyBank.newValue)) {
          for (const item of changes.vocabularyBank.newValue) {
            if (item.german) {
              for (const w of item.german.toLowerCase().split(/\s+/)) {
                if (w.length > 2) vocabWordsSet.add(w);
              }
            }
          }
        }
        if (activeSubtitleIndex >= 0) renderCue(activeSubtitleIndex);
      }
      if (shouldRebuild) {
        rebuildSubtitles();
        if (activeSubtitleIndex >= 0) {
          renderCue(activeSubtitleIndex);
        }
        if (currentSubtitleMode !== "german") {
          requestTranslationIfNeeded();
        }
      }
    });
  } catch (_) {}
}

function setupBoxInteractions(container, box) {
  if (box.__cleanSubsInteractionsHooked) return;
  box.__cleanSubsInteractionsHooked = true;

  // Add bookmark button
  let bookmarkBtn = box.querySelector("#clean-subs-bookmark-btn");
  if (!bookmarkBtn) {
    bookmarkBtn = document.createElement("button");
    bookmarkBtn.id = "clean-subs-bookmark-btn";
    bookmarkBtn.className = "clean-subs-bookmark-btn";
    bookmarkBtn.title = "Save cue to Anki / Vocabulary (Alt+S)";
    bookmarkBtn.textContent = "★";
    bookmarkBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      saveCurrentCueToVocabulary();
    });
    box.appendChild(bookmarkBtn);
  }

  // Mouse Dragging for custom subtitle position
  box.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest(".clean-subs-bookmark-btn")) return;

    // Click on blurred quiz translation reveals it directly
    if (e.target.closest(".clean-subs-quiz-hidden")) {
      e.stopPropagation();
      e.preventDefault();
      quizRevealed = true;
      if (activeSubtitleIndex >= 0) renderCue(activeSubtitleIndex);
      return;
    }

    // Do not initiate drag when clicking a word for dictionary lookup
    if (e.target.closest(".clean-subs-word")) return;

    const player = document.querySelector(".html5-video-player");
    if (!player) return;

    isDragging = true;
    box.classList.add("dragging");
    const pRect = player.getBoundingClientRect();
    const cRect = container.getBoundingClientRect();

    const startMouseX = e.clientX;
    const startMouseY = e.clientY;
    const startLeft = cRect.left - pRect.left;
    const startTop = cRect.top - pRect.top;

    const onMouseMove = (ev) => {
      if (!isDragging) return;
      const dx = ev.clientX - startMouseX;
      const dy = ev.clientY - startMouseY;
      let newLeft = startLeft + dx;
      let newTop = startTop + dy;

      newLeft = Math.max(10, Math.min(newLeft, pRect.width - cRect.width - 10));
      newTop = Math.max(10, Math.min(newTop, pRect.height - cRect.height - 10));

      const leftPct = (newLeft / pRect.width) * 100;
      const topPct = (newTop / pRect.height) * 100;

      container.style.left = leftPct + "%";
      container.style.top = topPct + "%";
      container.style.bottom = "auto";
      container.style.transform = "none";

      currentSubtitlePos = "custom";
      customPosCoords = { leftPct, topPct };
      updateContainerClasses();
    };

    const onMouseUp = () => {
      if (!isDragging) return;
      isDragging = false;
      box.classList.remove("dragging");
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);

      if (customPosCoords) {
        chrome.storage.local.set({
          subtitlePosition: "custom",
          customPosCoords
        });
      }
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  });
}

function ensureOverlay() {
  const playerContainer = document.querySelector(".html5-video-player");
  if (!playerContainer) return null;

  let container = document.getElementById("clean-subs-container");
  let box = document.getElementById("clean-subs-box");
  let original = document.getElementById("clean-subs-original");
  let translated = document.getElementById("clean-subs-translated");

  if (!container || !container.isConnected) {
    container = document.createElement("div");
    container.id = "clean-subs-container";
    container.className = `font-${currentFontSize} mode-${currentSubtitleMode} pos-${currentSubtitlePos}`;

    box = document.createElement("div");
    box.id = "clean-subs-box";

    original = document.createElement("div");
    original.id = "clean-subs-original";
    original.className = "clean-subs-line clean-subs-original";

    translated = document.createElement("div");
    translated.id = "clean-subs-translated";
    translated.className = "clean-subs-line clean-subs-translated";

    box.appendChild(original);
    box.appendChild(translated);
    container.appendChild(box);
    playerContainer.appendChild(container);
    setupBoxInteractions(container, box);
  } else {
    updateContainerClasses();
    if (!box || !box.isConnected) {
      box = document.createElement("div");
      box.id = "clean-subs-box";

      original = document.createElement("div");
      original.id = "clean-subs-original";
      original.className = "clean-subs-line clean-subs-original";

      translated = document.createElement("div");
      translated.id = "clean-subs-translated";
      translated.className = "clean-subs-line clean-subs-translated";

      box.appendChild(original);
      box.appendChild(translated);
      container.appendChild(box);
      setupBoxInteractions(container, box);
    }
  }

  overlayElements = { container, box, original, translated };
  return overlayElements;
}

function hideOverlay() {
  const box = document.getElementById("clean-subs-box");
  if (box) box.style.display = "none";
}

let toastEl = null;
let toastTimerId = null;

function showStatusToast(message, type = "info", duration = 3000) {
  try {
    const playerContainer = document.querySelector(".html5-video-player");
    if (!playerContainer) return;

    if (!toastEl || !toastEl.isConnected) {
      toastEl = document.createElement("div");
      toastEl.id = "clean-subs-toast";
      playerContainer.appendChild(toastEl);
    }

    toastEl.className = `clean-subs-toast ${type} visible`;
    toastEl.textContent = message;

    if (toastTimerId) clearTimeout(toastTimerId);
    if (duration > 0) {
      toastTimerId = setTimeout(() => {
        if (toastEl && toastEl.isConnected) {
          toastEl.classList.remove("visible");
        }
      }, duration);
    }
  } catch (_) {}
}

function hideStatusToast() {
  if (toastTimerId) {
    clearTimeout(toastTimerId);
    toastTimerId = null;
  }
  if (toastEl && toastEl.isConnected) {
    toastEl.classList.remove("visible");
  }
}

let activeCueWordElements = [];
let lastActiveWordIndex = -1;
let karaokeHighlightEnabled = true;

function updateKaraokeWordHighlight(playbackSec) {
  if (!karaokeHighlightEnabled || !activeCueWordElements.length) return;
  const nowMs = Math.round(playbackSec * 1000);

  let activeIdx = -1;
  for (let i = 0; i < activeCueWordElements.length; i++) {
    const item = activeCueWordElements[i];
    if (nowMs >= item.startMs && nowMs < item.endMs) {
      activeIdx = i;
      break;
    }
  }

  if (activeIdx === -1 && activeCueWordElements.length > 0) {
    const first = activeCueWordElements[0];
    const last = activeCueWordElements[activeCueWordElements.length - 1];
    if (nowMs < first.startMs) {
      activeIdx = -1;
    } else if (nowMs >= last.endMs) {
      activeIdx = activeCueWordElements.length;
    }
  }

  if (activeIdx === lastActiveWordIndex) return;
  lastActiveWordIndex = activeIdx;

  for (let i = 0; i < activeCueWordElements.length; i++) {
    const el = activeCueWordElements[i].span;
    if (i === activeIdx) {
      el.classList.add("word-active");
      el.classList.remove("word-spoken", "word-upcoming");
    } else if (i < activeIdx) {
      el.classList.add("word-spoken");
      el.classList.remove("word-active", "word-upcoming");
    } else {
      el.classList.add("word-upcoming");
      el.classList.remove("word-active", "word-spoken");
    }
  }
}

function renderGermanWithWordSpans(text, wordTimings = []) {
  activeCueWordElements = [];
  lastActiveWordIndex = -1;

  const frag = document.createDocumentFragment();
  const words = text.split(/(\s+)/);
  let wordIndex = 0;

  for (const token of words) {
    if (/^\s+$/.test(token)) {
      frag.appendChild(document.createTextNode(token));
      continue;
    }
    const span = document.createElement("span");
    span.className = "clean-subs-word";
    span.textContent = token;
    // Check if this word is in the user's vocabulary bank
    const lc = token.toLowerCase().replace(/[.,!?;:"'()[\]{}]/g, "");
    if (lc.length > 2 && vocabWordsSet.has(lc)) {
      span.classList.add("vocab-known");
    }

    const timing = wordTimings[wordIndex];
    if (timing) {
      activeCueWordElements.push({
        span,
        startMs: timing.startMs,
        endMs: timing.endMs
      });
    }

    span.addEventListener("click", (e) => {
      e.stopPropagation();
      showWordPopup(token, span);
    });
    frag.appendChild(span);
    wordIndex++;
  }
  return frag;
}

let wordPopupEl = null;

function showWordPopup(word, anchorEl) {
  hideWordPopup();
  const cleanWord = word.replace(/[.,!?;:"""''()[\]{}]/g, "").trim();
  if (!cleanWord) return;

  const lookupFn = typeof lookupGermanWord === "function" ? lookupGermanWord : (typeof window !== "undefined" ? window.lookupGermanWord : null);
  const result = typeof lookupFn === "function" ? lookupFn(cleanWord) : null;
  const playerContainer = document.querySelector(".html5-video-player");
  if (!playerContainer) return;

  wordPopupEl = document.createElement("div");
  wordPopupEl.id = "clean-subs-word-popup";

  const termEl = document.createElement("div");
  termEl.className = "word-popup-term";
  termEl.textContent = cleanWord;
  wordPopupEl.appendChild(termEl);

  if (result) {
    const posLabels = { n: "Noun", v: "Verb", adj: "Adjective", adv: "Adverb", prep: "Preposition", conj: "Conjunction", pron: "Pronoun", art: "Article", part: "Particle", num: "Number", int: "Interjection" };
    const posEl = document.createElement("div");
    posEl.className = "word-popup-pos";
    posEl.textContent = posLabels[result.pos] || result.pos || "";
    wordPopupEl.appendChild(posEl);

    if (result.gender) {
      const genderEl = document.createElement("div");
      genderEl.className = "word-popup-gender";
      genderEl.textContent = `${result.gender} ${cleanWord}`;
      wordPopupEl.appendChild(genderEl);
    }

    const meaningEl = document.createElement("div");
    meaningEl.className = "word-popup-meaning";
    meaningEl.textContent = result.en || "";
    wordPopupEl.appendChild(meaningEl);
  } else {
    const unknownEl = document.createElement("div");
    unknownEl.className = "word-popup-unknown";
    unknownEl.textContent = "Not in dictionary";
    wordPopupEl.appendChild(unknownEl);
  }

  const saveBtn = document.createElement("button");
  saveBtn.className = "word-popup-save-btn";
  saveBtn.textContent = "★ Save to Anki";
  saveBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    e.preventDefault();
    const translation = result ? `${result.gender ? result.gender + ' ' : ''}${result.en}` : "[Saved Word]";
    await saveIndividualWordToVocabulary(cleanWord, translation);
    hideWordPopup();
  });
  wordPopupEl.appendChild(saveBtn);
  playerContainer.appendChild(wordPopupEl);

  // Position near the anchor element
  const pRect = playerContainer.getBoundingClientRect();
  const aRect = anchorEl.getBoundingClientRect();
  let left = aRect.left - pRect.left + aRect.width / 2;
  let top = aRect.top - pRect.top - 10;

  // Show popup, measure, then adjust
  requestAnimationFrame(() => {
    if (!wordPopupEl) return;
    const popRect = wordPopupEl.getBoundingClientRect();
    left = Math.max(8, Math.min(left - popRect.width / 2, pRect.width - popRect.width - 8));
    top = Math.max(8, top - popRect.height);
    wordPopupEl.style.left = left + "px";
    wordPopupEl.style.top = top + "px";
    wordPopupEl.classList.add("visible");
  });

  // Dismiss on click outside
  setTimeout(() => {
    document.addEventListener("click", handleWordPopupDismiss, { once: true, capture: true });
  }, 50);
}

async function saveIndividualWordToVocabulary(word, translation) {
  if (!word) return;
  const title = document.title.replace(/\s*-\s*YouTube$/, "").trim() || "YouTube Video";
  const videoId = getCurrentVideoId();
  const video = getCachedVideo();
  const timeSec = Math.floor(video?.currentTime || 0);

  try {
    const res = await chrome.storage.local.get(["vocabularyBank"]);
    const bank = Array.isArray(res?.vocabularyBank) ? res.vocabularyBank : [];

    const existingIdx = bank.findIndex((item) => item.german.toLowerCase() === word.toLowerCase() && item.videoId === videoId);
    if (existingIdx >= 0) {
      bank[existingIdx].translated = translation || bank[existingIdx].translated;
    } else {
      bank.unshift({
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        german: word,
        translated: translation || "[Saved Word]",
        videoId,
        videoTitle: title,
        timestamp: timeSec,
        dateAdded: new Date().toLocaleDateString()
      });
    }

    await chrome.storage.local.set({ vocabularyBank: bank });
    vocabWordsSet.add(word.toLowerCase());
    sessionStats.wordsSaved++;
    updateSessionStatsDisplay();
    showStatusToast(`★ Saved "${word}" to Anki Bank! (${bank.length} cards)`, "success", 2500);

    if (activeSubtitleIndex >= 0) {
      renderCue(activeSubtitleIndex);
    }
  } catch (_) {
    showStatusToast("Could not save word", "error", 2000);
  }
}

function handleWordPopupDismiss(e) {
  if (wordPopupEl && wordPopupEl.contains(e.target)) {
    // Click was inside popup — re-attach listener so clicking outside still works
    setTimeout(() => {
      document.addEventListener("click", handleWordPopupDismiss, { once: true, capture: true });
    }, 50);
    return;
  }
  hideWordPopup();
}

function hideWordPopup() {
  if (wordPopupEl && wordPopupEl.isConnected) {
    wordPopupEl.remove();
  }
  wordPopupEl = null;
}

function renderCue(index) {
  if (index < 0 || index >= currentSubtitles.length) {
    hideOverlay();
    return;
  }
  if (!extensionEnabled) {
    hideOverlay();
    return;
  }
  const cue = currentSubtitles[index];
  const overlay = (overlayElements && overlayElements.container?.isConnected)
    ? overlayElements
    : ensureOverlay();
  if (!overlay) return;

  const { box, original, translated } = overlay;

  // Ensure loop badge exists
  if (!box.querySelector(".clean-subs-loop-badge")) {
    const loopBadge = document.createElement("span");
    loopBadge.className = "clean-subs-loop-badge";
    loopBadge.textContent = "🔁";
    box.appendChild(loopBadge);
  }
  box.classList.toggle("looping", isLooping && loopCueIndex === index);

  // Ensure autopause badge exists
  if (!box.querySelector(".clean-subs-autopause-badge")) {
    const apBadge = document.createElement("span");
    apBadge.className = "clean-subs-autopause-badge";
    apBadge.textContent = "⏸ AUTO";
    box.appendChild(apBadge);
  }
  box.classList.toggle("autopause", autoPauseEnabled);

  // Track session stats
  sessionStats.cuesSeen.add(index);
  updateSessionStatsDisplay();

  if (currentSubtitleMode === "german") {
    original.textContent = "";
    original.appendChild(renderGermanWithWordSpans(cue.original || "", cue.words || []));
    original.style.display = cue.original ? "block" : "none";
    translated.style.display = "none";
    translated.textContent = "";
  } else if (currentSubtitleMode === "english") {
    original.style.display = "none";
    original.textContent = "";
    translated.textContent = cue.translated || cue.original || "";
    translated.className = "clean-subs-line clean-subs-translated";
    translated.style.display = "block";
  } else if (currentSubtitleMode === "quiz") {
    // Quiz mode: show German, blur English until revealed
    original.textContent = "";
    original.appendChild(renderGermanWithWordSpans(cue.original || "", cue.words || []));
    original.style.display = cue.original ? "block" : "none";

    const translationText = cue.translated || "";
    if (quizRevealed) {
      translated.textContent = translationText || "...";
      translated.className = "clean-subs-line clean-subs-translated clean-subs-quiz-revealed";
    } else {
      translated.textContent = translationText || "???";
      translated.className = "clean-subs-line clean-subs-translated clean-subs-quiz-hidden";
    }
    translated.style.display = "block";

    // Show reveal hint
    let hint = box.querySelector(".clean-subs-reveal-hint");
    if (!quizRevealed) {
      if (!hint) {
        hint = document.createElement("div");
        hint.className = "clean-subs-reveal-hint";
        hint.textContent = "Press Space to reveal";
        box.appendChild(hint);
      }
      hint.style.display = "block";
    } else if (hint) {
      hint.style.display = "none";
    }
  } else {
    // "bilingual" (default)
    original.textContent = "";
    original.appendChild(renderGermanWithWordSpans(cue.original || "", cue.words || []));
    original.style.display = cue.original ? "block" : "none";
    translated.textContent = cue.translated || (cue.original ? "..." : "");
    translated.className = "clean-subs-line clean-subs-translated";
    translated.style.display = "block";
  }

  box.style.display = "inline-flex";

  const v = getCachedVideo();
  if (v && karaokeHighlightEnabled && activeSubtitleIndex >= 0) {
    updateKaraokeWordHighlight(Number(v.currentTime || cue.start));
  }
}

function rebuildSubtitles() {
  const len = stitchedSegments.length;
  if (currentSubtitles.length !== len) {
    currentSubtitles.length = len;
  }

  for (let i = 0; i < len; i++) {
    const segment = stitchedSegments[i];
    const start = segment.startMs / 1000;
    const end = segment.endMs / 1000;
    const original = segment.text;
    const translated = typeof translations[i] === "string" ? translations[i].trim() : "";
    const words = segment.words || [];
    const cue = currentSubtitles[i];

    if (!cue || cue.original !== original || cue.translated !== translated || cue.start !== start || cue.end !== end || cue.words !== words) {
      currentSubtitles[i] = { start, end, original, translated, words };
      if (i === activeSubtitleIndex) {
        renderCue(i);
      }
    }
  }

  startSyncLoop();
}

function startSyncLoop() {
  if (syncTimerId == null) {
    syncTimerId = setInterval(syncPlaybackTick, 60);
  }
}

function stopSyncLoop() {
  if (syncTimerId != null) {
    clearInterval(syncTimerId);
    syncTimerId = null;
  }
  activeSubtitleIndex = -1;
  overlayElements = null;
  videoEl = null;
}

let lastClientReadyPost = 0;
function requestMainWorldExtractionIfNeeded() {
  const now = Date.now();
  if (now - lastClientReadyPost > 2500) {
    lastClientReadyPost = now;
    window.postMessage({ __cleanSubsClientReady: true, videoId: getCurrentVideoId() }, "*");
  }
}

function attachVideoListeners(video) {
  if (!video || video.__cleanSubsSeekAttached) return;
  video.__cleanSubsSeekAttached = true;

  video.addEventListener("seeked", () => {
    onPlaybackSeeked();
  });

  const onPlay = () => {
    if (!currentSubtitles.length) {
      requestMainWorldExtractionIfNeeded();
    }
  };
  video.addEventListener("play", onPlay);
  video.addEventListener("playing", onPlay);
}

function onPlaybackSeeked() {
  const video = getCachedVideo();
  if (!video || !currentSubtitles.length) return;
  const now = Number(video.currentTime || 0);
  const idx = findSubtitleIndex(now);
  activeSubtitleIndex = idx;
  if (idx >= 0) {
    renderCue(idx);
    if (!translations[idx] && activeRequestId && currentSubtitleMode !== "german") {
      try {
        chrome.runtime.sendMessage({
          action: "PRIORITIZE_SEEK",
          videoId: currentVideoId || getCurrentVideoId(),
          cueIndex: idx,
          playbackSec: now
        });
      } catch (_) {}
    }
  } else {
    hideOverlay();
  }
}

function getCachedVideo() {
  if (videoEl && videoEl.isConnected) {
    attachVideoListeners(videoEl);
    return videoEl;
  }
  videoEl = document.querySelector("video");
  if (videoEl) {
    attachVideoListeners(videoEl);
  }
  return videoEl;
}

function findSubtitleIndex(time) {
  if (!currentSubtitles.length || !Number.isFinite(time)) return -1;

  let lo = 0;
  let hi = currentSubtitles.length - 1;
  let result = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (currentSubtitles[mid].start <= time) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (result < 0) return -1;

  const cue = currentSubtitles[result];
  if (time <= cue.end) return result;

  const next = currentSubtitles[result + 1];
  if (next && time >= next.start && time <= next.end) return result + 1;

  return -1;
}

function syncPlaybackTick() {
  if (!isExtensionContextValid()) {
    cleanupJob();
    stopSyncLoop();
    hideOverlay();
    return;
  }

  try {
    if (!extensionEnabled) {
      hideOverlay();
      return;
    }

    const activeVid = getCurrentVideoId();
    if (activeVid && currentVideoId && activeVid !== currentVideoId) {
      cleanupJob();
      masterRawEventsMap.clear();
      knownTranslations.clear();
      resetSessionStats();
      currentVideoId = activeVid;
      currentSubtitles = [];
      stitchedSegments = [];
      translations = [];
      processedVideoId = null;
      lastSentCount = 0;
      hideOverlay();
      requestMainWorldExtractionIfNeeded();
      return;
    }

    if (!currentSubtitles.length) {
      hideOverlay();
      const video = getCachedVideo();
      if (video && !video.paused && video.currentTime > 0.5) {
        requestMainWorldExtractionIfNeeded();
      }
      return;
    }

    const video = getCachedVideo();
    if (!video) {
      hideOverlay();
      return;
    }

    const now = Number(video.currentTime || 0) + 0.08;

    // Cue loop: if looping, rewind when we pass the cue end
    if (isLooping && loopCueIndex >= 0 && loopCueIndex < currentSubtitles.length) {
      const loopCue = currentSubtitles[loopCueIndex];
      if (now > loopCue.end + 0.15) {
        video.currentTime = loopCue.start;
        return;
      }
    }

    // BUGFIX: nextIndex was never computed here — ReferenceError on every tick
    // silently killed the sync loop, so subtitles never appeared.
    const nextIndex = findSubtitleIndex(now);

    if (nextIndex === activeSubtitleIndex) {
      if (activeSubtitleIndex >= 0 && karaokeHighlightEnabled) {
        updateKaraokeWordHighlight(Number(video.currentTime || 0));
      }
      return;
    }

    const previousIndex = activeSubtitleIndex;
    activeSubtitleIndex = nextIndex;

    // Reset quiz reveal state on cue change
    if (currentSubtitleMode === "quiz") {
      quizRevealed = false;
    }

    // Auto-pause on new cue
    if (autoPauseEnabled && nextIndex >= 0 && previousIndex !== nextIndex && previousIndex >= 0) {
      video.pause();
    }

    if (nextIndex >= 0) {
      renderCue(nextIndex);
    } else {
      hideOverlay();
    }
  } catch (_) {}
}

function cleanupJob() {
  if (watchdogId) {
    clearTimeout(watchdogId);
    watchdogId = null;
  }
  if (workerListener) {
    try {
      chrome.runtime.onMessage.removeListener(workerListener);
    } catch (_) {}
    workerListener = null;
  }
  activeRequestId = null;
  pendingVideoId = null;
  lastSentCount = 0;
}

let portReconnectTimer = null;
function schedulePortReconnect() {
  if (portPingInterval) {
    clearInterval(portPingInterval);
    portPingInterval = null;
  }
  activePort = null;
  if (!isExtensionContextValid()) return;
  if (portReconnectTimer) clearTimeout(portReconnectTimer);
  portReconnectTimer = setTimeout(() => {
    portReconnectTimer = null;
    if (isExtensionContextValid()) {
      setupKeepAlivePort();
    }
  }, 1500);
}

function setupKeepAlivePort() {
  if (portPingInterval) {
    clearInterval(portPingInterval);
    portPingInterval = null;
  }

  if (!isExtensionContextValid()) return;

  try {
    if (activePort) {
      try { activePort.disconnect(); } catch (_) {}
      activePort = null;
    }

    activePort = chrome.runtime.connect({ name: "clean-subs-keepalive" });

    portPingInterval = setInterval(() => {
      if (activePort && isExtensionContextValid()) {
        try {
          activePort.postMessage({ type: "PING" });
        } catch (_) {
          schedulePortReconnect();
        }
      } else {
        schedulePortReconnect();
      }
    }, 8000);

    activePort.onDisconnect.addListener(() => {
      schedulePortReconnect();
    });
  } catch (err) {
    schedulePortReconnect();
  }
}

function armWatchdog(ms = 90000) {
  if (watchdogId) clearTimeout(watchdogId);
  watchdogId = setTimeout(() => {
    watchdogId = null;
    if (!activeRequestId) return;
    const since = Date.now() - lastProgressAt;
    if (since < ms * 2) {
      armWatchdog(ms);
      return;
    }
  }, ms);
}

function requestTranslationIfNeeded() {
  if (currentSubtitleMode === "german") return;
  if (!stitchedSegments.length) return;
  const currentVid = currentVideoId || processedVideoId || pendingVideoId || getCurrentVideoId();
  if (!currentVid) return;

  const hasUntranslated = stitchedSegments.some((_, idx) => !translations[idx]);
  if (hasUntranslated && !activeRequestId) {
    handleEventsPipeline(Array.from(masterRawEventsMap.values()), currentVid, "mode_change");
  }
}

let pipelineDebounceTimer = null;

function handleEventsPipeline(incomingEvents, videoId, source) {
  if (!isExtensionContextValid()) return;
  if (!videoId || !Array.isArray(incomingEvents) || !incomingEvents.length) return;

  if (currentVideoId && currentVideoId !== videoId) {
    cleanupJob();
    masterRawEventsMap.clear();
    knownTranslations.clear();
    resetSessionStats();
    stitchedSegments = [];
    translations = [];
    currentSubtitles = [];
  }
  currentVideoId = videoId;

  // Ingest into master registry with timestamp-bucketing deduplication immediately
  for (const ev of incomingEvents) {
    const t = Math.max(0, Number(ev.tStartMs) || 0);
    const txt = String(ev.text || "").replace(/\s+/g, " ").trim();
    if (!txt) continue;
    const dur = Math.max(250, Number(ev.dDurationMs) || 2000);
    const key = `${Math.round(t / 50) * 50}|${txt.toLowerCase()}`;
    if (!masterRawEventsMap.has(key)) {
      const words = Array.isArray(ev.words) && ev.words.length > 0
        ? ev.words
        : computeProportionalWords(txt, t, dur);
      masterRawEventsMap.set(key, { tStartMs: t, dDurationMs: dur, text: txt, words });
    }
  }

  // Debounce multiple rapid extraction bursts from YouTube into a single cohesive pipeline pass
  if (pipelineDebounceTimer) clearTimeout(pipelineDebounceTimer);
  pipelineDebounceTimer = setTimeout(() => {
    executeEventsPipeline(videoId, source);
  }, 350);
}

async function executeEventsPipeline(videoId, source) {
  if (!isExtensionContextValid() || currentVideoId !== videoId) return;

  // Canonical deduplication and monotonic stitching across all known events
  const allRaw = Array.from(masterRawEventsMap.values());
  const stitched = stitchGermanSegments(allRaw);
  if (!stitched.length) return;
  stitchedSegments = stitched;

  // Rebuild translations preserving all existing known translations and sound effects
  translations = new Array(stitchedSegments.length);
  for (let i = 0; i < stitchedSegments.length; i++) {
    const segText = stitchedSegments[i].text;
    const norm = segText.toLowerCase().trim();
    const fx = getSoundEffectTranslation(segText);
    if (fx) {
      translations[i] = fx;
      knownTranslations.set(norm, fx);
    } else if (knownTranslations.has(norm)) {
      translations[i] = knownTranslations.get(norm);
    }
  }

  // Render clean German subtitles immediately on the player
  rebuildSubtitles();

  if (currentSubtitleMode === "german") {
    return;
  }

  // Identify all uncached / untranslated cues
  // BUGFIX: Only enqueue cues near/after the current playback position.
  // Previously every cue of a 3h+ video was sent in one TRANSLATE_BATCH job,
  // which saturated the 15 RPM free tier and delayed the cues actually being
  // watched by many minutes — subtitles appeared to "never show up".
  const video = getCachedVideo();
  const now = Number(video?.currentTime || 0);
  const currentCueIndex = activeSubtitleIndex >= 0 ? activeSubtitleIndex : findSubtitleIndex(now);
  const LOOKBEHIND_CUES = 5;
  const HORIZON_CUES = 120;

  const uncachedCues = [];
  let totalUncached = 0;
  for (let i = 0; i < stitchedSegments.length; i++) {
    if (translations[i]) continue;
    totalUncached++;
    const pivot = currentCueIndex >= 0 ? currentCueIndex : 0;
    if (i < pivot - LOOKBEHIND_CUES) continue;          // already watched
    if (pivot >= 0 && i > pivot + HORIZON_CUES) continue; // far future — fetch later
    uncachedCues.push({
      index: i,
      text: stitchedSegments[i].text,
      startMs: stitchedSegments[i].startMs,
      endMs: stitchedSegments[i].endMs
    });
  }

  if (totalUncached === 0) {
    processedVideoId = videoId;
    return;
  }

  if (uncachedCues.length === 0) {
    // Everything untranslated is in the past (e.g. user seeked backwards);
    // re-run from the new position instead of doing nothing.
    if (activeRequestId && pendingVideoId === videoId && (Date.now() - lastProgressAt < 25000)) {
      return;
    }
    const fallbackPivot = currentCueIndex >= 0 ? currentCueIndex : 0;
    for (let i = 0; i < stitchedSegments.length && uncachedCues.length < HORIZON_CUES; i++) {
      const j = (fallbackPivot + i) % stitchedSegments.length;
      if (!translations[j]) {
        uncachedCues.push({
          index: j,
          text: stitchedSegments[j].text,
          startMs: stitchedSegments[j].startMs,
          endMs: stitchedSegments[j].endMs
        });
      }
    }
    if (uncachedCues.length === 0) {
      processedVideoId = videoId;
      return;
    }
  }

  // If a translation job for this video is actively progressing, avoid abortive churn
  if (activeRequestId && pendingVideoId === videoId && (Date.now() - lastProgressAt < 25000)) {
    return;
  }

  const requestId = `${videoId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  activeRequestId = requestId;
  pendingVideoId = videoId;
  lastProgressAt = Date.now();

  if (!workerListener) {
    workerListener = (message) => {
      if (!message) return;
      if (message.requestId !== activeRequestId && message.videoId !== currentVideoId) return;

      if (message.type === "TRANSLATION_PROGRESS") {
        const indexes = Array.isArray(message.indexes) ? message.indexes : [];
        const incoming = Array.isArray(message.translations) ? message.translations : [];
        const incomingTexts = Array.isArray(message.texts) ? message.texts : [];

        for (let i = 0; i < incoming.length; i++) {
          const value = String(incoming[i] ?? "").trim();
          if (!value) continue;

          // 1. Save to knownTranslations map by normalized German text
          const germanText = incomingTexts[i] || (stitchedSegments[indexes[i]]?.text);
          if (germanText) {
            knownTranslations.set(germanText.toLowerCase().trim(), value);
          }

          // 2. Map directly to stitchedSegments by matching German text first (zero-drift sync)
          let targetIdx = -1;
          if (germanText) {
            const norm = germanText.toLowerCase().trim();
            targetIdx = stitchedSegments.findIndex((s) => s.text.toLowerCase().trim() === norm);
          }
          if (targetIdx === -1 && Number.isInteger(indexes[i]) && indexes[i] >= 0 && indexes[i] < translations.length) {
            targetIdx = indexes[i];
          }

          if (targetIdx >= 0 && targetIdx < translations.length) {
            translations[targetIdx] = value;
          }
        }

        lastProgressAt = Date.now();
        rebuildSubtitles();
        armWatchdog(90000);

        if (message.complete) {
          // Only mark the video fully processed when EVERY cue actually has a
          // translation. With the rolling horizon window, a job can complete
          // while far-future cues are still pending — those must keep being
          // fetched by the follow-up request below.
          const allTranslated = stitchedSegments.length > 0 &&
            translations.slice(0, stitchedSegments.length).every((t) => !!t);
          if (allTranslated) {
            processedVideoId = currentVideoId;
            showStatusToast("CleanSubs: Subtitles ready", "success", 2000);
          }
          if (watchdogId) {
            clearTimeout(watchdogId);
            watchdogId = null;
          }
          activeRequestId = null;
          // Rolling window: as soon as a horizon batch finishes, immediately
          // queue the next chunk ahead of the playhead so long videos keep
          // translating without ever saturating the free-tier rate limit.
          setTimeout(() => requestTranslationIfNeeded(), 500);
        }
        return;
      }

      if (message.type === "TRANSLATION_ERROR") {
        console.warn("[CleanSubs] Translation notice:", message.error || "Notice");
        showStatusToast(`CleanSubs: ${message.error || "Translation notice"}`, "error", 6000);
      }
    };

    try {
      chrome.runtime.onMessage.addListener(workerListener);
    } catch (err) {
      cleanupJob();
      return;
    }
  }

  setupKeepAlivePort();
  armWatchdog(90000);

  try {
    chrome.runtime.sendMessage(
      {
        action: "TRANSLATE_BATCH",
        requestId,
        videoId,
        cues: uncachedCues,
        currentPlaybackSec: now,
        currentCueIndex
      },
      (response) => {
        const err = chrome.runtime.lastError;
        if (err || !response || response.accepted === false) {
          const errMsg = response?.error || "Could not reach background translator.";
          showStatusToast(`CleanSubs: ${errMsg}`, "error", 6000);
          if (activeRequestId === requestId) {
            activeRequestId = null;
            rebuildSubtitles();
          }
        }
      }
    );
  } catch (err) {
    activeRequestId = null;
  }
}

function teardownWorkerChannel() {
  activeRequestId = null;
}

document.addEventListener("yt-navigate-start", () => {
  cleanupJob();
  masterRawEventsMap.clear();
  knownTranslations.clear();
  resetSessionStats();
  currentVideoId = null;
  currentSubtitles = [];
  stitchedSegments = [];
  translations = [];
  processedVideoId = null;
  lastSentCount = 0;
  stopSyncLoop();
  hideOverlay();
  hideStatusToast();
});

window.addEventListener("message", (event) => {
  if (event.source !== window || !event.data || event.data.__cleanSubs !== true) {
    return;
  }

  try {
    const msg = event.data;
    if (msg.type === "EVENTS") {
      const payload = msg.payload || {};
      if (Array.isArray(payload.events) && payload.videoId) {
        handleEventsPipeline(payload.events, payload.videoId, payload.source || "events");
      }
    } else if (msg.type === "RAW_PAYLOAD") {
      const payload = msg.payload || {};
      const videoId = payload.videoId || getCurrentVideoId();
      if (!videoId || !payload.rawBody) return;

      const parsedEvents = parseRawCaptionsPayload(payload.rawBody);
      if (parsedEvents.length > 0) {
        handleEventsPipeline(parsedEvents, videoId, payload.source || "raw");
      }
    }
  } catch (_) {}
});

// --- Session Stats Display ---
function resetSessionStats() {
  sessionStats.cuesSeen.clear();
  sessionStats.wordsSaved = 0;
  const statsEl = document.getElementById("clean-subs-session-stats");
  if (statsEl) {
    statsEl.classList.remove("visible");
    const cuesEl = statsEl.querySelector("#cs-stat-cues");
    const savedEl = statsEl.querySelector("#cs-stat-saved");
    const progressEl = statsEl.querySelector("#cs-stat-progress");
    if (cuesEl) cuesEl.textContent = "0";
    if (savedEl) savedEl.textContent = "0";
    if (progressEl) progressEl.textContent = "0%";
  }
}

function updateSessionStatsDisplay() {
  try {
    const playerContainer = document.querySelector(".html5-video-player");
    if (!playerContainer) return;

    let statsEl = document.getElementById("clean-subs-session-stats");
    if (!statsEl) {
      statsEl = document.createElement("div");
      statsEl.id = "clean-subs-session-stats";

      const createStatItem = (iconText, statId, suffix) => {
        const item = document.createElement("div");
        item.className = "stats-item";
        const icon = document.createElement("span");
        icon.className = "stats-icon";
        icon.textContent = iconText;
        const val = document.createElement("span");
        val.className = "stats-value";
        val.id = statId;
        val.textContent = "0";
        item.appendChild(icon);
        item.appendChild(val);
        if (suffix) item.appendChild(document.createTextNode(suffix));
        return item;
      };

      statsEl.appendChild(createStatItem("📖", "cs-stat-cues", " cues"));
      statsEl.appendChild(createStatItem("★", "cs-stat-saved", " saved"));
      statsEl.appendChild(createStatItem("📊", "cs-stat-progress", ""));
      playerContainer.appendChild(statsEl);
    }

    const cuesEl = statsEl.querySelector("#cs-stat-cues");
    const savedEl = statsEl.querySelector("#cs-stat-saved");
    const progressEl = statsEl.querySelector("#cs-stat-progress");

    if (cuesEl) cuesEl.textContent = sessionStats.cuesSeen.size;
    if (savedEl) savedEl.textContent = sessionStats.wordsSaved;
    if (progressEl && currentSubtitles.length > 0) {
      const pct = Math.round((sessionStats.cuesSeen.size / currentSubtitles.length) * 100);
      progressEl.textContent = pct + "%";
    }

    if (!statsEl.classList.contains("visible") && sessionStats.cuesSeen.size > 0) {
      statsEl.classList.add("visible");
    }
  } catch (_) {}
}

// --- Vocabulary / Anki Bank ---
let lastSaveCueTime = 0;
async function saveCurrentCueToVocabulary() {
  const now = Date.now();
  if (now - lastSaveCueTime < 500) return;
  lastSaveCueTime = now;

  if (activeSubtitleIndex < 0 || activeSubtitleIndex >= currentSubtitles.length) {
    showStatusToast("No subtitle active to save", "error", 2000);
    return;
  }
  const cue = currentSubtitles[activeSubtitleIndex];
  const original = (cue.original || "").trim();
  const translated = (cue.translated || "").trim();
  if (!original) return;

  const title = document.title.replace(/\s*-\s*YouTube$/, "").trim() || "YouTube Video";
  const videoId = getCurrentVideoId();
  const video = getCachedVideo();
  const timeSec = Math.floor(video?.currentTime || cue.start || 0);

  try {
    const res = await chrome.storage.local.get(["vocabularyBank"]);
    const bank = Array.isArray(res?.vocabularyBank) ? res.vocabularyBank : [];

    const existingIdx = bank.findIndex((item) => item.german === original && item.videoId === videoId);
    if (existingIdx >= 0) {
      bank[existingIdx].translated = translated || bank[existingIdx].translated;
    } else {
      bank.unshift({
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        german: original,
        translated: translated || "[Pending Translation]",
        videoId,
        videoTitle: title,
        timestamp: timeSec,
        dateAdded: new Date().toLocaleDateString()
      });
    }

    await chrome.storage.local.set({ vocabularyBank: bank });
    sessionStats.wordsSaved++;
    updateSessionStatsDisplay();
    showStatusToast(`★ Saved to Anki Bank! (${bank.length} cards)`, "success", 2500);
  } catch (_) {
    showStatusToast("Could not save word", "error", 2000);
  }
}

// --- Subtitle Exporter (.SRT) ---
function formatSrtTime(totalSec) {
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = Math.floor(totalSec % 60);
  const ms = Math.floor((totalSec % 1) * 1000);
  return (
    String(hours).padStart(2, "0") +
    ":" +
    String(minutes).padStart(2, "0") +
    ":" +
    String(seconds).padStart(2, "0") +
    "," +
    String(ms).padStart(3, "0")
  );
}

function exportSubtitlesAsSrt() {
  if (!currentSubtitles.length) {
    showStatusToast("No subtitles loaded to export", "error", 2500);
    return;
  }

  let srtContent = "";
  let cueNumber = 1;

  for (let i = 0; i < currentSubtitles.length; i++) {
    const cue = currentSubtitles[i];
    if (!cue.original && !cue.translated) continue;

    const startStr = formatSrtTime(cue.start);
    const endStr = formatSrtTime(cue.end);

    let body = "";
    if (currentSubtitleMode === "german") {
      body = cue.original;
    } else if (currentSubtitleMode === "english") {
      body = cue.translated || cue.original;
    } else {
      // Bilingual
      body = `${cue.original}\n${cue.translated || ""}`.trim();
    }

    if (!body) continue;

    srtContent += `${cueNumber}\n${startStr} --> ${endStr}\n${body}\n\n`;
    cueNumber++;
  }

  if (!srtContent.trim()) {
    showStatusToast("Subtitle content empty", "error", 2000);
    return;
  }

  const title = (document.title.replace(/\s*-\s*YouTube$/, "").trim() || "subtitles")
    .replace(/[^a-zA-Z0-9_\-\s]/g, "")
    .trim();
  const blob = new Blob([srtContent], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title}_${currentSubtitleMode}.srt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showStatusToast("📥 Subtitles downloaded (.SRT)!", "success", 2500);
}

// --- Player Quick Controls & Menu ---
function injectPlayerControls() {
  const rightControls = document.querySelector(".ytp-right-controls");
  const player = document.querySelector(".html5-video-player");
  if (!rightControls || !player) return;

  if (!document.getElementById("clean-subs-player-btn")) {
    const btn = document.createElement("button");
    btn.id = "clean-subs-player-btn";
    btn.className = "ytp-button clean-subs-player-btn";
    btn.title = "Clean German Subtitles (CS)";
    btn.setAttribute("aria-label", "CleanSubs Settings");

    const badge = document.createElement("span");
    badge.className = "clean-subs-btn-badge";
    badge.textContent = "CS";
    btn.appendChild(badge);

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      toggleQuickMenu();
    });

    try {
      const settingsBtn = rightControls.querySelector(".ytp-settings-button");
      if (settingsBtn && settingsBtn.parentElement) {
        settingsBtn.parentElement.insertBefore(btn, settingsBtn);
      } else {
        rightControls.appendChild(btn);
      }
    } catch (_) {
      try {
        rightControls.appendChild(btn);
      } catch (_) {}
    }
    updatePlayerBadge();
  }

  if (!document.getElementById("clean-subs-quick-menu")) {
    const menu = document.createElement("div");
    menu.id = "clean-subs-quick-menu";

    // Header
    const header = document.createElement("div");
    header.className = "clean-subs-menu-header";
    const headerTitle = document.createElement("span");
    headerTitle.textContent = "CleanSubs Settings";
    const closeBtnEl = document.createElement("button");
    closeBtnEl.id = "cs-menu-close";
    closeBtnEl.className = "cs-icon-btn";
    closeBtnEl.textContent = "×";
    header.append(headerTitle, closeBtnEl);
    menu.appendChild(header);

    // Row helper
    const createMenuRow = (labelText, inputEl) => {
      const row = document.createElement("div");
      row.className = "clean-subs-menu-row";
      const lbl = document.createElement("span");
      lbl.textContent = labelText;
      row.append(lbl, inputEl);
      return row;
    };

    // Display Mode
    const modeSelEl = document.createElement("select");
    modeSelEl.id = "cs-quick-mode";
    [
      { val: "bilingual", text: "Bilingual (DE + EN)" },
      { val: "english", text: "English Only" },
      { val: "german", text: "German Only" },
      { val: "quiz", text: "Quiz (Reveal)" }
    ].forEach((opt) => {
      const o = document.createElement("option");
      o.value = opt.val;
      o.textContent = opt.text;
      modeSelEl.appendChild(o);
    });
    menu.appendChild(createMenuRow("Display Mode", modeSelEl));

    // Font Size
    const sizeSelEl = document.createElement("select");
    sizeSelEl.id = "cs-quick-size";
    [
      { val: "small", text: "Small" },
      { val: "normal", text: "Normal" },
      { val: "large", text: "Large" }
    ].forEach((opt) => {
      const o = document.createElement("option");
      o.value = opt.val;
      o.textContent = opt.text;
      sizeSelEl.appendChild(o);
    });
    menu.appendChild(createMenuRow("Font Size", sizeSelEl));

    // Position
    const posSelEl = document.createElement("select");
    posSelEl.id = "cs-quick-pos";
    [
      { val: "bottom", text: "Bottom (Default)" },
      { val: "top", text: "Top" },
      { val: "custom", text: "Draggable / Custom" }
    ].forEach((opt) => {
      const o = document.createElement("option");
      o.value = opt.val;
      o.textContent = opt.text;
      posSelEl.appendChild(o);
    });
    menu.appendChild(createMenuRow("Position", posSelEl));

    // Karaoke Highlight
    const karaokeCheckEl = document.createElement("input");
    karaokeCheckEl.type = "checkbox";
    karaokeCheckEl.id = "cs-quick-karaoke";
    karaokeCheckEl.style.cssText = "accent-color: #0284c7; cursor: pointer; transform: scale(1.15);";
    menu.appendChild(createMenuRow("Karaoke Highlight", karaokeCheckEl));

    // Actions
    const actionsEl = document.createElement("div");
    actionsEl.className = "clean-subs-menu-actions";
    const downloadBtnEl = document.createElement("button");
    downloadBtnEl.id = "cs-download-srt-btn";
    downloadBtnEl.className = "cs-action-btn";
    downloadBtnEl.textContent = "📥 Download .SRT";
    const saveAnkiBtnEl = document.createElement("button");
    saveAnkiBtnEl.id = "cs-save-anki-btn";
    saveAnkiBtnEl.className = "cs-action-btn secondary";
    saveAnkiBtnEl.textContent = "★ Save to Anki";
    actionsEl.append(downloadBtnEl, saveAnkiBtnEl);
    menu.appendChild(actionsEl);

    player.appendChild(menu);

    const closeBtn = menu.querySelector("#cs-menu-close");
    closeBtn?.addEventListener("click", () => menu.classList.remove("visible"));

    const karaokeCheck = menu.querySelector("#cs-quick-karaoke");
    if (karaokeCheck) {
      karaokeCheck.checked = karaokeHighlightEnabled;
      karaokeCheck.addEventListener("change", (e) => {
        karaokeHighlightEnabled = e.target.checked;
        chrome.storage.local.set({ karaokeHighlightEnabled });
      });
    }

    const modeSel = menu.querySelector("#cs-quick-mode");
    if (modeSel) {
      modeSel.value = currentSubtitleMode;
      modeSel.addEventListener("change", (e) => {
        currentSubtitleMode = e.target.value;
        quizRevealed = false;
        chrome.storage.local.set({ subtitleMode: currentSubtitleMode });
        updateContainerClasses();
        rebuildSubtitles();
        if (activeSubtitleIndex >= 0) renderCue(activeSubtitleIndex);
        if (currentSubtitleMode !== "german") requestTranslationIfNeeded();
      });
    }

    const sizeSel = menu.querySelector("#cs-quick-size");
    if (sizeSel) {
      sizeSel.value = currentFontSize;
      sizeSel.addEventListener("change", (e) => {
        currentFontSize = e.target.value;
        chrome.storage.local.set({ fontSize: currentFontSize });
      });
    }

    const posSel = menu.querySelector("#cs-quick-pos");
    if (posSel) {
      posSel.value = currentSubtitlePos;
      posSel.addEventListener("change", (e) => {
        currentSubtitlePos = e.target.value;
        if (currentSubtitlePos === "bottom") {
          customPosCoords = null;
        }
        chrome.storage.local.set({
          subtitlePosition: currentSubtitlePos,
          customPosCoords
        });
        updateContainerClasses();
      });
    }

    const srtBtn = menu.querySelector("#cs-download-srt-btn");
    srtBtn?.addEventListener("click", () => exportSubtitlesAsSrt());

    const ankiBtn = menu.querySelector("#cs-save-anki-btn");
    ankiBtn?.addEventListener("click", () => saveCurrentCueToVocabulary());

    document.addEventListener("click", (e) => {
      if (!e.target.closest("#clean-subs-quick-menu") && !e.target.closest("#clean-subs-player-btn")) {
        menu.classList.remove("visible");
      }
    });
  }
}

function toggleQuickMenu() {
  const menu = document.getElementById("clean-subs-quick-menu");
  if (!menu) {
    injectPlayerControls();
    return;
  }
  const isVis = menu.classList.contains("visible");
  if (isVis) {
    menu.classList.remove("visible");
  } else {
    const karaokeCheck = menu.querySelector("#cs-quick-karaoke");
    if (karaokeCheck) karaokeCheck.checked = karaokeHighlightEnabled;
    const modeSel = menu.querySelector("#cs-quick-mode");
    if (modeSel) modeSel.value = currentSubtitleMode;
    const sizeSel = menu.querySelector("#cs-quick-size");
    if (sizeSel) sizeSel.value = currentFontSize;
    const posSel = menu.querySelector("#cs-quick-pos");
    if (posSel) posSel.value = currentSubtitlePos;
    menu.classList.add("visible");
  }
}

// Global Keyboard Shortcuts
document.addEventListener("keydown", (e) => {
  const activeTag = document.activeElement?.tagName?.toLowerCase();
  if (activeTag === "input" || activeTag === "textarea" || document.activeElement?.isContentEditable) {
    return;
  }

  // Alt + C: Toggle extension on/off
  if (e.altKey && (e.key === "c" || e.key === "C")) {
    e.preventDefault();
    chrome.storage.local.get(["extensionEnabled"], (res) => {
      const next = res?.extensionEnabled === false;
      chrome.storage.local.set({ extensionEnabled: next });
      showStatusToast(next ? "CleanSubs Enabled" : "CleanSubs Disabled", next ? "success" : "info", 2000);
    });
    return;
  }

  // Alt + B: Cycle display modes (bilingual -> english -> german -> quiz)
  if (e.altKey && (e.key === "b" || e.key === "B")) {
    e.preventDefault();
    const modes = ["bilingual", "english", "german", "quiz"];
    const nextMode = modes[(modes.indexOf(currentSubtitleMode) + 1) % modes.length];
    currentSubtitleMode = nextMode;
    quizRevealed = false;
    chrome.storage.local.set({ subtitleMode: nextMode });
    showStatusToast(`Mode: ${nextMode.toUpperCase()}`, "info", 1800);
    return;
  }

  // Alt + S: Save active cue to Anki bank
  if (e.altKey && (e.key === "s" || e.key === "S")) {
    e.preventDefault();
    saveCurrentCueToVocabulary();
    return;
  }

  // Alt + P: Toggle auto-pause
  if (e.altKey && (e.key === "p" || e.key === "P")) {
    e.preventDefault();
    autoPauseEnabled = !autoPauseEnabled;
    chrome.storage.local.set({ autoPauseEnabled });
    showStatusToast(autoPauseEnabled ? "⏸ Auto-Pause ON" : "Auto-Pause OFF", "info", 1800);
    if (activeSubtitleIndex >= 0) renderCue(activeSubtitleIndex);
    return;
  }

  // Space: Reveal translation in quiz mode
  if (e.key === " " && !e.altKey && !e.ctrlKey && !e.metaKey) {
    if (currentSubtitleMode === "quiz" && !quizRevealed && activeSubtitleIndex >= 0) {
      e.preventDefault();
      quizRevealed = true;
      renderCue(activeSubtitleIndex);
      return;
    }
    // Don't prevent default Space (play/pause) if not in quiz mode
  }

  // 'L' / 'l': Toggle cue loop
  if (!e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "l" || e.key === "L")) {
    if (activeSubtitleIndex >= 0 && currentSubtitles[activeSubtitleIndex]) {
      e.preventDefault();
      e.stopPropagation();
      if (isLooping && loopCueIndex === activeSubtitleIndex) {
        // Turn off loop
        isLooping = false;
        loopCueIndex = -1;
        showStatusToast("Loop OFF", "info", 1200);
      } else {
        // Turn on loop for current cue
        isLooping = true;
        loopCueIndex = activeSubtitleIndex;
        showStatusToast("🔁 Loop ON — press L to stop", "info", 2000);
      }
      renderCue(activeSubtitleIndex);
      return;
    }
  }

  // 'R' / 'r': Replay current subtitle cue (only when a cue is active)
  if (!e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "r" || e.key === "R")) {
    if (activeSubtitleIndex >= 0 && currentSubtitles[activeSubtitleIndex]) {
      e.preventDefault();
      e.stopPropagation();
      const video = getCachedVideo();
      if (video) {
        video.currentTime = Math.max(0, currentSubtitles[activeSubtitleIndex].start);
        showStatusToast("Replaying cue ↺", "info", 1200);
      }
      return;
    }
    // Don't return here — let YouTube handle 'R' if no cue is active
  }
});

// Runtime message listener for popup & background communication (e.g. Export SRT, Shortcuts)
if (isExtensionContextValid()) {
  try {
    chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
      if (req?.action === "EXPORT_SRT") {
        exportSubtitlesAsSrt();
        sendResponse({ ok: true });
        return true;
      }
      if (req?.action === "CYCLE_MODE") {
        const modes = ["bilingual", "english", "german", "quiz"];
        const nextMode = modes[(modes.indexOf(currentSubtitleMode) + 1) % modes.length];
        currentSubtitleMode = nextMode;
        chrome.storage.local.set({ subtitleMode: nextMode });
        showStatusToast(`Mode: ${nextMode.toUpperCase()}`, "info", 1800);
        sendResponse({ ok: true, mode: nextMode });
        return true;
      }
      if (req?.action === "SAVE_VOCABULARY") {
        saveCurrentCueToVocabulary();
        sendResponse({ ok: true });
        return true;
      }
    });
  } catch (_) {}
}

// Lifecycle player controls injection & persistent keep-alive initialization
setupKeepAlivePort();
startSyncLoop();
[1000, 2500, 4500].forEach((ms) => setTimeout(injectPlayerControls, ms));
document.addEventListener("yt-navigate-finish", () => {
  setupKeepAlivePort();
  startSyncLoop();
  setTimeout(injectPlayerControls, 1000);
  window.postMessage({ __cleanSubsClientReady: true, videoId: getCurrentVideoId() }, "*");
});
document.addEventListener("yt-page-data-updated", () => {
  startSyncLoop();
  setTimeout(injectPlayerControls, 1000);
});

window.postMessage({ __cleanSubsClientReady: true, videoId: getCurrentVideoId() }, "*");
