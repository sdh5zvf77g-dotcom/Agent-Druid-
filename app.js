/* Scout AI: browser-only research agent with optional on-device WebLLM models. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const STORE_KEY = "scout_ai_saved_v1";
  const CONFIG_KEY = "scout_ai_config_v1";
  const state = {
    stop: false,
    running: false,
    key: "",
    config: {
      provider: "none",
      endpoint: "https://api.openai.com/v1",
      model: "",
      webllmModel: "SmolLM2-135M-Instruct-q0f16-MLC"
    },
    currentReport: null,
    webllm: null,          // MLCEngine instance
    webllmReady: false,
    webllmLoading: false,
    webllmProgress: ""
  };

  // Small models that are realistic on iPhone Safari (memory limits ~1.5 GB)
  const WEBLLM_MODELS = [
    { id: "SmolLM2-135M-Instruct-q0f16-MLC", label: "SmolLM2 135M (tiny · best for iPhone)", size: "~300 MB" },
    { id: "SmolLM2-360M-Instruct-q0f16-MLC", label: "SmolLM2 360M (small · still phone-friendly)", size: "~700 MB" },
    { id: "Qwen2.5-0.5B-Instruct-q4f16_1-MLC", label: "Qwen2.5 0.5B (small)", size: "~400 MB" },
    { id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", label: "Qwen2.5 1.5B (medium · may OOM on some iPhones)", size: "~1.1 GB" },
    { id: "Llama-3.2-1B-Instruct-q4f16_1-MLC", label: "Llama 3.2 1B (medium · desktop preferred)", size: "~1 GB" }
  ];

  const depthSettings = {
    quick: { queries: 2, perQuery: 4 },
    standard: { queries: 4, perQuery: 6 },
    thorough: { queries: 6, perQuery: 8 }
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, c =>
      ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
  }

  function loadSaved() {
    try {
      const x = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
      return Array.isArray(x) ? x : [];
    } catch { return []; }
  }

  function saveSaved(items) {
    localStorage.setItem(STORE_KEY, JSON.stringify(items.slice(0, 100)));
    renderSaved();
  }

  function loadConfig() {
    try {
      const c = JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}");
      state.config = { ...state.config, ...c };
    } catch {}
    $("provider").value = state.config.provider || "none";
    $("endpoint").value = state.config.endpoint || "";
    $("model-name").value = state.config.model || "";
    if ($("webllm-model")) {
      $("webllm-model").value = state.config.webllmModel || WEBLLM_MODELS[0].id;
    }
    updateProviderUI();
  }

  function log(message) {
    const item = document.createElement("div");
    item.className = "activity-item";
    item.innerHTML = `<span class="dot">●</span><span>${escapeHtml(message)}</span>`;
    $("activity-log").prepend(item);
  }

  function progress(value, status) {
    $("progress-bar").style.width = `${Math.max(0, Math.min(100, value))}%`;
    $("status-text").textContent = status;
  }

  function domainOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); }
    catch { return "source"; }
  }

  function cleanText(s) {
    return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }

  async function fetchJson(url, options = {}, timeout = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal, mode: "cors" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- Search ----------
  async function searchWikipedia(query) {
    const url = "https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=" +
      encodeURIComponent(query) +
      "&gsrnamespace=0&gsrlimit=6&prop=extracts%7Cinfo&exintro=1&explaintext=1&inprop=url&format=json&origin=*";
    const data = await fetchJson(url, {}, 12000);
    const pages = Object.values(data?.query?.pages || {});
    return pages.map(p => ({
      title: p.title,
      url: p.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}`,
      snippet: cleanText(p.extract).slice(0, 650),
      source: "Wikipedia",
      date: ""
    }));
  }

  async function searchDuckDuckGo(query) {
    const url = "https://api.duckduckgo.com/?q=" + encodeURIComponent(query) +
      "&format=json&no_html=1&skip_disambig=1";
    const data = await fetchJson(url, {}, 10000);
    const results = [];
    if (data.AbstractText && data.AbstractURL) {
      results.push({
        title: data.Heading || query,
        url: data.AbstractURL,
        snippet: cleanText(data.AbstractText).slice(0, 650),
        source: data.AbstractSource || "DuckDuckGo",
        date: ""
      });
    }
    const flatten = (items) => (items || []).forEach(item => {
      if (item.FirstURL && item.Text) {
        results.push({
          title: cleanText(item.Text).slice(0, 120),
          url: item.FirstURL,
          snippet: cleanText(item.Text).slice(0, 650),
          source: "DuckDuckGo",
          date: ""
        });
      }
      flatten(item.Topics);
    });
    flatten(data.RelatedTopics);
    return results;
  }

  async function searchQuery(query) {
    const settled = await Promise.allSettled([searchWikipedia(query), searchDuckDuckGo(query)]);
    const results = settled.flatMap(x => x.status === "fulfilled" ? x.value : []);
    const seen = new Set();
    return results.filter(r => r.url && !seen.has(r.url) && seen.add(r.url));
  }

  function makeQueries(topic, depth) {
    const variants = [
      topic,
      `${topic} latest developments evidence`,
      `${topic} independent analysis limitations`,
      `${topic} official source facts`,
      `${topic} filetype:pdf OR filetype:csv OR filetype:xlsx OR "download" OR "full text" OR dataset`
    ];
    if (depth === "thorough") {
      variants.push(
        `${topic} research papers data`,
        `${topic} criticism counterarguments`,
        `${topic} open access PDF OR preprint OR "supplementary materials"`
      );
    }
    return variants.slice(0, depthSettings[depth].queries);
  }

  // Detect likely downloadable files from URL / title / snippet
  const FILE_EXT_RE = /\.(pdf|docx?|xlsx?|csv|tsv|zip|gz|tgz|rar|7z|pptx?|txt|json|xml|parquet|hdf5|npz|pkl|npz|mp4|mp3|wav|ogg|epub|mobi)(?:[?#]|$)/i;
  const FILE_HINT_RE = /\b(pdf|download|full[\s-]?text|preprint|dataset|spreadsheet|csv|excel|zip archive|supplementary|open data|open access)\b/i;

  function detectFileType(item) {
    const url = item.url || "";
    const title = item.title || "";
    const snippet = item.snippet || "";
    const blob = `${url} ${title} ${snippet}`;

    const extMatch = url.match(FILE_EXT_RE);
    if (extMatch) {
      return extMatch[1].toLowerCase();
    }
    // Common academic / data hosts that usually lead to a downloadable file
    if (/arxiv\.org\/(pdf|abs)/i.test(url)) return "pdf";
    if (/biorxiv\.org|medrxiv\.org/i.test(url)) return "pdf";
    if (/pubmed\.ncbi\.nlm\.nih\.gov|pmc\.ncbi\.nlm\.nih\.gov/i.test(url) && /pdf|full/i.test(blob)) return "pdf";
    if (/zenodo\.org|figshare\.com|dataverse|dryad|osf\.io|kaggle\.com\/datasets/i.test(url)) return "dataset";
    if (/github\.com\/.*\/(releases|archive|raw)/i.test(url)) return "archive";
    if (FILE_HINT_RE.test(blob) && /\.gov|\.edu|nih\.gov|who\.int|europa\.eu|oecd\.org/i.test(url)) {
      return "document";
    }
    return null;
  }

  function enrichWithFileMeta(items) {
    return items.map(item => {
      const fileType = detectFileType(item);
      return {
        ...item,
        isFile: !!fileType,
        fileType: fileType || undefined
      };
    });
  }

  function collectDownloadable(items) {
    const seen = new Set();
    return items.filter(item => {
      if (!item.isFile || !item.url) return false;
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    });
  }

  function fileBadge(fileType) {
    const t = (fileType || "file").toUpperCase();
    return `<span class="file-badge">${escapeHtml(t)}</span>`;
  }

  function sourceHtml(s, index) {
    const fileBits = s.isFile
      ? `${fileBadge(s.fileType)} <a class="download-link" href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer" download>Open / Download</a>`
      : "";
    return `<article class="source${s.isFile ? " source-file" : ""}">
      <a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">
        ${index + 1}. ${escapeHtml(s.title || s.url)}
      </a>
      <p>${escapeHtml(s.snippet || "Open source to inspect details.")}</p>
      <div class="source-meta">
        ${escapeHtml(s.source || domainOf(s.url))} · ${escapeHtml(domainOf(s.url))}
        ${fileBits}
      </div>
    </article>`;
  }

  function downloadableHtml(files) {
    if (!files.length) return "";
    return `
      <div class="downloads-block">
        <h4>Downloadable files found (${files.length})</h4>
        <p class="microcopy">These links look like PDFs, datasets, spreadsheets or archives. Tap to open or download. Always verify the file before opening.</p>
        <div class="download-list">
          ${files.map((f, i) => `
            <article class="download-item">
              <div class="download-main">
                ${fileBadge(f.fileType)}
                <a href="${escapeHtml(f.url)}" target="_blank" rel="noopener noreferrer">
                  ${escapeHtml(f.title || f.url)}
                </a>
              </div>
              <p>${escapeHtml((f.snippet || "").slice(0, 180) || domainOf(f.url))}</p>
              <div class="download-actions">
                <a class="primary-mini" href="${escapeHtml(f.url)}" target="_blank" rel="noopener noreferrer">Open</a>
                <a class="quiet-mini" href="${escapeHtml(f.url)}" target="_blank" rel="noopener noreferrer" download>Download</a>
                <span class="source-meta">${escapeHtml(domainOf(f.url))}</span>
              </div>
            </article>
          `).join("")}
        </div>
      </div>`;
  }

  function dedupeByDomain(items) {
    const seen = new Set();
    return items.filter(item => {
      const key = `${domainOf(item.url)}|${(item.title || "").toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // ---------- WebLLM (on-device) ----------
  async function ensureWebLLM() {
    if (state.webllmReady && state.webllm) return state.webllm;
    if (state.webllmLoading) throw new Error("Model is already downloading. Please wait.");

    // Check WebGPU
    if (!navigator.gpu) {
      throw new Error("WebGPU is not available in this browser. On iPhone you need a recent Safari (iOS 18+/Safari 18+) and an HTTPS origin.");
    }

    state.webllmLoading = true;
    updateModelStatus("Loading WebLLM runtime…");

    try {
      // Dynamic import so the rest of the app still works if CDN is blocked
      const webllm = await import("https://esm.run/@mlc-ai/web-llm");
      const modelId = state.config.webllmModel || WEBLLM_MODELS[0].id;

      updateModelStatus(`Downloading ${modelId}… (first time only, cached afterwards)`);

      const engine = await webllm.CreateMLCEngine(modelId, {
        initProgressCallback: (report) => {
          const pct = Math.round((report.progress || 0) * 100);
          const text = report.text || `Loading model ${pct}%`;
          state.webllmProgress = text;
          updateModelStatus(text);
          // Also surface in the research log if a run is active
          if (state.running) {
            progress(Math.min(70, 40 + pct * 0.25), text);
          }
        }
      });

      state.webllm = engine;
      state.webllmReady = true;
      state.webllmLoading = false;
      updateModelStatus(`Ready · ${modelId}`);
      log(`On-device model ready: ${modelId}`);
      return engine;
    } catch (err) {
      state.webllmLoading = false;
      state.webllmReady = false;
      state.webllm = null;
      updateModelStatus("Failed to load model");
      throw err;
    }
  }

  function updateModelStatus(text) {
    const el = $("webllm-status");
    if (el) el.textContent = text;
  }

  async function askWebLLM(prompt, sources) {
    const engine = await ensureWebLLM();
    const excerpt = sources.slice(0, 18).map((s, i) =>
      `[${i + 1}] ${s.title}\nURL: ${s.url}\nSnippet: ${s.snippet}`
    ).join("\n\n");

    const system = `You are Scout, a careful research analyst. Use only the supplied source snippets for factual claims. Cite claims inline with [1], [2], etc. Explicitly separate established facts, plausible interpretations, and unknowns. Do not claim you opened pages beyond the snippets. Point out source limitations and disagreements. Never invent sources. If any sources look like downloadable files (PDF, dataset, CSV, archive…), mention them in a short "Downloadable resources" section with their numbers. Keep the report concise.`;

    const messages = [
      { role: "system", content: system },
      {
        role: "user",
        content: `Research question: ${prompt}\n\nSearch snippets:\n${excerpt}\n\nWrite a useful report with: Executive summary, Findings, Disagreements and uncertainty, Downloadable resources (if any), What to investigate next. Cite supplied snippets as [number].`
      }
    ];

    const reply = await engine.chat.completions.create({
      messages,
      temperature: 0.2,
      max_tokens: 1024
    });

    return reply?.choices?.[0]?.message?.content || null;
  }

  // ---------- External model (OpenAI-compatible / Ollama) ----------
  async function askExternalModel(prompt, sources) {
    const endpoint = (state.config.endpoint || "").replace(/\/+$/, "");
    const model = (state.config.model || "").trim();
    if (!endpoint || !model) throw new Error("Set the model API base URL and model name in Settings.");
    if (state.config.provider !== "ollama" && !state.key) {
      throw new Error("Enter an API key in Settings for this session.");
    }

    const excerpt = sources.slice(0, 22).map((s, i) =>
      `[${i + 1}] ${s.title}\nURL: ${s.url}\nSnippet: ${s.snippet}`
    ).join("\n\n");

    const system = "You are Scout, a careful research analyst. Use only the supplied source snippets for factual claims. Cite claims inline with [1], [2], etc. Explicitly separate established facts, plausible interpretations, and unknowns. Do not claim you opened pages beyond the snippets. Point out source limitations and disagreements. Never invent sources. If any sources look like downloadable files (PDF, dataset, CSV, archive…), mention them in a short Downloadable resources section with their numbers.";

    const url = `${endpoint}/chat/completions`;
    const headers = { "Content-Type": "application/json" };
    if (state.config.provider !== "ollama") headers.Authorization = `Bearer ${state.key}`;

    const payload = {
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `Research question: ${prompt}\n\nSearch snippets:\n${excerpt}\n\nWrite a useful report with: Executive summary, Findings, Disagreements and uncertainty, Downloadable resources (if any), What to investigate next. Cite supplied snippets as [number].`
        }
      ]
    };

    const data = await fetchJson(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    }, 60000);

    return data?.choices?.[0]?.message?.content || data?.message?.content || null;
  }

  async function askModel(prompt, sources) {
    if (state.config.provider === "none") return null;
    if (state.config.provider === "webllm") return askWebLLM(prompt, sources);
    return askExternalModel(prompt, sources);
  }

  function fallbackReport(topic, sources, queries) {
    const domains = [...new Set(sources.map(s => domainOf(s.url)))];
    const files = collectDownloadable(sources);
    const snippets = sources.slice(0, 10).map((s, i) =>
      `${i + 1}. ${s.title}${s.isFile ? ` [${(s.fileType || "file").toUpperCase()}]` : ""}\n${s.snippet || "No snippet available."}\nSource: ${s.url}`
    ).join("\n\n");

    const fileSection = files.length
      ? `\n\nDownloadable files detected\n${files.map((f, i) =>
          `${i + 1}. [${(f.fileType || "file").toUpperCase()}] ${f.title || domainOf(f.url)}\n${f.url}`
        ).join("\n\n")}`
      : "";

    return `Research question: ${topic}

Executive summary
Scout found ${sources.length} search results across ${domains.length} distinct domains${files.length ? ` and ${files.length} likely downloadable file(s)` : ""}. This is a source digest, not a definitive answer: search coverage depends on public APIs and the snippets they return.

Findings from retrieved snippets
${snippets || "No searchable snippets were returned. Try a different query or configure a model."}
${fileSection}

Evidence quality and uncertainty
• A search result snippet is not the same as reading and validating the full page.
• Check publication dates, primary sources, methods and conflicts of interest.
• Treat repeated claims as corroboration only when sources are genuinely independent.
• Downloadable files (PDFs, CSVs, zips…) should be opened and inspected before relying on them.

Queries attempted
${queries.map(q => "• " + q).join("\n")}

Suggested next step
Open the source links and any downloadable files, verify the relevant passages, and rerun with narrower or competing queries.`;
  }

  function renderReport(report, sources, queries, savedId = null) {
    const enriched = enrichWithFileMeta(sources || []);
    const files = collectDownloadable(enriched);

    state.currentReport = {
      report,
      sources: enriched,
      queries,
      topic: $("research-query").value.trim(),
      savedId,
      files
    };

    const sourceMarkup = enriched.length
      ? enriched.slice(0, 30).map(sourceHtml).join("")
      : `<div class="empty-state">No sources returned. Search providers may be unavailable in this browser.</div>`;

    $("result-area").innerHTML = `
      <div class="result-card">
        <h3>Research report</h3>
        <div class="report-body">${escapeHtml(report)}</div>
        <div class="report-actions">
          <button id="save-report">Save discovery</button>
          <button id="copy-report">Copy report</button>
          ${files.length ? `<button id="copy-file-links">Copy file links</button>` : ""}
        </div>
        ${downloadableHtml(files)}
        <h4>Sources (${enriched.length})</h4>
        <div class="source-list">${sourceMarkup}</div>
      </div>`;

    $("save-report").addEventListener("click", saveCurrentReport);
    $("copy-report").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(report);
        $("copy-report").textContent = "Copied";
      } catch {
        window.prompt("Copy your report:", report);
      }
    });
    const copyFilesBtn = $("copy-file-links");
    if (copyFilesBtn) {
      copyFilesBtn.addEventListener("click", async () => {
        const text = files.map((f, i) =>
          `${i + 1}. [${(f.fileType || "file").toUpperCase()}] ${f.title || ""}\n${f.url}`
        ).join("\n\n");
        try {
          await navigator.clipboard.writeText(text);
          copyFilesBtn.textContent = "Links copied";
        } catch {
          window.prompt("Copy file links:", text);
        }
      });
    }
  }

  function saveCurrentReport() {
    if (!state.currentReport) return;
    const saved = loadSaved();
    const item = {
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
      topic: state.currentReport.topic || "Research discovery",
      report: state.currentReport.report,
      sources: state.currentReport.sources,
      queries: state.currentReport.queries,
      files: state.currentReport.files || [],
      savedAt: new Date().toISOString()
    };
    saved.unshift(item);
    saveSaved(saved);
    $("save-report").textContent = "Saved ✓";
  }

  async function runResearch() {
    const topic = $("research-query").value.trim();
    if (!topic) { $("research-query").focus(); return; }
    if (state.running) return;

    state.running = true;
    state.stop = false;
    $("research-start").disabled = true;
    $("run-panel").classList.remove("hidden");
    $("activity-log").innerHTML = "";
    $("result-area").innerHTML = "";

    const depth = $("depth").value;
    const queries = makeQueries(topic, depth);
    let all = [];

    progress(3, "Planning research…");
    log(`Created ${queries.length} search angles.`);

    try {
      for (let i = 0; i < queries.length; i++) {
        if (state.stop) break;
        progress(8 + Math.round((i / queries.length) * 52), `Searching angle ${i + 1} of ${queries.length}…`);
        log(`Searching: ${queries[i]}`);
        try {
          const results = await searchQuery(queries[i]);
          all = dedupeByDomain([...all, ...results]);
          log(`Retrieved ${results.length} result(s); ${all.length} unique results so far.`);
        } catch (e) {
          log(`Search provider error: ${e.message}. Continuing with other angles.`);
        }
      }

      if (!state.stop && all.length < 3 && depth !== "quick") {
        const retry = `${topic} facts sources`;
        log("Evidence looks thin; retrying with a broader query.");
        try {
          all = dedupeByDomain([...all, ...(await searchQuery(retry))]);
          queries.push(retry);
        } catch (e) {
          log(`Retry failed: ${e.message}`);
        }
      }

      if (state.stop) {
        progress(100, "Stopped by user. Partial findings retained below.");
      } else {
        progress(72, "Reviewing source diversity and preparing report…");
      }

      const sources = enrichWithFileMeta(all.slice(0, depthSettings[depth].perQuery * 4));
      const files = collectDownloadable(sources);
      if (files.length) {
        log(`Found ${files.length} likely downloadable file(s) (PDF, dataset, archive…).`);
      }

      let report;

      try {
        if (state.stop) throw new Error("Stopped before synthesis.");
        report = await askModel(topic, sources);
        if (report) {
          const providerLabel = state.config.provider === "webllm"
            ? "on-device model"
            : "remote model";
          log(`Model synthesis completed using the ${providerLabel}.`);
        } else {
          report = fallbackReport(topic, sources, queries);
          log("No model configured; generated a transparent source digest.");
        }
      } catch (e) {
        report = fallbackReport(topic, sources, queries);
        log(`Model synthesis unavailable (${e.message}); generated source digest instead.`);
      }

      renderReport(report, sources, queries);
      progress(100, state.stop
        ? "Partial research complete."
        : "Research pass complete. Review sources before relying on claims.");
    } catch (e) {
      progress(100, `Research ended with an error: ${e.message}`);
      log(e.message);
    } finally {
      state.running = false;
      $("research-start").disabled = false;
      $("run-title").textContent = "Research workspace";
    }
  }

  function renderSaved() {
    const items = loadSaved();
    if (!items.length) {
      $("saved-list").innerHTML = `<div class="empty-state">No discoveries saved yet.<br>Run a research task and tap “Save discovery”.</div>`;
      return;
    }
    $("saved-list").innerHTML = items.map(item => {
      const fileCount = (item.files || []).length || (item.sources || []).filter(s => s.isFile).length;
      return `
      <article class="saved-item">
        <button data-open="${escapeHtml(item.id)}">${escapeHtml(item.topic)}</button>
        <p>${escapeHtml((item.report || "").slice(0, 150).replace(/\s+/g, " "))}…</p>
        <div class="saved-meta">
          <span>${new Date(item.savedAt).toLocaleDateString()}</span>
          <span>${(item.sources || []).length} sources</span>
          ${fileCount ? `<span>${fileCount} file${fileCount === 1 ? "" : "s"}</span>` : ""}
        </div>
      </article>`;
    }).join("");

    $("saved-list").querySelectorAll("[data-open]").forEach(btn => {
      btn.addEventListener("click", () => {
        const item = loadSaved().find(x => x.id === btn.dataset.open);
        if (!item) return;
        $("run-panel").classList.remove("hidden");
        $("run-title").textContent = "Saved discovery";
        $("research-query").value = item.topic;
        renderReport(item.report, item.sources || [], item.queries || [], item.id);
        $("status-text").textContent = `Saved on ${new Date(item.savedAt).toLocaleString()}`;
        $("progress-bar").style.width = "100%";
        $("run-panel").scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }

  function exportNotes() {
    const data = JSON.stringify({
      exportedAt: new Date().toISOString(),
      app: "Scout AI",
      discoveries: loadSaved()
    }, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `scout-ai-discoveries-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function updateProviderUI() {
    const provider = $("provider").value;
    const isWebLLM = provider === "webllm";
    const isNone = provider === "none";
    const isRemote = provider === "openai" || provider === "ollama";

    // Show / hide sections
    const webllmSection = $("webllm-section");
    const remoteSection = $("remote-section");
    if (webllmSection) webllmSection.classList.toggle("hidden", !isWebLLM);
    if (remoteSection) remoteSection.classList.toggle("hidden", !isRemote);

    // Pre-fill helpful defaults
    if (provider === "openai" && !$("endpoint").value) {
      $("endpoint").value = "https://api.openai.com/v1";
    }
    if (provider === "ollama" && !$("endpoint").value) {
      $("endpoint").value = "http://localhost:11434/v1";
    }
  }

  // ---------- UI wiring ----------
  $("research-start").addEventListener("click", runResearch);
  $("stop-run").addEventListener("click", () => {
    state.stop = true;
    progress(0, "Stopping after the current request…");
  });
  $("settings-open").addEventListener("click", () => $("settings-dialog").showModal());
  $("settings-close").addEventListener("click", () => $("settings-dialog").close());

  $("provider").addEventListener("change", updateProviderUI);

  $("save-settings").addEventListener("click", () => {
    state.config = {
      provider: $("provider").value,
      endpoint: $("endpoint").value.trim(),
      model: $("model-name").value.trim(),
      webllmModel: $("webllm-model") ? $("webllm-model").value : state.config.webllmModel
    };
    state.key = $("api-key").value.trim();
    localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config));
    $("api-key").value = "";
    $("settings-dialog").close();

    // If user switched away from webllm, we keep the engine in memory
    // (re-downloading is expensive). If they changed the model id we reset.
    if (state.config.provider === "webllm") {
      if (state.webllm && state.config.webllmModel !== state.webllm.modelId) {
        // simple reset – next use will re-create
        state.webllm = null;
        state.webllmReady = false;
      }
      log("Settings saved. On-device model will download on first research run.");
    } else {
      log("Settings updated. API key remains in memory for this tab session only.");
    }
  });

  $("clear-data").addEventListener("click", () => {
    if (confirm("Delete all saved discoveries from this browser? This cannot be undone.")) {
      localStorage.removeItem(STORE_KEY);
      renderSaved();
    }
  });

  $("export-notes").addEventListener("click", exportNotes);
  $("research-query").addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") runResearch();
  });

  // Optional: explicit “Download model now” button
  const downloadBtn = $("download-model");
  if (downloadBtn) {
    downloadBtn.addEventListener("click", async () => {
      try {
        downloadBtn.disabled = true;
        downloadBtn.textContent = "Downloading…";
        await ensureWebLLM();
        downloadBtn.textContent = "Model ready ✓";
      } catch (e) {
        updateModelStatus(`Error: ${e.message}`);
        downloadBtn.textContent = "Retry download";
        alert("Could not load model:\n" + e.message);
      } finally {
        downloadBtn.disabled = false;
      }
    });
  }

  // Populate model select
  const modelSelect = $("webllm-model");
  if (modelSelect) {
    modelSelect.innerHTML = WEBLLM_MODELS.map(m =>
      `<option value="${m.id}">${m.label} · ${m.size}</option>`
    ).join("");
  }

  loadConfig();
  renderSaved();

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }
})();
