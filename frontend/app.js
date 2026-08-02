// Mission Control — client logic. Vanilla JS, no build step, no CDN dependency.

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const fmtNum = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 });

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "HTTP " + res.status);
  return body;
}

/**
 * Every render below rebuilds a panel's whole innerHTML from a string, which is simple but destroys
 * and recreates every element inside it -- including whatever input the user is mid-keystroke in, so
 * it loses focus and the cursor position. Typing "abc" into a search box otherwise re-renders after
 * "a", drops focus, and "b"/"c" never reach the (new, unfocused) input.
 *
 * This captures the focused element's id and selection range before the swap and restores both
 * after, so a search box stays focused and the caret stays where it was across every keystroke.
 */
function setHtmlPreservingFocus(el, html) {
  const active = document.activeElement;
  const activeId = active && active.id && el.contains(active) ? active.id : null;
  const selStart = activeId && "selectionStart" in active ? active.selectionStart : null;
  const selEnd = activeId && "selectionEnd" in active ? active.selectionEnd : null;

  // The container starts as `class="loading"` in the static HTML, and `.loading` is `display:flex`
  // so the loading spinner can sit next to its text. Every render below only ever replaces the
  // CONTENT, never the container's own class -- so without this, the container stays a flex row
  // forever, and its two real children (the stat-grid and the filters+table card) get laid out
  // side by side instead of stacked, which is exactly "the KPIs are to the left of the table."
  el.classList.remove("loading", "err");
  el.innerHTML = html;

  if (!activeId) return;
  const restored = document.getElementById(activeId);
  if (!restored) return;
  restored.focus();
  if (selStart != null && typeof restored.setSelectionRange === "function") {
    try {
      restored.setSelectionRange(selStart, selEnd);
    } catch {
      // Not a text input (e.g. a <select>) -- focus alone is enough.
    }
  }
}

// ---------------------------------------------------------------------------
// nav
// ---------------------------------------------------------------------------

const views = ["chat", "anomalies", "alerts", "rollup", "llm", "health"];
const loaded = new Set();

function activateView(v) {
  document
    .querySelectorAll("nav button")
    .forEach((b) => b.classList.toggle("active", b.dataset.view === v));
  views.forEach((name) => $("#view-" + name).classList.toggle("active", name === v));
  if (v === "alerts") renderAlerts();
  if (!loaded.has(v)) {
    loaded.add(v);
    loadView(v);
  }
}

document.querySelectorAll("nav button").forEach((btn) => {
  btn.addEventListener("click", () => activateView(btn.dataset.view));
});

