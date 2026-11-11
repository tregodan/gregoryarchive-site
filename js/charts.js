// Chart engine: aggregation + dependency-free SVG rendering with inline styles
// (so exported SVG/PNG look identical to the page). Every mark carries data-sel so a
// click can show the images behind it.
import { esc, fmtN, fmtYear, centuryLabel, centuryOf } from "./data.js";

export const ACCENT = "#9a4f24";
// Validated categorical palette (dataviz reference): fixed order, never cycled; 8th+ series fold into "Other".
export const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
export const OTHER = "#a39d94";
const INK = "#1f1b16", INK2 = "#5b5249", MUTED = "#8b8178", GRID = "#e9e3d9", AXIS = "#cfc6b8", SURFACE = "#fffdf9";
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif";

export const CHART_TYPES = [
  ["column", "Columns", '<path d="M5 20V11M10 20V5M15 20V9M20 20V14"/>'],
  ["bar", "Bars", '<path d="M4 5h9M4 10h15M4 15h7M4 20h12"/>'],
  ["stacked", "Stacked", '<path d="M6 20v-6M12 20v-9M18 20v-4"/><path d="M6 13V9M12 10V4M18 15v-4" stroke-opacity=".45"/>'],
  ["grouped", "Grouped", '<path d="M4 20v-8M7 20V7M13 20v-5M16 20V9"/>'],
  ["line", "Line", '<path d="M3 17l5-6 4 3 4-7 5 4"/>'],
  ["area", "Area", '<path d="M3 20V15l5-5 4 3 4-6 5 4v9z" fill="currentColor" fill-opacity=".25"/>'],
  ["pie", "Pie", '<path d="M12 3v9h9A9 9 0 1 1 12 3z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>'],
  ["donut", "Donut", '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/>'],
  ["scatter", "Scatter", '<circle cx="6" cy="16" r="1.6"/><circle cx="10" cy="10" r="1.6"/><circle cx="15" cy="13" r="1.6"/><circle cx="18" cy="6" r="1.6"/><circle cx="8" cy="19" r="1.6"/>'],
];

// numeric fields for scatter axes, binned x axes and averages
export const NUMERIC = {
  "Subject date (year)": (r) => (r._sy == null ? null : Math.round((r._sy + r._ey) / 2)),
  "Year photographed": (r) => r._cy ?? null,
  "Latitude": (r) => r._lat ?? null,
  "Longitude": (r) => r._lng ?? null,
};
export const BINS = {
  "Subject date (year)": [[100, "Century"], [50, "50 years"], [25, "25 years"], [10, "Decade"]],
  "Year photographed": [[1, "Year"], [5, "5 years"], [10, "Decade"]],
  "Latitude": [[1, "1°"], [0.5, "0.5°"], [0.1, "0.1°"]],
  "Longitude": [[1, "1°"], [0.5, "0.5°"], [0.1, "0.1°"]],
};
const isYear = (f) => f === "Subject date (year)" || f === "Year photographed";
export function binKey(field, v, bin) {
  if (field === "Subject date (year)" && bin === 100) { const c = centuryOf(v); return c > 0 ? (c - 1) * 100 : c * 100; }
  return +(Math.floor(v / bin) * bin).toFixed(6);
}
function binLabel(field, k, bin) {
  if (field === "Subject date (year)" && bin === 100) return centuryLabel(k >= 0 ? k / 100 + 1 : k / 100);
  if (isYear(field)) return bin === 1 ? fmtYear(k) : `${fmtYear(k)}–${fmtYear(k + bin - 1)}`;
  return `${+k.toFixed(2)}°`;
}

