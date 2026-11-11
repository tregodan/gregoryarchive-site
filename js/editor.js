// Gregory Archive editor: spreadsheet-style editing on top of the Google Sheet.
import { CFG, loadArchive, indexRecords, thumbUrl, mediumUrl, fullUrl, attachFallback, esc, fmtN, debounce, download } from "./data.js";
import { Lightbox } from "./lightbox.js";

const $ = (s, el = document) => el.querySelector(s);
const LS = {
  get(k, d) { try { const v = localStorage.getItem("ga-ed-" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("ga-ed-" + k, JSON.stringify(v)); } catch {} },
};

// ------------------------------------------------------------------ state
const settings = Object.assign({ url: CFG.appsScriptUrl || "", key: "", name: "" }, LS.get("settings", {}));
let mode = "demo";                 // "demo" (static data, nothing saved to Sheet) | "live"
let fields = [];                   // Sheet headers (minus ID)
let records = [], byId = new Map();
let view = [];                     // filtered records
let pending = new Map(LS.get("pending", []));   // id -> {field: value}
let original = new Map(LS.get("original", []));  // id -> {field: value before edit}
const selected = new Set();
let active = { r: 0, c: 0 };       // active cell (row index in view, column index in cols)
let currentId = null;              // record open in the side form
let filter = { q: "", box: "", issue: "" };

const DEFAULT_COLS = ["Title", "Subject", "Location", "Georeference", "Date of Subject", "Date Created", "Slide Box", "Creator",
  "Digital File Name", "Digitizer 1", "Digitizer 2", "Date digitized", "Device", "Medium", "Format", "Class"];
let cols = LS.get("cols", null);
const WIDTH = { Title: 240, Subject: 200, Location: 150, Georeference: 170, "Date of Subject": 130, "Date Created": 110, "Slide Box": 200,
  Creator: 150, "Digital File Name": 170, "Image_URL": 260 };
const CATEGORICAL = new Set(["Slide Box", "Location", "Subject", "Creator", "Digitizer 1", "Digitizer 2", "Device", "Medium", "Format", "Class", "Date digitized", "Date of Subject"]);
const READONLY = new Set(["ID"]);

const val = (r, f) => { const p = pending.get(r._id); return p && f in p ? p[f] : r[f] ?? ""; };
const isDirty = (r, f) => { const p = pending.get(r._id); return !!(p && f in p); };

// ------------------------------------------------------------------ data-quality checks (on raw Sheet data)
const ISSUES = [
  ["missing-title", "Missing title", (r) => !val(r, "Title")],
  ["missing-subject", "Missing subject", (r) => !val(r, "Subject")],
  ["missing-location", "Missing location", (r) => !val(r, "Location")],
  ["missing-date", "Missing date created", (r) => !val(r, "Date Created")],
  ["no-geo", "No map coordinates", (r) => !/^\s*-?\d+\.\d+\s*,\s*-?\d+\.\d+\s*$/.test(val(r, "Georeference"))],
  ["bad-geo", "Georeference isn’t coordinates", (r) => { const g = val(r, "Georeference"); return g && !/^\s*-?\d+\.\d+\s*,\s*-?\d+\.\d+\s*$/.test(g); }],
  ["dup-file", "Duplicate file name", (r) => dupFiles.has(val(r, "Digital File Name"))],
  ["shifted", "Columns shifted (Medium = “35mm”)", (r) => val(r, "Medium") === "35mm"],
  ["header-row", "Pasted header row", (r) => val(r, "Title") === "Title" && val(r, "Slide Box") === "Slide Box"],
  ["no-image", "No image", (r) => !val(r, "Digital File Name") && !val(r, "Image_URL")],
  ["edited", "Edited, not saved", (r) => pending.has(r._id)],
];
let dupFiles = new Set();
function computeDups() {
  const c = new Map();
  for (const r of records) { const f = val(r, "Digital File Name"); if (f) c.set(f, (c.get(f) || 0) + 1); }
  dupFiles = new Set([...c].filter(([, n]) => n > 1).map(([f]) => f));
}

// ------------------------------------------------------------------ backend
async function api(action, payload = {}) {
  if (!settings.url) throw new Error("No Apps Script URL set (⚙ settings).");
  const res = await fetch(settings.url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ key: settings.key, editor: settings.name, action, ...payload }) });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function load() {
  $("#count").textContent = "Loading…";
  if (settings.url && settings.key) {
    try {
      const d = await api("list");
      const idCol = d.headers.indexOf("ID");
      fields = d.headers.filter((h) => h && h !== "ID");
      records = d.rows.map((row, i) => {
        const r = {}; d.headers.forEach((h, j) => { if (h) r[h] = row[j]; });
        r._id = idCol >= 0 && row[idCol] ? row[idCol] : "r" + (i + 2); r._row = i + 2; r._i = i; return r;
      });
      mode = "live";
      if (idCol < 0) toast("Tip: run “Add / fill record IDs” from the Sheet’s Gregory Archive menu so edits survive row moves.", 7000);
    } catch (e) {
      toast("Couldn’t reach the Sheet: " + e.message + " — showing demo data.", 7000);
    }
  }
  if (mode !== "live") {
    const db = await loadArchive();
    fields = db.fields; records = db.records;
    records.forEach((r) => { r._id = String(r._id); if (!r.Image_URL) r.Image_URL = fullUrl(r); });
  }
  byId = new Map(records.map((r) => [r._id, r]));
  // drop pending edits for records that no longer exist
  for (const id of [...pending.keys()]) if (!byId.has(id)) { pending.delete(id); original.delete(id); }
  indexRecords(records, fields);
  if (!cols) cols = DEFAULT_COLS.filter((c) => fields.includes(c));
  cols = cols.filter((c) => fields.includes(c));
  computeDups();
  $("#conn").textContent = mode === "live" ? "● Connected to Sheet" : "Demo mode · not saving";
  $("#conn").className = "conn " + mode;
  $("#publishBtn").hidden = mode !== "live";
  const boxes = [...new Set(records.map((r) => r["Slide Box"]).filter(Boolean))].sort((a, b) => (parseInt(a) || 1e6) - (parseInt(b) || 1e6) || a.localeCompare(b));
  $("#boxSel").innerHTML = `<option value="">All boxes (${boxes.length})</option>` + boxes.map((b) => `<option>${esc(b)}</option>`).join("");
  refresh();
}

