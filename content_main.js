// CleanSubs - Content Main Script (Page Context) v4.9.1
(function () {
  let isExtracting = false;
  let successfullyExtractedVideoId = "";
  let lastCachedPayload = null;
  let retryTimer = null;

  function getUrlString(input) {
    try {
      if (typeof input === "string") return input;
      if (input instanceof URL) return input.toString();
      if (input && typeof input.url === "string") return input.url;
    } catch (_) {}
    return "";
  }

  function isGermanTimedtextUrl(url) {
    const u = String(url || "");
    if (!u.includes("/api/timedtext")) return false;
    // Skip if explicitly requesting another non-German language
    if (/[?&]lang=(?!de\b|ger\b|deu\b)[a-z]{2,}/i.test(u)) return false;
    if (/[?&]tlang=(?!de\b|ger\b|deu\b)[a-z]{2,}/i.test(u)) return false;
    return true;
  }

  function getVideoId() {
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

  function parseAnyCaptions(raw) {
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

  function dispatchEvents(events, videoId, source) {
    if (!events || events.length === 0) return;
    successfullyExtractedVideoId = videoId;
    lastCachedPayload = {
      __cleanSubs: true,
      type: "EVENTS",
      payload: {
        videoId,
        events,
        source,
        timestamp: Date.now()
      }
    };
    window.postMessage(lastCachedPayload, "*");
  }

  function dispatchRawTranscript(rawBody, source, url) {
    if (!rawBody || rawBody.trim().length <= 10) return;
    const videoId = getVideoId();

    // Check if we can parse events directly right here!
    const parsed = parseAnyCaptions(rawBody);
    if (parsed.length > 0 && videoId) {
      dispatchEvents(parsed, videoId, source || "raw_parsed");
      return;
    }

    // Fallback: pass raw payload to content.js (do not prematurely mark video as successfully extracted)
    lastCachedPayload = {
      __cleanSubs: true,
      type: "RAW_PAYLOAD",
      payload: {
        rawBody,
        source,
        url,
        videoId,
        timestamp: Date.now()
      }
    };
    window.postMessage(lastCachedPayload, "*");
  }

  // Hook XHR
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const urlString = getUrlString(url);

    if (urlString.includes("/api/timedtext")) {
      this.__cleanSubsUrl = urlString;
      if (!this.__cleanSubsHooked) {
        this.__cleanSubsHooked = true;
        this.addEventListener("load", function () {
          const u = this.__cleanSubsUrl || "";
          if (this.responseText && this.responseText.trim().length > 10 && isGermanTimedtextUrl(u)) {
            const parsed = parseAnyCaptions(this.responseText);
            const v = getVideoId();
            if (parsed.length > 0 && v) {
              dispatchEvents(parsed, v, "xhr_interception");
            } else {
              dispatchRawTranscript(this.responseText, "xhr_interception", u);
            }
          }
        });
      }
    }
    return origOpen.apply(this, [method, url, ...rest]);
  };

  // Hook Fetch
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await origFetch.apply(this, args);
    try {
      let url = getUrlString(args[0]);
      if (!url && response && response.url) url = response.url;

      if (response.ok && isGermanTimedtextUrl(url)) {
        const clone = response.clone();
        clone
          .text()
          .then((txt) => {
            if (txt && txt.trim().length > 10) {
              const parsed = parseAnyCaptions(txt);
              const v = getVideoId();
              if (parsed.length > 0 && v) {
                dispatchEvents(parsed, v, "fetch_interception");
              } else {
                dispatchRawTranscript(txt, "fetch_interception", url);
              }
            }
          })
          .catch(() => {});
      }
    } catch (_) {}
    return response;
  };

  function findGermanTrack(tracks) {
    if (!Array.isArray(tracks) || !tracks.length) return null;
    return (
      // 1. Manual German track (non-ASR)
      tracks.find((t) => (t.languageCode === "de" || t.vssId === ".de" || t.vss_id === ".de") && t.kind !== "asr") ||
      // 2. Exact German track (including ASR)
      tracks.find((t) => t.languageCode === "de" || t.vssId === ".de" || t.vss_id === ".de" || t.vssId === "a.de" || t.vss_id === "a.de") ||
      // 3. German regional (de-DE, de-AT, de-CH) or contains .de
      tracks.find((t) => String(t.languageCode || "").toLowerCase().startsWith("de") || String(t.vssId || t.vss_id || "").toLowerCase().includes(".de")) ||
      // 4. ISO 639-2 (ger, deu)
      tracks.find((t) => t.languageCode === "ger" || t.languageCode === "deu" || String(t.vssId || "").toLowerCase().includes(".ger") || String(t.vssId || "").toLowerCase().includes(".deu")) ||
      // 5. Track name contains "German" or "Deutsch"
      tracks.find((t) => {
        const name = String(t.name?.text || t.name?.simpleText || "").toLowerCase();
        return name.includes("deutsch") || name.includes("german");
      }) ||
      null
    );
  }

  async function tryDirectCaptionTrack(track, videoId) {
    const trackUrl = track?.baseUrl || track?.url;
    if (!trackUrl) return false;
    try {
      // 1. Try with fmt=json3 first
      const url = new URL(trackUrl, window.location.origin);
      if (!url.searchParams.has("fmt")) {
        url.searchParams.set("fmt", "json3");
      }

      let res = await fetch(url.toString(), {
        credentials: "same-origin",
        headers: { Accept: "*/*" }
      });

      if (res.ok) {
        const text = await res.text();
        const events = parseAnyCaptions(text);
        if (events && events.length > 0) {
          dispatchEvents(events, videoId, "tier1_caption_track_json3");
          return true;
        }
      }

      // 2. If fmt=json3 was rejected by HMAC or returned empty, fetch untouched trackUrl
      res = await fetch(trackUrl, {
        credentials: "same-origin",
        headers: { Accept: "*/*" }
      });

      if (res.ok) {
        const text = await res.text();
        const events = parseAnyCaptions(text);
        if (events && events.length > 0) {
          dispatchEvents(events, videoId, "tier1_caption_track_untouched");
          return true;
        }
        dispatchRawTranscript(text, "tier1_caption_track_raw", trackUrl);
      }
    } catch (_) {}
    return false;
  }

  async function tryGetTranscriptEndpoint(videoId) {
    try {
      const apiKey = window.ytcfg?.get?.("INNERTUBE_API_KEY");
      if (!apiKey) return false;

      const context = window.ytcfg?.get?.("INNERTUBE_CONTEXT") || {
        client: { clientName: "WEB", clientVersion: "2.20240901.01.00" }
      };
      const params = btoa(String.fromCharCode(10, videoId.length) + videoId);

      const res = await fetch(`https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ context, params })
      });
      if (!res.ok) return false;

      const data = await res.json();

      function findSegments(obj) {
        if (!obj || typeof obj !== "object") return [];
        if (Array.isArray(obj)) {
          for (const item of obj) {
            const found = findSegments(item);
            if (found.length) return found;
          }
          return [];
        }
        if (Array.isArray(obj.initialSegments)) return obj.initialSegments;
        for (const k of Object.keys(obj)) {
          const found = findSegments(obj[k]);
          if (found.length) return found;
        }
        return [];
      }

      const segments = findSegments(data.actions || data);
      if (segments && segments.length > 0) {
        const parsed = [];
        for (const s of segments) {
          const r = s.transcriptSegmentRenderer;
          if (!r) continue;
          const startMs = parseInt(r.startMs || "0", 10);
          const endMs = parseInt(r.endMs || "0", 10);
          const text = (r.snippet?.runs || []).map((x) => x.text || "").join("").trim();
          if (text) {
            const cleanText = decodeHtml(text);
            const durMs = endMs > startMs ? endMs - startMs : 2500;
            parsed.push({
              tStartMs: startMs,
              dDurationMs: durMs,
              text: cleanText,
              words: computeProportionalWords(cleanText, startMs, durMs)
            });
          }
        }

        if (parsed.length > 0) {
          dispatchEvents(parsed, videoId, "tier2_get_transcript");
          return true;
        }
      }
    } catch (_) {}
    return false;
  }

  async function tryInnertubePlayerTracks(videoId) {
    try {
      const apiKey = window.ytcfg?.get?.("INNERTUBE_API_KEY");
      if (!apiKey) return false;
      const context = window.ytcfg?.get?.("INNERTUBE_CONTEXT") || {
        client: { clientName: "WEB", clientVersion: "2.20240901.01.00" }
      };
      const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ videoId, context })
      });
      if (!res.ok) return false;
      const data = await res.json();
      const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      const deTrack = findGermanTrack(tracks);
      if (deTrack) {
        return await tryDirectCaptionTrack(deTrack, videoId);
      }
    } catch (_) {}
    return false;
  }

  function tryTriggerPlayerSubtitles() {
    const player = document.getElementById("movie_player");
    if (player) {
      try {
        player.setOption?.("captions", "track", { languageCode: "de" });
        player.loadModule?.("captions");
        player.toggleSubtitlesOn?.();
      } catch (_) {}
    }
    const ccBtn = document.querySelector(".ytp-subtitles-button");
    if (ccBtn && ccBtn.getAttribute("aria-pressed") === "false") {
      ccBtn.click();
    }
  }

  async function executeExtractionPipeline(retryAttempt = 0) {
    const v = getVideoId();
    if (!v || v === successfullyExtractedVideoId || isExtracting) return;

    isExtracting = true;
    try {
      hookVideoEvents();
      const player = document.getElementById("movie_player");
      let playerResponse = player?.getPlayerResponse
        ? player.getPlayerResponse()
        : null;

      // If playerResponse is for an ad (videoId mismatch), fall back to ytInitialPlayerResponse
      if (playerResponse?.videoDetails?.videoId && playerResponse.videoDetails.videoId !== v) {
        playerResponse = window.ytInitialPlayerResponse;
      }
      if (!playerResponse) playerResponse = window.ytInitialPlayerResponse;

      let tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

      // Secondary track source from YouTube player options API
      if (!tracks.length && player?.getOption) {
        try {
          const optTracks = player.getOption("captions", "tracklist");
          if (Array.isArray(optTracks) && optTracks.length > 0) {
            tracks = optTracks;
          }
        } catch (_) {}
      }

      const deTrack = findGermanTrack(tracks);
      if (deTrack) {
        const ok1 = await tryDirectCaptionTrack(deTrack, v);
        if (ok1) {
          isExtracting = false;
          return;
        }
      }

      // Tier 2: get_transcript endpoint
      const ok2 = await tryGetTranscriptEndpoint(v);
      if (ok2) {
        isExtracting = false;
        return;
      }

      // Tier 3: Innertube player API
      const ok3 = await tryInnertubePlayerTracks(v);
      if (ok3) {
        isExtracting = false;
        return;
      }

      // Tier 4: Trigger native captions to stimulate timedtext request
      tryTriggerPlayerSubtitles();
    } catch (err) {
      console.debug("[CleanSubs-Main] Extraction error:", err);
    } finally {
      isExtracting = false;
    }

    if (successfullyExtractedVideoId !== v && retryAttempt < 6) {
      const delays = [500, 1000, 2000, 3500, 5000, 8000];
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => executeExtractionPipeline(retryAttempt + 1), delays[retryAttempt] || 4000);
    }
  }

  function hookVideoEvents() {
    const video = document.querySelector("video");
    if (!video || video.__cleanSubsEventsAttached) return;
    video.__cleanSubsEventsAttached = true;

    const onPlayOrPlaying = () => {
      const v = getVideoId();
      if (v && v !== successfullyExtractedVideoId) {
        executeExtractionPipeline(0);
      }
    };

    video.addEventListener("play", onPlayOrPlaying);
    video.addEventListener("playing", onPlayOrPlaying);
  }

  window.addEventListener("message", (event) => {
    if (event.data && event.data.__cleanSubsClientReady) {
      const v = getVideoId();
      if (lastCachedPayload && successfullyExtractedVideoId === v && lastCachedPayload.payload?.events?.length > 0) {
        window.postMessage(lastCachedPayload, "*");
      } else {
        executeExtractionPipeline(0);
      }
    }
  });

  // Periodic liveness check: if video is playing but subtitles not extracted (e.g. after ad finishes)
  setInterval(() => {
    hookVideoEvents();
    const v = getVideoId();
    if (v && v !== successfullyExtractedVideoId) {
      const video = document.querySelector("video");
      if (video && !video.paused && video.currentTime > 0.5) {
        executeExtractionPipeline(0);
      }
    }
  }, 2500);

  [300, 800, 1600, 3200].forEach((ms) => setTimeout(() => executeExtractionPipeline(0), ms));

  function resetOnNavigation() {
    successfullyExtractedVideoId = "";
    lastCachedPayload = null;
    clearTimeout(retryTimer);
    [200, 700, 1800, 3500].forEach((ms) => setTimeout(() => executeExtractionPipeline(0), ms));
  }

  document.addEventListener("yt-navigate-finish", resetOnNavigation);
  document.addEventListener("yt-page-data-updated", () => {
    const v = getVideoId();
    if (v && v !== successfullyExtractedVideoId) resetOnNavigation();
  });
  window.addEventListener("popstate", () => {
    const v = getVideoId();
    if (v && v !== successfullyExtractedVideoId) resetOnNavigation();
  });
})();
