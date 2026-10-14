// CleanSubs - Background Service Worker v4.9.1
const BATCH_SIZE = 20;
const MAX_BATCH_CHARS = 4000;

// Valid models in Google Gemini API (AI Studio Active Models)
const DEFAULT_MODEL = "gemini-2.5-flash";
const FALLBACK_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  // Legacy (possibly deprecated) Gemini 3.x names kept last in the cascade so
  // rotation always lands on a model that actually exists first.
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash"
];

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MODEL_PATTERN = /^[a-zA-Z0-9._\-]{1,80}$/;
const CACHE_PREFIX = "cleanSubsCache:";
const CACHE_META_KEY = "cleanSubsCacheMeta";
const MAX_CACHE_ENTRIES = 20000;
const MAX_MEMORY_CACHE_ENTRIES = 5000;
const INITIAL_BURST_SIZE = 6;

// In-Memory L1 Cache for sub-millisecond instant hits
const memoryCache = new Map();

function setMemoryCache(key, value) {
  if (memoryCache.size >= MAX_MEMORY_CACHE_ENTRIES) {
    const it = memoryCache.keys();
    for (let i = 0; i < 500; i++) {
      const next = it.next();
      if (next.done) break;
      memoryCache.delete(next.value);
    }
  }
  memoryCache.set(key, value);
}

// Free tier has 15 RPM; a 3s gap prevents rate limit 429 errors without freezing
const MAX_REQUESTS_PER_MINUTE = 15;
const MIN_REQUEST_GAP_MS = 3000;
const MAX_RETRIES = 5;
const REQUEST_TIMEOUT_MS = 50000;
const MIN_RECOVERY_BATCH = 1;
const PROGRESS_CHUNK = 80;
const HEARTBEAT_INTERVAL_MS = 20000;

let translationQueue = Promise.resolve();
const jobs = new Map();
const latestRequestIdByTab = new Map();
const keepAlivePorts = new Map();
let activeModelOverride = null;

async function touchKeepAlive() {
  if (chrome.storage?.session) {
    try {
      await chrome.storage.session.set({ lastWorkerHeartbeat: Date.now() });
    } catch (_) {}
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "clean-subs-keepalive") {
    const tabId = port.sender?.tab?.id;
    keepAlivePorts.set(port, { tabId, lastPingAt: Date.now() });
    touchKeepAlive();

    port.onMessage.addListener((msg) => {
      if (msg?.type === "PING") {
        const entry = keepAlivePorts.get(port);
        if (entry) entry.lastPingAt = Date.now();
        touchKeepAlive();
        try {
          port.postMessage({ type: "PONG" });
        } catch (_) {}
      }
    });

    port.onDisconnect.addListener(() => {
      keepAlivePorts.delete(port);
    });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [port, entry] of keepAlivePorts) {
    if (now - entry.lastPingAt > HEARTBEAT_INTERVAL_MS * 3) {
      keepAlivePorts.delete(port);
      continue;
    }
    try {
      port.postMessage({ type: "WORKER_PING" });
    } catch (_) {
      keepAlivePorts.delete(port);
    }
  }
}, HEARTBEAT_INTERVAL_MS);

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [id, job] of jobs) {
    if (job.tabId === tabId) jobs.delete(id);
  }
  latestRequestIdByTab.delete(tabId);
});

if (chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        if (command === "toggle-translation") {
          chrome.storage.local.get(["extensionEnabled"], (res) => {
            chrome.storage.local.set({ extensionEnabled: res?.extensionEnabled === false });
          });
        } else if (command === "cycle-mode") {
          chrome.tabs.sendMessage(tabs[0].id, { action: "CYCLE_MODE" }, () => {});
        } else if (command === "save-vocabulary") {
          chrome.tabs.sendMessage(tabs[0].id, { action: "SAVE_VOCABULARY" }, () => {});
        }
      }
    });
  });
}

