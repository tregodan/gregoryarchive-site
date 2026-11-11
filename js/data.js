// Shared data helpers for the viewer and the editor.
export const CFG = window.GA_CONFIG;

export async function loadArchive(url = CFG.dataUrl, onProgress) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Could not load ${url} (${res.status})`);
  const data = await res.json();
  return unpack(data);
}

export function unpack(data) {
  const { columns, dicts, rows } = data;
  const dictCols = columns.map((c) => dicts[c] || null);
  const records = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i], rec = {};
    for (let j = 0; j < columns.length; j++) {
      const d = dictCols[j];
      rec[columns[j]] = d ? d[row[j]] : row[j];
    }
    rec._i = i;
    records[i] = rec;
  }
  const fields = columns.filter((c) => !c.startsWith("_"));
  indexRecords(records, fields);
  return { records, fields, generated: data.generated, imageBase: data.imageBase || CFG.imageBase };
}

export function indexRecords(records, fields) {
  for (const r of records) {
    r._text = fields.map((f) => r[f] || "").join(" \u0001 ").toLowerCase();
  }
}

// ------------------------------------------------------------ images
const extRe = /\.(jpe?g|png|tiff?|webp)$/i;
export function fullUrl(r) {
  return r.Image_URL || (r["Digital File Name"] ? CFG.imageBase + encodeURIComponent(r["Digital File Name"]) : "");
}
export function thumbUrl(r) {
  if (!CFG.thumbsReady || !r["Digital File Name"]) return fullUrl(r);
  return CFG.thumbBase + encodeURIComponent(r["Digital File Name"].replace(extRe, "")) + ".webp";
}
export function mediumUrl(r) {
  if (!CFG.thumbsReady || !r["Digital File Name"]) return fullUrl(r);
  return CFG.mediumBase + encodeURIComponent(r["Digital File Name"].replace(extRe, "")) + ".webp";
}
// <img onerror> fallback: thumbnail missing -> original
export function attachFallback(img, r) {
  img.onerror = () => {
    const f = fullUrl(r);
    if (img.src !== f) img.src = f;
    else { img.onerror = null; img.classList.add("broken"); }
  };
}

// ------------------------------------------------------------ slide-box photos (boxes/<slug>.webp, copied from Airtable)
export const boxSlug = (name) => String(name || "").split(/\s+/).join(" ").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export function boxPhoto(name, small) {
  if (CFG.boxCovers && CFG.boxCovers[name]) return CFG.boxCovers[name];
  return (CFG.boxPhotoBase || CFG.imageBase + "boxes/") + boxSlug(name) + (small ? "-400" : "") + ".webp";
}

// ------------------------------------------------------------ permanent links
export function uri(r) { return (CFG.permalinkBase || location.href.split("#")[0]) + "#slide/" + r._id; }

// ------------------------------------------------------------ years
export function fmtYear(y) {
  if (y == null || y === "") return "";
  return y < 0 ? `${-y} BC` : `${y}`;
}
export function parseYearInput(s) {
  if (s == null) return null;
  s = String(s).trim();
  if (!s) return null;
  const m = s.match(/^(-?\d{1,4})\s*(bc|bce|b\.c\.?)?\s*(ad|ce)?$/i);
  if (!m) return null;
  let y = parseInt(m[1], 10);
  if (m[2]) y = -Math.abs(y);
  return y;
}
export function centuryLabel(c) {
  // c = century index: 5 => 5th c. AD, -5 => 5th c. BC
  const n = Math.abs(c);
  const suf = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
  return `${n}${suf} c. ${c < 0 ? "BC" : "AD"}`;
}
export function centuryOf(y) {
  if (y == null) return null;
  return y > 0 ? Math.ceil(y / 100) : -Math.ceil(-y / 100);
}

// ------------------------------------------------------------ derived fields usable for grouping/charts
export const DERIVED = {
  "Century (subject)": (r) => (r._sy == null ? "" : centuryLabel(centuryOf(Math.round((r._sy + r._ey) / 2)))),
  "Decade photographed": (r) => (r._cy == null ? "" : `${Math.floor(r._cy / 10) * 10}s`),
  "Year photographed": (r) => (r._cy == null ? "" : String(r._cy)),
  "Has map location": (r) => (r._lat != null ? "Yes" : "No"),
};
export function getValue(r, field) {
  const d = DERIVED[field];
  return d ? d(r) : r[field] || "";
}
export function sortKeyFor(field) {
  if (field === "Century (subject)") return (v) => { const m = v.match(/^(\d+)\w+ c\. (BC|AD)/); return m ? (m[2] === "BC" ? -m[1] : +m[1]) : 1e9; };
  if (field === "Decade photographed" || field === "Year photographed") return (v) => parseInt(v, 10) || 1e9;
  if (field === "Slide Box") return (v) => { const m = v.match(/^\s*(\d+)/); return m ? +m[1] : 1e6 + v.charCodeAt(0); };
  return null;
}

// ------------------------------------------------------------ export
export function toCSV(records, fields) {
  const esc = (v) => { v = v == null ? "" : String(v); return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  const head = ["ID", "URI", ...fields, "Image URL", "Thumbnail URL"];
  const lines = [head.map(esc).join(",")];
  for (const r of records) lines.push([r._id, uri(r), ...fields.map((f) => r[f]), fullUrl(r), thumbUrl(r)].map(esc).join(","));
  return lines.join("\r\n");
}
export function download(name, text, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const fmtN = (n) => n.toLocaleString("en-US");
export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