// ---------------------------------------------------------------- aggregation
export function aggregate(records, spec, getValue, sortKeyFor) {
  if (spec.type === "scatter") return aggregateScatter(records, spec, getValue);
  const numX = NUMERIC[spec.x], bin = +spec.bin || (BINS[spec.x] ? BINS[spec.x][0][0] : 1);
  const pie = spec.type === "pie" || spec.type === "donut";
  const useSeries = !!spec.series && !pie;
  const cells = new Map(), sTotals = new Map(), xLabels = new Map();
  for (const r of records) {
    let xk;
    if (numX) { const v = numX(r); if (v == null) continue; xk = binKey(spec.x, v, bin); if (!xLabels.has(xk)) xLabels.set(xk, binLabel(spec.x, xk, bin)); }
    else { xk = getValue(r, spec.x) || "(blank)"; if (xk === "(blank)" && !spec.blanks) continue; }
    const sk = useSeries ? getValue(r, spec.series) || "(blank)" : "Images";
    if (sk === "(blank)" && !spec.blanks) continue;
    let m = cells.get(xk); if (!m) cells.set(xk, (m = new Map()));
    let a = m.get(sk); if (!a) m.set(sk, (a = []));
    a.push(r); sTotals.set(sk, (sTotals.get(sk) || 0) + 1);
  }
  let sKeys = [...sTotals.keys()].sort((a, b) => sTotals.get(b) - sTotals.get(a));
  let otherS = false;
  if (sKeys.length > 8) { otherS = true; sKeys = sKeys.slice(0, 7); }
  const sIndex = new Map(sKeys.map((k, i) => [k, i]));
  const series = sKeys.map((k, i) => ({ name: k, color: useSeries ? PALETTE[i] : ACCENT }));
  if (otherS) series.push({ name: "Other", color: OTHER, other: true });
  const sOf = (sk) => (sIndex.has(sk) ? sIndex.get(sk) : series.length - 1);

  let xKeys = [...cells.keys()];
  const total = (xk) => { let n = 0; for (const a of cells.get(xk).values()) n += a.length; return n; };
  if (numX) {
    xKeys.sort((a, b) => a - b);
    if (!pie && xKeys.length > 1 && (xKeys[xKeys.length - 1] - xKeys[0]) / bin < 400) {
      const full = [];
      for (let k = xKeys[0]; k <= xKeys[xKeys.length - 1] + 1e-9; k = +(k + bin).toFixed(6)) {
        const kk = +k.toFixed(6); // keys are multiples of the bin (centuries: -100 = 1st c. BC, 0 = 1st c. AD)
        if (!full.includes(kk)) { full.push(kk); if (!xLabels.has(kk)) xLabels.set(kk, binLabel(spec.x, kk, bin)); }
      }
      xKeys = full;
    }
  } else {
    const sk = sortKeyFor && sortKeyFor(spec.x);
    if (spec.sort === "label") xKeys.sort(sk ? (a, b) => sk(a) - sk(b) || a.localeCompare(b) : (a, b) => a.localeCompare(b));
    else xKeys.sort((a, b) => total(b) - total(a));
  }
  const limit = pie ? Math.min(spec.top || 7, 7) : +spec.top || 0;
  let otherX = null;
  if (!numX && limit && xKeys.length > limit) {
    const rest = xKeys.slice(limit); xKeys = xKeys.slice(0, limit);
    otherX = new Map();
    for (const xk of rest) for (const [sk, a] of cells.get(xk)) { const o = otherX.get(sk); otherX.set(sk, o ? o.concat(a) : a.slice()); }
    otherX.restCount = rest.length;
    if (!pie && !spec.other) otherX = null; // bars/columns: leftover groups hidden unless asked for
  }
  // keep the chart's own selected category visible even when it falls outside the top N
  if (!numX && spec.keep != null && cells.has(spec.keep) && !xKeys.includes(spec.keep)) xKeys.push(spec.keep);
  const cats = xKeys.map((k) => ({ key: k, label: numX ? xLabels.get(k) : String(k) }));
  if (otherX) cats.push({ key: "__other", label: `Other (${fmtN(otherX.restCount)} more)`, other: true });

  const metric = makeMetric(spec, getValue), val = [], recs = [];
  cats.forEach((c, ci) => {
    val[ci] = series.map(() => 0); recs[ci] = series.map(() => []);
    const m = c.key === "__other" ? otherX : cells.get(c.key);
    if (m) for (const [sk, a] of m) { const si = sOf(sk); recs[ci][si] = recs[ci][si].length ? recs[ci][si].concat(a) : a; }
    series.forEach((_, si) => (val[ci][si] = metric(recs[ci][si])));
  });
  return { kind: pie ? "pie" : "cartesian", cats, series, val, recs, numericX: !!numX, metricLabel: metricLabel(spec) };
}
function makeMetric(spec, getValue) {
  const y = spec.y || "count";
  if (y === "count") return (a) => a.length;
  if (y === "distinct") return (a) => new Set(a.map((r) => getValue(r, spec.yField)).filter(Boolean)).size;
  const fn = NUMERIC[spec.yField] || (() => null);
  return (a) => {
    const v = a.map(fn).filter((x) => x != null);
    if (!v.length) return 0;
    if (y === "sum") return v.reduce((s, x) => s + x, 0);
    if (y === "min") return Math.min(...v);
    if (y === "max") return Math.max(...v);
    return Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 10) / 10;
  };
}
export function metricLabel(spec) {
  const y = spec.y || "count";
  if (y === "count") return "Images";
  if (y === "distinct") return `Distinct ${spec.yField}`;
  return `${{ avg: "Average", min: "Minimum", max: "Maximum", sum: "Sum of" }[y]} ${spec.yField}`;
}
function aggregateScatter(records, spec, getValue) {
  const xl = NUMERIC[spec.x] ? spec.x : "Year photographed", yl = NUMERIC[spec.yField] ? spec.yField : "Subject date (year)";
  const fx = NUMERIC[xl], fy = NUMERIC[yl];
  let pts = [];
  const counts = new Map();
  for (const r of records) {
    const x = fx(r), y = fy(r); if (x == null || y == null) continue;
    const s = spec.series ? getValue(r, spec.series) || "(blank)" : "Images";
    if (s === "(blank)" && !spec.blanks) continue;
    pts.push({ x, y, s, r }); counts.set(s, (counts.get(s) || 0) + 1);
  }
  // only three colours stay distinguishable between every pair of points; the rest fold into Other
  const keys = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
  const top = spec.series ? keys.slice(0, 3) : keys;
  const series = top.map((k, i) => ({ name: k, color: spec.series ? PALETTE[i] : ACCENT }));
  if (spec.series && keys.length > 3) series.push({ name: "Other", color: OTHER, other: true });
  const idx = new Map(top.map((k, i) => [k, i]));
  pts.forEach((p) => (p.si = idx.has(p.s) ? idx.get(p.s) : series.length - 1));
  const totalPts = pts.length;
  if (pts.length > 6000) { const step = pts.length / 6000; pts = Array.from({ length: 6000 }, (_, i) => pts[Math.floor(i * step)]); }
  return { kind: "scatter", pts, series, totalPts, xLabel: xl, yLabel: yl, metricLabel: "Images" };
}