async function runConnectionTest(apiKey, modelName) {
  const probe = ["Guten Tag, wie geht es dir?"];
  try {
    const res = await translateWithRetry(probe, apiKey, modelName, null);
    const finalModel = activeModelOverride || modelName;
    if (activeModelOverride) {
      try {
        await chrome.storage.local.set({ selectedModel: activeModelOverride });
      } catch (_) {}
    }
    return { ok: true, modelUsed: finalModel, translation: res[0] };
  } catch (error) {
    return {
      ok: false,
      message: describeError(error),
      details: String(error?.message || error).slice(0, 300)
    };
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.action === "TEST_CONNECTION") {
    (async () => {
      let apiKey = String(request.apiKey || "").trim();
      let modelName = String(request.model || "").trim();

      if (!apiKey || !MODEL_PATTERN.test(modelName)) {
        const stored = await chrome.storage.local.get(["geminiApiKey", "selectedModel"]);
        apiKey = apiKey || String(stored.geminiApiKey || "").trim();
        if (!MODEL_PATTERN.test(modelName)) {
          modelName = String(stored.selectedModel || DEFAULT_MODEL).trim();
          if (!MODEL_PATTERN.test(modelName)) modelName = DEFAULT_MODEL;
        }
      }

      if (!apiKey) {
        sendResponse({ ok: false, message: "No API key provided. Enter your Gemini API key in the extension popup." });
        return;
      }

      activeModelOverride = null;
      const result = await runConnectionTest(apiKey, modelName);
      sendResponse(result);
    })().catch((error) => {
      try {
        sendResponse({ ok: false, message: "Test failed unexpectedly.", details: String(error?.message || error) });
      } catch (_) {}
    });
    return true;
  }

  if (request?.action === "CHECK_JOB_ALIVE") {
    const requestId = String(request.requestId || "");
    const job = jobs.get(requestId);
    const tabId = sender?.tab?.id;
    const alive = !!job && !job.canceled && Number.isInteger(tabId)
      ? latestRequestIdByTab.get(tabId) === requestId
      : false;
    try {
      sendResponse({ type: "JOB_ALIVE_RESULT", requestId, alive });
    } catch (_) {}
    return false;
  }

  if (request?.action === "CLEAR_MEMORY_CACHE") {
    memoryCache.clear();
    try {
      sendResponse({ ok: true });
    } catch (_) {}
    return true;
  }

  if (request?.action === "PRIORITIZE_SEEK") {
    const cueIndex = Number(request.cueIndex || 0);
    const playbackSec = Number(request.playbackSec || 0);
    const tabId = sender?.tab?.id;

    if (Number.isInteger(tabId)) {
      const activeReqId = latestRequestIdByTab.get(tabId);
      if (activeReqId) {
        const job = jobs.get(activeReqId);
        if (job && !job.canceled && job.reorderQueue) {
          job.reorderQueue(cueIndex, playbackSec);
        }
      }
    }
    try {
      sendResponse({ ok: true });
    } catch (_) {}
    return true;
  }

  if (request?.action !== "TRANSLATE_BATCH") return;

  const requestId = String(request.requestId || "");
  const videoId = String(request.videoId || "");
  const currentPlaybackSec = Number(request.currentPlaybackSec || 0);
  const currentCueIndex = Number.isInteger(request.currentCueIndex) ? request.currentCueIndex : -1;
  const tabId = sender?.tab?.id;

  // Support structured cues and legacy texts
  let cues = [];
  if (Array.isArray(request.cues) && request.cues.length > 0) {
    cues = request.cues
      .map((c) => ({
        index: Number.isInteger(c.index) ? c.index : 0,
        text: String(c.text || "").trim(),
        startMs: Number(c.startMs) || 0
      }))
      .filter((c) => c.text.length > 0);
  } else if (Array.isArray(request.texts)) {
    const startIdx = Number.isInteger(request.startIndex) && request.startIndex > 0 ? request.startIndex : 0;
    cues = request.texts
      .map((t, idx) => ({ index: startIdx + idx, text: String(t || "").trim(), startMs: 0 }))
      .filter((c) => c.text.length > 0);
  }

  if (!requestId || !cues.length || !Number.isInteger(tabId)) {
    try {
      sendResponse({ accepted: false, error: "Invalid translation request parameters." });
    } catch (_) {}
    return;
  }

  for (const [id, job] of jobs) {
    if (job.tabId === tabId && id !== requestId) {
      if (job.videoId !== videoId) {
        job.canceled = true;
      }
    }
  }

  const jobRecord = { tabId, videoId, canceled: false, reorderQueue: null };
  jobs.set(requestId, jobRecord);
  latestRequestIdByTab.set(tabId, requestId);

  try {
    sendResponse({ accepted: true, requestId, total: cues.length });
  } catch (_) {}

  translationQueue = translationQueue
    .catch(() => {})
    .then(() =>
      processRequest({
        requestId,
        videoId,
        cues,
        tabId,
        currentPlaybackSec,
        currentCueIndex,
        jobRecord
      })
    )
    .catch(async (error) => {
      console.error("[CleanSubs] Translation job exception:", error);
      if (!isStaleJob(tabId, requestId)) {
        await sendProgress(tabId, requestId, {
          type: "TRANSLATION_ERROR",
          videoId,
          error: describeError(error),
          details: error?.message || String(error)
        });
      }
    })
    .finally(() => {
      jobs.delete(requestId);
      if (latestRequestIdByTab.get(tabId) === requestId) {
        latestRequestIdByTab.delete(tabId);
      }
    });

  return false;
});