// ------------------------------------------------------------------ filtering + sidebar
function refresh(keepScroll = true) {
  const toks = filter.q.toLowerCase().split(/\s+/).filter(Boolean);
  const issue = ISSUES.find((i) => i[0] === filter.issue);
  view = records.filter((r) => {
    if (filter.box && val(r, "Slide Box") !== filter.box) return false;
    for (const t of toks) if (!r._text.includes(t)) return false;
    if (issue && !issue[2](r)) return false;
    return true;
  });
  if (active.r >= view.length) active.r = Math.max(0, view.length - 1);
  renderIssues(); renderBar(); renderSheet(keepScroll);
}
function renderIssues() {
  const base = records.filter((r) => !filter.box || val(r, "Slide Box") === filter.box);
  $("#issues").innerHTML = ISSUES.map(([k, label, t]) => {
    const n = base.reduce((s, r) => s + (t(r) ? 1 : 0), 0);
    return n || filter.issue === k ? `<li><button class="${filter.issue === k ? "on" : ""}" data-issue="${k}"><span>${esc(label)}</span><b>${fmtN(n)}</b></button></li>` : "";
  }).join("") || "<li class='muted small'>Nothing flagged 🎉</li>";
  if (filter.issue === "shifted" && view.length) $("#issues").insertAdjacentHTML("beforeend", `<li><button class="btn fixbtn" id="fixShift">Repair ${fmtN(view.length)} shifted rows</button><small class="muted">Moves Digitizer 2 → Medium → Format → Class back one column.</small></li>`);
}
function repairShifted() {
  let n = 0;
  for (const r of view.slice()) {
    if (val(r, "Medium") !== "35mm") continue;
    const d2 = val(r, "Digitizer 2"), med = val(r, "Medium"), fmt = val(r, "Format");
    setValue(r, "Class", fmt); setValue(r, "Format", med); setValue(r, "Medium", d2); setValue(r, "Digitizer 2", ""); n++;
  }
  toast(`${fmtN(n)} rows repaired (not saved yet).`); refresh();
}
function renderBar() {
  $("#count").innerHTML = `<b>${fmtN(view.length)}</b> of ${fmtN(records.length)} records`;
  const chips = [];
  if (filter.q) chips.push(["q", `“${filter.q}”`]);
  if (filter.box) chips.push(["box", filter.box]);
  if (filter.issue) chips.push(["issue", ISSUES.find((i) => i[0] === filter.issue)[1]]);
  $("#chips").innerHTML = chips.map(([k, l]) => `<button class="chip" data-chip="${k}">${esc(l)}<span>×</span></button>`).join("");
  const n = [...pending.values()].reduce((s, p) => s + Object.keys(p).length, 0);
  $("#pending").textContent = n ? `${fmtN(n)} unsaved change${n > 1 ? "s" : ""} in ${fmtN(pending.size)} record${pending.size > 1 ? "s" : ""}` : "All changes saved";
  $("#pending").classList.toggle("dirty", !!n);
  $("#saveBtn").disabled = !n;
  $("#saveBtn").textContent = mode === "live" ? (n ? `Save ${fmtN(n)}` : "Saved") : "Save (demo)";
  $("#selInfo").textContent = selected.size ? `${fmtN(selected.size)} selected` : "Tick rows to bulk edit them.";
}
function persist() { LS.set("pending", [...pending]); LS.set("original", [...original]); }

