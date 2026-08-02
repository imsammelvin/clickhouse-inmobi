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

const views = ["chat", "anomalies", "rollup", "llm", "health"];
const loaded = new Set();

document.querySelectorAll("nav button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const v = btn.dataset.view;
    document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b === btn));
    views.forEach((name) => $("#view-" + name).classList.toggle("active", name === v));
    if (!loaded.has(v)) {
      loaded.add(v);
      loadView(v);
    }
  });
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
    if (b) {
      for (const id of ["#a-from", "#a-to"]) {
        const input = $(id);
        if (!input) continue;
        input.min = b.from;
        input.max = b.to;
        if (!input.value) input.value = id === "#a-from" ? b.from : b.to;
      }
    }
    const w = data.appliedWindow;
    const note = $("#a-range-note");
    if (note && w) {
      note.textContent =
        `${anomaliesData.length} window(s) over ${w.from} → ${w.to}` +
        (anomaliesRange.from || anomaliesRange.to ? "" : " (all loaded data)");
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
  anomaliesRange = { from: "", to: "" };
  const b = $("#a-from");
  if (b) b.value = b.min || "";
  const t = $("#a-to");
  if (t) t.value = t.max || "";
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
    const cmp = typeof va === "string" ? va.localeCompare(vb) : va - vb;
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
 * While you were away.
 *
 * The watchman runs on a cron, so its findings have to wait for you rather than the other way round.
 * The browser remembers when you last dismissed the strip and asks only for what came after, so
 * returning to the tab does not replay incidents you have already read — a banner that shows the same
 * three things every morning is a banner nobody reads by Thursday.
 * ------------------------------------------------------------------------------------------------ */
const AWAY_SEEN_KEY = "watchman.seenAt";

async function loadAway() {
  const el = document.querySelector("#away");
  if (!el) return;
  const since = localStorage.getItem(AWAY_SEEN_KEY);
  let data;
  try {
    data = await getJson(`/api/watch${since ? `?since=${encodeURIComponent(since)}` : ""}`);
  } catch {
    return; // the dashboard is useful without this; never let it break the page
  }

  const items = data.notifications ?? [];
  if (items.length === 0) {
    el.hidden = true;
    return;
  }

  document.querySelector("#away-title").textContent =
    `While you were away — ${items.length} thing${items.length > 1 ? "s" : ""} you asked to be told about`;

  document.querySelector("#away-list").innerHTML = items
    .map((n) => {
      const dir = n.pct < 0 ? "down" : "up";
      return `<li><b>${n.metric}</b> ${dir} ${Math.abs(n.pct).toFixed(0)}% on <b>${n.where}</b>
        &middot; ${n.day} &middot; ~${Number(n.requestsPerDay).toLocaleString()} requests/day</li>`;
    })
    .join("");

  el.hidden = false;
}

document.querySelector("#away-dismiss")?.addEventListener("click", () => {
  // Watermark by NOW, not by the newest item shown: anything the cron writes while the tab is open
  // is still unseen, and marking it read here would silently swallow it.
  localStorage.setItem(AWAY_SEEN_KEY, new Date().toISOString());
  document.querySelector("#away").hidden = true;
});

loadAway();