function isStaleJob(tabId, requestId) {
  const job = jobs.get(requestId);
  if (!job || job.canceled) return true;
  if (Number.isInteger(tabId)) {
    const latestReq = latestRequestIdByTab.get(tabId);
    if (latestReq && latestReq !== requestId) {
      const latestJob = jobs.get(latestReq);
      if (latestJob && latestJob.videoId !== job.videoId) {
        return true;
      }
    }
  }
  return false;
}

function describeError(error) {
  const status = error?.status || parseStatus(error?.message);
  const lower = String(error?.details || error?.message || "").toLowerCase();

  if (error?.isInvalidApiKey || (status === 400 && /api key not valid|invalid api key|api_key_invalid/i.test(lower))) {
    return "Your Gemini API key was rejected by Google (API key invalid). Check your key at ai.google.dev.";
  }
  if (error?.isApiDisabled || /generative language api has not been used|not enabled/i.test(lower)) {
    return "Generative Language API is not enabled for this Google project. Enable it in Google Cloud Console.";
  }
  if (status === 400 && /location is not supported|user location/i.test(lower)) {
    return "Gemini API is not available in your current geographic region (HTTP 400). A VPN may be required.";
  }
  if ((status === 404 || status === 400) && /not found|unsupported|model/i.test(lower)) {
    return `The selected model is unavailable for your account. Switched to '${DEFAULT_MODEL}'.`;
  }
  if (status === 403) {
    return "Access denied (HTTP 403). Make sure the Generative Language API is enabled for your API key.";
  }
  if (status === 429) {
    return "Gemini free rate limit reached (HTTP 429). Pausing momentarily before resuming...";
  }
  if (status >= 500) {
    return `Gemini service temporarily busy (HTTP ${status}). Retrying automatically...`;
  }
  if (/timed out/i.test(lower)) {
    return "Gemini request timed out. Retrying...";
  }
  if (error?.details) {
    return `Gemini Error (${status || 400}): ${String(error.details).slice(0, 160)}`;
  }
  return "Translation error. Auto-recovering with fallback model...";
}