// ------------------------------------------------------------------ the sheet (virtualized grid)
const RH = 40, HEAD = 38, SEL_W = 36, IMG_W = 56;
let colX = [];
function renderSheet(keepScroll) {
  const sheet = $("#sheet"), inner = $("#sheetInner");
  colX = []; let x = SEL_W + IMG_W;
  for (const c of cols) { colX.push(x); x += WIDTH[c] || 140; }
  inner.style.width = x + "px"; inner.style.height = HEAD + view.length * RH + "px";
  inner.innerHTML = `<div class="sh-head" style="width:${x}px"><div class="sh-c sel" style="left:0;width:${SEL_W}px"><input type="checkbox" id="selPage" title="Select all filtered"></div><div class="sh-c" style="left:${SEL_W}px;width:${IMG_W}px"></div>${cols.map((c, j) => `<div class="sh-c" style="left:${colX[j]}px;width:${WIDTH[c] || 140}px" title="${esc(c)}">${esc(c)}</div>`).join("")}</div><div class="sh-rows"></div>`;
  $("#selPage").checked = view.length && view.every((r) => selected.has(r._id));
  if (!keepScroll) sheet.scrollTop = 0;
  drawRows();
}
function drawRows() {
  const sheet = $("#sheet"), wrap = $(".sh-rows");
  if (!wrap) return;
  const i0 = Math.max(0, Math.floor((sheet.scrollTop - HEAD) / RH) - 5), i1 = Math.min(view.length, i0 + Math.ceil(sheet.clientHeight / RH) + 12);
  let h = "";
  for (let i = i0; i < i1; i++) {
    const r = view[i], top = HEAD + i * RH, sel = selected.has(r._id);
    h += `<div class="sh-r ${sel ? "sel" : ""} ${r._id === currentId ? "cur" : ""}" data-i="${i}" style="top:${top}px">
      <div class="sh-c sel" style="left:0;width:${SEL_W}px"><input type="checkbox" ${sel ? "checked" : ""}></div>
      <div class="sh-c img" style="left:${SEL_W}px;width:${IMG_W}px"><img loading="lazy" alt="" data-i="${i}"></div>
      ${cols.map((c, j) => `<div class="sh-c ${isDirty(r, c) ? "dirty" : ""} ${active.r === i && active.c === j ? "act" : ""}" data-c="${j}" style="left:${colX[j]}px;width:${WIDTH[c] || 140}px">${esc(val(r, c))}</div>`).join("")}
    </div>`;
  }
  wrap.innerHTML = h;
  wrap.querySelectorAll("img[data-i]").forEach((im) => { const r = view[+im.dataset.i]; attachFallback(im, r); im.src = thumbUrl(r); });
}
function cellEl(i, j) { return $(`.sh-r[data-i="${i}"] .sh-c[data-c="${j}"]`); }
function setActive(i, j, scroll = true) {
  i = Math.max(0, Math.min(view.length - 1, i)); j = Math.max(0, Math.min(cols.length - 1, j));
  const prev = cellEl(active.r, active.c); prev && prev.classList.remove("act");
  active = { r: i, c: j };
  if (scroll) {
    const sh = $("#sheet"), top = HEAD + i * RH, left = colX[j], w = WIDTH[cols[j]] || 140;
    if (top - HEAD < sh.scrollTop) sh.scrollTop = top - HEAD; else if (top + RH > sh.scrollTop + sh.clientHeight) sh.scrollTop = top + RH - sh.clientHeight;
    if (left < sh.scrollLeft + SEL_W + IMG_W) sh.scrollLeft = left - SEL_W - IMG_W; else if (left + w > sh.scrollLeft + sh.clientWidth) sh.scrollLeft = left + w - sh.clientWidth;
  }
  drawRows();
  if (view[i] && view[i]._id !== currentId) openForm(view[i]._id);
}

// inline cell editor
let editing = null;
function startEdit(initial) {
  const r = view[active.r], f = cols[active.c];
  if (!r || READONLY.has(f)) return;
  const cell = cellEl(active.r, active.c); if (!cell) return;
  const inp = document.createElement("input");
  inp.className = "cell-input"; inp.value = initial != null ? initial : val(r, f);
  if (CATEGORICAL.has(f)) { fillDatalist(f); inp.setAttribute("list", "dl-active"); }
  cell.appendChild(inp); inp.focus();
  if (initial == null) inp.select();
  editing = { inp, r, f };
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitEdit(); setActive(active.r + (e.shiftKey ? -1 : 1), active.c); $("#sheet").focus(); }
    else if (e.key === "Tab") { e.preventDefault(); commitEdit(); setActive(active.r, active.c + (e.shiftKey ? -1 : 1)); $("#sheet").focus(); }
    else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); $("#sheet").focus(); }
    e.stopPropagation();
  });
  inp.addEventListener("blur", () => setTimeout(() => editing && editing.inp === inp && commitEdit(), 100));
}
function commitEdit() {
  if (!editing) return;
  const { inp, r, f } = editing; editing = null;
  setValue(r, f, inp.value);
  inp.remove(); drawRows(); renderBar(); if (r._id === currentId) openForm(r._id);
}
function cancelEdit() { if (editing) { editing.inp.remove(); editing = null; } }

function setValue(r, f, v) {
  v = String(v ?? "");
  const orig = original.get(r._id)?.[f] ?? (r[f] ?? "");
  if (!original.has(r._id)) original.set(r._id, {});
  if (!(f in original.get(r._id))) original.get(r._id)[f] = r[f] ?? "";
  const p = pending.get(r._id) || {};
  if (v === String(orig)) { delete p[f]; delete original.get(r._id)[f]; }
  else p[f] = v;
  if (Object.keys(p).length) pending.set(r._id, p); else { pending.delete(r._id); original.delete(r._id); }
  persist();
}
const listCache = new Map();
function distinct(f) {
  if (listCache.has(f)) return listCache.get(f);
  const c = new Map(); for (const r of records) { const v = val(r, f); if (v) c.set(v, (c.get(v) || 0) + 1); }
  const out = [...c].sort((a, b) => b[1] - a[1]); listCache.set(f, out); setTimeout(() => listCache.delete(f), 15000); return out;
}
function fillDatalist(f, id = "dl-active") {
  $("#" + id).innerHTML = distinct(f).slice(0, 400).map(([v]) => `<option value="${esc(v)}">`).join("");
}

