/* Scout AI: browser-only research agent. No server-side secrets or hidden background service. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const STORE_KEY = "scout_ai_saved_v1";
  const CONFIG_KEY = "scout_ai_config_v1";
  const state = { stop: false, running: false, key: "", config: { provider: "none", endpoint: "https://api.openai.com/v1", model: "", }, currentReport: null };
  const depthSettings = { quick: { queries: 2, perQuery: 4 }, standard: { queries: 4, perQuery: 6 }, thorough: { queries: 6, perQuery: 8 } };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
  }
  function loadSaved() {
    try { const x = JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); return Array.isArray(x) ? x : []; } catch { return []; }
  }
  function saveSaved(items) { localStorage.setItem(STORE_KEY, JSON.stringify(items.slice(0, 100))); renderSaved(); }
  function loadConfig() {
    try { const c = JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}"); state.config = { ...state.config, ...c }; } catch {}
    $("provider").value = state.config.provider || "none";
    $("endpoint").value = state.config.endpoint || "";
    $("model-name").value = state.config.model || "";
  }
  function log(message) {
    const item = document.createElement("div"); item.className = "activity-item";
    item.innerHTML = `<span class="dot">●</span><span>${escapeHtml(message)}</span>`;
    $("activity-log").prepend(item);
  }
  function progress(value, status) { $("progress-bar").style.width = `${Math.max(0, Math.min(100, value))}%`; $("status-text").textContent = status; }
  function domainOf(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "source"; } }
  function cleanText(s) { return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); }
  async function fetchJson(url, options = {}, timeout = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal, mode: "cors" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timer); }
  }
  async function searchWikipedia(query) {
    const url = "https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=" +
      encodeURIComponent(query) + "&gsrnamespace=0&gsrlimit=6&prop=extracts%7Cinfo&exintro=1&explaintext=1&inprop=url&format=json&origin=*";
    const data = await fetchJson(url, {}, 12000);
    const pages = Object.values(data?.query?.pages || {});
    return pages.map(p => ({ title: p.title, url: p.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}`,
      snippet: cleanText(p.extract).slice(0, 650), source: "Wikipedia", date: "" }));
  }
  async function searchDuckDuckGo(query) {
    // Instant Answer endpoint is a no-key supplementary source, not a complete web search engine.
    const url = "https://api.duckduckgo.com/?q=" + encodeURIComponent(query) + "&format=json&no_html=1&skip_disambig=1";
    const data = await fetchJson(url, {}, 10000);
    const results = [];
    if (data.AbstractText && data.AbstractURL) results.push({ title: data.Heading || query, url: data.AbstractURL, snippet: cleanText(data.AbstractText).slice(0, 650), source: data.AbstractSource || "DuckDuckGo", date: "" });
    const flatten = (items) => (items || []).forEach(item => {
      if (item.FirstURL && item.Text) results.push({ title: cleanText(item.Text).slice(0, 120), url: item.FirstURL, snippet: cleanText(item.Text).slice(0, 650), source: "DuckDuckGo", date: "" });
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
      `${topic} official source facts`
    ];
    if (depth === "thorough") variants.push(`${topic} research papers data`, `${topic} criticism counterarguments`);
    return variants.slice(0, depthSettings[depth].queries);
  }
  function sourceHtml(s, index) {
    return `<article class="source"><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${index + 1}. ${escapeHtml(s.title || s.url)}</a><p>${escapeHtml(s.snippet || "Open source to inspect details.")}</p><div class="source-meta">${escapeHtml(s.source || domainOf(s.url))} · ${escapeHtml(domainOf(s.url))}</div></article>`;
  }
  function dedupeByDomain(items) {
    const seen = new Set();
    return items.filter(item => {
      const key = `${domainOf(item.url)}|${(item.title || "").toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }
  async function askModel(prompt, sources) {
    if (state.config.provider === "none") return null;
    const endpoint = (state.config.endpoint || "").replace(/\/+$/, "");
    const model = state.config.model.trim();
    if (!endpoint || !model) throw new Error("Set the model API base URL and model name in Settings.");
    if (state.config.provider !== "ollama" && !state.key) throw new Error("Enter an API key in Settings for this session.");
    const excerpt = sources.slice(0, 22).map((s, i) => `[${i+1}] ${s.title}\nURL: ${s.url}\nSnippet: ${s.snippet}`).join("\n\n");
    const system = "You are Scout, a careful research analyst. Use only the supplied source snippets for factual claims. Cite claims inline with [1], [2], etc. Explicitly separate established facts, plausible interpretations, and unknowns. Do not claim you opened pages beyond the snippets. Point out source limitations and disagreements. Never invent sources.";
    const url = `${endpoint}/chat/completions`;
    const headers = { "Content-Type": "application/json" };
    if (state.config.provider !== "ollama") headers.Authorization = `Bearer ${state.key}`;
    const payload = { model, temperature: 0.2, messages: [{ role: "system", content: system }, { role: "user", content: `Research question: ${prompt}\n\nSearch snippets:\n${excerpt}\n\nWrite a useful report with: Executive summary, Findings, Disagreements and uncertainty, What to investigate next. Cite supplied snippets as [number].` }] };
    const data = await fetchJson(url, { method: "POST", headers, body: JSON.stringify(payload) }, 60000);
    return data?.choices?.[0]?.message?.content || data?.message?.content || null;
  }
  function fallbackReport(topic, sources, queries) {
    const domains = [...new Set(sources.map(s => domainOf(s.url)))];
    const snippets = sources.slice(0, 10).map((s, i) => `${i+1}. ${s.title}\n${s.snippet || "No snippet available."}\nSource: ${s.url}`).join("\n\n");
    return `Research question: ${topic}\n\nExecutive summary\nScout found ${sources.length} search results across ${domains.length} distinct domains. This is a source digest, not a definitive answer: search coverage depends on public APIs and the snippets they return.\n\nFindings from retrieved snippets\n${snippets || "No searchable snippets were returned. Try a different query or configure a model."}\n\nEvidence quality and uncertainty\n• A search result snippet is not the same as reading and validating the full page.\n• Check publication dates, primary sources, methods and conflicts of interest.\n• Treat repeated claims as corroboration only when sources are genuinely independent.\n\nQueries attempted\n${queries.map(q => "• " + q).join("\n")}\n\nSuggested next step\nOpen the source links, verify the relevant passages, and rerun with narrower or competing queries.`;
  }
  function renderReport(report, sources, queries, savedId = null) {
    state.currentReport = { report, sources, queries, topic: $("research-query").value.trim(), savedId };
    const sourceMarkup = sources.length ? sources.slice(0, 30).map(sourceHtml).join("") : `<div class="empty-state">No sources returned. Search providers may be unavailable in this browser.</div>`;
    $("result-area").innerHTML = `<div class="result-card"><h3>Research report</h3><div class="report-body">${escapeHtml(report)}</div><div class="report-actions"><button id="save-report">Save discovery</button><button id="copy-report">Copy report</button></div><h4>Sources (${sources.length})</h4><div class="source-list">${sourceMarkup}</div></div>`;
    $("save-report").addEventListener("click", saveCurrentReport);
    $("copy-report").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(report); $("copy-report").textContent = "Copied"; }
      catch { window.prompt("Copy your report:", report); }
    });
  }
  function saveCurrentReport() {
    if (!state.currentReport) return;
    const saved = loadSaved();
    const item = { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), topic: state.currentReport.topic || "Research discovery",
      report: state.currentReport.report, sources: state.currentReport.sources, queries: state.currentReport.queries, savedAt: new Date().toISOString() };
    saved.unshift(item); saveSaved(saved); $("save-report").textContent = "Saved ✓";
  }
  async function runResearch() {
    const topic = $("research-query").value.trim();
    if (!topic) { $("research-query").focus(); return; }
    if (state.running) return;
    state.running = true; state.stop = false;
    $("research-start").disabled = true; $("run-panel").classList.remove("hidden");
    $("activity-log").innerHTML = ""; $("result-area").innerHTML = "";
    const depth = $("depth").value; const queries = makeQueries(topic, depth); let all = [];
    progress(3, "Planning research…"); log(`Created ${queries.length} search angles.`);
    try {
      for (let i = 0; i < queries.length; i++) {
        if (state.stop) break;
        progress(8 + Math.round((i / queries.length) * 52), `Searching angle ${i+1} of ${queries.length}…`);
        log(`Searching: ${queries[i]}`);
        try {
          const results = await searchQuery(queries[i]);
          all = dedupeByDomain([...all, ...results]);
          log(`Retrieved ${results.length} result(s); ${all.length} unique results so far.`);
        } catch (e) { log(`Search provider error: ${e.message}. Continuing with other angles.`); }
      }
      if (!state.stop && all.length < 3 && depth !== "quick") {
        const retry = `${topic} facts sources`;
        log("Evidence looks thin; retrying with a broader query.");
        try { all = dedupeByDomain([...all, ...(await searchQuery(retry))]); queries.push(retry); } catch (e) { log(`Retry failed: ${e.message}`); }
      }
      if (state.stop) { progress(100, "Stopped by user. Partial findings retained below."); }
      else { progress(72, "Reviewing source diversity and preparing report…"); }
      const sources = all.slice(0, depthSettings[depth].perQuery * 4);
      let report;
      try {
        if (state.stop) throw new Error("Stopped before synthesis.");
        report = await askModel(topic, sources);
        if (report) log("Model synthesis completed using the retrieved snippets.");
        else { report = fallbackReport(topic, sources, queries); log("No model configured; generated a transparent source digest."); }
      } catch (e) {
        report = fallbackReport(topic, sources, queries);
        log(`Model synthesis unavailable (${e.message}); generated source digest instead.`);
      }
      renderReport(report, sources, queries);
      progress(100, state.stop ? "Partial research complete." : "Research pass complete. Review sources before relying on claims.");
    } catch (e) {
      progress(100, `Research ended with an error: ${e.message}`); log(e.message);
    } finally {
      state.running = false; $("research-start").disabled = false; $("run-title").textContent = "Research workspace";
    }
  }
  function renderSaved() {
    const items = loadSaved();
    if (!items.length) { $("saved-list").innerHTML = `<div class="empty-state">No discoveries saved yet.<br>Run a research task and tap “Save discovery”.</div>`; return; }
    $("saved-list").innerHTML = items.map(item => `<article class="saved-item"><button data-open="${escapeHtml(item.id)}">${escapeHtml(item.topic)}</button><p>${escapeHtml((item.report || "").slice(0, 150).replace(/\s+/g," "))}…</p><div class="saved-meta"><span>${new Date(item.savedAt).toLocaleDateString()}</span><span>${(item.sources || []).length} sources</span></div></article>`).join("");
    $("saved-list").querySelectorAll("[data-open]").forEach(btn => btn.addEventListener("click", () => {
      const item = loadSaved().find(x => x.id === btn.dataset.open); if (!item) return;
      $("run-panel").classList.remove("hidden"); $("run-title").textContent = "Saved discovery";
      $("research-query").value = item.topic;
      renderReport(item.report, item.sources || [], item.queries || [], item.id);
      $("status-text").textContent = `Saved on ${new Date(item.savedAt).toLocaleString()}`;
      $("progress-bar").style.width = "100%";
      $("run-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    }));
  }
  function exportNotes() {
    const data = JSON.stringify({ exportedAt: new Date().toISOString(), app: "Scout AI", discoveries: loadSaved() }, null, 2);
    const blob = new Blob([data], { type: "application/json" }); const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `scout-ai-discoveries-${new Date().toISOString().slice(0,10)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $("research-start").addEventListener("click", runResearch);
  $("stop-run").addEventListener("click", () => { state.stop = true; progress(0, "Stopping after the current request…"); });
  $("settings-open").addEventListener("click", () => $("settings-dialog").showModal());
  $("settings-close").addEventListener("click", () => $("settings-dialog").close());
  $("save-settings").addEventListener("click", () => {
    state.config = { provider: $("provider").value, endpoint: $("endpoint").value.trim(), model: $("model-name").value.trim() };
    state.key = $("api-key").value.trim();
    localStorage.setItem(CONFIG_KEY, JSON.stringify(state.config));
    $("api-key").value = ""; $("settings-dialog").close();
    log("Settings updated. API key remains in memory for this tab session only.");
  });
  $("clear-data").addEventListener("click", () => {
    if (confirm("Delete all saved discoveries from this browser? This cannot be undone.")) {
      localStorage.removeItem(STORE_KEY); renderSaved();
    }
  });
  $("export-notes").addEventListener("click", exportNotes);
  $("research-query").addEventListener("keydown", e => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") runResearch(); });
  loadConfig(); renderSaved();
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
  }
})();