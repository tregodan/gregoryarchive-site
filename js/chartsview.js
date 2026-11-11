// Chart builder: a dashboard of chart cards (like Airtable's chart extension, with more chart
// types, multiple series, and the images behind every mark shown under each chart).
import { CFG, getValue, sortKeyFor, DERIVED, thumbUrl, fullUrl, uri, attachFallback, toCSV, download, esc, fmtN, debounce } from "./data.js";
import { aggregate, render, modelRows, CHART_TYPES, NUMERIC, BINS, binKey } from "./charts.js";

const $ = (s, el = document) => el.querySelector(s);
const LS_KEY = "ga-charts-v1";
const SKIP = new Set(["Title", "Digital File Name", "Image_URL", "Georeference"]);

const SUGGESTIONS = [
  { title: "Images by location", type: "bar", x: "Location", top: 15, note: "Where the photographs were taken" },
  { title: "Subjects across time", type: "column", x: "Subject date (year)", bin: 100, note: "Century of the thing photographed" },
  { title: "Share by medium", type: "pie", x: "Medium", note: "Colour vs black-and-white, positive vs negative" },
  { title: "Photographs per year", type: "line", x: "Year photographed", bin: 1, note: "When the slides were shot" },
  { title: "Photographs per year by creator", type: "line", x: "Year photographed", bin: 1, series: "Creator", note: "Several lines, one per photographer" },
  { title: "Top locations by century", type: "stacked", x: "Location", top: 10, series: "Century (subject)", note: "Stacked columns" },
  { title: "Subject date vs year photographed", type: "scatter", x: "Year photographed", yField: "Subject date (year)", series: "Creator", note: "Each dot is one slide; drag to select" },
  { title: "Slide boxes by size", type: "bar", x: "Slide Box", top: 20, sort: "value", note: "Largest boxes first" },
  { title: "Who digitized the slides", type: "donut", x: "Digitizer 1", note: "Donut with total" },
  { title: "Distinct locations per box", type: "bar", x: "Slide Box", top: 20, y: "distinct", yField: "Location", note: "How varied each box is" },
  { title: "Average subject date by location", type: "bar", x: "Location", top: 15, y: "avg", yField: "Subject date (year)", note: "Older sites vs newer" },
  { title: "Photographs per 5 years by location", type: "area", x: "Year photographed", bin: 5, series: "Location", note: "Stacked area, top 7 locations" },
  { title: "Map coverage", type: "donut", x: "Has map location", note: "Slides with and without coordinates" },
  { title: "Subjects by century and medium", type: "grouped", x: "Subject date (year)", bin: 100, series: "Medium", note: "Grouped columns" },
];
const DEFAULTS = [0, 1, 2];
const icon = (t) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${(CHART_TYPES.find((c) => c[0] === t) || CHART_TYPES[0])[2]}</svg>`;
const b64 = { enc: (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s) => JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))))) };
let seq = 1;
const mk = ({ k, note, ...o }) => ({ type: "column", x: "Location", bin: 0, series: "", y: "count", yField: "", top: 0, sort: "value", linked: true, ...o, k: "c" + seq++ });
const LINK_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>';
const LINK_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 15l-1.3 1.3a3 3 0 0 1-4.2-4.2L6 9.6M15 9l1.3-1.3a3 3 0 0 1 4.2 4.2L18 14.4M8 4v2M4 8h2M16 20v-2M20 16h-2"/></svg>';

export class ChartsView {
  constructor(ctx) {
    this.ctx = ctx; this.sel = {}; this.models = {}; this.shown = {};
    let charts = null;
    try { if (ctx.initialHash) charts = b64.dec(ctx.initialHash); } catch {}
    if (!charts) try { charts = JSON.parse(localStorage.getItem(LS_KEY)); } catch {}
    this.charts = (Array.isArray(charts) && charts.length ? charts : DEFAULTS.map((i) => SUGGESTIONS[i])).map((c) => mk(c));
    this.showSugg = false;
  }
  save() {
    const plain = this.charts.map(({ k, ...c }) => c);
    try { localStorage.setItem(LS_KEY, JSON.stringify(plain)); } catch {}
    this.ctx.setHashCharts(b64.enc(plain));
  }
  // ---------------------------------------------------------------- options
  catFields() { return [...this.ctx.fields.filter((f) => !SKIP.has(f)), ...Object.keys(DERIVED)]; }
  xFields(type) { return type === "scatter" ? Object.keys(NUMERIC) : [...this.catFields(), ...Object.keys(NUMERIC)]; }

  mount(root) {
    this.root = root;
    root.innerHTML = `<div class="cv">
      <div class="cv-top">
        <div><h2>Charts</h2><p class="muted small" id="cvScope"></p></div>
        <div class="cv-actions">
          <button class="btn" id="cvSugg">✦ Suggested charts</button>
          <button class="btn primary" id="cvNew">+ New chart</button>
          <div class="menu"><button class="btn ghost" id="cvMore">⋯</button>
            <div class="menu-pop right" id="cvMoreMenu" hidden>
              <button data-cv="link">Copy link to these charts</button>
              <button data-cv="reset">Reset to the starter charts</button>
            </div></div>
        </div>
      </div>
      <div class="links" id="cvLinks" hidden></div>
      <div class="sugg" id="cvSuggList" hidden></div>
      <div class="cards" id="cvCards"></div>
    </div>`;
    $("#cvScope", root).innerHTML = `Charts use your current filters — <b>${esc(this.ctx.filterSummary())}</b> (${fmtN(this.ctx.records.length)} images). Click any bar, slice or point to see its images. <span class="lk-hint">A pick in a linked chart <i class="lk-dot"></i> filters the linked charts below it.</span>`;
    this.renderSugg();
    this.renderCards();
    this.renderLinks();
    this.bind();
    this.ro = new ResizeObserver(debounce(() => this.charts.forEach((c) => this.drawChart(c)), 120));
    this.ro.observe($("#cvCards", root));
    this.save();
  }
  unmount() { this.ro && this.ro.disconnect(); }

  renderSugg() {
    const el = $("#cvSuggList", this.root);
    el.hidden = !this.showSugg;
    el.innerHTML = SUGGESTIONS.map((s, i) => `<button class="sg" data-sg="${i}"><span class="sg-ic">${icon(s.type)}</span><span><b>${esc(s.title)}</b><small>${esc(s.note)}</small></span></button>`).join("");
  }
  renderCards() {
    const wrap = $("#cvCards", this.root);
    wrap.innerHTML = this.charts.map((c) => `<section class="ccard" data-k="${c.k}"></section>`).join("") ||
      `<div class="empty small-empty"><h3>No charts yet</h3><p>Add a suggested chart or build your own.</p></div>`;
    this.charts.forEach((c) => this.renderCard(c));
  }
  renderCard(c) {
    const el = $(`.ccard[data-k="${c.k}"]`, this.root); if (!el) return;
    const scatter = c.type === "scatter", pie = c.type === "pie" || c.type === "donut", numX = !!NUMERIC[c.x];
    const opt = (list, v, blank) => (blank ? `<option value="">${blank}</option>` : "") + list.map((f) => `<option ${f === v ? "selected" : ""}>${esc(f)}</option>`).join("");
    const yOpts = [["count", "Count of images"], ["distinct", "Distinct count of…"], ["avg", "Average of…"], ["min", "Minimum of…"], ["max", "Maximum of…"]];
    el.classList.toggle("linked", c.linked !== false);
    el.innerHTML = `
      <div class="cc-head">
        <button class="cc-link ${c.linked !== false ? "on" : ""}" data-act="link" title="${c.linked !== false ? "Linked: filtered by picks in the linked charts above, and a pick here filters the linked charts below. Click to make standalone." : "Standalone: ignores other charts. Click to link it."}">${c.linked !== false ? LINK_ON : LINK_OFF}<span>${c.linked !== false ? "Linked" : "Standalone"}</span></button>
        <input class="cc-title" value="${esc(c.title || "Untitled chart")}" aria-label="Chart title">
        <div class="cc-actions">
          <div class="menu"><button class="btn ghost" data-act="export">Export ▾</button>
            <div class="menu-pop right" hidden>
              <button data-exp="png">Chart as PNG image</button>
              <button data-exp="svg">Chart as SVG (vector)</button>
              <button data-exp="data">Chart data (CSV)</button>
              <button data-exp="records">Chart data + images table (CSV)</button>
              <button data-exp="html">Report with thumbnails (HTML)</button>
            </div></div>
          <button class="btn ghost icon" data-act="up" title="Move up">↑</button>
          <button class="btn ghost icon" data-act="down" title="Move down">↓</button>
          <button class="btn ghost icon" data-act="dup" title="Duplicate">⧉</button>
          <button class="btn ghost icon" data-act="del" title="Remove">×</button>
        </div>
      </div>
      <div class="cc-types" role="radiogroup" aria-label="Chart type">${CHART_TYPES.map(([t, label]) => `<button class="${t === c.type ? "on" : ""}" data-type="${t}" title="${label}" aria-label="${label}">${icon(t)}<span>${label}</span></button>`).join("")}</div>
      <div class="cc-config">
        <label>${scatter ? "X axis" : pie ? "Slices" : "X axis"} <select data-k="x">${opt(this.xFields(c.type), c.x)}</select></label>
        ${numX && !scatter ? `<label>Group into <select data-k="bin">${BINS[c.x].map(([b, l]) => `<option value="${b}" ${+c.bin === b || (!c.bin && b === BINS[c.x][0][0]) ? "selected" : ""}>${l}</option>`).join("")}</select></label>` : ""}
        ${scatter ? `<label>Y axis <select data-k="yField">${opt(Object.keys(NUMERIC), c.yField || "Subject date (year)")}</select></label>` :
          `<label>Y axis <select data-k="y">${yOpts.map(([v, l]) => `<option value="${v}" ${v === (c.y || "count") ? "selected" : ""}>${l}</option>`).join("")}</select></label>
           ${c.y && c.y !== "count" ? `<label>of <select data-k="yField">${opt(c.y === "distinct" ? this.catFields() : Object.keys(NUMERIC), c.yField)}</select></label>` : ""}`}
        ${pie ? "" : `<label>${scatter ? "Colour by" : "Group by"} <select data-k="series">${opt(this.catFields().filter((f) => f !== c.x), c.series, "None")}</select></label>`}
        ${!numX && !scatter ? `<label>Show <select data-k="top">${(pie ? [[4, "Top 4"], [5, "Top 5"], [6, "Top 6"], [7, "Top 7"]] : [[0, "All"], [5, "Top 5"], [10, "Top 10"], [15, "Top 15"], [20, "Top 20"], [30, "Top 30"], [50, "Top 50"]]).map(([n, l]) => `<option value="${n}" ${+c.top === n ? "selected" : ""}>${l}</option>`).join("")}</select></label>
          <label>Sort <select data-k="sort"><option value="value" ${c.sort !== "label" ? "selected" : ""}>Largest first</option><option value="label" ${c.sort === "label" ? "selected" : ""}>By name / order</option></select></label>` : ""}
        ${!numX && !scatter && !pie && c.top ? `<label class="cc-check"><input type="checkbox" data-k="other" ${c.other ? "checked" : ""}> Show “Other”</label>` : ""}
        <label class="cc-check"><input type="checkbox" data-k="blanks" ${c.blanks ? "checked" : ""}> Include blanks</label>
      </div>
      <div class="cc-chart"></div>
      <div class="cc-note muted small"></div>
      <div class="cc-sel"></div>`;
    this.drawChart(c);
  }
  drawChart(c) {
    const el = $(`.ccard[data-k="${c.k}"]`, this.root); if (!el) return;
    const box = $(".cc-chart", el);
    const recs = this.recordsFor(c);
    const own = this.sel[c.k];
    const m = aggregate(recs, own && !own.ids && !own.numeric ? { ...c, keep: own.xKey } : c, getValue, sortKeyFor);
    this._recs = this._recs || {}; this._recs[c.k] = recs;
    this.models[c.k] = m;
    const svg = render(m, c, box.clientWidth || 800);
    box.innerHTML = svg || `<div class="muted cc-empty">Nothing to chart for this selection — try another field or clear some filters.</div>`;
    const note = $(".cc-note", el);
    if (m.kind === "scatter") note.textContent = `${fmtN(m.totalPts)} images have both values${m.totalPts > m.pts.length ? ` (showing ${fmtN(m.pts.length)} evenly sampled)` : ""}. Click a dot to open it, or drag across the plot to select a group.`;
    else note.textContent = (m.series.length > 1 && m.series.at(-1).other ? "Smaller groups are combined into “Other”. " : "") + (m.numericX ? "Images without a value on the X axis are left out. " : !c.blanks ? "Images with a blank value are left out (tick “Include blanks” to count them). " : "");
    const others = c.linked !== false ? this.linkedSels(c).length : 0;
    if (others) note.innerHTML = `<span class="lk-badge">${LINK_ON} Filtered by ${others} chart${others > 1 ? "s" : ""} above · ${fmtN(recs.length)} of ${fmtN(this.ctx.records.length)} images</span> ` + esc(note.textContent);
    if (m.kind === "scatter") this.bindBrush(c, box, m);
    this.markSelection(c, box, m);
    this.renderSel(c);
  }
  allRecs(c) {
    const m = this.models[c.k]; if (!m) return [];
    if (m.kind === "scatter") return m.pts.map((p) => p.r);
    const out = []; m.recs.forEach((row) => row.forEach((a) => { for (const r of a) out.push(r); }));
    return out;
  }
  renderSel(c) {
    const el = $(`.ccard[data-k="${c.k}"] .cc-sel`, this.root); if (!el) return;
    const sel = this.sel[c.k];
    const all = this.allRecs(c);
    const list = sel ? ((this._recs && this._recs[c.k]) || all).filter(this.pred(sel)) : all;
    const n = this.shown[c.k] || 24;
    el.innerHTML = `<div class="sel-head">
        <div>${sel ? `<b>${esc(sel.label)}</b> · ${fmtN(list.length)} image${list.length === 1 ? "" : "s"}${c.linked !== false && this.charts.slice(this.charts.indexOf(c) + 1).some((x) => x.linked !== false) ? ` <span class="muted">— also filtering the linked charts below</span>` : ""} <button class="link" data-act="clearsel">Clear selection</button>` : `<b>${fmtN(list.length)} images</b> in this chart <span class="muted">— click a mark to narrow down</span>`}</div>
        <div class="sel-actions">${list.length ? `<button class="btn ghost" data-act="openall">Open viewer</button>` : ""}${sel && sel.pairs && sel.pairs.length ? `<button class="btn ghost" data-act="filter">Show in gallery</button>` : ""}${list.length ? `<button class="btn ghost" data-act="selcsv">Download CSV</button>` : ""}</div>
      </div>
      <div class="sel-grid">${list.slice(0, n).map((r, i) => `<button class="st" data-si="${i}" title="${esc(r.Title || "")}"><img loading="lazy" alt="" data-ri="${i}"><span>${esc(r.Title || r._id)}</span></button>`).join("")}</div>
      ${list.length > n ? `<button class="btn ghost more-sel" data-act="moresel">Show more (${fmtN(list.length - n)} left)</button>` : ""}`;
    el.querySelectorAll("img[data-ri]").forEach((im) => { const r = list[+im.dataset.ri]; attachFallback(im, r); im.src = thumbUrl(r); });
    el._list = list;
  }
  // ---------------------------------------------------------------- selections + linking
  // A selection is stored by value (not position) so it survives other charts re-filtering this one.
  select(c, ci, si) {
    const m = this.models[c.k]; if (!m || m.kind === "scatter") return;
    const cat = m.cats[ci]; if (!cat) return;
    const ser = si === "*" ? null : m.series[si];
    const sKey = ser && m.series.length > 1 ? ser.name : null;
    const prev = this.sel[c.k];
    if (prev && !prev.ids && prev.xKey === cat.key && prev.sKey === sKey) return this.setSel(c, null); // click again = clear
    let label = cat.label + (sKey ? " · " + sKey : "");
    const pairs = [];
    if (!cat.other && !m.numericX && cat.key !== "(blank)") pairs.push([c.x, cat.key]);
    if (sKey && c.series && !ser.other && sKey !== "(blank)") pairs.push([c.series, sKey]);
    if ((sKey && ser.other) || m.numericX) pairs.length = 0;
    const sel = { label, x: c.x, bin: +c.bin || (BINS[c.x] ? BINS[c.x][0][0] : 1), numeric: m.numericX, xKey: cat.key, series: c.series, sKey, pairs, title: c.title };
    if (cat.other || (ser && ser.other)) sel.ids = new Set((si === "*" ? m.recs[ci].flat() : m.recs[ci][si]).map((r) => r._id));
    this.setSel(c, sel);
  }
  setSel(c, sel) {
    if (sel) this.sel[c.k] = sel; else delete this.sel[c.k];
    this.shown[c.k] = 24;
    if (c.linked !== false) { this.redrawFrom(c); this.renderLinks(); }
    else this.drawChart(c);
  }
  redrawFrom(c) { // this chart and every linked chart below it
    const i = this.charts.indexOf(c);
    this.charts.forEach((x, j) => { if (x === c || (j > i && x.linked !== false)) this.drawChart(x); });
  }
  pred(sel) {
    if (sel.ids) return (r) => sel.ids.has(r._id);
    const xm = sel.numeric
      ? (r) => { const v = NUMERIC[sel.x](r); return v != null && binKey(sel.x, v, sel.bin) === sel.xKey; }
      : (r) => (getValue(r, sel.x) || "(blank)") === sel.xKey;
    if (sel.sKey == null) return xm;
    return (r) => xm(r) && (getValue(r, sel.series) || "(blank)") === sel.sKey;
  }
  // Linked charts form a chain from top to bottom: a chart is filtered only by the
  // selections of the linked charts ABOVE it, so its own photos stay tied to its own pick.
  linkedSels(c) {
    const i = this.charts.indexOf(c);
    return this.charts.slice(0, i < 0 ? this.charts.length : i).filter((x) => x.linked !== false && this.sel[x.k]).map((x) => this.sel[x.k]);
  }
  recordsFor(c) {
    if (c.linked === false) return this.ctx.records;
    const preds = this.linkedSels(c).map((s) => this.pred(s));
    return preds.length ? this.ctx.records.filter((r) => preds.every((p) => p(r))) : this.ctx.records;
  }
  markSelection(c, box, m) {
    const sel = this.sel[c.k]; if (!sel || m.kind === "scatter") return;
    const ci = m.cats.findIndex((k) => (sel.ids ? k.other : k.key === sel.xKey));
    const si = sel.sKey == null ? null : m.series.findIndex((s) => s.name === sel.sKey || (sel.ids && s.other));
    box.querySelectorAll("[data-sel]").forEach((el) => {
      const [a, b] = el.dataset.sel.split(":");
      const hit = +a === ci && (si == null || b === "*" || +b === si);
      el.classList.toggle("dim", !hit && el.classList.contains("mark"));
      el.classList.toggle("picked", hit && el.classList.contains("hit"));
    });
  }
  renderLinks() {
    const el = $("#cvLinks", this.root); if (!el) return;
    const items = this.charts.filter((x) => x.linked !== false && this.sel[x.k]);
    el.hidden = !items.length;
    if (!items.length) return;
    const preds = items.map((x) => this.pred(this.sel[x.k]));
    const n = this.ctx.records.filter((r) => preds.every((p) => p(r))).length;
    const canApply = items.every((x) => this.sel[x.k].pairs && this.sel[x.k].pairs.length);
    el.innerHTML = `<span class="lk-title">${LINK_ON} Linked selections</span>
      ${items.map((x, i) => `${i ? '<span class="lk-arrow">→</span>' : ""}<button class="lk-chip" data-unsel="${x.k}" title="Remove this selection"><small>${esc(x.title || "Chart")}</small>${esc(this.sel[x.k].label)}<span>×</span></button>`).join("")}
      <span class="lk-n"><b>${fmtN(n)}</b> image${n === 1 ? "" : "s"} at the end of the chain</span>
      ${canApply ? `<button class="btn ghost" data-lk="apply" title="Turn these selections into page filters (gallery, table, map…)">Use as page filter</button>` : ""}
      <button class="btn ghost" data-lk="clear">Clear all</button>`;
  }
  bindBrush(c, box, m) {
    const svg = box.querySelector("svg"); if (!svg) return;
    const area = svg.querySelector(".brush-area"); if (!area) return;
    let start = null, rect = null;
    const pt = (e) => { const p = svg.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(svg.getScreenCTM().inverse()); };
    svg.addEventListener("pointerdown", (e) => {
      if (!e.target.closest(".brush-area") && !e.target.closest("circle")) return;
      start = pt(e); rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("fill", "rgba(154,79,36,.12)"); rect.setAttribute("stroke", "#9a4f24"); rect.setAttribute("stroke-dasharray", "4 3");
      svg.appendChild(rect); svg.setPointerCapture(e.pointerId); start.target = e.target;
    });
    svg.addEventListener("pointermove", (e) => {
      if (!start) return; const p = pt(e);
      rect.setAttribute("x", Math.min(p.x, start.x)); rect.setAttribute("y", Math.min(p.y, start.y));
      rect.setAttribute("width", Math.abs(p.x - start.x)); rect.setAttribute("height", Math.abs(p.y - start.y));
    });
    svg.addEventListener("pointerup", (e) => {
      if (!start) return; const p = pt(e), s = start; start = null; rect.remove();
      if (Math.abs(p.x - s.x) < 5 && Math.abs(p.y - s.y) < 5) {
        const dot = s.target.closest && s.target.closest("circle[data-pt]");
        if (dot) { const list = this.allRecs(c); const r = m.pts[+dot.dataset.pt].r; this.ctx.openRecords(list, Math.max(0, list.indexOf(r))); }
        return;
      }
      const [xa, xb] = [Math.min(p.x, s.x), Math.max(p.x, s.x)], [ya, yb] = [Math.min(p.y, s.y), Math.max(p.y, s.y)];
      const recs = [];
      svg.querySelectorAll("circle[data-pt]").forEach((cEl) => { const cx = +cEl.getAttribute("cx"), cy = +cEl.getAttribute("cy"); if (cx >= xa && cx <= xb && cy >= ya && cy <= yb) recs.push(m.pts[+cEl.dataset.pt].r); });
      if (!recs.length) return this.setSel(c, null);
      this.setSel(c, { label: `${fmtN(recs.length)} points in selected area`, ids: new Set(recs.map((r) => r._id)), pairs: [], title: c.title });
    });
  }
  // ---------------------------------------------------------------- events
  bind() {
    const root = this.root;
    $("#cvSugg", root).onclick = () => { this.showSugg = !this.showSugg; this.renderSugg(); };
    $("#cvNew", root).onclick = () => { this.charts.unshift(mk({ title: "New chart" })); this.save(); this.renderCards(); };
    $("#cvMore", root).onclick = (e) => { e.stopPropagation(); $("#cvMoreMenu", root).hidden = !$("#cvMoreMenu", root).hidden; };
    $("#cvMoreMenu", root).onclick = async (e) => {
      const a = e.target.closest("[data-cv]")?.dataset.cv;
      if (a === "link") { try { await navigator.clipboard.writeText(location.href); } catch {} }
      if (a === "reset") { this.charts = DEFAULTS.map((i) => mk({ ...SUGGESTIONS[i] })); this.sel = {}; this.save(); this.renderCards(); this.renderLinks(); }
    };
    $("#cvSuggList", root).onclick = (e) => {
      const b = e.target.closest("[data-sg]"); if (!b) return;
      const c = mk({ ...SUGGESTIONS[+b.dataset.sg] }); this.charts.unshift(c); this.save(); this.renderCards();
      root.closest(".view").scrollTo({ top: 0, behavior: "smooth" });
    };
    $("#cvLinks", root).onclick = (e) => {
      const u = e.target.closest("[data-unsel]");
      if (u) { const c = this.charts.find((x) => x.k === u.dataset.unsel); if (c) this.setSel(c, null); return; }
      const a = e.target.closest("[data-lk]")?.dataset.lk;
      const linked = this.charts.filter((x) => x.linked !== false && this.sel[x.k]);
      if (a === "clear") { linked.forEach((x) => delete this.sel[x.k]); this.charts.filter((x) => x.linked !== false).forEach((x) => this.drawChart(x)); this.renderLinks(); }
      if (a === "apply") { const pairs = linked.flatMap((x) => this.sel[x.k].pairs); linked.forEach((x) => delete this.sel[x.k]); this.ctx.applyFilter(pairs); }
    };
    const cards = $("#cvCards", root);
    cards.addEventListener("click", (e) => {
      const card = e.target.closest(".ccard"); if (!card) return;
      const c = this.charts.find((x) => x.k === card.dataset.k);
      const t = e.target.closest("[data-type]");
      if (t) { this.setType(c, t.dataset.type); return; }
      const mark = e.target.closest("[data-sel]");
      if (mark) { const [ci, si] = mark.dataset.sel.split(":"); this.select(c, +ci, si === "*" ? "*" : +si); return; }
      const st = e.target.closest("[data-si]");
      if (st) { const list = card.querySelector(".cc-sel")._list; this.ctx.openRecords(list, +st.dataset.si); return; }
      const exp = e.target.closest("[data-exp]");
      if (exp) { exp.closest(".menu-pop").hidden = true; this.exportChart(c, exp.dataset.exp); return; }
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (!act) return;
      if (act === "export") { e.stopPropagation(); const pop = e.target.closest(".menu").querySelector(".menu-pop"); document.querySelectorAll(".ccard .menu-pop").forEach((p) => p !== pop && (p.hidden = true)); pop.hidden = !pop.hidden; }
      if (act === "up" || act === "down") {
        const i = this.charts.indexOf(c), j = act === "up" ? i - 1 : i + 1;
        if (j < 0 || j >= this.charts.length) return;
        [this.charts[i], this.charts[j]] = [this.charts[j], this.charts[i]];
        this.save(); this.renderCards(); this.renderLinks();
        $(`.ccard[data-k="${c.k}"]`, this.root)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        return;
      }
      if (act === "dup") { const i = this.charts.indexOf(c); this.charts.splice(i + 1, 0, mk({ ...c, title: (c.title || "Chart") + " (copy)" })); this.save(); this.renderCards(); }
      if (act === "del") { this.charts = this.charts.filter((x) => x !== c); delete this.sel[c.k]; this.save(); this.renderCards(); this.renderLinks(); }
      if (act === "clearsel") { this.setSel(c, null); }
      if (act === "link") {
        const hadSel = !!this.sel[c.k]; c.linked = c.linked === false; this.save(); this.renderCard(c);
        this.redrawFrom(c); this.renderLinks();
      }
      if (act === "moresel") { this.shown[c.k] = (this.shown[c.k] || 24) + 48; this.renderSel(c); }
      if (act === "openall") { const list = card.querySelector(".cc-sel")._list; if (list.length) this.ctx.openRecords(list, 0); }
      if (act === "filter") { const s = this.sel[c.k]; if (s && s.pairs.length) this.ctx.applyFilter(s.pairs); }
      if (act === "selcsv") { const list = card.querySelector(".cc-sel")._list; download(`${slug(c.title)}-images.csv`, toCSV(list, this.ctx.fields.filter((f) => f !== "Image_URL"))); }
    });
    cards.addEventListener("change", (e) => {
      const sel = e.target.closest("select[data-k], input[data-k]"); if (!sel) return;
      const card = e.target.closest(".ccard"), c = this.charts.find((x) => x.k === card.dataset.k);
      const k = sel.dataset.k, v = sel.type === "checkbox" ? sel.checked : sel.value;
      c[k] = k === "top" || k === "bin" ? +v : v;
      if (k === "x") { c.bin = 0; if (c.series === v) c.series = ""; }
      if (k === "y") c.yField = v === "count" ? "" : v === "distinct" ? (c.yField && !NUMERIC[c.yField] ? c.yField : "Location") : (NUMERIC[c.yField] ? c.yField : "Subject date (year)");
      const had = !!this.sel[c.k]; delete this.sel[c.k]; this.save(); this.renderCard(c);
      if (had && c.linked !== false) { this.redrawFrom(c); this.renderLinks(); }
    });
    cards.addEventListener("input", debounce((e) => {
      const t = e.target.closest(".cc-title"); if (!t) return;
      const c = this.charts.find((x) => x.k === t.closest(".ccard").dataset.k); c.title = t.value; this.save();
    }, 300));
    if (!ChartsView._docBound) { ChartsView._docBound = true; document.addEventListener("click", () => document.querySelectorAll(".cv .menu-pop").forEach((p) => (p.hidden = true))); }
  }
  setType(c, type) {
    const was = c.type; c.type = type;
    if (type === "scatter") { if (!NUMERIC[c.x]) c.x = "Year photographed"; if (!NUMERIC[c.yField]) c.yField = "Subject date (year)"; c.y = "count"; }
    else if (was === "scatter") { c.yField = ""; c.y = "count"; }
    if ((type === "stacked" || type === "grouped") && !c.series) c.series = c.x === "Medium" ? "Creator" : "Medium";
    if ((type === "pie" || type === "donut") && (!c.top || c.top > 7)) c.top = 6;
    const had = !!this.sel[c.k]; delete this.sel[c.k]; this.save(); this.renderCard(c);
    if (had && c.linked !== false) { this.redrawFrom(c); this.renderLinks(); }
  }
  // ---------------------------------------------------------------- export
  svgOf(c) { return $(`.ccard[data-k="${c.k}"] .cc-chart svg`, this.root); }
  async exportChart(c, kind) {
    const name = slug(c.title || "chart"), m = this.models[c.k], svgEl = this.svgOf(c);
    const svgText = svgEl ? titled(svgEl, c.title, this.ctx.filterSummary()) : "";
    if (kind === "svg" && svgText) return download(`${name}.svg`, svgText, "image/svg+xml");
    if (kind === "png" && svgText) return svgToPng(svgText, `${name}.png`);
    if (kind === "data") return download(`${name}-data.csv`, rowsToCSV(modelRows(m)));
    const recs = this.sel[c.k] ? this.sel[c.k].recs : this.allRecs(c);
    if (kind === "records") {
      const csv = "# Chart: " + (c.title || "") + " — " + this.ctx.filterSummary() + (this.sel[c.k] ? " — selection: " + this.sel[c.k].label : "") + "\r\n# Chart data\r\n" + rowsToCSV(modelRows(m)) + "\r\n\r\n# Images referenced by the chart\r\n" + toCSV(recs, this.ctx.fields.filter((f) => f !== "Image_URL"));
      return download(`${name}-with-images.csv`, csv);
    }
    if (kind === "html") return download(`${name}-report.html`, reportHTML(c, svgText, modelRows(m), recs, this.ctx.fields, this.ctx.filterSummary(), this.sel[c.k]), "text/html");
  }
}

const slug = (s) => (s || "chart").toLowerCase().replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "chart";
function rowsToCSV(rows) { const e = (v) => { v = v == null ? "" : String(v); return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }; return rows.map((r) => r.map(e).join(",")).join("\r\n"); }
function titled(svgEl, title, scope) {
  // add title + scope above the chart for exports
  const w = +svgEl.getAttribute("width"), h = +svgEl.getAttribute("height");
  const inner = svgEl.innerHTML;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w + 40} ${h + 80}" width="${w + 40}" height="${h + 80}" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif"><rect width="100%" height="100%" fill="#fffdf9"/><text x="20" y="32" font-size="18" font-weight="600" fill="#1f1b16">${esc(title || "Chart")}</text><text x="20" y="52" font-size="12" fill="#8b8178">${esc("Gregory Archive · " + scope)}</text><g transform="translate(20,64)">${inner}</g></svg>`;
}
function svgToPng(svgText, name) {
  return new Promise((ok) => {
    const img = new Image(), url = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml" }));
    img.onload = () => {
      const k = 2, c = document.createElement("canvas"); c.width = img.width * k; c.height = img.height * k;
      const g = c.getContext("2d"); g.scale(k, k); g.drawImage(img, 0, 0); URL.revokeObjectURL(url);
      c.toBlob((b) => { const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(b), download: name }); document.body.appendChild(a); a.click(); a.remove(); ok(); }, "image/png");
    };
    img.src = url;
  });
}
function reportHTML(c, svgText, rows, recs, fields, scope, sel) {
  const show = recs.slice(0, 2000), cols = ["Title", "Subject", "Location", "Date of Subject", "Date Created", "Slide Box"].filter((f) => fields.includes(f));
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${esc(c.title || "Chart")} — Gregory Archive</title>
<style>body{font:14px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1f1b16;max-width:1100px;margin:30px auto;padding:0 20px}h1{font:600 26px Georgia,serif;margin:0}p.s{color:#8b8178;margin:4px 0 20px}table{border-collapse:collapse;width:100%;margin:12px 0 30px}th,td{border-bottom:1px solid #e4ddd2;padding:6px 8px;text-align:left;vertical-align:top}th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#5b5249}td img{width:110px;height:80px;object-fit:contain;background:#eee8df;border-radius:4px}h2{font:600 18px Georgia,serif;margin-top:28px}svg{max-width:100%;height:auto}a{color:#7a3c18}</style></head><body>
<h1>${esc(c.title || "Chart")}</h1><p class="s">Gregory Archive · ${esc(scope)}${sel ? " · selection: " + esc(sel.label) : ""} · exported ${new Date().toISOString().slice(0, 10)}</p>
${svgText}
<h2>Chart data</h2><table><thead><tr>${rows[0].map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.slice(1).map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table>
<h2>Images (${fmtN(recs.length)}${recs.length > show.length ? `, first ${fmtN(show.length)} shown` : ""})</h2>
<table><thead><tr><th></th><th>ID</th>${cols.map((f) => `<th>${esc(f)}</th>`).join("")}</tr></thead><tbody>${show.map((r) => `<tr><td><a href="${esc(uri(r))}"><img loading="lazy" src="${esc(thumbUrl(r))}" alt=""></a></td><td><a href="${esc(uri(r))}">${esc(r._id)}</a><br><a href="${esc(fullUrl(r))}">full image</a></td>${cols.map((f) => `<td>${esc(r[f] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table>
</body></html>`;
}