async function processRequest({
  requestId,
  videoId,
  cues,
  tabId,
  currentPlaybackSec,
  currentCueIndex = -1,
  jobRecord
}) {
  if (isStaleJob(tabId, requestId)) return;

  const { geminiApiKey, extensionEnabled, selectedModel } = await chrome.storage.local.get([
    "geminiApiKey",
    "extensionEnabled",
    "selectedModel"
  ]);

  if (extensionEnabled === false) {
    await sendProgress(tabId, requestId, {
      type: "TRANSLATION_ERROR",
      videoId,
      error: "Extension is disabled in settings popup."
    });
    return;
  }

  const apiKey = String(geminiApiKey || "").trim();
  if (!apiKey) {
    await sendProgress(tabId, requestId, {
      type: "TRANSLATION_ERROR",
      videoId,
      error: "Gemini API key missing. Click the CleanSubs extension icon to enter your key."
    });
    return;
  }

  let modelName = String(selectedModel || DEFAULT_MODEL).trim();
  if (!MODEL_PATTERN.test(modelName)) {
    modelName = DEFAULT_MODEL;
  }

  const total = cues.length;
  const allTranslations = new Map();
  const primaryKeys = cues.map((c) => makeCacheKey(c.text));
  const legacyKeys = cues.map((c) => makeLegacyCacheKey(c.text, modelName));

  const cachedCues = [];
  const uncachedCues = [];

  // Step 1: Check In-Memory L1 Cache first (0ms synchronous lookup)
  const l1Missing = [];
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const pKey = CACHE_PREFIX + primaryKeys[i];
    const lKey = CACHE_PREFIX + legacyKeys[i];

    if (memoryCache.has(pKey)) {
      const val = memoryCache.get(pKey);
      allTranslations.set(cue.index, val);
      cachedCues.push({ index: cue.index, translation: val });
    } else if (memoryCache.has(lKey)) {
      const val = memoryCache.get(lKey);
      allTranslations.set(cue.index, val);
      cachedCues.push({ index: cue.index, translation: val });
    } else {
      l1Missing.push(i);
    }
  }

  // Step 2: Check Disk Cache (chrome.storage.local) for items missing in L1
  if (l1Missing.length > 0) {
    const diskLookupKeys = [];
    for (const idx of l1Missing) {
      diskLookupKeys.push(CACHE_PREFIX + primaryKeys[idx]);
      diskLookupKeys.push(CACHE_PREFIX + legacyKeys[idx]);
    }

    let diskCached = {};
    try {
      diskCached = await chrome.storage.local.get(diskLookupKeys);
    } catch (err) {
      console.warn("[CleanSubs] Disk cache lookup warning:", err);
    }

    for (const idx of l1Missing) {
      const cue = cues[idx];
      const pKey = CACHE_PREFIX + primaryKeys[idx];
      const lKey = CACHE_PREFIX + legacyKeys[idx];
      const val = diskCached[pKey] || diskCached[lKey];

      if (typeof val === "string" && val.trim()) {
        allTranslations.set(cue.index, val);
        setMemoryCache(pKey, val); // Promote to L1
        cachedCues.push({ index: cue.index, translation: val });
      } else {
        uncachedCues.push(cue);
      }
    }
  }

  // Sort cached hits by original index order
  cachedCues.sort((a, b) => a.index - b.index);

  let sentCached = 0;
  for (let i = 0; i < cachedCues.length; i += PROGRESS_CHUNK) {
    if (isStaleJob(tabId, requestId)) return;

    const slice = cachedCues.slice(i, i + PROGRESS_CHUNK);
    const indexes = slice.map((c) => c.index);
    const translations = slice.map((c) => c.translation);
    const texts = slice.map((c) => cues.find((q) => q.index === c.index)?.text || "");
    sentCached += slice.length;

    await sendProgress(tabId, requestId, {
      type: "TRANSLATION_PROGRESS",
      videoId,
      total,
      indexes,
      translations,
      texts,
      complete: false,
      completedCues: sentCached
    });
  }

  let completed = cachedCues.length;

  if (uncachedCues.length === 0) {
    await sendProgress(tabId, requestId, {
      type: "TRANSLATION_PROGRESS",
      videoId,
      total,
      indexes: [],
      translations: [],
      complete: true,
      completedCues: completed
    });
    return;
  }

  // Prioritize uncached cues based on playback time/cue index
  function sortUncached(targetIndex) {
    const pivot = targetIndex >= 0 ? targetIndex : 0;
    uncachedCues.sort((a, b) => {
      const fwdA = a.index >= pivot ? a.index - pivot : 1000000 + (pivot - a.index);
      const fwdB = b.index >= pivot ? b.index - pivot : 1000000 + (pivot - b.index);
      return fwdA - fwdB;
    });
  }

  const initialPivot = currentCueIndex >= 0
    ? currentCueIndex
    : Math.max(0, Math.floor(currentPlaybackSec / 3));
  sortUncached(initialPivot);

  if (jobRecord) {
    jobRecord.reorderQueue = (seekCueIndex, seekPlaybackSec) => {
      const pivot = seekCueIndex >= 0 ? seekCueIndex : Math.max(0, Math.floor(seekPlaybackSec / 3));
      sortUncached(pivot);
    };
  }

  let isFirstBatch = true;

  while (uncachedCues.length > 0) {
    if (isStaleJob(tabId, requestId)) return;
    await touchKeepAlive();

    const currentBatchLimit = isFirstBatch ? INITIAL_BURST_SIZE : BATCH_SIZE;
    const batchCues = [];
    let chars = 0;

    let pickIdx = 0;
    while (pickIdx < uncachedCues.length && batchCues.length < currentBatchLimit) {
      const candidate = uncachedCues[pickIdx];
      const candidateChars = candidate.text.length + 8;
      if (batchCues.length > 0 && chars + candidateChars > MAX_BATCH_CHARS) {
        break;
      }
      batchCues.push(candidate);
      chars += candidateChars;
      pickIdx += 1;
    }

    uncachedCues.splice(0, batchCues.length);
    isFirstBatch = false;

    const batch = batchCues.map((c) => c.text);

    let batchTranslations;
    try {
      batchTranslations = await translateBatchResilient(
        batch,
        apiKey,
        modelName,
        () => isStaleJob(tabId, requestId)
      );
    } catch (err) {
      if (isStaleJob(tabId, requestId)) return;
      console.warn("[CleanSubs] Batch error recovered gracefully:", err?.message || err);
      batchTranslations = batch.slice();
    }

    if (isStaleJob(tabId, requestId)) return;

    // Strict 1:1 length guarantee
    while (batchTranslations.length < batch.length) {
      batchTranslations.push(batch[batchTranslations.length]);
    }
    if (batchTranslations.length > batch.length) {
      batchTranslations = batchTranslations.slice(0, batch.length);
    }

    const cacheWrite = {};
    for (let i = 0; i < batchCues.length; i++) {
      const cue = batchCues[i];
      const translated = String(batchTranslations[i] ?? "").trim();
      const finalVal = translated || cue.text;
      allTranslations.set(cue.index, finalVal);

      const pKey = CACHE_PREFIX + makeCacheKey(cue.text);
      cacheWrite[pKey] = finalVal;
      setMemoryCache(pKey, finalVal);
    }

    try {
      await chrome.storage.local.set(cacheWrite);
      await pruneCacheIfNeeded(Object.keys(cacheWrite));
    } catch (_) {}

    completed += batchCues.length;

    await sendProgress(tabId, requestId, {
      type: "TRANSLATION_PROGRESS",
      videoId,
      total,
      indexes: batchCues.map((c) => c.index),
      translations: batchTranslations,
      texts: batchCues.map((c) => c.text),
      complete: uncachedCues.length === 0,
      completedCues: completed
    });
  }

  await sendProgress(tabId, requestId, {
    type: "TRANSLATION_PROGRESS",
    videoId,
    total,
    indexes: [],
    translations: [],
    complete: true,
    completedCues: completed
  });
}