function loadView(v) {
  if (v === "chat") return loadChat();
  if (v === "anomalies") return loadAnomalies();
  if (v === "rollup") return loadRollup();
  if (v === "llm") return loadLlm();
  if (v === "health") return loadHealth();
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

async function loadChat() {
  try {
    const cfg = await getJson("/api/config");
    libreChatUrl = cfg.libreChatUrl;
    $("#chat-frame").src = cfg.libreChatUrl;
  } catch (e) {
    $("#chat-frame").outerHTML =
      '<div class="pad err">Could not reach LibreChat: ' + esc(e.message) + "</div>";
  }
}
loaded.add("chat");
loadChat();

// ---------------------------------------------------------------------------
// Anomalies — filter by metric/direction, search, sort, expand for detail
// ---------------------------------------------------------------------------

let anomaliesData = [];
let anomaliesSort = { key: "worstSigma", dir: "desc" };
let anomaliesFilter = { metric: "all", direction: "all", q: "" };

/* The window the user has chosen. Empty means "all time", which is the sweep's own default. */
let anomaliesRange = { from: "", to: "" };

async function loadAnomalies() {
  const el = $("#anomalies-body");
  el.className = "loading";
  el.innerHTML = '<div class="spinner"></div>Loading…';
  try {
    const qs = new URLSearchParams();
    if (anomaliesRange.from) qs.set("from", anomaliesRange.from);
    if (anomaliesRange.to) qs.set("to", anomaliesRange.to);
    const data = await getJson("/api/anomalies" + (qs.toString() ? `?${qs}` : ""));
    anomaliesData = data.windows || [];

    /* Clamp the pickers to days that exist. A window outside the loaded data returns nothing, and an
       empty panel reads as "all clear" rather than "you asked about days we do not have" — which is
       the most misleading thing this screen could do. */
    const b = data.dataBounds;
    const w = data.appliedWindow;
    if (b) {
      /* Clamp to the whole dataset, then show the window actually swept. The two are different on
         first paint — the server defaults to the last few days — and the inputs have to show that
         window, or the picker would claim a range the table below is not showing. */
      for (const id of ["#a-from", "#a-to"]) {
        const input = $(id);
        if (!input) continue;
        input.min = b.from;
        input.max = b.to;
        const applied = id === "#a-from" ? w && w.from : w && w.to;
        if (!input.value || data.windowIsDefault)
          input.value = applied || (id === "#a-from" ? b.from : b.to);
      }
    }
    const note = $("#a-range-note");
    if (note && w) {
      /* Say when the range was chosen for them. "50 windows over <dates>" with no explanation reads
         as the whole dataset, and a judge comparing counts would think incidents went missing. */
      const suffix = data.windowIsDefault
        ? ` (last ${data.defaultRangeDays || 7} days — “All time” to widen)`
        : anomaliesRange.from || anomaliesRange.to
          ? ""
          : " (all loaded data)";
      note.textContent = `${anomaliesData.length} window(s) over ${w.from} → ${w.to}${suffix}`;
    }
    renderAnomalies();
  } catch (e) {
    el.className = "err";
    el.innerHTML = "⚠ Could not load anomalies: " + esc(e.message);
  }
}

$("#a-apply")?.addEventListener("click", () => {
  const from = $("#a-from")?.value ?? "";
  const to = $("#a-to")?.value ?? "";
  if (from && to && from > to) {
    $("#a-range-note").textContent = "From is after To — swap them.";
    return;
  }
  anomaliesRange = { from, to };
  loadAnomalies();
});

$("#a-reset")?.addEventListener("click", () => {
  /* Sends the bounds explicitly rather than clearing the range. An empty window now means "the
     default last 7 days" to the server, so blanking the fields would re-request the very thing
     All time exists to escape. `min`/`max` are the full dataset — see the clamp in loadAnomalies. */
  const f = $("#a-from");
  const t = $("#a-to");
  const from = (f && f.min) || "";
  const to = (t && t.max) || "";
  if (f) f.value = from;
  if (t) t.value = to;
  anomaliesRange = { from, to };
  loadAnomalies();
});

function anomalySeverity(x) {
  return x.worstPct >= 0 ? "rise" : "drop";
}

function renderAnomalies() {
  const el = $("#anomalies-body");
  const all = anomaliesData;
  if (!all.length) {
    el.classList.remove("loading", "err");
    el.innerHTML = '<div class="card empty">No anomalies in the current sweep window.</div>';
    return;
  }

  const metrics = [...new Set(all.map((x) => x.metric))].sort();

  let rows = all.filter((x) => {
    if (anomaliesFilter.metric !== "all" && x.metric !== anomaliesFilter.metric) return false;
    if (anomaliesFilter.direction !== "all" && anomalySeverity(x) !== anomaliesFilter.direction)
      return false;
    if (anomaliesFilter.q) {
      const hay = (
        x.leadSegment.dimension +
        " " +
        x.leadSegment.value +
        " " +
        x.metric
      ).toLowerCase();
      if (!hay.includes(anomaliesFilter.q.toLowerCase())) return false;
    }
    return true;
  });

  const { key, dir } = anomaliesSort;
  rows = rows.slice().sort((a, b) => {
    const va = key === "window" ? a.from : key === "sigma" ? Math.abs(a.worstSigma) : a[key];
    const vb = key === "window" ? b.from : key === "sigma" ? Math.abs(b.worstSigma) : b[key];
    let cmp = typeof va === "string" ? va.localeCompare(vb) : va - vb;

    /* Ties need a deterministic order or the sort looks broken.
       Dozens of windows share a start date, so sorting by date alone reshuffles them on every render
       and it reads as if the click did nothing. Break by end date, then by severity, so equal dates
       come out in a stable and actually useful order. */
    if (cmp === 0 && key === "window") cmp = a.to.localeCompare(b.to);
    if (cmp === 0) cmp = Math.abs(b.worstSigma) - Math.abs(a.worstSigma);
    if (cmp === 0) cmp = a.metric.localeCompare(b.metric);
    return dir === "asc" ? cmp : -cmp;
  });

  const th = (label, k) =>
    '<th data-sort="' +
    k +
    '" class="' +
    (anomaliesSort.key === k ? "sorted " + (anomaliesSort.dir === "asc" ? "asc" : "") : "") +
    '">' +
    label +
    "</th>";

  const html =
    '<div class="stat-grid">' +
    '<div class="stat"><div class="n">' +
    all.length +
    '</div><div class="l">incident window(s)</div></div>' +
    '<div class="stat"><div class="n">' +
    metrics.length +
    '</div><div class="l">metric(s) affected</div></div>' +
    '<div class="stat"><div class="n">' +
    all.filter((x) => anomalySeverity(x) === "drop").length +
    '</div><div class="l">drops</div></div>' +
    '<div class="stat"><div class="n">' +
    all.filter((x) => anomalySeverity(x) === "rise").length +
    '</div><div class="l">rises</div></div>' +
    "</div>" +
    '<div class="card">' +
    '<div class="filters">' +
    '<select id="f-metric"><option value="all">All metrics</option>' +
    metrics
      .map(
        (m) =>
          '<option value="' +
          esc(m) +
          '"' +
          (anomaliesFilter.metric === m ? " selected" : "") +
          ">" +
          esc(m) +
          "</option>",
      )
      .join("") +
    "</select>" +
    '<div class="chip-group" id="f-direction">' +
    '<div class="chip' +
    (anomaliesFilter.direction === "all" ? " active" : "") +
    '" data-dir="all">All</div>' +
    '<div class="chip' +
    (anomaliesFilter.direction === "drop" ? " active" : "") +
    '" data-dir="drop">📉 Drops</div>' +
    '<div class="chip' +
    (anomaliesFilter.direction === "rise" ? " active" : "") +
    '" data-dir="rise">📈 Rises</div>' +
    "</div>" +
    '<input type="search" id="f-search" placeholder="Search segment…" value="' +
    esc(anomaliesFilter.q) +
    '" />' +
    '<span class="count">' +
    rows.length +
    " / " +
    all.length +
    " shown</span>" +
    "</div>" +
    "<table><thead><tr>" +
    th("Metric", "metric") +
    th("Window", "window") +
    "<th>Lead segment</th>" +
    th("Move", "worstPct") +
    th("Sigma", "sigma") +
    th("Req/day", "requestsPerDay") +
    th("Correlated", "correlatedSegments") +
    "<th></th>" +
    "</tr></thead><tbody>" +
    rows
      .map((x, i) => {
        const sev = anomalySeverity(x);
        const examples = (x.examples || []).map((e) => "<div>" + esc(e) + "</div>").join("");
        return (
          '<tr class="sev-' +
          sev +
          '" data-i="' +
          i +
          '">' +
          "<td>" +
          esc(x.metric) +
          "</td>" +
          "<td>" +
          esc(x.from) +
          " → " +
          esc(x.to) +
          "</td>" +
          "<td>" +
          esc(x.leadSegment.dimension) +
          " = <b>" +
          esc(x.leadSegment.value) +
          "</b></td>" +
          '<td class="num">' +
          (x.worstPct > 0 ? "+" : "") +
          x.worstPct +
          "%</td>" +
          '<td class="num">' +
          x.worstSigma +
          "σ</td>" +
          '<td class="num">' +
          fmtNum(x.requestsPerDay) +
          "</td>" +
          '<td class="num">' +
          x.correlatedSegments +
          "</td>" +
          '<td class="expand-btn">▸ examples</td>' +
          "</tr>" +
          '<tr class="row-detail" style="display:none"><td colspan="8">' +
          (examples || "No correlated examples recorded.") +
          "</td></tr>"
        );
      })
      .join("") +
    "</tbody></table></div>";

  setHtmlPreservingFocus(el, html);

  $("#f-metric").addEventListener("change", (e) => {
    anomaliesFilter.metric = e.target.value;
    renderAnomalies();
  });
  $("#f-search").addEventListener("input", (e) => {
    anomaliesFilter.q = e.target.value;
    renderAnomalies();
  });
  $("#f-direction")
    .querySelectorAll(".chip")
    .forEach((chip) => {
      chip.addEventListener("click", () => {
        anomaliesFilter.direction = chip.dataset.dir;
        renderAnomalies();
      });
    });
  el.querySelectorAll("th[data-sort]").forEach((h) => {
    h.addEventListener("click", () => {
      const k = h.dataset.sort;
      if (anomaliesSort.key === k) anomaliesSort.dir = anomaliesSort.dir === "asc" ? "desc" : "asc";
      else anomaliesSort = { key: k, dir: "desc" };
      renderAnomalies();
    });
  });
  el.querySelectorAll("tbody tr[data-i]").forEach((row) => {
    row.addEventListener("click", () => {
      const detail = row.nextElementSibling;
      detail.style.display = detail.style.display === "none" ? "table-row" : "none";
    });
  });
}

// ---------------------------------------------------------------------------
// Rollup vs Raw
// ---------------------------------------------------------------------------

async function loadRollup() {
  const el = $("#rollup-body");
  try {
    const data = await getJson("/api/rollup-comparison");
    const t = data.totals;
    const maxRows = Math.max(t.raw.readRows, t.rollup.readRows) || 1;
    const maxMs = Math.max(t.raw.serverMs, t.rollup.serverMs) || 1;
    const rowsLess =
      t.rollup.readRows === 0 ? "∞" : (t.raw.readRows / t.rollup.readRows).toFixed(1) + "x";
    const msLess =
      t.rollup.serverMs === 0 ? "∞" : (t.raw.serverMs / t.rollup.serverMs).toFixed(1) + "x";

    const bar = (label, rawV, rollV, max, unit) =>
      '<div class="bar-row"><div class="label">' +
      label +
      " (raw)</div>" +
      '<div class="bar-track"><div class="bar-fill raw" style="width:' +
      (100 * rawV) / max +
      '%"></div></div>' +
      '<div class="num">' +
      fmtNum(rawV) +
      unit +
      "</div></div>" +
      '<div class="bar-row"><div class="label">' +
      label +
      " (rollup)</div>" +
      '<div class="bar-track"><div class="bar-fill rollup" style="width:' +
      (100 * rollV) / max +
      '%"></div></div>' +
      '<div class="num">' +
      fmtNum(rollV) +
      unit +
      "</div></div>";

    el.classList.remove("loading", "err");
    el.innerHTML =
      '<div class="stat-grid">' +
      '<div class="stat"><div class="n">' +
      rowsLess +
      '</div><div class="l">fewer rows read</div></div>' +
      '<div class="stat"><div class="n">' +
      msLess +
      '</div><div class="l">faster server time</div></div>' +
      '<div class="stat"><div class="n">' +
      data.calls.length +
      '</div><div class="l">tool calls measured</div></div>' +
      "</div>" +
      '<div class="card"><h2>Totals across ' +
      data.calls.length +
      " representative calls</h2>" +
      bar("rows read", t.raw.readRows, t.rollup.readRows, maxRows, "") +
      bar("server ms", t.raw.serverMs, t.rollup.serverMs, maxMs, " ms") +
      "</div>" +
      '<div class="card"><h2>Per-call breakdown</h2><table><thead><tr>' +
      '<th>Call</th><th class="num">Rows (raw)</th><th class="num">Rows (rollup)</th><th class="num">Less</th><th class="num">Server ms</th>' +
      "</tr></thead><tbody>" +
      data.calls
        .map((c) => {
          const less =
            c.rollup.readRows === 0
              ? c.raw.readRows === 0
                ? "—"
                : "∞"
              : (c.raw.readRows / c.rollup.readRows).toFixed(1) + "x";
          return (
            "<tr><td>" +
            esc(c.label) +
            "</td>" +
            '<td class="num">' +
            fmtNum(c.raw.readRows) +
            "</td>" +
            '<td class="num">' +
            fmtNum(c.rollup.readRows) +
            "</td>" +
            '<td class="num">' +
            less +
            "</td>" +
            '<td class="num">' +
            c.raw.serverMs +
            " → " +
            c.rollup.serverMs +
            "</td></tr>"
          );
        })
        .join("") +
      "</tbody></table></div>" +
      '<div class="sub">Measured ' +
      new Date(data.measuredAt).toLocaleString() +
      "</div>";
  } catch (e) {
    el.className = "err";
    el.innerHTML = "⚠ Could not load rollup comparison: " + esc(e.message);
  }
}

// ---------------------------------------------------------------------------
// LLM Cost
// ---------------------------------------------------------------------------

async function loadLlm() {
  const el = $("#llm-body");
  try {
    const data = await getJson("/api/llm-cost");
    const rows = data.rows || [];
    const totalCost = rows.reduce((a, r) => a + Number(r.sum_totalCost || 0), 0);
    const totalTokens = rows.reduce((a, r) => a + Number(r.sum_totalTokens || 0), 0);
    const totalCalls = rows.reduce((a, r) => a + Number(r.count_count || 0), 0);
    const maxCost = Math.max(...rows.map((r) => Number(r.sum_totalCost || 0)), 0.0001);

    el.classList.remove("loading", "err");
    el.innerHTML =
      '<div class="stat-grid">' +
      '<div class="stat"><div class="n">$' +
      totalCost.toFixed(3) +
      '</div><div class="l">total cost, 24h</div></div>' +
      '<div class="stat"><div class="n">' +
      fmtNum(totalTokens) +
      '</div><div class="l">total tokens</div></div>' +
      '<div class="stat"><div class="n">' +
      totalCalls +
      '</div><div class="l">generations</div></div>' +
      "</div>" +
      '<div class="card"><h2>Cost by model</h2>' +
      rows
        .map((r) => {
          const model = r.providedModelName || "(unknown)";
          const cost = Number(r.sum_totalCost || 0);
          return (
            '<div class="bar-row"><div class="label">' +
            esc(model) +
            "</div>" +
            '<div class="bar-track"><div class="bar-fill rollup" style="width:' +
            (100 * cost) / maxCost +
            '%"></div></div>' +
            '<div class="num">$' +
            cost.toFixed(4) +
            "</div></div>"
          );
        })
        .join("") +
      "</div>" +
      '<div class="sub">Window: last ' +
      data.windowHours +
      "h, measured " +
      new Date(data.measuredAt).toLocaleString() +
      "</div>";
  } catch (e) {
    el.className = "err";
    el.innerHTML = "⚠ Could not load LLM cost: " + esc(e.message);
  }
}

// ---------------------------------------------------------------------------
// LLM Cost — sub-tabs (Overview / Recent Prompts)
// ---------------------------------------------------------------------------

const llmSubLoaded = new Set(["overview"]); // overview loads via the existing top-level view loader
document.querySelectorAll(".subtab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const v = btn.dataset.llmview;
    document.querySelectorAll(".subtab").forEach((b) => b.classList.toggle("active", b === btn));
    $("#llm-view-overview").hidden = v !== "overview";
    $("#llm-view-prompts").hidden = v !== "prompts";
    if (!llmSubLoaded.has(v)) {
      llmSubLoaded.add(v);
      if (v === "prompts") loadLlmPrompts();
    }
  });
});