// ---------------------------------------------------------------- helpers
function nice(max) {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max)), n = max / p;
  return [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => n <= s + 1e-9) * p;
}
function ticks(min, max, n = 5) {
  const span = max - min || 1, step0 = span / n, p = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= step0) || p * 10;
  const out = []; for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}
const fmtV = (v) => (Math.abs(v) >= 1000 ? fmtN(Math.round(v)) : String(+(+v).toFixed(1)));
const T = (x, y, s, o = {}) => `<text x="${(+x).toFixed(1)}" y="${(+y).toFixed(1)}" font-size="${o.size || 11}" fill="${o.fill || MUTED}"${o.anchor ? ` text-anchor="${o.anchor}"` : ""}${o.weight ? ` font-weight="${o.weight}"` : ""}${o.rot ? ` transform="rotate(${o.rot} ${(+x).toFixed(1)} ${(+y).toFixed(1)})"` : ""} pointer-events="none">${esc(s)}</text>`;
const trunc = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s);
function legend(series, width) {
  if (series.length < 2) return { svg: "", h: 0 };
  let x = 0, y = 14, out = "";
  for (const s of series) {
    const w = 34 + Math.min(26, s.name.length) * 6.6;
    if (x + w > width && x > 0) { x = 0; y += 20; }
    out += `<rect x="${x}" y="${y - 9}" width="10" height="10" rx="2" fill="${s.color}"/>` + T(x + 15, y, trunc(s.name, 26), { fill: INK2, size: 12 });
    x += w;
  }
  return { svg: out, h: y + 14 };
}
const wrap = (w, h, body, title) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="font-family:${FONT};background:${SURFACE};display:block;max-width:100%;height:auto" role="img" aria-label="${esc(title || "Chart")}">${body}</svg>`;

// ---------------------------------------------------------------- render
export function render(m, spec, width) {
  const W = Math.max(340, Math.round(width));
  if (m.kind === "pie") return renderPie(m, spec, W);
  if (m.kind === "scatter") return renderScatter(m, spec, W);
  if (!m.cats.length) return "";
  return spec.type === "bar" ? renderBars(m, spec, W) : renderColumns(m, spec, W);
}

function renderColumns(m, spec, W) {
  const stacked = spec.type === "stacked" || spec.type === "area";
  const lines = spec.type === "line" || spec.type === "area";
  const n = m.cats.length, S = m.series.length;
  const tot = m.val.map((row) => (stacked ? row.reduce((a, b) => a + b, 0) : Math.max(...row)));
  const ymax = nice(Math.max(...tot, 0)), yt = ticks(0, ymax, 4);
  const L = 30 + Math.max(...yt.map((v) => fmtV(v).length)) * 7, R = 12;
  const lg = legend(m.series, W - L - R), top = 12 + lg.h;
  const plotW = W - L - R, bw = plotW / n;
  const rotate = n > plotW / 70;
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / (rotate ? 16 : 70)))));
  const maxLab = Math.min(22, Math.max(...m.cats.map((c) => c.label.length)));
  const B = rotate ? 20 + maxLab * 5 : 34, plotH = 260, H = top + plotH + B;
  const y = (v) => top + plotH * (1 - v / ymax);
  let s = lg.svg ? `<g transform="translate(${L},0)">${lg.svg}</g>` : "";
  for (const v of yt) s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${GRID}"/>` + T(L - 8, y(v) + 4, fmtV(v), { anchor: "end" });
  s += T(12, top + plotH / 2, m.metricLabel, { rot: -90, anchor: "middle", fill: INK2 });
  if (lines) {
    const cum = m.cats.map(() => 0);
    const paths = m.series.map((ser) => ({ ser, pts: [] }));
    m.series.forEach((ser, si) => m.cats.forEach((c, ci) => {
      const base = stacked ? cum[ci] : 0, v = base + m.val[ci][si];
      paths[si].pts.push([L + bw * ci + bw / 2, y(v), y(base)]);
      if (stacked) cum[ci] = v;
    }));
    for (const { ser, pts } of paths.slice().reverse()) {
      const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
      if (spec.type === "area") s += `<path d="${d}${pts.slice().reverse().map((p) => `L${p[0].toFixed(1)},${p[2].toFixed(1)}`).join("")}Z" fill="${ser.color}" fill-opacity="0.8" stroke="${SURFACE}" stroke-width="1"/>`;
      else s += `<path d="${d}" fill="none" stroke="${ser.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }
    if (spec.type === "line" && n <= 80) paths.forEach(({ ser, pts }) => pts.forEach((p) => (s += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${n > 40 ? 2.5 : 4}" fill="${ser.color}" stroke="${SURFACE}" stroke-width="1.5" pointer-events="none"/>`)));
    m.cats.forEach((c, ci) => {
      const tip = `${c.label} — ` + m.series.map((ser, si) => `${S > 1 ? ser.name + ": " : ""}${fmtV(m.val[ci][si])}`).join(", ");
      s += `<rect data-sel="${ci}:*" data-tip="${esc(tip)}" x="${(L + bw * ci).toFixed(1)}" y="${top}" width="${bw.toFixed(1)}" height="${plotH}" fill="transparent" class="hit"/>`;
    });
  } else {
    const gw = Math.max(1, bw * (n > 60 ? 0.92 : 0.72));
    m.cats.forEach((c, ci) => {
      const x0 = L + bw * ci + (bw - gw) / 2;
      let base = 0;
      const lastSi = m.val[ci].reduce((acc, v, i) => (v ? i : acc), -1);
      m.series.forEach((ser, si) => {
        const v = m.val[ci][si]; if (!v) return;
        let x, w, yTop, yBot;
        if (stacked || S === 1) { x = x0; w = gw; yTop = y(base + v); yBot = y(base); base += v; }
        else { w = gw / S; x = x0 + w * si; yTop = y(v); yBot = y(0); }
        const gap = stacked && si !== lastSi ? 2 : 0; // 2px surface gap between stacked segments
        const isTop = !stacked || si === lastSi;
        const ww = w > 4 ? w - 1 : w;
        const d = barPath(x, yTop + gap, ww, Math.max(1, yBot - yTop - gap), isTop ? Math.min(4, ww / 2) : 0);
        if (d) s += `<path data-sel="${ci}:${si}" data-tip="${esc(`${c.label}${S > 1 ? " · " + ser.name : ""}: ${fmtV(v)}`)}" d="${d}" fill="${ser.color}" class="mark"/>`;
      });
    });
  }
  s += `<line x1="${L}" x2="${W - R}" y1="${top + plotH}" y2="${top + plotH}" stroke="${AXIS}"/>`;
  m.cats.forEach((c, ci) => {
    if (ci % every) return;
    const x = L + bw * ci + bw / 2;
    s += rotate ? T(x + 3, top + plotH + 12, trunc(c.label, 22), { anchor: "end", rot: -45 }) : T(x, top + plotH + 18, trunc(c.label, Math.max(4, Math.floor((bw * every) / 6.5))), { anchor: "middle" });
  });
  return wrap(W, H, s, spec.title);
}
function barPath(x, y, w, h, r) {
  if (h <= 0.2) return "";
  r = Math.max(0, Math.min(r, h));
  const f = (v) => v.toFixed(1);
  return `M${f(x)},${f(y + h)}V${f(y + r)}Q${f(x)},${f(y)} ${f(x + r)},${f(y)}H${f(x + w - r)}Q${f(x + w)},${f(y)} ${f(x + w)},${f(y + r)}V${f(y + h)}Z`;
}