// ------------------------------------------------------------------ record form (right panel)
let miniMap = null;
function openForm(id) {
  currentId = id;
  const r = byId.get(id), form = $("#form");
  if (!r) { form.innerHTML = `<div class="form-empty">Select a row to edit the full record.</div>`; return; }
  const idx = view.indexOf(r);
  form.innerHTML = `
    <div class="form-head"><button class="btn ghost" data-nav="-1" title="Previous">‹</button><span>${idx >= 0 ? fmtN(idx + 1) + " / " + fmtN(view.length) : ""}</span><button class="btn ghost" data-nav="1" title="Next">›</button>
      <span class="rid">${esc(r._id)}${mode === "live" ? " · row " + r._row : ""}</span></div>
    <button class="form-img" data-open title="Open full viewer (Space)"><img alt=""></button>
    <div class="form-fields">${fields.filter((f) => !READONLY.has(f)).map((f) => `
      <label class="${isDirty(r, f) ? "dirty" : ""}"><span>${esc(f)}${isDirty(r, f) ? ` <button class="link revert" data-revert="${esc(f)}" title="Was: ${esc(original.get(r._id)?.[f] ?? "")}">revert</button>` : ""}</span>
      ${f === "Title" || f === "Subject" ? `<textarea rows="2" data-f="${esc(f)}">${esc(val(r, f))}</textarea>` : `<input data-f="${esc(f)}" value="${esc(val(r, f))}" ${CATEGORICAL.has(f) ? `list="dl-${slug(f)}"` : ""}>`}
      ${f === "Georeference" ? `<div class="mini-map" id="miniMap"></div><small class="muted">Click the map to set coordinates.</small>` : ""}
      </label>`).join("")}
    </div>
    ${[...CATEGORICAL].filter((f) => fields.includes(f)).map((f) => `<datalist id="dl-${slug(f)}"></datalist>`).join("")}`;
  const img = $(".form-img img", form); attachFallback(img, r); img.src = mediumUrl(r);
  form.querySelectorAll("datalist").forEach((dl) => { const f = [...CATEGORICAL].find((x) => "dl-" + slug(x) === dl.id); dl.dataset.f = f; });
  form.querySelectorAll("input[list]").forEach((inp) => inp.addEventListener("focus", () => { const id = inp.getAttribute("list"); const dl = $("#" + id); dl.innerHTML = distinct(dl.dataset.f).slice(0, 400).map(([v]) => `<option value="${esc(v)}">`).join(""); }, { once: true }));
  if (fields.includes("Georeference") && window.L) {
    if (miniMap) { miniMap.remove(); miniMap = null; }
    const g = val(r, "Georeference").match(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);
    const ll = g ? [+g[1], +g[2]] : [38.5, 23.5];
    miniMap = L.map("miniMap", { attributionControl: false }).setView(ll, g ? 11 : 5);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18 }).addTo(miniMap);
    let mk = g ? L.marker(ll).addTo(miniMap) : null;
    miniMap.on("click", (e) => {
      const v = `${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`;
      setValue(r, "Georeference", v); $('[data-f="Georeference"]', form).value = v;
      mk ? mk.setLatLng(e.latlng) : (mk = L.marker(e.latlng).addTo(miniMap));
      drawRows(); renderBar();
    });
  }
  drawRows();
}
const slug = (s) => s.replace(/\W+/g, "-").toLowerCase();