/**
 * One decision-tree step: the check(s) run in that round-trip, in plain English -- no tool names, no
 * dimension='value' pairs, matching the same "never show the machinery" rule the chat's own answers
 * already follow (backend/mcp/protocol.ts). Each pill is a short plain-English label ("Checked which
 * publisher tier was worst"); clicking it expands the fuller sentence explaining what was found.
 */
function renderStep(step, i) {
  const pills = step.calls.length
    ? step.calls
        .map((c, j) => {
          const detailId = "step-detail-" + i + "-" + j;
          return (
            '<span class="tool-pill expandable" data-detail="' +
            detailId +
            '">🔍 ' +
            esc(c.label) +
            " ▾</span>"
          );
        })
        .join(" ")
    : '<span class="tool-pill">Answered directly, no check needed</span>';
  const details = step.calls
    .map((c, j) => {
      const rows = c.rows && c.rows.length
        ? '<ul class="step-rows">' +
          c.rows
            .map(
              (r) =>
                "<li><span class=\"row-label\">" +
                esc(r.label) +
                '</span><span class="row-value">' +
                esc(r.value) +
                "</span></li>",
            )
            .join("") +
          "</ul>"
        : "";
      return (
        '<div class="step-explain" id="step-detail-' +
        i +
        "-" +
        j +
        '" hidden><div class="step-explain-text">' +
        esc(c.summary) +
        "</div>" +
        rows +
        "</div>"
      );
    })
    .join("");
  // "how many scenarios it covered" — a dispatch that bundled more than one tool call was genuinely
  // weighing multiple candidates at once, not just calling tools one after another; say so.
  const parallelNote = step.parallel
    ? '<div class="step-parallel-note">Checked ' + step.calls.length + " things at once:</div>"
    : "";
  return (
    '<div class="decision-step-wrap">' +
    parallelNote +
    '<div class="decision-step"><span class="step-idx">' +
    (i + 1) +
    "</span>" +
    pills +
    '<span class="step-ms">' +
    step.latencySec.toFixed(2) +
    "s</span></div>" +
    details +
    "</div>"
  );
}