function renderBars(m, spec, W) {
  const S = m.series.length;
  const ROW = 28, LBL = Math.min(250, Math.max(90, Math.max(...m.cats.map((c) => Math.min(34, c.label.length))) * 6.6 + 16));
  const lg = legend(m.series, W - LBL), top = 26 + lg.h;
  const tot = m.val.map((row) => row.reduce((a, b) => a + b, 0));
  const max = nice(Math.max(...tot, 0)), R = 64, plotW = W - LBL - R;
  const x = (v) => LBL + (v / max) * plotW, H = top + m.cats.length * ROW + 8;
  let s = lg.svg ? `<g transform="translate(${LBL},0)">${lg.svg}</g>` : "";
  for (const t of ticks(0, max, 4)) s += `<line x1="${x(t)}" x2="${x(t)}" y1="${top - 6}" y2="${H - 6}" stroke="${GRID}"/>` + T(x(t), top - 10, fmtV(t), { anchor: "middle" });
  m.cats.forEach((c, ci) => {
    const y0 = top + ci * ROW;
    s += `<rect data-sel="${ci}:*" x="0" y="${y0}" width="${W}" height="${ROW}" fill="transparent" class="hit" data-tip="${esc(c.label + ": " + fmtV(tot[ci]))}"/>`;
    s += T(LBL - 10, y0 + ROW / 2 + 4, trunc(c.label, 34), { anchor: "end", fill: INK, size: 12 });
    let base = 0;
    const lastSi = m.val[ci].reduce((acc, v, i) => (v ? i : acc), -1);
    m.series.forEach((ser, si) => {
      const v = m.val[ci][si]; if (!v) return;
      const bx = x(base), bw = x(base + v) - bx; base += v;
      const gap = si !== lastSi ? 2 : 0;
      s += `<path data-sel="${ci}:${si}" data-tip="${esc(`${c.label}${S > 1 ? " · " + ser.name : ""}: ${fmtV(v)}`)}" d="${hBarPath(bx, y0 + 7, Math.max(1.5, bw - gap), ROW - 14, si === lastSi ? 4 : 0)}" fill="${ser.color}" class="mark"/>`;
    });
    s += T(x(tot[ci]) + 6, y0 + ROW / 2 + 4, fmtV(tot[ci]), { fill: INK2 });
  });
  return wrap(W, H, s, spec.title);
}
function hBarPath(x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w, h / 2));
  const f = (v) => v.toFixed(1);
  return `M${f(x)},${f(y)}H${f(x + w - r)}Q${f(x + w)},${f(y)} ${f(x + w)},${f(y + r)}V${f(y + h - r)}Q${f(x + w)},${f(y + h)} ${f(x + w - r)},${f(y + h)}H${f(x)}Z`;
}