// ------------------------------------------------------------------ save / publish
async function save() {
  const changes = [];
  for (const [id, p] of pending) for (const [field, value] of Object.entries(p)) changes.push({ id, field, value });
  if (!changes.length) return;
  if (mode !== "live") {
    return modal(`<h3>Demo mode</h3><p>You’re looking at the published data, not the live Sheet, so changes can’t be saved yet. Connect the Sheet in ⚙ settings (see the setup guide), or download your ${fmtN(changes.length)} changes as a CSV.</p>
      <div class="modal-actions"><button class="btn" data-close>Close</button><button class="btn primary" id="dlCh">Download changes CSV</button></div>`, (b) => { $("#dlCh", b).onclick = exportChanges; });
  }
  const btn = $("#saveBtn"); btn.disabled = true; btn.textContent = "Saving…";
  try {
    let written = 0, missing = [];
    for (let k = 0; k < changes.length; k += 400) {
      const chunk = changes.slice(k, k + 400);
      const res = await api("update", { changes: chunk });
      written += res.written; missing = missing.concat(res.missing || []);
      for (const c of chunk) if (!missing.includes(c.id)) { const r = byId.get(c.id); if (r) r[c.field] = c.value; }
      btn.textContent = `Saving… ${Math.min(100, Math.round(((k + chunk.length) / changes.length) * 100))}%`;
    }
    for (const c of changes) if (!missing.includes(c.id)) { const p = pending.get(c.id); if (p) { delete p[c.field]; if (!Object.keys(p).length) { pending.delete(c.id); original.delete(c.id); } } }
    persist(); indexRecords(records, fields); computeDups();
    toast(`Saved ${fmtN(written)} change${written === 1 ? "" : "s"} to the Sheet.${missing.length ? ` ${missing.length} records weren’t found.` : ""} Click Publish when you want the public site updated.`, 6000);
  } catch (e) { toast("Save failed: " + e.message, 8000); }
  refresh(); if (currentId) openForm(currentId);
}
async function publish() {
  try { await api("publish"); toast("Publishing started — the public site updates in 2–3 minutes.", 6000); }
  catch (e) { toast("Publish failed: " + e.message, 8000); }
}
function exportChanges() {
  const rows = [["Record ID", "Sheet row", "Field", "Old value", "New value"]];
  for (const [id, p] of pending) for (const [f, v] of Object.entries(p)) rows.push([id, byId.get(id)?._row ?? "", f, original.get(id)?.[f] ?? "", v]);
  download("gregory-archive-changes.csv", rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n"));
}

// ------------------------------------------------------------------ modal + tools
function modal(html, init) {
  $("#modalBody").innerHTML = html; $("#modal").hidden = false;
  init && init($("#modalBody"));
  const first = $("#modalBody input, #modalBody select"); first && first.focus();
}
function closeModal() { $("#modal").hidden = true; $("#modalBody").innerHTML = ""; }
const fieldOptions = (sel) => fields.filter((f) => !READONLY.has(f)).map((f) => `<option ${f === sel ? "selected" : ""}>${esc(f)}</option>`).join("");
const targetSet = () => (selected.size ? records.filter((r) => selected.has(r._id)) : view);

const TOOLS = {
  bulk() {
    const set = targetSet();
    modal(`<h3>Bulk edit</h3><p class="muted">Applies to <b>${fmtN(set.length)}</b> ${selected.size ? "selected" : "filtered"} records. Changes stay pending until you Save.</p>
      <div class="frm"><label>Field <select id="bf">${fieldOptions(cols[active.c] || "Location")}</select></label>
      <label>New value <input id="bv" list="dl-bulk"></label><datalist id="dl-bulk"></datalist>
      <label class="check"><input type="checkbox" id="bblank"> Only fill empty cells</label></div>
      <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="bgo">Apply to ${fmtN(set.length)}</button></div>`, (b) => {
      const upd = () => fillDatalist($("#bf", b).value, "dl-bulk"); $("#bf", b).onchange = upd; upd();
      $("#bgo", b).onclick = () => {
        const f = $("#bf", b).value, v = $("#bv", b).value, blank = $("#bblank", b).checked; let n = 0;
        for (const r of set) if (!blank || !val(r, f)) { setValue(r, f, v); n++; }
        closeModal(); toast(`${fmtN(n)} cells changed (not saved yet).`); refresh(); if (currentId) openForm(currentId);
      };
    });
  },
  replace() {
    modal(`<h3>Find &amp; replace</h3><p class="muted">Searches the ${selected.size ? fmtN(selected.size) + " selected" : fmtN(view.length) + " filtered"} records.</p>
      <div class="frm"><label>In field <select id="rf"><option value="*">All fields</option>${fieldOptions(cols[active.c])}</select></label>
      <label>Find <input id="rfind"></label><label>Replace with <input id="rrep"></label>
      <label class="check"><input type="checkbox" id="rcase"> Match case</label><label class="check"><input type="checkbox" id="rwhole"> Whole cell only</label>
      <p class="muted" id="rprev">&nbsp;</p></div>
      <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="rgo" disabled>Replace</button></div>`, (b) => {
      const set = targetSet();
      const plan = () => {
        const f = $("#rf", b).value, find = $("#rfind", b).value, rep = $("#rrep", b).value;
        if (!find) return [];
        const fl = f === "*" ? fields.filter((x) => !READONLY.has(x)) : [f], cs = $("#rcase", b).checked, whole = $("#rwhole", b).checked;
        const re = new RegExp(whole ? `^${escRe(find)}$` : escRe(find), cs ? "g" : "gi"), out = [];
        for (const r of set) for (const x of fl) { const v = String(val(r, x)); if (re.test(v)) { re.lastIndex = 0; out.push([r, x, v.replace(re, rep)]); } re.lastIndex = 0; }
        return out;
      };
      const prev = () => { const p = plan(); $("#rprev", b).textContent = $("#rfind", b).value ? `${fmtN(p.length)} cells will change${p[0] ? ` — e.g. “${p[0][1]}”: ${val(p[0][0], p[0][1])} → ${p[0][2]}` : ""}` : " "; $("#rgo", b).disabled = !p.length; };
      b.querySelectorAll("input, select").forEach((el) => el.addEventListener("input", debounce(prev, 150)));
      $("#rgo", b).onclick = () => { const p = plan(); p.forEach(([r, f, v]) => setValue(r, f, v)); closeModal(); toast(`${fmtN(p.length)} cells changed (not saved yet).`); refresh(); };
    });
  },
  clean() {
    modal(`<h3>Clean up values</h3><p class="muted">Merge spelling variants so filters and charts group correctly. Similar values (same letters, ignoring case, spaces and punctuation) are suggested first.</p>
      <div class="frm row"><label>Field <select id="cf">${[...CATEGORICAL].filter((f) => fields.includes(f)).map((f) => `<option>${esc(f)}</option>`).join("")}</select></label>
      <label>Search values <input id="cq" placeholder="e.g. Frey"></label></div>
      <div class="clean-list" id="clist"></div>
      <div class="frm row"><label>Merge ticked values into <input id="cinto" list="dl-clean"></label><datalist id="dl-clean"></datalist></div>
      <div class="modal-actions"><button class="btn" data-close>Close</button><button class="btn primary" id="cgo" disabled>Merge</button></div>`, (b) => {
      const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, "");
      const draw = () => {
        const f = $("#cf", b).value, q = $("#cq", b).value.toLowerCase();
        listCache.delete(f); fillDatalist(f, "dl-clean");
        const vals = distinct(f), groups = new Map();
        for (const [v, n] of vals) { const k = norm(v); (groups.get(k) || groups.set(k, []).get(k)).push([v, n]); }
        const sugg = [...groups.values()].filter((g) => g.length > 1);
        const rest = vals.filter(([v]) => !q || v.toLowerCase().includes(q)).slice(0, 300);
        const item = ([v, n]) => `<label><input type="checkbox" value="${esc(v)}"><span>${esc(v) || "<i>(blank)</i>"}</span><b>${fmtN(n)}</b></label>`;
        $("#clist", b).innerHTML = (sugg.length && !q ? `<h5>Suggested groups (${sugg.length})</h5>${sugg.slice(0, 60).map((g) => `<div class="cgroup">${g.map(item).join("")}<button class="link" data-pick='${esc(JSON.stringify(g.map((x) => x[0])))}'>Merge this group →</button></div>`).join("")}` : "")
          + `<h5>${q ? "Matching values" : "All values"} (${fmtN(q ? rest.length : vals.length)})</h5>${rest.map(item).join("")}`;
      };
      const ticked = () => [...b.querySelectorAll("#clist input:checked")].map((i) => i.value);
      const upd = () => { const t = ticked(); $("#cgo", b).disabled = !t.length || !$("#cinto", b).value; $("#cgo", b).textContent = t.length ? `Merge ${t.length} values` : "Merge"; };
      $("#cf", b).onchange = draw; $("#cq", b).oninput = debounce(draw, 150);
      $("#clist", b).addEventListener("change", (e) => { if (!$("#cinto", b).value && e.target.checked) $("#cinto", b).value = e.target.value; upd(); });
      $("#cinto", b).oninput = upd;
      $("#clist", b).addEventListener("click", (e) => {
        const p = e.target.closest("[data-pick]"); if (!p) return;
        const vs = JSON.parse(p.dataset.pick); b.querySelectorAll("#clist input").forEach((i) => (i.checked = vs.includes(i.value)));
        $("#cinto", b).value = vs[0]; upd();
      });
      $("#cgo", b).onclick = () => {
        const f = $("#cf", b).value, into = $("#cinto", b).value, from = new Set(ticked()); let n = 0;
        for (const r of records) if (from.has(val(r, f)) && val(r, f) !== into) { setValue(r, f, into); n++; }
        toast(`${fmtN(n)} records changed to “${into}” (not saved yet).`); listCache.delete(f); draw(); upd(); refresh();
      };
      draw();
    });
  },
  columns() {
    modal(`<h3>Columns</h3><p class="muted">Choose which Sheet columns show in the grid. Every field is always editable in the side panel.</p>
      <div class="col-pick">${fields.map((f) => `<label class="check"><input type="checkbox" value="${esc(f)}" ${cols.includes(f) ? "checked" : ""}> ${esc(f)}</label>`).join("")}</div>
      <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="cok">Apply</button></div>`, (b) => {
      $("#cok", b).onclick = () => { cols = fields.filter((f) => b.querySelector(`input[value="${CSS.escape(f)}"]`).checked); LS.set("cols", cols); closeModal(); renderSheet(true); };
    });
  },
  exportChanges() { exportChanges(); },
  discard() {
    modal(`<h3>Discard changes?</h3><p>This throws away all unsaved edits in this browser.</p><div class="modal-actions"><button class="btn" data-close>Keep them</button><button class="btn primary" id="dok">Discard</button></div>`, (b) => {
      $("#dok", b).onclick = () => { pending.clear(); original.clear(); persist(); closeModal(); refresh(); if (currentId) openForm(currentId); };
    });
  },
};
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ------------------------------------------------------------------ add images (upload to S3 + new rows)
function addImages() {
  const live = mode === "live";
  modal(`<h3>Add images</h3>
    ${live ? "" : `<p class="warn">Demo mode: connect the Sheet in ⚙ settings to upload. You can still try the form.</p>`}
    <label class="drop" id="drop"><input type="file" id="files" accept="image/*" multiple hidden><b>Drop scans here</b> or click to choose files<br><small class="muted">Files go to the S3 bucket under their own names; one new record is created per image.</small></label>
    <div id="flist" class="flist"></div>
    <div class="frm grid2">${["Slide Box", "Location", "Subject", "Date Created", "Creator", "Digitizer 1", "Medium", "Format", "Class"].filter((f) => fields.includes(f)).map((f) => `<label>${esc(f)} <input data-nf="${esc(f)}" list="dl-n-${slug(f)}" value="${esc(f === "Slide Box" ? filter.box : f === "Medium" ? "Color Positive" : f === "Format" ? "35mm" : f === "Class" ? "Image" : "")}"><datalist id="dl-n-${slug(f)}"></datalist></label>`).join("")}</div>
    <p class="muted small">Titles default to the file name; edit them in the grid afterwards. Thumbnails are made in your browser during upload.</p>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="upGo" disabled>Upload &amp; create records</button></div>`, (b) => {
    let files = [];
    b.querySelectorAll("[data-nf]").forEach((i) => fillDatalist(i.dataset.nf, i.getAttribute("list")));
    const existing = new Set(records.map((r) => r["Digital File Name"]));
    const show = () => {
      $("#flist", b).innerHTML = files.map((f, k) => `<div class="fi" data-k="${k}"><span>${esc(f.name)}</span>${existing.has(f.name) ? `<em>name already in archive — will overwrite</em>` : ""}<small>${(f.size / 1048576).toFixed(1)} MB</small><i class="prog"></i></div>`).join("");
      $("#upGo", b).disabled = !files.length || !live; $("#upGo", b).textContent = files.length ? `Upload ${files.length} & create records` : "Upload & create records";
    };
    const take = (list) => { files = files.concat([...list].filter((f) => f.type.startsWith("image/"))); show(); };
    $("#files", b).onchange = (e) => take(e.target.files);
    const drop = $("#drop", b);
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); take(e.dataTransfer.files); };
    $("#upGo", b).onclick = async () => {
      const go = $("#upGo", b); go.disabled = true; go.textContent = "Uploading…";
      const shared = {}; b.querySelectorAll("[data-nf]").forEach((i) => { if (i.value) shared[i.dataset.nf] = i.value; });
      try {
        const safe = (n) => n.replace(/[^\w.\-]+/g, "_"), stemOf = (n) => safe(n).replace(/\.[^.]+$/, "");
        const names = files.flatMap((f) => [f.name, `thumbs/400/${stemOf(f.name)}.webp`, `thumbs/1600/${stemOf(f.name)}.webp`]);
        const { files: signed } = await api("presign", { files: names.map((name) => ({ name })) });
        const done = [];
        let noThumbs = 0;
        await pool(files.map((f, k) => async () => {
          const s = signed[k * 3], row = b.querySelector(`.fi[data-k="${k}"]`);
          await putWithProgress(s.put, f, (p) => (row.querySelector(".prog").style.width = p * 90 + "%"));
          // make the thumbnails here in the browser, so no server job has to download the scan again
          try {
            for (const [j, size, q] of [[1, 400, 0.76], [2, 1600, 0.82]]) {
              const blob = await resizeToWebp(f, size, q);
              if (!blob) { noThumbs++; break; }
              await putWithProgress(signed[k * 3 + j].put, blob, () => {}, "image/webp");
            }
          } catch { noThumbs++; }
          row.classList.add("ok");
          done.push({ ...shared, Title: f.name.replace(/\.[^.]+$/, ""), "Digital File Name": s.name, Image_URL: s.url });
        }), 4);
        go.textContent = "Creating records…";
        const res = await api("append", { records: done });
        toast(`${res.ids.length} images uploaded and added to the Sheet.${noThumbs ? " This browser couldn’t make WebP thumbnails; run the thumbnail script later." : ""}`, 6000);
        closeModal(); mode = "demo"; await load();
      } catch (e) { toast("Upload failed: " + e.message + ". Check the bucket CORS settings in the setup guide.", 9000); go.disabled = false; go.textContent = "Retry"; }
    };
  });
}
async function resizeToWebp(file, size, quality) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const k = Math.min(1, size / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
  const blob = await new Promise((r) => c.toBlob(r, "image/webp", quality));
  return blob && blob.type === "image/webp" ? blob : null; // some Safari versions can't encode WebP
}
function putWithProgress(url, file, onp, type) {
  return new Promise((ok, fail) => {
    const x = new XMLHttpRequest(); x.open("PUT", url); x.setRequestHeader("Content-Type", type || file.type || "image/jpeg");
    x.upload.onprogress = (e) => e.lengthComputable && onp(e.loaded / e.total);
    x.onload = () => (x.status < 300 ? ok() : fail(new Error(`S3 returned ${x.status}`)));
    x.onerror = () => fail(new Error("Network error / CORS blocked")); x.send(file);
  });
}
async function pool(tasks, n) { const q = tasks.slice(); await Promise.all(Array.from({ length: n }, async () => { while (q.length) await q.shift()(); })); }