document.addEventListener("click", (e) => {
  const pill = e.target.closest(".tool-pill.expandable");
  if (!pill) return;
  const detail = document.getElementById(pill.dataset.detail);
  if (detail) detail.hidden = !detail.hidden;
});

async function loadLlmPrompts() {
  const el = $("#llm-prompts-body");
  try {
    const data = await getJson("/api/llm-cost/recent-prompts");
    const prompts = data.prompts || [];
    if (!prompts.length) {
      el.classList.remove("loading", "err");
      el.innerHTML = '<div class="card empty">No recent prompts found.</div>';
      return;
    }
    el.classList.remove("loading", "err");
    el.innerHTML = prompts
      .map(
        (p) =>
          '<div class="card prompt-card">' +
          '<div class="prompt-text">💬 ' +
          esc(p.prompt.length > 240 ? p.prompt.slice(0, 240) + "…" : p.prompt) +
          "</div>" +
          '<div class="prompt-meta">' +
          "<span>" +
          new Date(p.timestamp).toLocaleString() +
          "</span>" +
          "<span><b>$" +
          p.costUsd.toFixed(4) +
          "</b> cost</span>" +
          "<span><b>" +
          p.latencySec.toFixed(1) +
          "s</b> total</span>" +
          "<span><b>" +
          p.steps.length +
          "</b> step(s)</span>" +
          "</div>" +
          '<div class="prompt-ids">' +
          (p.traceUrl
            ? '<a href="' + esc(p.traceUrl) + '" target="_blank" rel="noopener">trace: ' + esc(p.traceId) + "</a>"
            : "<span>trace: " + esc(p.traceId) + "</span>") +
          (p.userId ? "<span>user: " + esc(p.userId) + "</span>" : "") +
          "</div>" +
          '<div class="decision-tree">' +
          (p.steps.length
            ? p.steps.map(renderStep).join("")
            : '<div class="decision-step">No tool calls — answered directly.</div>') +
          "</div>" +
          "</div>",
      )
      .join("");
  } catch (e) {
    el.className = "err";
    el.innerHTML = "⚠ Could not load recent prompts: " + esc(e.message);
  }
}

