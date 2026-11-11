// Fullscreen single-image viewer: next/prev, rotate, zoom + pan, all metadata,
// download, keyboard, filmstrip, shareable link. Ported from the Airtable extension.
import { CFG, fullUrl, mediumUrl, thumbUrl, attachFallback, esc, fmtN, uri } from "./data.js";

const ICON = {
  prev: '<path d="M15 18l-6-6 6-6"/>', next: '<path d="M9 18l6-6-6-6"/>',
  rotL: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  rotR: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  zin: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/>',
  zout: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>',
  dl: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  fs: '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>',
};
const svg = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON[k]}</svg>`;

export class Lightbox {
  constructor({ onFilter, onClose, onIndex, onEdit, fieldsFor } = {}) {
    this.onFilter = onFilter; this.onClose = onClose; this.onIndex = onIndex; this.onEdit = onEdit;
    this.fieldsFor = fieldsFor || ((r) => Object.keys(r).filter((k) => !k.startsWith("_")));
    this.list = []; this.i = 0; this.rot = 0; this.zoom = 1; this.tx = 0; this.ty = 0;
    this.showInfo = matchMedia("(min-width: 800px)").matches;
    this.allFields = true;
    this.build();
  }

  build() {
    const el = (this.el = document.createElement("div"));
    el.className = "lb"; el.hidden = true; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true");
    el.innerHTML = `
      <header class="lb-head">
        <div class="lb-title"><span class="lb-pos"></span><h2></h2></div>
        <div class="lb-tools">
          <button data-a="rotL" title="Rotate left (Shift+R)">${svg("rotL")}</button>
          <button data-a="rotR" title="Rotate right (R)">${svg("rotR")}</button>
          <button data-a="zout" title="Zoom out (−)">${svg("zout")}</button>
          <span class="lb-zoom">100%</span>
          <button data-a="zin" title="Zoom in (+)">${svg("zin")}</button>
          <button data-a="fit" title="Fit (0)">${svg("fit")}</button>
          <span class="sep"></span>
          <button data-a="info" title="Information (I)">${svg("info")}</button>
          <button data-a="edit" title="Edit record (E)" hidden>${svg("edit")}</button>
          <a data-a="dl" title="Download original" target="_blank" rel="noopener">${svg("dl")}</a>
          <button data-a="link" title="Copy permanent link">${svg("link")}</button>
          <button data-a="fs" title="Fullscreen (F)">${svg("fs")}</button>
          <button data-a="close" title="Close (Esc)">${svg("close")}</button>
        </div>
      </header>
      <div class="lb-body">
        <aside class="lb-info"><div class="lb-info-tabs"><button data-t="key">Key fields</button><button data-t="all">All fields</button></div><dl></dl></aside>
        <div class="lb-stage">
          <img class="lb-img" alt="" draggable="false">
          <div class="lb-spin"></div>
          <button class="lb-nav prev" data-a="prev" title="Previous (←)">${svg("prev")}</button>
          <button class="lb-nav next" data-a="next" title="Next (→)">${svg("next")}</button>
          <div class="lb-res"></div>
        </div>
      </div>
      <footer class="lb-strip"></footer>
      <div class="lb-toast" hidden></div>`;
    document.body.appendChild(el);
    this.img = el.querySelector(".lb-img");
    this.stage = el.querySelector(".lb-stage");
    if (this.onEdit) el.querySelector('[data-a="edit"]').hidden = false;

    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-a]");
      if (b) { if (b.dataset.a !== "dl") e.preventDefault(); this.act(b.dataset.a); return; }
      const t = e.target.closest("[data-t]");
      if (t) { this.allFields = t.dataset.t === "all"; this.renderInfo(); return; }
      const f = e.target.closest("[data-ff]");
      if (f && this.onFilter) { this.onFilter(f.dataset.ff, f.dataset.fv); this.close(); return; }
      const s = e.target.closest("[data-si]");
      if (s) this.go(+s.dataset.si);
    });
    this.keyHandler = (e) => this.key(e);
    addEventListener("resize", () => { if (!this.el.hidden) this.apply(); });

    // pan + wheel zoom
    let drag = null;
    this.stage.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      drag = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty, moved: false };
      this.stage.setPointerCapture(e.pointerId);
    });
    this.stage.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (this.zoom !== 1) { this.tx = drag.tx + dx; this.ty = drag.ty + dy; this.apply(); }
    });
    this.stage.addEventListener("pointerup", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (this.zoom === 1 && drag.moved && Math.abs(dx) > 60) this.go(this.i + (dx < 0 ? 1 : -1)); // swipe
      drag = null;
    });
    this.stage.addEventListener("dblclick", (e) => { this.zoom !== 1 ? this.fit() : this.setZoom(2.5, e); });
    this.stage.addEventListener("wheel", (e) => { e.preventDefault(); this.setZoom(this.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e); }, { passive: false });
  }

  open(list, index) {
    this.list = list; this.el.hidden = false; document.body.classList.add("lb-open");
    document.addEventListener("keydown", this.keyHandler);
    this.el.classList.toggle("noinfo", !this.showInfo);
    this.go(index, true);
  }
  close() {
    if (this.el.hidden) return;
    this.el.hidden = true; document.body.classList.remove("lb-open");
    document.removeEventListener("keydown", this.keyHandler);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.onClose && this.onClose();
  }
  get rec() { return this.list[this.i]; }

  go(i, first) {
    if (!this.list.length) return;
    i = (i + this.list.length) % this.list.length;
    this.i = i; this.rot = 0; this.fit(true);
    const r = this.rec;
    this.el.querySelector(".lb-pos").textContent = `${fmtN(i + 1)} / ${fmtN(this.list.length)}`;
    this.el.querySelector("h2").textContent = r.Title || r["Digital File Name"] || "Untitled";
    this.el.querySelector('[data-a="dl"]').href = fullUrl(r);
    this.loadImage(r);
    this.renderInfo(); this.renderStrip();
    this.prefetch();
    this.onIndex && this.onIndex(r, i);
  }

  loadImage(r) {
    const img = this.img, med = mediumUrl(r), full = fullUrl(r);
    this.el.classList.add("loading");
    img.onload = () => { this.el.classList.remove("loading"); this.apply(); };
    attachFallback(img, r);
    img.src = med; this.res = med === full ? "full" : "medium";
    this.el.querySelector(".lb-res").textContent = this.res === "full" ? "" : "Preview · zoom in for full resolution";
  }
  upgrade() {
    // switch to the original scan when zooming past fit
    if (this.res === "full") return;
    const r = this.rec, full = fullUrl(r), pre = new Image();
    this.res = "full";
    this.el.querySelector(".lb-res").textContent = "Loading full resolution…";
    pre.onload = () => { if (this.rec === r) { this.img.src = full; this.el.querySelector(".lb-res").textContent = ""; } };
    pre.src = full;
  }
  prefetch() {
    for (const d of [1, -1, 2]) {
      const r = this.list[(this.i + d + this.list.length) % this.list.length];
      if (r) new Image().src = mediumUrl(r);
    }
  }

  renderInfo() {
    const r = this.rec; if (!r) return;
    this.el.querySelectorAll("[data-t]").forEach((b) => b.classList.toggle("on", (b.dataset.t === "all") === this.allFields));
    const fields = this.allFields ? this.fieldsFor(r) : CFG.keyFields;
    const filterable = new Set([...CFG.facetFields, "Location", "Subject", "Slide Box"]);
    const rows = fields.filter((f) => r[f] != null && String(r[f]).trim() !== "").map((f) => {
      const v = esc(r[f]);
      const val = filterable.has(f) && this.onFilter ? `<a href="#" data-ff="${esc(f)}" data-fv="${v}" title="Show all with this ${esc(f)}">${v}</a>` : /^https?:\/\//.test(r[f]) ? `<a href="${v}" target="_blank" rel="noopener">${v}</a>` : v;
      return `<dt>${esc(f)}</dt><dd>${val}</dd>`;
    });
    if (r._id && !String(r._id).startsWith("r")) rows.unshift(`<dt>ID</dt><dd>${esc(r._id)}</dd>`, `<dt>Permanent link</dt><dd><a href="${esc(uri(r))}" target="_blank" rel="noopener">${esc(uri(r))}</a></dd>`);
    if (r._lat != null) rows.push(`<dt>Map</dt><dd><a href="https://www.openstreetmap.org/?mlat=${r._lat}&mlon=${r._lng}#map=14/${r._lat}/${r._lng}" target="_blank" rel="noopener">Open in OpenStreetMap</a></dd>`);
    this.el.querySelector(".lb-info dl").innerHTML = rows.join("") || "<dd class='muted'>No metadata for this record.</dd>";
  }

  renderStrip() {
    const n = this.list.length, out = [];
    for (let d = -7; d <= 7; d++) {
      if (n < 15 && (d < -Math.floor((n - 1) / 2) || d > Math.ceil((n - 1) / 2))) continue;
      const j = (this.i + d + n) % n, r = this.list[j];
      out.push(`<button data-si="${j}" class="${d === 0 ? "on" : ""}"><img loading="lazy" src="${esc(thumbUrl(r))}" alt=""></button>`);
    }
    const strip = this.el.querySelector(".lb-strip");
    strip.innerHTML = out.join("");
    strip.querySelectorAll("img").forEach((im, k) => attachFallback(im, this.list[+strip.children[k].dataset.si]));
  }

  apply() {
    // when turned sideways, shrink so the whole rotated image still fits the stage
    let fit = 1;
    if (Math.abs(this.rot) % 180 === 90 && this.img.naturalWidth) {
      const W = this.img.clientWidth, H = this.img.clientHeight, nw = this.img.naturalWidth, nh = this.img.naturalHeight;
      const k = Math.min(W / nw, H / nh), dw = nw * k, dh = nh * k;
      fit = Math.min(W / dh, H / dw, 1);
    }
    this.img.style.transform = `translate(${this.tx}px, ${this.ty}px) rotate(${this.rot}deg) scale(${this.zoom * fit})`;
    this.el.querySelector(".lb-zoom").textContent = `${Math.round(this.zoom * 100)}%`;
    this.stage.classList.toggle("zoomed", this.zoom !== 1);
  }
  fit(silent) { this.zoom = 1; this.tx = 0; this.ty = 0; this.apply(); }
  setZoom(z, e) {
    z = Math.max(0.2, Math.min(8, z));
    if (Math.abs(z - 1) < 0.04) z = 1;
    if (e && e.clientX != null) {
      const b = this.stage.getBoundingClientRect();
      const cx = e.clientX - b.left - b.width / 2, cy = e.clientY - b.top - b.height / 2;
      this.tx = cx - (cx - this.tx) * (z / this.zoom); this.ty = cy - (cy - this.ty) * (z / this.zoom);
    } else { this.tx *= z / this.zoom; this.ty *= z / this.zoom; }
    this.zoom = z; if (z === 1) { this.tx = this.ty = 0; }
    if (z > 1.2) this.upgrade();
    this.apply();
  }

  async act(a) {
    switch (a) {
      case "prev": return this.go(this.i - 1);
      case "next": return this.go(this.i + 1);
      case "rotL": this.rot -= 90; return this.apply();
      case "rotR": this.rot += 90; return this.apply();
      case "zin": return this.setZoom(this.zoom * 1.5);
      case "zout": return this.setZoom(this.zoom / 1.5);
      case "fit": return this.fit();
      case "info": this.showInfo = !this.showInfo; this.el.classList.toggle("noinfo", !this.showInfo); return;
      case "edit": return this.onEdit && this.onEdit(this.rec);
      case "close": return this.close();
      case "fs":
        try { document.fullscreenElement ? await document.exitFullscreen() : await this.el.requestFullscreen(); } catch {}
        return;
      case "link":
        try { await navigator.clipboard.writeText(uri(this.rec)); this.toast("Permanent link copied"); }
        catch { this.toast(uri(this.rec)); }
    }
  }
  toast(msg) {
    const t = this.el.querySelector(".lb-toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(this._tt); this._tt = setTimeout(() => (t.hidden = true), 2200);
  }
  key(e) {
    if (e.target.closest("input, textarea, select")) return;
    const k = e.key;
    if (k === "ArrowRight" || k === "j") this.act("next");
    else if (k === "ArrowLeft" || k === "k") this.act("prev");
    else if (k === "Escape") { if (!document.fullscreenElement) this.close(); }
    else if (k === "r") this.act("rotR");
    else if (k === "R") this.act("rotL");
    else if (k === "+" || k === "=") this.act("zin");
    else if (k === "-" || k === "_") this.act("zout");
    else if (k === "0") this.act("fit");
    else if (k === "i") this.act("info");
    else if (k === "f") this.act("fs");
    else if (k === "e" && this.onEdit) this.act("edit");
    else return;
    e.preventDefault();
  }
}