async function sendProgress(tabId, requestId, message) {
  if (!Number.isInteger(tabId)) return;
  try {
    await chrome.tabs.sendMessage(tabId, { requestId, ...message });
  } catch (error) {
    const msg = String(error?.message || error);
    if (/no tab|tab was closed|receiving end does not exist|extension context invalidated/i.test(msg)) {
      const job = jobs.get(requestId);
      if (job) job.canceled = true;
    }
  }
}

let recentRequestTimestamps = [];

async function getRecentRequestTimestamps() {
  if (chrome.storage?.session) {
    try {
      const res = await chrome.storage.session.get("recentRequestTimestamps");
      if (Array.isArray(res?.recentRequestTimestamps)) {
        recentRequestTimestamps = res.recentRequestTimestamps;
      }
    } catch (_) {}
  }
  return recentRequestTimestamps;
}

async function recordRequestTimestamp(ts) {
  recentRequestTimestamps.push(ts);
  if (chrome.storage?.session) {
    try {
      await chrome.storage.session.set({ recentRequestTimestamps });
    } catch (_) {}
  }
}

async function waitForRateSlot() {
  await getRecentRequestTimestamps();
  for (;;) {
    const now = Date.now();
    recentRequestTimestamps = recentRequestTimestamps.filter(
      (time) => Number.isFinite(time) && now - time < 60000
    );

    // Write pruned timestamps back to session storage to prevent unbounded growth
    if (chrome.storage?.session) {
      try {
        await chrome.storage.session.set({ recentRequestTimestamps });
      } catch (_) {}
    }

    let waitMs = 0;
    if (recentRequestTimestamps.length >= MAX_REQUESTS_PER_MINUTE) {
      waitMs = Math.max(150, 60000 - (now - recentRequestTimestamps[0]) + 50);
    } else {
      const last = recentRequestTimestamps[recentRequestTimestamps.length - 1] || 0;
      const gap = MIN_REQUEST_GAP_MS - (now - last);
      if (gap > 0) waitMs = gap;
    }

    if (waitMs <= 0) break;
    await sleep(waitMs);
  }
  await recordRequestTimestamp(Date.now());
}

