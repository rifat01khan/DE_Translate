// CleanSubs - Popup Controller v4.9.1
document.addEventListener("DOMContentLoaded", async () => {
  const keyInput = document.getElementById("apiKey");
  const modelSelect = document.getElementById("modelSelect");
  const subtitleModeSelect = document.getElementById("subtitleModeSelect");
  const fontSizeSelect = document.getElementById("fontSizeSelect");
  const positionSelect = document.getElementById("positionSelect");
  const toggle = document.getElementById("extToggle");
  const saveBtn = document.getElementById("saveBtn");
  const testBtn = document.getElementById("testBtn");
  const clearCacheBtn = document.getElementById("clearCacheBtn");
  const exportAnkiBtn = document.getElementById("exportAnkiBtn");
  const downloadSrtBtn = document.getElementById("downloadSrtBtn");
  const vocabCountEl = document.getElementById("vocabCount");
  const msg = document.getElementById("msg");

  const data = await chrome.storage.local.get([
    "geminiApiKey",
    "extensionEnabled",
    "selectedModel",
    "fontSize",
    "subtitleMode",
    "subtitlePosition",
    "vocabularyBank",
    "autoPauseEnabled",
    "karaokeHighlightEnabled"
  ]);

  if (data.geminiApiKey) {
    keyInput.value = data.geminiApiKey;
  }

  let activeModel = data.selectedModel || "gemini-2.5-flash";

  if (activeModel) {
    if (![...modelSelect.options].some((o) => o.value === activeModel)) {
      const opt = document.createElement("option");
      opt.value = activeModel;
      opt.textContent = activeModel;
      modelSelect.appendChild(opt);
    }
    modelSelect.value = activeModel;
  }

  if (data.subtitleMode) {
    subtitleModeSelect.value = data.subtitleMode;
  }

  if (data.fontSize) {
    fontSizeSelect.value = data.fontSize;
  }

  if (data.subtitlePosition && positionSelect) {
    positionSelect.value = data.subtitlePosition;
  }

  const karaokeToggle = document.getElementById("karaokeToggle");
  if (karaokeToggle) {
    karaokeToggle.checked = data.karaokeHighlightEnabled !== false;
    karaokeToggle.addEventListener("change", async () => {
      await chrome.storage.local.set({ karaokeHighlightEnabled: karaokeToggle.checked });
      showMessage(karaokeToggle.checked ? "Karaoke highlighting enabled!" : "Karaoke highlighting disabled!");
    });
  }

  const autoPauseToggle = document.getElementById("autoPauseToggle");

  if (autoPauseToggle) {
    autoPauseToggle.checked = data.autoPauseEnabled === true;
    autoPauseToggle.addEventListener("change", async () => {
      await chrome.storage.local.set({ autoPauseEnabled: autoPauseToggle.checked });
      showMessage(autoPauseToggle.checked ? "Auto-pause enabled!" : "Auto-pause disabled!");
    });
  }

  if (vocabCountEl) {
    const bank = Array.isArray(data.vocabularyBank) ? data.vocabularyBank : [];
    vocabCountEl.textContent = bank.length;
  }

  toggle.checked = data.extensionEnabled !== false;

  function showMessage(text, color = "#16a34a", duration = 4000) {
    msg.style.color = color;
    msg.textContent = text;
    if (duration > 0) {
      setTimeout(() => {
        if (msg.textContent === text) {
          msg.textContent = "";
        }
      }, duration);
    }
  }

  saveBtn.addEventListener("click", async () => {
    const key = keyInput.value.trim();
    const model = modelSelect.value;

    if (!key) {
      showMessage("Please enter a Gemini API key.", "#dc2626");
      return;
    }

    await chrome.storage.local.set({
      geminiApiKey: key,
      selectedModel: model,
      subtitleMode: subtitleModeSelect.value,
      fontSize: fontSizeSelect.value,
      subtitlePosition: positionSelect?.value || "bottom",
      extensionEnabled: toggle.checked,
      autoPauseEnabled: autoPauseToggle ? autoPauseToggle.checked : false,
      karaokeHighlightEnabled: karaokeToggle ? karaokeToggle.checked : true
    });

    showMessage("Settings saved successfully!");
  });

  subtitleModeSelect.addEventListener("change", async () => {
    await chrome.storage.local.set({ subtitleMode: subtitleModeSelect.value });
    showMessage("Subtitle mode updated!");
  });

  fontSizeSelect.addEventListener("change", async () => {
    await chrome.storage.local.set({ fontSize: fontSizeSelect.value });
    showMessage("Subtitle size updated!");
  });

  positionSelect?.addEventListener("change", async () => {
    await chrome.storage.local.set({ subtitlePosition: positionSelect.value });
    showMessage("Subtitle position updated!");
  });

  exportAnkiBtn?.addEventListener("click", async () => {
    const res = await chrome.storage.local.get(["vocabularyBank"]);
    const bank = Array.isArray(res.vocabularyBank) ? res.vocabularyBank : [];
    if (!bank.length) {
      showMessage("No words saved yet! Click ★ on any subtitle or press Alt+S to save words.", "#64748b", 5000);
      return;
    }

    let csv = "German\tEnglish\tSource Video\tTimestamp\tDate Added\n";
    for (const item of bank) {
      const de = (item.german || "").replace(/[\t\n\r]/g, " ").trim();
      const en = (item.translated || "").replace(/[\t\n\r]/g, " ").trim();
      const vid = (item.videoTitle || "").replace(/[\t\n\r]/g, " ").trim();
      const ts = item.timestamp
        ? `${Math.floor(item.timestamp / 60)}:${String(item.timestamp % 60).padStart(2, "0")}`
        : "00:00";
      csv += `${de}\t${en}\t${vid}\t${ts}\t${item.dateAdded || ""}\n`;
    }

    const blob = new Blob([csv], { type: "text/tab-separated-values;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "CleanSubs_Anki_Flashcards.tsv";
    a.click();
    URL.revokeObjectURL(url);
    showMessage(`Exported ${bank.length} flashcards for Anki!`);
  });

  downloadSrtBtn?.addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "EXPORT_SRT" }, (resp) => {
          if (chrome.runtime.lastError || !resp?.ok) {
            showMessage("Open a YouTube video with subtitles first.", "#dc2626");
          } else {
            showMessage("Subtitles exported (.SRT)!");
          }
        });
      }
    });
  });

  toggle.addEventListener("change", async () => {
    await chrome.storage.local.set({
      extensionEnabled: toggle.checked
    });
    showMessage(toggle.checked ? "Extension enabled." : "Extension disabled.");
  });

  testBtn.addEventListener("click", async () => {
    const key = keyInput.value.trim();
    const model = modelSelect.value;

    if (!key) {
      showMessage("Enter an API key first.", "#dc2626");
      return;
    }

    showMessage("Testing API connection...", "#0284c7", 0);

    try {
      const res = await chrome.runtime.sendMessage({
        action: "TEST_CONNECTION",
        apiKey: key,
        model
      });

      if (res?.ok) {
        if (res.modelUsed && res.modelUsed !== model) {
          modelSelect.value = res.modelUsed;
          await chrome.storage.local.set({ selectedModel: res.modelUsed });
          showMessage(
            `Connected! "${model}" was unavailable, switched to "${res.modelUsed}" and saved!`,
            "#d97706",
            7000
          );
        } else {
          showMessage(`Connection verified! Model "${model}" is ready.`, "#16a34a", 5000);
        }
      } else {
        const detailMsg = res?.details && res.details !== res?.message ? ` (${res.details})` : "";
        showMessage(
          `Test failed: ${res?.message || "Unknown error."}${detailMsg}`,
          "#dc2626",
          10000
        );
      }
    } catch (err) {
      showMessage("Could not reach extension background worker. Try reloading the extension.", "#dc2626", 7000);
    }
  });

  clearCacheBtn.addEventListener("click", async () => {
    try {
      await chrome.runtime.sendMessage({ action: "CLEAR_MEMORY_CACHE" });
    } catch (_) {}

    const all = await chrome.storage.local.get(null);
    const keysToRemove = Object.keys(all).filter(
      (k) => k.startsWith("cleanSubsCache:") || k === "cleanSubsCacheMeta"
    );

    if (keysToRemove.length === 0) {
      showMessage("Cache already empty.", "#64748b");
      return;
    }

    await chrome.storage.local.remove(keysToRemove);
    const subtitleCount = keysToRemove.filter((k) => k !== "cleanSubsCacheMeta").length;
    showMessage(`Cleared ${subtitleCount} cached subtitles!`);
  });
});