function settingsModal() {
  modal(`<h3>Connect to the Google Sheet</h3>
    <p class="muted">Paste the Apps Script web-app URL and the editor key from the setup guide. They’re stored only in this browser.</p>
    <div class="frm"><label>Apps Script web-app URL <input id="su" value="${esc(settings.url)}" placeholder="https://script.google.com/macros/s/…/exec"></label>
    <label>Editor key <input id="sk" type="password" value="${esc(settings.key)}"></label>
    <label>Your name (for the edit log) <input id="sn" value="${esc(settings.name)}"></label></div>
    <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="sok">Connect</button></div>`, (b) => {
    $("#sok", b).onclick = async () => {
      Object.assign(settings, { url: $("#su", b).value.trim(), key: $("#sk", b).value, name: $("#sn", b).value.trim() });
      LS.set("settings", settings); closeModal(); mode = "demo"; await load();
    };
  });
}

let toastT;
function toast(msg, ms = 3500) { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }

// ------------------------------------------------------------------ events
const lb = new Lightbox({ fieldsFor: () => fields, onIndex: (r) => { if (byId.has(r._id)) { currentId = null; const i = view.indexOf(r); if (i >= 0) setActive(i, active.c); } } });
function bind() {
  $("#q").addEventListener("input", debounce((e) => { filter.q = e.target.value.trim(); refresh(false); }, 200));
  $("#boxSel").onchange = (e) => { filter.box = e.target.value; refresh(false); };
  $("#issues").onclick = (e) => { if (e.target.id === "fixShift") return repairShifted(); const b = e.target.closest("[data-issue]"); if (!b) return; filter.issue = filter.issue === b.dataset.issue ? "" : b.dataset.issue; refresh(false); };
  $("#clear").onclick = () => { filter = { q: "", box: "", issue: "" }; $("#q").value = ""; $("#boxSel").value = ""; refresh(false); };
  $("#chips").onclick = (e) => { const c = e.target.closest("[data-chip]"); if (!c) return; filter[c.dataset.chip] = ""; if (c.dataset.chip === "q") $("#q").value = ""; if (c.dataset.chip === "box") $("#boxSel").value = ""; refresh(false); };
  $("#selAll").onclick = () => { view.forEach((r) => selected.add(r._id)); drawRows(); renderBar(); };
  $("#selNone").onclick = () => { selected.clear(); drawRows(); renderBar(); };

  const sheet = $("#sheet");
  let raf = 0;
  sheet.addEventListener("scroll", () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (!editing) drawRows(); }); }, { passive: true });
  sheet.addEventListener("click", (e) => {
    if (e.target.id === "selPage") { const on = e.target.checked; view.forEach((r) => (on ? selected.add(r._id) : selected.delete(r._id))); drawRows(); renderBar(); return; }
    const row = e.target.closest(".sh-r"); if (!row) return;
    const i = +row.dataset.i;
    if (e.target.matches('input[type="checkbox"]')) { const id = view[i]._id; e.target.checked ? selected.add(id) : selected.delete(id); row.classList.toggle("sel", e.target.checked); renderBar(); return; }
    if (e.target.closest(".img")) { lb.open(view, i); return; }
    const c = e.target.closest(".sh-c[data-c]");
    if (c && !e.target.classList.contains("cell-input")) { if (editing) commitEdit(); setActive(i, +c.dataset.c, false); sheet.focus(); }
  });
  sheet.addEventListener("dblclick", (e) => { if (e.target.closest(".sh-c[data-c]")) startEdit(); });
  sheet.addEventListener("keydown", (e) => {
    if (editing || !view.length) return;
    const k = e.key;
    if (k === "ArrowDown") setActive(active.r + 1, active.c);
    else if (k === "ArrowUp") setActive(active.r - 1, active.c);
    else if (k === "ArrowRight" || (k === "Tab" && !e.shiftKey)) setActive(active.r, active.c + 1);
    else if (k === "ArrowLeft" || (k === "Tab" && e.shiftKey)) setActive(active.r, active.c - 1);
    else if (k === "PageDown") setActive(active.r + 15, active.c);
    else if (k === "PageUp") setActive(active.r - 15, active.c);
    else if (k === "Enter" || k === "F2") startEdit();
    else if (k === " ") lb.open(view, active.r);
    else if (k === "Backspace" || k === "Delete") { setValue(view[active.r], cols[active.c], ""); drawRows(); renderBar(); openForm(view[active.r]._id); }
    else if (k.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) { startEdit(k); }
    else return;
    e.preventDefault();
  });
  document.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); if (editing) commitEdit(); save(); } });

  const form = $("#form");
  form.addEventListener("change", (e) => {
    const el = e.target.closest("[data-f]"); if (!el) return;
    const r = byId.get(currentId); setValue(r, el.dataset.f, el.value);
    el.closest("label").classList.toggle("dirty", isDirty(r, el.dataset.f)); drawRows(); renderBar();
  });
  form.addEventListener("click", (e) => {
    const n = e.target.closest("[data-nav]"); if (n) { setActive(active.r + +n.dataset.nav, active.c); return; }
    if (e.target.closest("[data-open]")) { const i = view.findIndex((r) => r._id === currentId); lb.open(i >= 0 ? view : [byId.get(currentId)], Math.max(0, i)); return; }
    const rv = e.target.closest("[data-revert]"); if (rv) { e.preventDefault(); const r = byId.get(currentId), f = rv.dataset.revert; setValue(r, f, original.get(r._id)?.[f] ?? r[f]); openForm(currentId); renderBar(); }
  });

  $("#saveBtn").onclick = save;
  $("#publishBtn").onclick = publish;
  $("#settingsBtn").onclick = settingsModal;
  $("#addBtn").onclick = addImages;
  $("#toolsBtn").onclick = (e) => { e.stopPropagation(); $("#toolsMenu").hidden = !$("#toolsMenu").hidden; };
  document.addEventListener("click", () => ($("#toolsMenu").hidden = true));
  $("#toolsMenu").onclick = (e) => { const t = e.target.closest("[data-tool]"); if (t) TOOLS[t.dataset.tool](); };
  $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal" || e.target.closest("[data-close]")) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#modal").hidden) closeModal(); });
  addEventListener("beforeunload", (e) => { if (pending.size && mode === "live") { e.preventDefault(); e.returnValue = ""; } });
  new ResizeObserver(() => drawRows()).observe(sheet);
}

bind();
load().catch((e) => { $("#count").textContent = "Couldn’t load: " + e.message; });