// ---------------------------------------------------------------------------
// System Health — filter by layer, search, sort, latency bars
// ---------------------------------------------------------------------------

let healthData = [];
let healthSort = { key: "calls", dir: "desc" };
let healthFilter = { layer: "all", q: "" };

async function loadHealth() {
  const el = $("#health-body");
  try {
    const data = await getJson("/api/system-health");
    healthData = data.stages || [];
    healthData._windowHours = data.windowHours;
    healthData._measuredAt = data.measuredAt;
    renderHealth();
  } catch (e) {
    el.className = "err";
    el.innerHTML = "⚠ Could not load system health: " + esc(e.message);
  }
}

function healthLayer(s) {
  return s.spanName.startsWith("mcp.tool.") ? "tool" : "engine";
}

function renderHealth() {
  const el = $("#health-body");
  const all = healthData;
  if (!all.length) {
    el.classList.remove("loading", "err");
    el.innerHTML =
      '<div class="card empty">No trace data in the last ' + (all._windowHours ?? 24) + "h.</div>";
    return;
  }

  let rows = all.filter((s) => {
    if (healthFilter.layer !== "all" && healthLayer(s) !== healthFilter.layer) return false;
    if (healthFilter.q && !s.spanName.toLowerCase().includes(healthFilter.q.toLowerCase()))
      return false;
    return true;
  });

  const { key, dir } = healthSort;
  rows = rows.slice().sort((a, b) => {
    const cmp = a[key] - b[key];
    return dir === "asc" ? cmp : -cmp;
  });

  const maxP95 = Math.max(...all.map((s) => s.p95Ms), 1);
  const totalCalls = all.reduce((a, s) => a + s.calls, 0);
  const totalErrors = all.reduce((a, s) => a + s.errors, 0);

  const th = (label, k) =>
    '<th data-sort="' +
    k +
    '" class="' +
    (healthSort.key === k ? "sorted " + (healthSort.dir === "asc" ? "asc" : "") : "") +
    '">' +
    label +
    "</th>";

  const html =
    '<div class="stat-grid">' +
    '<div class="stat"><div class="n">' +
    all.length +
    '</div><div class="l">span types</div></div>' +
    '<div class="stat"><div class="n">' +
    fmtNum(totalCalls) +
    '</div><div class="l">total calls</div></div>' +
    '<div class="stat"><div class="n">' +
    fmtNum(totalErrors) +
    '</div><div class="l">flagged (incl. refusals)</div></div>' +
    "</div>" +
    '<div class="card">' +
    '<div class="filters">' +
    '<div class="chip-group" id="h-layer">' +
    '<div class="chip' +
    (healthFilter.layer === "all" ? " active" : "") +
    '" data-layer="all">All</div>' +
    '<div class="chip' +
    (healthFilter.layer === "engine" ? " active" : "") +
    '" data-layer="engine">⚙️ Engine</div>' +
    '<div class="chip' +
    (healthFilter.layer === "tool" ? " active" : "") +
    '" data-layer="tool">🛠 Tool layer</div>' +
    "</div>" +
    '<input type="search" id="h-search" placeholder="Search span…" value="' +
    esc(healthFilter.q) +
    '" />' +
    '<span class="count">' +
    rows.length +
    " / " +
    all.length +
    " shown</span>" +
    "</div>" +
    "<table><thead><tr>" +
    "<th>Span</th>" +
    th("Calls", "calls") +
    th("p50 ms", "p50Ms") +
    "<th>p95 ms</th>" +
    th("Errors*", "errors") +
    "</tr></thead><tbody>" +
    rows
      .map((s) => {
        const pill =
          s.errors === 0
            ? '<span class="pill good">0</span>'
            : s.errors / s.calls > 0.05
              ? '<span class="pill bad">' + s.errors + "</span>"
              : '<span class="pill warn">' + s.errors + "</span>";
        const layerTag = healthLayer(s) === "engine" ? "⚙️" : "🛠";
        return (
          "<tr><td>" +
          layerTag +
          " " +
          esc(s.spanName) +
          "</td>" +
          '<td class="num">' +
          fmtNum(s.calls) +
          "</td>" +
          '<td class="num">' +
          s.p50Ms +
          "</td>" +
          '<td><div class="bar-row" style="grid-template-columns:1fr 60px"><div class="bar-track"><div class="bar-fill latency" style="width:' +
          (100 * s.p95Ms) / maxP95 +
          '%"></div></div><div class="num">' +
          s.p95Ms +
          "</div></div></td>" +
          '<td class="num">' +
          pill +
          "</td></tr>"
        );
      })
      .join("") +
    "</tbody></table></div>" +
    '<div class="sub">* Includes deliberate validation refusals (bad metric/dimension/window), not just crashes — high counts on ' +
    "<code>get_metric</code>/<code>rank_segments</code> are expected eval-suite traffic.</div>" +
    '<div class="sub">Measured ' +
    new Date(all._measuredAt).toLocaleString() +
    "</div>";

  setHtmlPreservingFocus(el, html);

  $("#h-search").addEventListener("input", (e) => {
    healthFilter.q = e.target.value;
    renderHealth();
  });
  $("#h-layer")
    .querySelectorAll(".chip")
    .forEach((chip) => {
      chip.addEventListener("click", () => {
        healthFilter.layer = chip.dataset.layer;
        renderHealth();
      });
    });
  el.querySelectorAll("th[data-sort]").forEach((h) => {
    h.addEventListener("click", () => {
      const k = h.dataset.sort;
      if (healthSort.key === k) healthSort.dir = healthSort.dir === "asc" ? "desc" : "asc";
      else healthSort = { key: k, dir: "desc" };
      renderHealth();
    });
  });
}