function isRetryableError(error) {
  if (!error) return false;
  if (error.isTimeout || error.isNetworkError || error.retryableShape) return true;
  const status = error.status || parseStatus(error.message);
  if (RETRYABLE_STATUSES.has(status)) return true;
  const msg = String(error.message || error).toLowerCase();
  return (
    msg.includes("timed out") ||
    msg.includes("time out") ||
    msg.includes("timeout") ||
    msg.includes("aborterror") ||
    msg.includes("aborted") ||
    msg.includes("network") ||
    msg.includes("failed to fetch") ||
    msg.includes("fetch failed") ||
    msg.includes("econnreset") ||
    msg.includes("connection error") ||
    msg.includes("rate limit") ||
    msg.includes("resource has been exhausted") ||
    msg.includes("temporarily busy")
  );
}

async function translateBatchResilient(batch, apiKey, modelName, shouldAbort) {
  if (shouldAbort?.()) throw new Error("Translation canceled.");

  try {
    return await translateWithRetry(batch, apiKey, modelName, shouldAbort);
  } catch (error) {
    if (shouldAbort?.()) throw error;

    // If batch has multiple cues, bisect into smaller chunks to force success!
    // Smaller batches process vastly faster and do not time out!
    if (batch.length > 1) {
      console.warn(
        `[CleanSubs] Batch of ${batch.length} cues encountered issue (${error?.message || error}), splitting batch into smaller halves to force success...`
      );
      const mid = Math.ceil(batch.length / 2);
      const left = batch.slice(0, mid);
      const right = batch.slice(mid);

      const leftTranslations = await translateBatchResilient(left, apiKey, modelName, shouldAbort);
      const rightTranslations = await translateBatchResilient(right, apiKey, modelName, shouldAbort);
      return leftTranslations.concat(rightTranslations);
    }

    // If a single cue still fails after all retries and fallback models, keep original text so pipeline NEVER crashes
    if (batch.length === 1) {
      console.warn(`[CleanSubs] Single cue failed to translate after all retries, using original text: "${batch[0]}"`);
      return [batch[0]];
    }

    throw error;
  }
}

function buildModelCandidates(failedModel) {
  const candidates = [];
  for (const m of FALLBACK_MODELS) {
    if (m && m !== failedModel && !candidates.includes(m)) {
      candidates.push(m);
    }
  }
  return candidates;
}

