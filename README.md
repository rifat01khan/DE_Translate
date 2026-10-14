# Clean German Subtitles for YouTube (v4.8.3)

Ultra-reliable German-to-English subtitle translation and **comprehensive language learning suite** for YouTube powered by Google Gemini. Engineered for marathon 3+ hour videos with zero drift, persistent Manifest V3 Service Worker keep-alive, instant seek prioritization, and robust chunk deduplication.

---

## 🛠️ What's New in v4.8.3: Service Worker Lifecycle & Zero-Drift Sync
- **Manifest V3 Persistent Auto-Reconnecting Keep-Alive Channel**: Solved Chrome MV3 service worker dormancy (`service worker (Inactive)`). Content scripts now maintain an 8s bidirectional heartbeat on `clean-subs-keepalive` that automatically reconnects across the 5-minute Chromium port limit.
- **Service Worker Active Work Heartbeat**: Background service worker periodically registers session heartbeats during batch translations, completely preventing Chrome from killing jobs mid-flight.
- **Zero-Drift Text-Based Translation Alignment**: Translations are now mapped and cached by canonical German text (`texts` payload), ensuring that even if YouTube inserts ads or restitches chunks on long videos, sentences never receive mismatched translations.
- **Coalesced Extraction Pipeline**: Debounced multiple rapid caption discovery events from YouTube to eliminate request cancellation storms at video start.
- **Active Gemini 3.x Models in Google AI Studio**: Configured defaults and fallback cascades for `gemini-3.1-flash-lite`, `gemini-3.5-flash-lite`, `gemini-3.8-flash`, and `gemini-3.7-flash` with automatic HTTP 400 schema recovery.

---

## 🌟 Language Learning Suite

### 1. 🧠 Quiz & Active Recall Mode
- **Active Listening Training**: Shows spoken German clearly while keeping the English translation blurred.
- **Instant Reveal**: Press **`Space`** or simply **click the blurred subtitle** to reveal the English translation once you've tested your comprehension.
- **Automatic Reset**: When the next dialogue cue arrives, the translation blurs again automatically for continuous recall practice.

### 2. 📖 Word-Level Clickable Dictionary (`dictionary.js`)
- **Interactive Words**: Every single German word in the subtitle overlay is clickable.
- **Instant Definition Card**: Click any word to open a sleek mini popup showing:
  - English definition
  - Part of speech (noun, verb, adjective, preposition, etc.)
  - Noun gender with article (**der**, **die**, **das**)
- **1-Click Anki Save**: Click **★ Save to Anki** directly inside the word definition popup to bookmark individual vocabulary words with their dictionary translation.

### 3. 🔆 Intelligent Vocabulary Highlighting
- **Visual Reinforcement**: Any word you've saved to your Vocabulary Bank is automatically detected and given an elegant **green underline** (`.vocab-known`) whenever it appears in future subtitles.
- Helps you spot words you're studying in real spoken contexts!

### 4. 🔁 Cue Loop Drill (`L` Key)
- **Pronunciation & Shadowing Drill**: Press **`L`** on any active subtitle cue to loop that exact 2–5 second video segment continuously.
- Replays the audio clip in a loop until you press **`L`** again. Perfect for shadowing difficult German pronunciation, dialect nuances, or fast native speech.
- Displays an amber **🔁** loop indicator badge on the subtitle box while active.

### 5. ⏸️ Auto-Pause Mode (`Alt+P`)
- **Reading Comprehension Assistant**: Automatically pauses video playback each time a new subtitle cue begins, giving you time to read, think, and process the German grammar.
- Toggle anytime via **`Alt+P`** or from the extension popup. Displays a purple **⏸ AUTO** badge when enabled.

### 6. 📊 Real-Time Session Learning Stats
- A subtle, translucent progress pill floating at the top of the video player:
  - 📖 **Cues Seen**: Number of unique subtitle phrases studied during your session.
  - ★ **Words Saved**: Total vocabulary cards bookmarked this session.
  - 📊 **Video Progress**: Percentage of video subtitles covered.

---

## 🎛️ On-Player Quick Controls & Dragging

- **`[CS]` Player Bar Button**: Injected directly into YouTube's right control bar with live mode badges:
  - `BI` (Bilingual)
  - `EN` (English Only)
  - `DE` (German Only — 0 API tokens used)
  - `QZ` (Quiz / Reveal Mode)
  - `OFF` (Disabled)
- **On-Screen Settings Card**: Click `[CS]` to change modes, font sizes, positions, or export Anki/SRT without leaving the video.
- **Draggable Subtitle Box**: Click and drag the subtitle box anywhere on the screen with mouse boundary clamping and persistent coordinate memory.

---

## ⌨️ Complete Keyboard Shortcuts Reference

| Shortcut | Action | Description |
| :--- | :--- | :--- |
| **`Space`** | **Reveal Quiz** | In Quiz Mode, reveals the blurred English translation |
| **`L`** | **Toggle Cue Loop** | Loops the current 2–5s video cue continuously for shadowing |
| **`R`** | **Replay Cue** | Rewinds and replays the current subtitle cue once |
| **`Alt + C`** | **Toggle CleanSubs** | Toggles subtitle overlay on / off |
| **`Alt + B`** | **Cycle Modes** | Cycles `Bilingual` ➡️ `English` ➡️ `German` ➡️ `Quiz` |
| **`Alt + S`** | **Bookmark Cue** | Saves active sentence to your Anki Vocabulary Bank |
| **`Alt + P`** | **Toggle Auto-Pause** | Toggles automatic pausing on every new subtitle cue |

---

## 💎 Core Architecture & Stability

- **Sub-Second Latency (`thinkingBudget: 0`)**: Hybrid reasoning models (`gemini-3.1-flash-lite`, `gemini-3.5-flash-lite`, `gemini-3.8-flash`) run with thinking tokens bypassed for lightning-fast <700ms responses.
- **Model-Agnostic & L1 In-Memory Caching**: Translations are cached by normalized language pair (`de:en`) in a dual L1 memory / L2 disk architecture for instant 0ms cross-model hits.
- **Fast Initial Burst**: The opening subtitle cue translates in an initial compact burst (~300ms) for instant display right as playback begins.
- **Pruned Session Rate Limiter**: Strictly enforces the free-tier 15 RPM / 3s gap limits with auto-pruning to eliminate session storage bloat.
- **German Only Mode**: Clean, stitched, properly punctuated German subtitles with 0 Gemini API calls (zero quota used).
- **Model 404 Auto-Recovery**: Automatically switches to working Gemini fallback models if a selected model is deprecated.
- **Bounded LRU Cache**: Automatically enforces `MAX_CACHE_ENTRIES` (20,000) for instant startup and lightweight storage.
- **1-Click Anki Export**: Generates tab-separated `.tsv` flashcards (`German \t English \t Source Video \t Timestamp \t Date Added`).
- **Full SRT Transcript Downloader**: Export full video subtitles formatted as standard `.srt` files.

---

## 🚀 How to Install / Load in Chrome

1. Open Google Chrome (or Brave, Edge, Opera, Vivaldi).
2. Navigate to `chrome://extensions/`.
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked** in the top-left corner.
5. Select this folder (`clean-german-subtitle_QWEN_CODER-main`).
6. Click the extension icon in your browser toolbar:
   - Enter your free Gemini API key from [Google AI Studio](https://aistudio.google.com).
   - Select your preferred model (e.g., `gemini-3.1-flash-lite`).
   - Click **Save Settings**, then click **Test Key** to verify.
7. Open any German YouTube video and start mastering spoken German!

---

## 📄 License

MIT License. Free to use, modify, and distribute.
