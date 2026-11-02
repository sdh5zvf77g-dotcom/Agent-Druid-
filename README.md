# Scout AI — iPhone Research Agent

Scout AI is a mobile-first, installable web app inspired by the research workflow of OpenClaw. It is designed to run in Safari on an iPhone and can be hosted as static files on GitHub Pages. It does **not** need an app store installation.

## What works in this project

- iPhone-friendly research dashboard and Home Screen web app metadata.
- Multi-angle search using Wikipedia's public API and DuckDuckGo Instant Answer API.
- Retry with a broader query when few results are found.
- A source digest when no AI model is configured.
- Optional model synthesis through an OpenAI-compatible chat-completions endpoint or an Ollama-compatible endpoint.
- Locally saved discoveries, source URLs, JSON export and deletion.
- Basic offline app-shell caching after the first online load.
- Session-only API key handling; the key is not written to local storage.

## Important limitations (honest by design)

This is a **client-side research agent**, not a full OpenClaw deployment. A static iPhone web app cannot reliably run unattended for hours in the background, control the whole phone, or guarantee access to every website. iOS may suspend Safari when it is backgrounded. The included search APIs are public, limited search/instant-answer services, not a complete commercial search index. Results can be incomplete or unavailable depending on browser CORS policies, network access, and provider changes.

Model providers may reject browser-origin requests due to CORS. For Ollama, the model must run on a reachable computer/server and be configured to allow requests from the app's origin; it is not running on the iPhone itself. Never put an API key in source code or commit it to GitHub. For stronger production security, use a small authenticated backend/proxy and store provider keys there.

## Quick start on iPhone

### Option A — easiest: GitHub Pages

1. Sign in to GitHub and create a new repository, for example `scout-ai`.
2. Upload all project files and the `icons` folder, preserving the folder structure.
3. Open **Settings → Pages** in the repository.
4. Choose **Deploy from a branch**, select `main` and `/ (root)`, then save.
5. Wait for GitHub Pages to publish the site.
6. Open the published HTTPS URL in Safari on your iPhone.
7. Tap **Share → Add to Home Screen**. Enable **Open as Web App** if the option appears.

GitHub Pages is static hosting and does not provide a private server or secret storage. Do not commit credentials.

### Option B — test locally

Open `index.html` in a browser. Some browser APIs and service workers require HTTPS or localhost; for full testing, serve the folder through a local static web server. Public API calls may fail if opened from a `file://` URL.

## Configure an AI model

Tap the gear icon.

### OpenAI-compatible API

- Provider: **OpenAI-compatible API**
- Base URL: your provider's documented API base, commonly `https://api.openai.com/v1`
- Model: a model ID available to your account
- API key: paste for the current tab session

This uses `POST {baseURL}/chat/completions`. It may fail if the provider disallows browser CORS. The app does not assume a model is free.

### Ollama / local model endpoint

- Provider: **Ollama / local model endpoint**
- Base URL: for example `http://<reachable-host>:11434/v1` if your Ollama setup supports the OpenAI-compatible route
- Model: exact model name served by your Ollama instance

The host must be reachable from the iPhone. Plain HTTP can be blocked from an HTTPS GitHub Pages app as mixed content; use a properly secured HTTPS endpoint or test from a local development origin. Configure CORS and network access deliberately. Do not expose Ollama or a model endpoint directly to the public internet without authentication and access controls.

## Security and privacy

- Research notes live in this browser's `localStorage`; they are not synced across devices.
- The optional model receives the research question and snippets selected for synthesis. Check the provider's privacy policy before using sensitive content.
- The API key is held in JavaScript memory only and cleared from the input after saving settings. Reloading the app clears the in-memory key; re-enter it if needed.
- Browser-only apps cannot protect a provider key as strongly as a backend can. Do not use a valuable long-lived key in a public client-side app.
- The app opens external source links in a new tab with `noopener noreferrer`.
- This prototype does not execute arbitrary code, send email, make purchases, or take external actions.

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
        +-- Optional OpenAI-compatible or Ollama-compatible model
        |
        +-- Local report + source list + localStorage memory
        |
        +-- JSON export / manual source review
```

## Verification checklist

- [ ] Open the app over HTTPS.
- [ ] Run a simple research query and confirm sources appear.
- [ ] Open several source links and check the actual pages.
- [ ] Run once without a model to test source-digest fallback.
- [ ] If using a model, test a non-sensitive prompt and verify citations against source snippets.
- [ ] Save a report, reload the app, and confirm it remains saved.
- [ ] Export the knowledge base and verify the JSON file.
- [ ] Test from the iPhone Home Screen launch.
- [ ] Test network loss; treat failed search calls as unavailable rather than proof that no information exists.

## Project files

- `index.html` — interface and settings
- `styles.css` — responsive iPhone-first design
- `app.js` — search workflow, model adapter, memory and report generation
- `manifest.webmanifest` — install metadata
- `sw.js` — app-shell caching
- `icons/` — Home Screen icons