async function translateWithRetry(batch, apiKey, modelName, shouldAbort) {
  let lastError = null;
  let effectiveModel = activeModelOverride || modelName;
  const triedModels = new Set([effectiveModel]);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (shouldAbort?.()) throw new Error("Translation canceled.");

    try {
      await waitForRateSlot();
      return await translateWithGemini(batch, apiKey, effectiveModel);
    } catch (error) {
      lastError = error;
      if (shouldAbort?.()) throw error;

      const status = error?.status || parseStatus(error?.message);
      const errDetailStr = String(error?.details || error?.message || "");

      // Check if API key is invalid (do not rotate models for invalid key)
      const isInvalidKey =
        status === 400 &&
        /api key not valid|invalid api key|api_key_invalid/i.test(errDetailStr);

      // Model Not Found (404) or unsupported/failing model on 400/403
      const isModelError =
        !isInvalidKey &&
        (status === 404 ||
          String(error?.message || "").includes("404") ||
          (status === 400 && !isInvalidKey) ||
          status === 403);

      const isTimeout = error?.isTimeout || /timed out|time out|aborterror/i.test(String(error?.message || ""));
      const isTransient = isRetryableError(error);

      // On model error or timeout, switch models to unstick the API
      if (isModelError || (isTimeout && attempt >= 1) || (status === 503 && attempt >= 1)) {
        const candidates = buildModelCandidates(effectiveModel);
        let recovered = false;

        for (const candidate of candidates) {
          if (!triedModels.has(candidate)) {
            console.warn(
              `[CleanSubs] Rotating model from "${effectiveModel}" to "${candidate}" (reason: ${isTimeout ? "timeout" : "status " + status})...`
            );
            effectiveModel = candidate;
            activeModelOverride = candidate;
            triedModels.add(candidate);
            recovered = true;
            try {
              chrome.storage.local.set({ selectedModel: candidate });
            } catch (_) {}
            break;
          }
        }

        if (recovered) {
          attempt--; // Give the new model a fresh attempt
          continue;
        }
      }

      // If not transient and not model error, fail fast (e.g. invalid API key)
      if (!isTransient && !isModelError) {
        throw error;
      }

      const waitMs = Math.min(20000, Math.max(1200, error?.retryAfterMs || 1800 * Math.pow(1.5, attempt)));
      console.warn(
        `[CleanSubs] Transient error on attempt ${attempt + 1}/${MAX_RETRIES} (${error?.message || error}). Forcing retry in ${waitMs}ms...`
      );
      await sleep(waitMs);
    }
  }

  throw lastError || new Error("Gemini translation failed after retries.");
}

async function translateWithGemini(batch, apiKey, modelName) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    modelName
  )}:generateContent`;

  const prompt = `You translate German YouTube subtitles into natural, concise conversational English.
