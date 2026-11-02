# Scout AI — iPhone Research Agent

Scout AI is a mobile-first, installable web app inspired by research-agent workflows. It runs in Safari on an iPhone (or any modern browser) and can be hosted as static files on GitHub Pages. No App Store install required.

## What’s new in this version

- **On-device models via WebLLM** — download a small open model once; it runs entirely in the browser with WebGPU. No API key, no data leaves the device.
- **Downloadable files panel** — Scout detects PDFs, datasets, spreadsheets, archives and similar links among search results and lists them with Open / Download buttons.
- Extra search angles aimed at papers and open data (`filetype:pdf`, preprint, dataset, etc.).
- Clear UI for choosing provider (none / on-device / OpenAI-compatible / Ollama).
- Progress feedback while a model downloads and loads.
- Explicit “Download now” button so you can preload a model before starting research.
- Honest guidance about which model sizes work on iPhone (memory limits are real).

## What works

- iPhone-friendly research dashboard and Home Screen web-app metadata.
- Multi-angle search using Wikipedia’s public API and DuckDuckGo Instant Answer API.
- Retry with a broader query when few results are found.
- Detection of downloadable files (PDF, CSV, XLSX, ZIP, datasets, preprints…) with a dedicated download panel.
- Source digest when no AI model is configured.
- Optional synthesis with:
  - **WebLLM** (on-device, downloadable)
  - any OpenAI-compatible chat-completions endpoint
  - Ollama (or similar) local endpoint
- Locally saved discoveries, source URLs, file links, JSON export and deletion.
- Basic offline app-shell caching after the first online load.
- Session-only API key handling (never written to localStorage).

## Important limitations (honest by design)

This is a **client-side research agent**, not a full background server agent. A static iPhone web app cannot reliably run unattended for hours, control the whole phone, or guarantee access to every website. iOS may suspend Safari when it is backgrounded.

The included search APIs are public, limited search/instant-answer services, not a complete commercial search index. Results can be incomplete depending on browser CORS policies, network access, and provider changes.

### On-device model constraints (especially iPhone)

- WebGPU is required. Recent Safari on iOS 18+ / Safari 18+ has it; older versions do not.
- iOS limits memory for a single browser tab (roughly ~1.5 GB in practice). Larger models frequently crash the tab after download.
- **Recommended starting models on iPhone**:
  - `SmolLM2-135M-Instruct-q0f16-MLC` (~300 MB) — most reliable
  - `SmolLM2-360M-Instruct-q0f16-MLC` (~700 MB) — still usually OK
  - Anything ≥ 1.5 B parameters is hit-or-miss on current iPhones
- First download can take several minutes on mobile data; afterwards the model is cached by the browser.
- The model must be loaded over HTTPS (or localhost). GitHub Pages works.

### Remote models

Model providers may reject browser-origin requests due to CORS. For Ollama the model runs on a reachable computer/server that must allow the app’s origin. Never put an API key in source code or commit it to GitHub.

## Quick start on iPhone

### Option A — easiest: GitHub Pages

1. Create a new GitHub repository (e.g. `scout-ai`).
2. Upload all project files preserving the folder structure (including `icons/`).
3. **Settings → Pages** → Deploy from branch `main` / root.
4. Open the published HTTPS URL in Safari.
5. Share → Add to Home Screen.

### Option B — test locally

Serve the folder with any static server (required for service workers and modules):

```bash
npx serve .
# or
python3 -m http.server 8080
```

Open the HTTPS/localhost URL in a WebGPU-capable browser.

## Configure a model

Tap the gear icon.

### 1. On-device model (recommended for privacy)

1. Choose **On-device model (WebLLM · download once)**.
2. Pick a small model (start with 135M on iPhone).
3. Tap **Download now** (or just start a research run — it will download automatically).
4. Wait for the progress messages; the model is then cached.

No API key is needed. All inference stays on the device.

### 2. OpenAI-compatible API

- Provider: OpenAI-compatible API
- Base URL: e.g. `https://api.openai.com/v1`
- Model: any model ID your account can use
- API key: paste for the current tab session only

### 3. Ollama / local endpoint

- Provider: Ollama / local model endpoint
- Base URL: e.g. `http://<reachable-host>:11434/v1`
- Model: exact name served by Ollama

The host must be reachable from the iPhone and allow CORS. Mixed content (HTTPS page → HTTP endpoint) is blocked by browsers.

## Security and privacy

- Research notes live in this browser’s `localStorage`.
- On-device models never send prompts off-device.
- Remote models receive the research question and selected snippets — check the provider’s privacy policy.
- API keys are held in JavaScript memory only and cleared when the tab session ends.
- External source links open with `noopener noreferrer`.

## Architecture

```text
Safari / Add to Home Screen
        |
        +-- Research planner (query variations, bounded retries)
        |
        +-- Public search APIs (Wikipedia + DuckDuckGo Instant Answer)
        |
        +-- Source deduplication / diversity checks
        |
        +-- Optional synthesis
        |     ├── WebLLM (on-device, WebGPU)
        |     ├── OpenAI-compatible endpoint
        |     └── Ollama-compatible endpoint
        |
        +-- Local report + source list + localStorage memory
```

## Project files

- `index.html` — interface and settings
- `styles.css` — responsive iPhone-first design
- `app.js` — search workflow, WebLLM loader, model adapters, memory
- `manifest.webmanifest` — install metadata
- `sw.js` — app-shell caching
- `icons/` — Home Screen icons

## Verification checklist

- [ ] Open the app over HTTPS.
- [ ] Run a simple research query and confirm sources appear.
- [ ] Test without a model (source-digest fallback).
- [ ] Switch to “On-device model”, download a small model, run research again.
- [ ] Confirm the report cites sources with `[1]`, `[2]`, etc.
- [ ] Save a report, reload, confirm it remains.
- [ ] Export the knowledge base JSON.
- [ ] Launch from the iPhone Home Screen.