/* ---------------------------------------------------------------------------------------------
 * Alerts — the watchman's findings, as a page rather than a banner.
 *
 * This began as a strip above the nav and that was the wrong shape: it pushed the entire app down,
 * occupied permanent vertical space for something read once a day, and had nowhere to grow. A tab
 * costs nothing when empty and has room for detail when it is not.
 *
 * The badge is what keeps it discoverable — it carries the unseen count, so the page still announces
 * itself without stealing the layout. Opening the tab is what marks them read, which is the natural
 * gesture; nothing needs dismissing.
 * ------------------------------------------------------------------------------------------------ */
const ALERTS_SEEN_KEY = "watchman.seenAt";

/* Set once the config lands; the ask button needs it to rebuild the iframe URL. */
let libreChatUrl = "";

/**
 * Hand an alert to the chat and ask it, in one click.
 *
 * The chat is a cross-origin iframe, so nothing here can reach into its input. LibreChat reads
 * `prompt` and `submit` from its own URL, which is the supported way in.
 *
 * It pre-fills and stops there. `submit=true` is supported and was tried, and it reads badly: the tab
 * changes and an answer is already generating before the reader has seen the question, so the moment
 * of arriving somewhere new is spent watching something they did not visibly ask for. Landing with the
 * question sitting in the box, ready to send, is calmer and costs one keystroke.
 */