Rules:
- Return exactly ONE English string for EACH input cue.
- Keep the exact same order.
- NEVER merge cues.
- NEVER split cues.
- NEVER omit a cue.
- NEVER add a cue.
- Preserve names, numbers, jokes, tone, idioms, and punctuation.
- Keep translations brief and fitting as video subtitles.
- Output JSON array of strings only.
INPUT COUNT: ${batch.length}
INPUT ARRAY:
${JSON.stringify(batch)}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  // Model-aware generationConfig tailored to Gemini API specs
  const generationConfig = {
    responseMimeType: "application/json"
  };

  if (modelName.includes("3.")) {
    // Gemini 3.x models use thinkingLevel instead of numeric thinkingBudget, and omit temperature
    generationConfig.thinkingConfig = { thinkingLevel: "minimal" };
  } else if (modelName.includes("2.5")) {
    // Gemini 2.5 series supports disabling thinking with budget 0
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
    generationConfig.temperature = 0.1;
  } else {
    generationConfig.temperature = 0.1;
  }

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig
      }),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutErr = new Error(`Gemini request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
      timeoutErr.isTimeout = true;
      timeoutErr.retryableShape = true;
      throw timeoutErr;
    }
    const netErr = new Error(`Gemini network connection error: ${error?.message || error}`);
    netErr.isNetworkError = true;
    netErr.retryableShape = true;
    throw netErr;
  } finally {
    clearTimeout(timeoutId);
  }

  // Gracefully recover if a model variant rejects thinkingConfig or options with 400
  if (!response.ok && response.status === 400) {
    try {
      console.warn("[CleanSubs] Model returned HTTP 400, retrying with clean baseline JSON config...");
      const cleanConfig = { responseMimeType: "application/json" };
      const retryController = new AbortController();
      const retryTimeoutId = setTimeout(() => retryController.abort(), REQUEST_TIMEOUT_MS);
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: cleanConfig
          }),
          signal: retryController.signal
        });
      } finally {
        clearTimeout(retryTimeoutId);
      }
    } catch (_) {}
  }

  if (!response.ok) {
    const errText = (await response.text()).slice(0, 2000);
    let errDetail = errText;
    try {
      const parsed = JSON.parse(errText);
      if (parsed?.error?.message) {
        errDetail = parsed.error.message;
      }
    } catch (_) {}

    const error = new Error(`Gemini API Error (${response.status}): ${errDetail}`);
    error.status = response.status;
    error.details = errDetail;

    if (/api key not valid|invalid api key|api_key_invalid/i.test(errDetail)) {
      error.isInvalidApiKey = true;
    }
    if (/generative language api has not been used|not enabled/i.test(errDetail)) {
      error.isApiDisabled = true;
    }

    throw error;
  }

  const data = await response.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) throw new Error("Empty translation response received from Gemini.");

  let clean = rawText.trim();
  if (clean.startsWith("```json")) {
    clean = clean.replace(/^```json\s*/, "").replace(/\s*```$/, "");
  } else if (clean.startsWith("```")) {
    clean = clean.replace(/^```\s*/, "").replace(/\s*```$/, "");
  }

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (err) {
    const parseError = new Error(`Gemini returned non-JSON payload: ${err.message}`);
    parseError.retryableShape = true;
    throw parseError;
  }

  if (!Array.isArray(parsed)) throw new Error("Gemini returned non-array translation structure.");
  if (parsed.length !== batch.length) {
    const shapeError = new Error(`Gemini translation count mismatch: expected ${batch.length}, received ${parsed.length}`);
    shapeError.retryableShape = true;
    throw shapeError;
  }
  return parsed.map((v) => String(v ?? "").trim());
}

function parseStatus(message) {
  const match = String(message || "").match(/Gemini API Error \((\d{3})\)/);
  return match ? Number(match[1]) : 0;
}

function normalizeText(text) {
  return String(text || "").trim().replace(/\s+/g, " ");
}

function makeCacheKey(text) {
  const norm = normalizeText(text);
  const value = `de:en:${norm}`;
  let h1 = 2166136261;
  let h2 = 5381;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 16777619);
    h2 = (Math.imul(h2, 33) + c) | 0;
  }
  return `${(h1 >>> 0).toString(16)}_${(h2 >>> 0).toString(16)}_${value.length.toString(36)}`;
}

function makeLegacyCacheKey(text, model) {
  const value = `${model}:en:${text}`;
  let h1 = 2166136261;
  let h2 = 5381;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 16777619);
    h2 = (Math.imul(h2, 33) + c) | 0;
  }
  return `${(h1 >>> 0).toString(16)}_${(h2 >>> 0).toString(16)}_${value.length.toString(36)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pruneCacheIfNeeded(newKeysAdded = []) {
  try {
    const metaRes = await chrome.storage.local.get([CACHE_META_KEY]);
    let keyList = Array.isArray(metaRes?.[CACHE_META_KEY]) ? metaRes[CACHE_META_KEY] : null;

    if (!keyList) {
      const all = await chrome.storage.local.get(null);
      keyList = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
    }

    let modified = false;
    for (const k of newKeysAdded) {
      const fullKey = k.startsWith(CACHE_PREFIX) ? k : CACHE_PREFIX + k;
      if (!keyList.includes(fullKey)) {
        keyList.push(fullKey);
        modified = true;
      }
    }

    if (keyList.length > MAX_CACHE_ENTRIES) {
      const excess = keyList.length - MAX_CACHE_ENTRIES;
      const toRemove = keyList.splice(0, excess);
      await chrome.storage.local.remove(toRemove);
      modified = true;
    }

    if (modified) {
      await chrome.storage.local.set({ [CACHE_META_KEY]: keyList });
    }
  } catch (err) {
    console.debug("[CleanSubs] Cache pruning note:", err);
  }
}