function renderPie(m, spec, W) {
  const vals = m.cats.map((_, ci) => m.val[ci][0]), total = vals.reduce((a, b) => a + b, 0);
  if (!total) return "";
  const colors = m.cats.map((c, i) => (c.other ? OTHER : PALETTE[i % 8]));
  const r = Math.min(140, (W - 60) * 0.25), cx = r + 20, cy = r + 16, inner = spec.type === "donut" ? r * 0.58 : 0;
  const H = Math.max(cy * 2 + 4, 40 + m.cats.length * 26);
  let a0 = -Math.PI / 2, s = "";
  m.cats.forEach((c, ci) => {
    const v = vals[ci]; if (!v) return;
    const a1 = a0 + (v / total) * Math.PI * 2, pct = (v / total) * 100;
    s += `<path data-sel="${ci}:0" data-tip="${esc(`${c.label}: ${fmtV(v)} (${pct.toFixed(1)}%)`)}" d="${arc(cx, cy, r, inner, a0, a1)}" fill="${colors[ci]}" stroke="${SURFACE}" stroke-width="2" class="mark"/>`;
    if (pct > 6) { const am = (a0 + a1) / 2, rr = inner ? (r + inner) / 2 : r * 0.64; s += T(cx + Math.cos(am) * rr, cy + Math.sin(am) * rr + 4, `${Math.round(pct)}%`, { anchor: "middle", fill: "#fff", weight: 600, size: 12 }); }
    a0 = a1;
  });
  if (inner) s += T(cx, cy + 2, fmtV(total), { anchor: "middle", fill: INK, weight: 600, size: 20 }) + T(cx, cy + 20, m.metricLabel.toLowerCase(), { anchor: "middle" });
  const lx = cx + r + 36;
  m.cats.forEach((c, ci) => {
    const y = 30 + ci * 26;
    s += `<g data-sel="${ci}:0" class="hit" data-tip="${esc(c.label)}"><rect x="${lx - 4}" y="${y - 15}" width="${W - lx}" height="24" fill="transparent"/><rect x="${lx}" y="${y - 10}" width="12" height="12" rx="2" fill="${colors[ci]}"/>` +
      T(lx + 20, y, trunc(c.label, Math.max(8, Math.floor((W - lx - 120) / 6.8))), { fill: INK, size: 12 }) +
      T(W - 12, y, `${fmtV(vals[ci])} · ${((vals[ci] / total) * 100).toFixed(1)}%`, { anchor: "end", fill: INK2, size: 12 }) + "</g>";
  });
  return wrap(W, H, s, spec.title);
}
function arc(cx, cy, r, ir, a0, a1) {
  if (a1 - a0 >= Math.PI * 2 - 1e-6) a1 = a0 + Math.PI * 2 - 1e-4;
  const p = (rad, a) => `${(cx + Math.cos(a) * rad).toFixed(2)},${(cy + Math.sin(a) * rad).toFixed(2)}`, big = a1 - a0 > Math.PI ? 1 : 0;
  return ir ? `M${p(r, a0)}A${r},${r} 0 ${big} 1 ${p(r, a1)}L${p(ir, a1)}A${ir},${ir} 0 ${big} 0 ${p(ir, a0)}Z` : `M${cx},${cy}L${p(r, a0)}A${r},${r} 0 ${big} 1 ${p(r, a1)}Z`;
}