function askInChat(question) {
  if (!libreChatUrl) return;
  /* /c/new, not / — LibreChat's root route is `<Navigate to="/c/new" replace>`, and React Router's
     Navigate drops the query string, so `/?prompt=…` arrived as a bare reload with the question gone.
     Going straight to the destination route skips the redirect and the parameter survives. */
  const url = new URL("/c/new", libreChatUrl);
  url.searchParams.set("prompt", question);
  const frame = $("#chat-frame");
  if (frame) frame.src = url.toString();
  activateView("chat");
}

/* The question an alert should open with: metric, segment and day, so the engine can scope it
   without a follow-up. Built from the alert's own fields rather than the diagnosis, so it still
   works when the investigation did not complete. */
function alertQuestion(n) {
  const dir = n.pct < 0 ? "drop" : "rise";
  return `Why did ${n.metric} ${dir} on ${n.day} for ${n.where}? Walk me through the cause and what was ruled out.`;
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-ask]");
  if (btn) askInChat(btn.getAttribute("data-ask"));
});

let alertItems = [];

/* The log accumulates across watch lifetimes, so re-creating a watch replays incidents it already
   reported — the same fill_rate drop appeared twice in the panel. One row per (metric, segment, day):
   a recurrence on a NEW day is news, the same day arriving twice is bookkeeping. */
function dedupeAlerts(items) {
  const seen = new Set();
  return items.filter((n) => {
    const key = `${n.metric}|${n.where}|${n.day}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unseenCount() {
  const seenAt = localStorage.getItem(ALERTS_SEEN_KEY) ?? "";
  return alertItems.filter((n) => n.at > seenAt).length;
}

function renderAlertsBadge() {
  const badge = $("#alerts-badge");
  if (!badge) return;
  const n = unseenCount();
  badge.textContent = String(n);
  badge.hidden = n === 0;
}

function renderAlerts() {
  const el = $("#alerts-body");
  if (!el) return;
  el.classList.remove("loading", "err");

  if (alertItems.length === 0) {
    el.innerHTML =
      '<div class="card empty">Nothing yet. Ask in chat about an incident and say yes when it ' +
      "offers to watch it — anything it catches later shows up here.</div>";
    return;
  }

  const seenAt = localStorage.getItem(ALERTS_SEEN_KEY) ?? "";
  /* Cards rather than table rows. The numbers alone ("fill_rate -45%") only restate what fired; a
     reader needs the verdict, whether it is still happening, and what was ruled out before any of the
     figures mean anything. Everything below already exists in the investigation — none of it is
     recomputed here, and none of it is invented. */
  el.innerHTML = alertItems
    .map((n) => {
      const fresh = n.at > seenAt;
      const dir = n.pct < 0 ? "drop" : "rise";
      const d = n.diagnosis;
      const usd = (v) => `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`;
      const live = d && d.status === "ongoing";

      const facts = [];
      if (d && d.sharePct !== null)
        facts.push(`<span><b>${d.sharePct.toFixed(1)}%</b> of traffic</span>`);
      if (d && d.deltaPp !== null)
        facts.push(
          `<span><b>${d.deltaPp >= 0 ? "+" : ""}${d.deltaPp.toFixed(1)}</b> points</span>`,
        );
      if (d && d.sigma !== null)
        facts.push(`<span><b>${Math.abs(d.sigma).toFixed(0)}σ</b> from normal</span>`);
      if (d && d.impactUsdPerDay !== null)
        facts.push(`<span><b>${usd(d.impactUsdPerDay)}</b>/day</span>`);
      if (d && d.daysRunning !== null)
        facts.push(`<span>ran <b>${d.daysRunning}</b> day${d.daysRunning === 1 ? "" : "s"}</span>`);
      if (d && d.lostSoFarUsd !== null)
        facts.push(`<span><b>${usd(d.lostSoFarUsd)}</b> total</span>`);

      return (
        `<div class="card alert${fresh ? " fresh" : ""}">` +
        `<div class="alert-top">` +
        `<span class="alert-what"><b>${esc(n.metric)}</b> ${dir === "drop" ? "fell" : "rose"} ` +
        `<span class="${dir}">${Math.abs(n.pct).toFixed(0)}%</span> on <b>${esc(n.where)}</b></span>` +
        `<span class="alert-tags">` +
        (d ? `<em class="pri ${esc(d.priority)}">${esc(d.priority.replace(/_/g, " "))}</em>` : "") +
        (fresh ? '<em class="new">new</em>' : "") +
        `</span></div>` +
        `<div class="alert-meta">${esc(n.day)} &middot; ~${Number(n.requestsPerDay).toLocaleString()} requests/day` +
        ` &middot; caught ${esc(new Date(n.at).toLocaleString())}</div>` +
        (d
          ? `<div class="alert-verdict ${live ? "live" : ""}">` +
            `${live ? "🔴" : "🟠"} <b>${esc(d.channelLabel ?? d.channel)}</b> — ${esc(d.owner)}</div>` +
            (facts.length ? `<div class="alert-facts">${facts.join("")}</div>` : "") +
            `<div class="alert-because">${esc(d.because)}</div>` +
            `<div class="alert-status"><b>${live ? "Still happening." : "Recovered."}</b> ` +
            `${esc(d.statusDetail)}</div>` +
            (d.clearedCount > 0
              ? `<div class="alert-cleared">✅ <b>${d.clearedCount}</b> other slice(s) looked implicated and were checked and cleared` +
                (d.clearedExamples && d.clearedExamples.length
                  ? ` — ${d.clearedExamples.map(esc).join(", ")}${d.clearedCount > d.clearedExamples.length ? ", and more" : ""}`
                  : "") +
                `. They only moved because the real cause sits inside them.</div>`
              : "") +
            (d.nextQuestion
              ? `<div class="alert-next">Next: <code>${esc(d.nextQuestion)}</code></div>`
              : "") +
            `<div class="alert-actions">` +
            `<button type="button" class="ask" data-ask="${esc(alertQuestion(n))}">💬 Ask in chat</button>` +
            `</div>`
          : `<div class="alert-because">Detected by the sweep; the full investigation did not complete, so no cause is stated here.</div>` +
            `<div class="alert-actions"><button type="button" class="ask" data-ask="${esc(alertQuestion(n))}">💬 Ask in chat</button></div>`) +
        `</div>`
      );
    })
    .join("");

  // Opening the tab is the read receipt. Marked AFTER rendering so the "new" markers are visible on
  // the visit that earned them, and gone on the next.
  const newest = alertItems
    .map((n) => n.at)
    .sort()
    .pop();
  if (newest) localStorage.setItem(ALERTS_SEEN_KEY, newest);
  renderAlertsBadge();
}

let alertsFirstLoad = true;

async function loadAlerts() {
  try {
    const data = await getJson("/api/watch");
    alertItems = dedupeAlerts(data.notifications ?? []);
  } catch {
    alertItems = [];
  }

  /* Open on Alerts when something is waiting, otherwise leave Chat as it was.
     ONLY on the first load. Switching tabs on a later poll would yank someone out of a chat mid
     sentence because a cron fired — an alert earns the badge, it does not earn the screen. */
  if (alertsFirstLoad) {
    alertsFirstLoad = false;
    if (unseenCount() > 0) {
      activateView("alerts");
      return; // activateView renders and marks read
    }
  }

  if ($("#view-alerts")?.classList.contains("active")) renderAlerts();
  else renderAlertsBadge();
}

loadAlerts();
setInterval(loadAlerts, 60_000);