function renderScatter(m, spec, W) {
  if (!m.pts.length) return "";
  const xs = m.pts.map((p) => p.x), ys = m.pts.map((p) => p.y);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const px = (x1 - x0 || 1) * 0.05, py = (y1 - y0 || 1) * 0.06; x0 -= px; x1 += px; y0 -= py; y1 += py;
  const f = (fld, v) => (isYear(fld) ? fmtYear(Math.round(v)) : fmtV(v));
  const yt = ticks(y0, y1, 5), xt = ticks(x0, x1, 6);
  const L = 34 + Math.max(...yt.map((v) => f(m.yLabel, v).length)) * 7, R = 14;
  const lg = legend(m.series, W - L - R), top = 12 + lg.h, plotW = W - L - R, plotH = 300, H = top + plotH + 44;
  const X = (v) => L + ((v - x0) / (x1 - x0)) * plotW, Y = (v) => top + plotH * (1 - (v - y0) / (y1 - y0));
  let s = lg.svg ? `<g transform="translate(${L},0)">${lg.svg}</g>` : "";
  for (const v of yt) s += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="${GRID}"/>` + T(L - 8, Y(v) + 4, f(m.yLabel, v), { anchor: "end" });
  for (const v of xt) s += `<line x1="${X(v)}" x2="${X(v)}" y1="${top}" y2="${top + plotH}" stroke="${GRID}"/>` + T(X(v), top + plotH + 18, f(m.xLabel, v), { anchor: "middle" });
  s += T(L + plotW / 2, H - 6, m.xLabel, { anchor: "middle", fill: INK2 }) + T(12, top + plotH / 2, m.yLabel, { rot: -90, anchor: "middle", fill: INK2 });
  s += `<rect class="brush-area" data-plot="${L},${top},${plotW},${plotH}" x="${L}" y="${top}" width="${plotW}" height="${plotH}" fill="transparent"/>`;
  const order = m.pts.map((_, i) => i).sort((a, b) => (m.series[m.pts[b].si].other ? 1 : 0) - (m.series[m.pts[a].si].other ? 1 : 0));
  for (const i of order) {
    const p = m.pts[i];
    s += `<circle data-pt="${i}" cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="4.5" fill="${m.series[p.si].color}" fill-opacity="0.8" stroke="${SURFACE}" stroke-width="1.5" data-tip="${esc(`${p.r.Title || "Untitled"} · ${f(m.xLabel, p.x)}, ${f(m.yLabel, p.y)}`)}" class="mark"/>`;
  }
  s += `<line x1="${L}" x2="${W - R}" y1="${top + plotH}" y2="${top + plotH}" stroke="${AXIS}"/>`;
  return wrap(W, H, s, spec.title);
}

// table of what the chart shows, for export
export function modelRows(m) {
  if (m.kind === "scatter") return [[m.xLabel, m.yLabel, "Series", "ID", "Title"], ...m.pts.map((p) => [p.x, p.y, m.series[p.si].name, p.r._id, p.r.Title || ""])];
  const head = [m.numericX ? "Range" : "Category", ...m.series.map((s) => (m.series.length > 1 ? s.name : m.metricLabel))];
  return [head, ...m.cats.map((c, ci) => [c.label, ...m.val[ci]])];
}
