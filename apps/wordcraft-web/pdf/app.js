// WriterPad PDF: view, mark up, fill, sign, redact, organize and OCR PDFs, all in the browser.
// Libraries: pdf.js (Apache-2.0) renders; pdf-lib (MIT) writes. Nothing is uploaded anywhere.
import * as pdfjsLib from "./vendor/pdf.min.mjs";

const L = window.PDFLib;
const { PDFDocument, StandardFonts, rgb, degrees, BlendMode, PDFName, PDFString, PDFHexString, PDFArray, PDFNumber } = L;
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.min.mjs", import.meta.url).href;
const VENDOR = new URL("./vendor/", import.meta.url).href;

// ------------------------------------------------------------------ utilities
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let idCounter = 1;
const uid = () => "o" + idCounter++;
const clone = (o) => JSON.parse(JSON.stringify(o));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r2 = (n) => Math.round(n * 100) / 100;

let toastTimer = 0;
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function hexRgb(hex) {
  const h = (hex || "#000000").replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}
const pdfColor = (hex) => { const c = hexRgb(hex); return rgb(c.r, c.g, c.b); };

function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

async function readFile(file) { return new Uint8Array(await file.arrayBuffer()); }
function readDataUrl(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}
function dataUrlBytes(url) {
  const b64 = url.split(",")[1] || "";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}
const baseName = (n) => (n || "document").replace(/\.[^.]+$/, "");

// Minimal ZIP writer (stored, no compression) for multi-file exports.
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function makeZip(files) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true); head.setUint16(4, 20, true); head.setUint16(6, 0x0800, true);
    head.setUint32(14, crc, true); head.setUint32(18, f.data.length, true); head.setUint32(22, f.data.length, true); head.setUint16(26, name.length, true);
    chunks.push(new Uint8Array(head.buffer), name, f.data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, f.data.length, true); cd.setUint32(24, f.data.length, true); cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  let cdSize = 0;
  central.forEach((c) => (cdSize += c.length));
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
}

// ------------------------------------------------------------------ state
const COLORS = ["#e53935", "#fb8c00", "#fdd835", "#43a047", "#1e88e5", "#8e24aa", "#000000", "#ffffff"];
const HL_COLORS = ["#fff176", "#a5d6a7", "#81d4fa", "#f48fb1", "#ffcc80"];
const S = {
  sources: [], pages: [], fileName: "document.pdf",
  scale: 1.2, tool: "select", sel: null, pending: null,
  undo: [], redo: [], dirty: false,
  prefs: { color: "#e53935", hl: "#fff176", width: 2, size: 14, font: "Helvetica", bold: false, italic: false, penOnly: false },
  fields: {}, flatten: false, removeOldText: true, decor: { pn: null, header: "", footer: "", wm: null }, meta: null, searchHits: [],
};
const PAPER = { "Letter 8.5 x 11 in": [612, 792], "Folio 8.5 x 13 in": [612, 936], "Legal 8.5 x 14 in": [612, 1008], "A4": [595.28, 841.89], "A5": [419.53, 595.28], "B5": [498.9, 708.66] };

const FONT_NAMES = {
  Helvetica: ["Helvetica", "HelveticaBold", "HelveticaOblique", "HelveticaBoldOblique"],
  Times: ["TimesRoman", "TimesRomanBold", "TimesRomanItalic", "TimesRomanBoldItalic"],
  Courier: ["Courier", "CourierBold", "CourierOblique", "CourierBoldOblique"],
};
const CSS_FONT = { Helvetica: 'Helvetica, Arial, "Liberation Sans", sans-serif', Times: '"Times New Roman", Times, "Liberation Serif", serif', Courier: '"Courier New", Courier, "Liberation Mono", monospace' };
const fontKey = (o) => FONT_NAMES[o.font || "Helvetica"][(o.bold ? 1 : 0) + (o.italic ? 2 : 0)];

let measureFonts = null;
async function initMeasure() {
  const d = await PDFDocument.create();
  measureFonts = {};
  for (const fam of Object.values(FONT_NAMES)) for (const n of fam) measureFonts[n] = await d.embedFont(StandardFonts[n]);
}
function textWidth(o, str, size = o.size) {
  try { return measureFonts[fontKey(o)].widthOfTextAtSize(str, size); } catch { return str.length * size * 0.55; }
}
function wrapLines(o) {
  const maxW = Math.max(10, o.w - 8);
  const out = [];
  for (const para of String(o.text || "").split("\n")) {
    if (!para) { out.push(""); continue; }
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      const test = line + word;
      if (line && textWidth(o, test.trimEnd()) > maxW) { out.push(line.trimEnd()); line = word.trimStart(); }
      else line = test;
    }
    out.push(line.trimEnd());
  }
  return out;
}
const LH = 1.2;
function textBox(o) {
  const lines = wrapLines(o);
  return { lines, h: Math.max(o.size * LH + 6, lines.length * o.size * LH + 6) };
}

// ------------------------------------------------------------------ sources and pages
const getDocOpts = (data, onPassword) => ({
  data, isEvalSupported: false,
  cMapUrl: VENDOR + "cmaps/", cMapPacked: true, standardFontDataUrl: VENDOR + "standard_fonts/",
  wasmUrl: VENDOR + "wasm/", iccUrl: VENDOR + "iccs/",
});

async function openPdfBytes(bytes, name) {
  const task = pdfjsLib.getDocument(getDocOpts(bytes.slice()));
  task.onPassword = (cb, reason) => {
    const pw = window.prompt(reason === 2 ? "Wrong password. Try again:" : "This PDF is password protected. Password:");
    if (pw === null) task.destroy(); else cb(pw);
  };
  const pdf = await task.promise;
  return { bytes, name, pdf, widgets: new Map(), pageCache: new Map() };
}

function newEntries(srcIdx, n) {
  return Array.from({ length: n }, (_, i) => ({ id: uid(), src: srcIdx, idx: i, rot: 0, edits: [], crop: null }));
}

async function loadDocument(bytes, name) {
  const src = await openPdfBytes(bytes, name);
  closeDocument();
  S.sources = [src];
  S.pages = newEntries(0, src.pdf.numPages);
  S.fileName = name || "document.pdf";
  S.fields = {}; S.decor = { pn: null, header: "", footer: "", wm: null }; S.meta = null;
  S.undo = []; S.redo = []; S.dirty = false; S.sel = null; S.searchHits = [];
  await collectFieldValues();
  $("#empty").hidden = true;
  await layoutPages();
  buildOutline();
  refreshButtons();
  document.title = baseName(S.fileName) + " - WriterPad PDF";
  $("#viewer").scrollTop = 0;
}

function closeDocument() {
  for (const s of S.sources) { try { s.pdf.destroy(); } catch {} }
  S.sources = []; S.pages = [];
  $("#pages").innerHTML = "";
}

async function getPageObj(entry) {
  const src = S.sources[entry.src];
  if (!src) return null;
  let p = src.pageCache.get(entry.idx);
  if (!p) { p = await src.pdf.getPage(entry.idx + 1); src.pageCache.set(entry.idx, p); }
  return p;
}

// pdf.js does not export its viewport class, so blank and cropped pages use this one (same maths).
class VP {
  constructor({ viewBox, scale, rotation }) {
    this.viewBox = viewBox; this.scale = scale; this.userUnit = 1; this.offsetX = 0; this.offsetY = 0;
    rotation = ((rotation % 360) + 360) % 360;
    this.rotation = rotation;
    const cx = (viewBox[2] + viewBox[0]) / 2, cy = (viewBox[3] + viewBox[1]) / 2;
    let a, b, c, d;
    if (rotation === 180) [a, b, c, d] = [-1, 0, 0, 1];
    else if (rotation === 90) [a, b, c, d] = [0, 1, 1, 0];
    else if (rotation === 270) [a, b, c, d] = [0, -1, -1, 0];
    else [a, b, c, d] = [1, 0, 0, -1];
    let ox, oy;
    if (a === 0) { ox = Math.abs(cy - viewBox[1]) * scale; oy = Math.abs(cx - viewBox[0]) * scale; this.width = (viewBox[3] - viewBox[1]) * scale; this.height = (viewBox[2] - viewBox[0]) * scale; }
    else { ox = Math.abs(cx - viewBox[0]) * scale; oy = Math.abs(cy - viewBox[1]) * scale; this.width = (viewBox[2] - viewBox[0]) * scale; this.height = (viewBox[3] - viewBox[1]) * scale; }
    this.transform = [a * scale, b * scale, c * scale, d * scale, ox - a * scale * cx - c * scale * cy, oy - b * scale * cx - d * scale * cy];
  }
  get rawDims() { const v = this.viewBox; return { pageWidth: v[2] - v[0], pageHeight: v[3] - v[1], pageX: v[0], pageY: v[1] }; }
  clone({ scale = this.scale, rotation = this.rotation } = {}) { return new VP({ viewBox: this.viewBox, scale, rotation }); }
  convertToViewportPoint(x, y) { const t = this.transform; return [x * t[0] + y * t[2] + t[4], x * t[1] + y * t[3] + t[5]]; }
  convertToPdfPoint(x, y) {
    const t = this.transform, det = t[0] * t[3] - t[1] * t[2];
    const dx = x - t[4], dy = y - t[5];
    return [(dx * t[3] - dy * t[2]) / det, (-dx * t[1] + dy * t[0]) / det];
  }
  convertToViewportRectangle(r) { const a = this.convertToViewportPoint(r[0], r[1]), b = this.convertToViewportPoint(r[2], r[3]); return [a[0], a[1], b[0], b[1]]; }
}

async function viewportFor(entry, scale) {
  if (entry.blank) {
    return new VP({ viewBox: [0, 0, entry.blank.w, entry.blank.h], scale, rotation: entry.rot % 360 });
  }
  const page = await getPageObj(entry);
  const rotation = (page.rotate + entry.rot) % 360;
  if (entry.crop) {
    const c = entry.crop;
    return new VP({ viewBox: [c[0], c[1], c[2], c[3]], scale, rotation });
  }
  return page.getViewport({ scale, rotation });
}

// ------------------------------------------------------------------ form fields (AcroForm via pdf.js)
async function widgetsFor(entry) {
  if (entry.blank || entry.src !== 0) return [];
  const src = S.sources[0];
  if (src.widgets.has(entry.idx)) return src.widgets.get(entry.idx);
  const page = await getPageObj(entry);
  let list = [];
  try { list = (await page.getAnnotations({ intent: "display" })).filter((a) => a.subtype === "Widget" && a.fieldName && !a.hidden); } catch {}
  src.widgets.set(entry.idx, list);
  return list;
}
async function collectFieldValues() {
  const src = S.sources[0];
  if (!src) return;
  const n = Math.min(src.pdf.numPages, 400);
  for (let i = 0; i < n; i++) {
    const list = await widgetsFor({ src: 0, idx: i });
    for (const a of list) {
      if (a.pushButton) continue;
      if (S.fields[a.fieldName] !== undefined) continue;
      if (a.checkBox) S.fields[a.fieldName] = { type: "check", on: a.fieldValue === a.exportValue || (!!a.fieldValue && a.fieldValue !== "Off" && a.fieldValue !== false) };
      else if (a.radioButton) S.fields[a.fieldName] = { type: "radio", value: a.fieldValue && a.fieldValue !== "Off" ? String(a.fieldValue) : "" };
      else if (a.fieldType === "Ch") S.fields[a.fieldName] = { type: a.combo ? "combo" : "list", value: Array.isArray(a.fieldValue) ? a.fieldValue[0] || "" : a.fieldValue || "" };
      else S.fields[a.fieldName] = { type: "text", value: Array.isArray(a.fieldValue) ? a.fieldValue.join("\n") : a.fieldValue || "" };
      const f0 = S.fields[a.fieldName];
      if (f0) f0.orig = f0.type === "check" ? f0.on : f0.value;
    }
  }
}

function buildFormLayer(entry, list) {
  const layer = document.createElement("div");
  layer.className = "flayer";
  for (const a of list) {
    if (a.pushButton) continue;
    const f = S.fields[a.fieldName];
    if (!f) continue;
    const [x1, y1, x2, y2] = entry.vp.convertToViewportRectangle(a.rect);
    const box = document.createElement("div");
    box.style.cssText = `left:${Math.min(x1, x2)}px;top:${Math.min(y1, y2)}px;width:${Math.abs(x2 - x1)}px;height:${Math.abs(y2 - y1)}px`;
    let input;
    const ro = a.readOnly;
    if (a.checkBox) {
      input = document.createElement("input"); input.type = "checkbox"; input.checked = f.on;
      input.onchange = () => { f.on = input.checked; S.dirty = true; $$(`[data-field="${CSS.escape(a.fieldName)}"]`).forEach((n) => { if (n !== input) n.checked = f.on; }); };
    } else if (a.radioButton) {
      input = document.createElement("input"); input.type = "radio"; input.checked = f.value === String(a.buttonValue);
      input.onchange = () => { f.value = String(a.buttonValue); S.dirty = true; $$(`[data-field="${CSS.escape(a.fieldName)}"]`).forEach((n) => { n.checked = n.dataset.val === f.value; }); };
      input.dataset.val = String(a.buttonValue);
    } else if (a.fieldType === "Ch") {
      input = document.createElement("select");
      input.appendChild(new Option("", ""));
      for (const o of a.options || []) input.appendChild(new Option(o.displayValue || o.exportValue, o.exportValue));
      input.value = f.value;
      input.onchange = () => { f.value = input.value; S.dirty = true; };
    } else if (a.multiLine) {
      input = document.createElement("textarea"); input.value = f.value;
      input.oninput = () => { f.value = input.value; S.dirty = true; };
    } else {
      input = document.createElement("input"); input.type = "text"; input.value = f.value;
      if (a.maxLen) input.maxLength = a.maxLen;
      input.oninput = () => { f.value = input.value; S.dirty = true; };
    }
    input.dataset.field = a.fieldName;
    const fs = Math.max(7, Math.min(Math.abs(y2 - y1) * 0.7, (a.defaultAppearanceData?.fontSize || 11) * S.scale));
    input.style.fontSize = (a.defaultAppearanceData?.fontSize ? a.defaultAppearanceData.fontSize * S.scale : fs) + "px";
    if (ro) { input.disabled = true; input.classList.add("ro"); }
    box.appendChild(input);
    layer.appendChild(box);
  }
  return layer;
}

// ------------------------------------------------------------------ layout and rendering
const viewer = () => $("#viewer");
let observer = null;
const renderQueue = [];
let rendering = 0;

function sizePageEl(entry) {
  const d = entry.dim || { w: 612, h: 792 };
  entry.el.style.width = d.w * S.scale + "px";
  entry.el.style.height = d.h * S.scale + "px";
  entry.el.style.setProperty("--scale-factor", S.scale);
  entry.el.style.setProperty("--total-scale-factor", S.scale);
}

async function layoutPages() {
  const host = $("#pages");
  host.innerHTML = "";
  if (observer) observer.disconnect();
  observer = new IntersectionObserver(onIntersect, { root: viewer(), rootMargin: "1400px 0px" });
  for (const entry of S.pages) {
    const el = document.createElement("div");
    el.className = "page";
    el.dataset.id = entry.id;
    entry.el = el;
    entry.renderedKey = null;
    entry.rtoken = (entry.rtoken || 0) + 1;
    sizePageEl(entry);
    host.appendChild(el);
    observer.observe(el);
  }
  $("#pageCount").textContent = "/ " + S.pages.length;
  $("#empty").hidden = S.pages.length > 0;
  buildThumbs();
  // Placeholders use the first page's size until each page's real size is known.
  let guess = { w: 612, h: 792 };
  const first = S.pages[0];
  if (first) { try { const vp = await viewportFor(first, 1); guess = { w: vp.width, h: vp.height }; } catch {} }
  for (const e of S.pages) if (!e.dim) { e.dim = guess; e.dimGuess = true; sizePageEl(e); }
  (async () => {
    for (const e of S.pages) {
      if (!e.dimGuess) continue;
      if (!e.el || !e.el.isConnected) return;
      try { const vp = await viewportFor(e, 1); e.dim = { w: vp.width, h: vp.height }; e.dimGuess = false; sizePageEl(e); } catch {}
    }
  })();
}

function onIntersect(items) {
  for (const it of items) {
    const entry = S.pages.find((p) => p.el === it.target);
    if (!entry) continue;
    if (it.isIntersecting) queueRender(entry);
    else unloadEntry(entry);
  }
}

function unloadEntry(entry) {
  if (!entry.el || !entry.renderedKey) return;
  try { entry.rtask?.cancel(); } catch {}
  entry.rtoken++;
  entry.el.querySelectorAll("canvas.pg, .textLayer, .flayer, svg.ov").forEach((n) => n.remove());
  entry.renderedKey = null;
}

function queueRender(entry) {
  if (renderQueue.includes(entry)) return;
  renderQueue.push(entry);
  pumpRender();
}
function pumpRender() {
  while (rendering < 2 && renderQueue.length) {
    const entry = renderQueue.shift();
    if (!entry.el || !entry.el.isConnected) continue;
    rendering++;
    renderEntry(entry).catch((e) => { if (e?.name !== "RenderingCancelledException") console.warn("render", e); }).finally(() => { rendering--; pumpRender(); });
  }
}

async function renderEntry(entry) {
  const key = `${S.scale}|${entry.rot}|${entry.crop ? entry.crop.join(",") : ""}`;
  if (entry.renderedKey === key && entry.el.querySelector("canvas.pg")) { drawOverlay(entry); return; }
  const token = ++entry.rtoken;
  try { entry.rtask?.cancel(); } catch {}
  const vp = await viewportFor(entry, S.scale);
  if (token !== entry.rtoken) return;
  entry.vp = vp;
  entry.dim = { w: vp.width / S.scale, h: vp.height / S.scale };
  sizePageEl(entry);

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let ratio = dpr;
  while (vp.width * vp.height * ratio * ratio > 12e6 && ratio > 0.5) ratio -= 0.25;
  const off = document.createElement("canvas");
  off.width = Math.max(1, Math.floor(vp.width * ratio));
  off.height = Math.max(1, Math.floor(vp.height * ratio));
  const ctx = off.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, off.width, off.height);
  let page = null;
  if (!entry.blank) {
    page = await getPageObj(entry);
    const task = page.render({ canvasContext: ctx, viewport: vp, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null, annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS });
    entry.rtask = task;
    await task.promise;
  }
  if (token !== entry.rtoken) return;

  entry.el.querySelectorAll("canvas.pg, .textLayer, .flayer, svg.ov").forEach((n) => n.remove());
  off.className = "pg";
  entry.el.appendChild(off);

  if (page) {
    const tdiv = document.createElement("div");
    tdiv.className = "textLayer";
    entry.el.appendChild(tdiv);
    try {
      const tl = new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }), container: tdiv, viewport: vp });
      await tl.render();
    } catch (e) { console.warn("text layer", e); }
    if (token !== entry.rtoken) return;
    const widgets = await widgetsFor(entry);
    if (widgets.length) entry.el.appendChild(buildFormLayer(entry, widgets));
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "ov");
  svg.setAttribute("viewBox", `0 0 ${vp.width} ${vp.height}`);
  entry.el.appendChild(svg);
  entry.renderedKey = key;
  drawOverlay(entry);
  updateThumbFor(entry);
  if (S.tool === "edit") ensureAnalysis(entry).then(() => drawOverlay(entry));
}

function rerenderAll() {
  for (const e of S.pages) { e.renderedKey = null; e.rtoken++; }
  const vr = viewer().getBoundingClientRect();
  for (const e of S.pages) {
    if (!e.el) continue;
    const r = e.el.getBoundingClientRect();
    if (r.bottom > vr.top - 1400 && r.top < vr.bottom + 1400) queueRender(e);
  }
}

function currentPageIndex() {
  const vr = viewer().getBoundingClientRect();
  const mid = vr.top + vr.height * 0.35;
  let best = 0;
  for (let i = 0; i < S.pages.length; i++) {
    const r = S.pages[i].el?.getBoundingClientRect();
    if (r && r.top <= mid) best = i;
  }
  return best;
}
function scrollToPage(i, smooth = true) {
  const e = S.pages[clamp(i, 0, S.pages.length - 1)];
  if (!e?.el) return;
  const v = viewer();
  const top = e.el.getBoundingClientRect().top - v.getBoundingClientRect().top + v.scrollTop - 10;
  v.scrollTo({ top, behavior: smooth ? "smooth" : "auto" });
}

function setScale(ns, anchorIdx) {
  ns = clamp(ns, 0.25, 5);
  if (Math.abs(ns - S.scale) < 0.001) return;
  const idx = anchorIdx ?? currentPageIndex();
  const e = S.pages[idx];
  const v = viewer();
  const frac = e?.el ? (v.getBoundingClientRect().top - e.el.getBoundingClientRect().top) / Math.max(1, e.el.offsetHeight) : 0;
  S.scale = ns;
  for (const p of S.pages) if (p.el) sizePageEl(p);
  if (e?.el) v.scrollTop = e.el.getBoundingClientRect().top - v.getBoundingClientRect().top + v.scrollTop + frac * e.el.offsetHeight;
  $("#zoomLabel").textContent = Math.round(ns * 100) + "%";
  rerenderAll();
}
function fitWidth() {
  const e = S.pages[currentPageIndex()];
  const w = (e?.dim?.w || 612);
  const avail = viewer().clientWidth - 24;
  setScale(avail / w);
}

// ------------------------------------------------------------------ edit objects: geometry and drawing
// Objects live in PDF user space (points, y up), so they follow the page through zoom and rotation:
//   hl {rects:[[x0,y0,x1,y1]], color, op}      ul/st {segs:[[x1,y1,x2,y2]], color, w}
//   ink {pts:[[x,y]], color, w}                rect/ell/line/arrow {a:[x,y], b:[x,y], color, w}
//   redact/white {a, b}                        note {p, text, color}
//   text {p, ang, w, text, size, color, font, bold, italic}   img {p, ang, w, h, img}   stamp {p, ang, w, h, label, color}
// p is the top-left corner of a box as seen on screen; ang is the page rotation it was made at.
const IMGS = new Map();
const addImage = (url) => { const k = "i" + uid(); IMGS.set(k, url); return k; };

const pt = (vp, x, y) => vp.convertToViewportPoint(x, y);
const aabb = (vp, r) => { const a = pt(vp, r[0], r[1]), b = pt(vp, r[2], r[3]); return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) }; };
const aabbAB = (vp, a, b) => aabb(vp, [a[0], a[1], b[0], b[1]]);
const userRect = (vp, x0, y0, x1, y1) => { const a = vp.convertToPdfPoint(x0, y0), b = vp.convertToPdfPoint(x1, y1); return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]; };

function boxH(o) { return o.t === "text" ? textBox(o).h : o.h; }
function boxFrame(entry, o) {
  const vp = entry.vp, k = vp.scale;
  const [sx, sy] = pt(vp, o.p[0], o.p[1]);
  return { sx, sy, rel: vp.rotation - (o.ang || 0), w: o.w * k, h: boxH(o) * k, k };
}
function toLocal(f, x, y) {
  const a = (-f.rel * Math.PI) / 180, dx = x - f.sx, dy = y - f.sy;
  return [dx * Math.cos(a) - dy * Math.sin(a), dx * Math.sin(a) + dy * Math.cos(a)];
}
function fromLocal(f, lx, ly) {
  const a = (f.rel * Math.PI) / 180;
  return [f.sx + lx * Math.cos(a) - ly * Math.sin(a), f.sy + lx * Math.sin(a) + ly * Math.cos(a)];
}
const BOXED = new Set(["text", "img", "stamp"]);

function objBounds(entry, o) {
  const vp = entry.vp;
  if (BOXED.has(o.t)) {
    const f = boxFrame(entry, o);
    const cs = [[0, 0], [f.w, 0], [f.w, f.h], [0, f.h]].map(([x, y]) => fromLocal(f, x, y));
    const xs = cs.map((c) => c[0]), ys = cs.map((c) => c[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  if (o.t === "note") { const [x, y] = pt(vp, o.p[0], o.p[1]); return { x, y, w: 24, h: 24 }; }
  if (o.t === "tedit") return aabb(vp, o.rect);
  let pts = [];
  if (o.t === "hl") o.rects.forEach((r) => { const a = aabb(vp, r); pts.push([a.x, a.y], [a.x + a.w, a.y + a.h]); });
  else if (o.t === "ul" || o.t === "st") o.segs.forEach((s) => pts.push(pt(vp, s[0], s[1]), pt(vp, s[2], s[3])));
  else if (o.t === "ink") pts = o.pts.map((p) => pt(vp, p[0], p[1]));
  else pts = [pt(vp, o.a[0], o.a[1]), pt(vp, o.b[0], o.b[1])];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function hitObj(entry, o, x, y) {
  const vp = entry.vp, tol = 10;
  if (BOXED.has(o.t)) { const f = boxFrame(entry, o); const [lx, ly] = toLocal(f, x, y); return lx >= -4 && ly >= -4 && lx <= f.w + 4 && ly <= f.h + 4; }
  if (o.t === "tedit") { const b = aabb(vp, o.rect); return x >= b.x - 3 && x <= b.x + b.w + 3 && y >= b.y - 3 && y <= b.y + b.h + 3; }
  if (o.t === "note") { const b = objBounds(entry, o); return x >= b.x - 4 && x <= b.x + b.w + 4 && y >= b.y - 4 && y <= b.y + b.h + 4; }
  if (o.t === "hl") return o.rects.some((r) => { const a = aabb(vp, r); return x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h; });
  if (o.t === "ul" || o.t === "st") return o.segs.some((s) => { const a = pt(vp, s[0], s[1]), b = pt(vp, s[2], s[3]); return distSeg(x, y, a[0], a[1], b[0], b[1]) < tol; });
  if (o.t === "ink") { const p = o.pts.map((q) => pt(vp, q[0], q[1])); for (let i = 1; i < p.length; i++) if (distSeg(x, y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) < tol + o.w * vp.scale / 2) return true; return p.length === 1 && Math.hypot(x - p[0][0], y - p[0][1]) < tol; }
  if (o.t === "line" || o.t === "arrow") { const a = pt(vp, o.a[0], o.a[1]), b = pt(vp, o.b[0], o.b[1]); return distSeg(x, y, a[0], a[1], b[0], b[1]) < tol; }
  const a = aabbAB(vp, o.a, o.b);
  if (o.t === "rect" && !o.fill) {
    const inX = x >= a.x - tol && x <= a.x + a.w + tol, inY = y >= a.y - tol && y <= a.y + a.h + tol;
    const near = Math.min(Math.abs(x - a.x), Math.abs(x - a.x - a.w), Math.abs(y - a.y), Math.abs(y - a.y - a.h)) < tol;
    return inX && inY && near;
  }
  return x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h;
}

function handlesOf(entry, o) {
  const vp = entry.vp;
  if (BOXED.has(o.t)) {
    const f = boxFrame(entry, o);
    if (o.t === "text") { const [x, y] = fromLocal(f, f.w, f.h / 2); return [{ k: "r", x, y }]; }
    const [x, y] = fromLocal(f, f.w, f.h);
    return [{ k: "br", x, y }];
  }
  if (["rect", "ell", "line", "arrow", "redact", "white", "ximg"].includes(o.t)) {
    const a = pt(vp, o.a[0], o.a[1]), b = pt(vp, o.b[0], o.b[1]);
    return [{ k: "a", x: a[0], y: a[1] }, { k: "b", x: b[0], y: b[1] }];
  }
  return [];
}

function decorObjects(entry, index, vp) {
  const out = [], D = S.decor, k = vp.scale, W = vp.width / k, H = vp.height / k;
  const mk = (text, pos, size = 10) => {
    const o = { t: "text", decor: true, font: "Helvetica", size, color: "#333333", text, w: 220, ang: vp.rotation };
    const h = textBox(o).h;
    const m = 28;
    const x = pos.endsWith("left") ? m : pos.endsWith("right") ? W - m - o.w : (W - o.w) / 2;
    const y = pos.startsWith("top") ? m - 6 : H - m - h + 6;
    o.p = vp.convertToPdfPoint(x * k, y * k);
    return o;
  };
  const total = S.pages.length, n = index + 1;
  if (D.pn) out.push(mk(D.pn.fmt.replace("{n}", n + (D.pn.start || 1) - 1).replace("{N}", total), D.pn.pos));
  if (D.header) out.push(mk(D.header, "top-center"));
  if (D.footer) out.push(mk(D.footer, D.pn && D.pn.pos === "bottom-center" ? "bottom-left" : "bottom-center"));
  if (D.wm) out.push({ t: "wm", decor: true, text: D.wm.text, size: D.wm.size, color: D.wm.color, op: D.wm.op, c: vp.convertToPdfPoint(vp.width / 2, vp.height / 2), ang: vp.rotation });
  return out;
}

function arrowHead(ax, ay, bx, by, size) {
  const ang = Math.atan2(by - ay, bx - ax), s = size;
  const p1 = [bx - s * Math.cos(ang - 0.45), by - s * Math.sin(ang - 0.45)];
  const p2 = [bx - s * Math.cos(ang + 0.45), by - s * Math.sin(ang + 0.45)];
  return `${bx},${by} ${p1[0]},${p1[1]} ${p2[0]},${p2[1]}`;
}

function objSvg(entry, o) {
  const vp = entry.vp, k = vp.scale, col = o.color || "#000";
  switch (o.t) {
    case "hl": return o.rects.map((r) => { const a = aabb(vp, r); return `<rect x="${r2(a.x)}" y="${r2(a.y)}" width="${r2(a.w)}" height="${r2(a.h)}" fill="${col}" opacity="${o.op ?? 0.45}" style="mix-blend-mode:multiply"/>`; }).join("");
    case "ul": case "st": return o.segs.map((s) => { const a = pt(vp, s[0], s[1]), b = pt(vp, s[2], s[3]); return `<line x1="${r2(a[0])}" y1="${r2(a[1])}" x2="${r2(b[0])}" y2="${r2(b[1])}" stroke="${col}" stroke-width="${(o.w || 1.2) * k}" stroke-linecap="round"/>`; }).join("");
    case "ink": return `<polyline points="${o.pts.map((p) => pt(vp, p[0], p[1]).map(r2).join(",")).join(" ")}" fill="none" stroke="${col}" stroke-width="${o.w * k}" stroke-linecap="round" stroke-linejoin="round"/>`;
    case "rect": { const a = aabbAB(vp, o.a, o.b); return `<rect x="${r2(a.x)}" y="${r2(a.y)}" width="${r2(a.w)}" height="${r2(a.h)}" fill="${o.fill ? col : "none"}" stroke="${col}" stroke-width="${o.w * k}"/>`; }
    case "ell": { const a = aabbAB(vp, o.a, o.b); return `<ellipse cx="${r2(a.x + a.w / 2)}" cy="${r2(a.y + a.h / 2)}" rx="${r2(a.w / 2)}" ry="${r2(a.h / 2)}" fill="none" stroke="${col}" stroke-width="${o.w * k}"/>`; }
    case "line": case "arrow": {
      const a = pt(vp, o.a[0], o.a[1]), b = pt(vp, o.b[0], o.b[1]);
      let s = `<line x1="${r2(a[0])}" y1="${r2(a[1])}" x2="${r2(b[0])}" y2="${r2(b[1])}" stroke="${col}" stroke-width="${o.w * k}" stroke-linecap="round"/>`;
      if (o.t === "arrow") s += `<polygon points="${arrowHead(a[0], a[1], b[0], b[1], Math.max(8, o.w * 4) * k)}" fill="${col}"/>`;
      return s;
    }
    case "redact": { const a = aabbAB(vp, o.a, o.b); return `<rect x="${r2(a.x)}" y="${r2(a.y)}" width="${r2(a.w)}" height="${r2(a.h)}" fill="rgba(0,0,0,.55)" stroke="#e53935" stroke-width="2" stroke-dasharray="6 4"/>`; }
    case "white": { const a = aabbAB(vp, o.a, o.b); return `<rect x="${r2(a.x)}" y="${r2(a.y)}" width="${r2(a.w)}" height="${r2(a.h)}" fill="#fff" stroke="#bbb" stroke-dasharray="4 3"/>`; }
    case "note": { const [x, y] = pt(vp, o.p[0], o.p[1]); return `<g transform="translate(${r2(x)} ${r2(y)})"><path d="M0 0h20v14h-6l-4 5-4-5H0z" fill="${o.color || "#fdd835"}" stroke="#a88700"/><path d="M4 5h12M4 9h8" stroke="#7a6200"/></g>`; }
    case "img": { const f = boxFrame(entry, o); return `<g transform="translate(${r2(f.sx)} ${r2(f.sy)}) rotate(${f.rel})"><image href="${IMGS.get(o.img) || ""}" x="0" y="0" width="${r2(f.w)}" height="${r2(f.h)}" preserveAspectRatio="none"/></g>`; }
    case "stamp": {
      const f = boxFrame(entry, o), bw = Math.max(1.5, f.h * 0.06);
      return `<g transform="translate(${r2(f.sx)} ${r2(f.sy)}) rotate(${f.rel})"><rect x="${bw / 2}" y="${bw / 2}" width="${r2(f.w - bw)}" height="${r2(f.h - bw)}" rx="${r2(f.h * 0.12)}" fill="none" stroke="${col}" stroke-width="${bw}"/><text x="${r2(f.w / 2)}" y="${r2(f.h / 2)}" text-anchor="middle" dominant-baseline="central" font-family="${CSS_FONT.Helvetica}" font-weight="700" font-size="${r2(stampFont(o) * k)}" fill="${col}">${esc(o.label)}</text></g>`;
    }
    case "text": {
      if (o.editing) return "";
      const f = boxFrame(entry, o), { lines } = textBox(o);
      const t = lines.map((ln, i) => `<text x="${r2(4 * k)}" y="${r2((3 + o.size * 0.82 + i * o.size * LH) * k)}" xml:space="preserve">${esc(ln)}</text>`).join("");
      return `<g transform="translate(${r2(f.sx)} ${r2(f.sy)}) rotate(${f.rel})" font-family='${CSS_FONT[o.font || "Helvetica"]}' font-size="${r2(o.size * k)}" font-weight="${o.bold ? 700 : 400}" font-style="${o.italic ? "italic" : "normal"}" fill="${col}" style="white-space:pre">${t}</g>`;
    }
    case "ximg": {
      if (o.unchanged) return "";
      const b0 = aabb(vp, o.box0), a = aabbAB(vp, o.a, o.b);
      let sv = `<rect x="${r2(b0.x)}" y="${r2(b0.y)}" width="${r2(b0.w)}" height="${r2(b0.h)}" fill="#fff"/>`;
      const href = IMGS.get(o.img || o.prev);
      if (!o.del && href) sv += `<image href="${href}" x="${r2(a.x)}" y="${r2(a.y)}" width="${r2(a.w)}" height="${r2(a.h)}" preserveAspectRatio="none"/>`;
      return sv;
    }
    case "tedit": {
      const a = aabb(vp, o.rect), [bx, by] = pt(vp, o.base[0], o.base[1]);
      return `<rect x="${r2(a.x - 1.5)}" y="${r2(a.y - 1.5)}" width="${r2(a.w + 3)}" height="${r2(a.h + 3)}" fill="${o.bg}"/><text x="${r2(bx)}" y="${r2(by)}" font-family='${CSS_FONT[o.font || "Helvetica"]}' font-size="${r2(o.size * k)}" font-weight="${o.bold ? 700 : 400}" font-style="${o.italic ? "italic" : "normal"}" fill="${o.fg}" xml:space="preserve" style="white-space:pre">${esc(o.text)}</text>`;
    }
    case "wm": {
      const [x, y] = pt(vp, o.c[0], o.c[1]);
      return `<text transform="translate(${r2(x)} ${r2(y)}) rotate(${vp.rotation - (o.ang || 0) - 45})" text-anchor="middle" dominant-baseline="central" font-family="${CSS_FONT.Helvetica}" font-weight="700" font-size="${r2(o.size * k)}" fill="${o.color}" opacity="${o.op}">${esc(o.text)}</text>`;
    }
  }
  return "";
}
const stampFont = (o) => Math.min(o.h * 0.5, (o.w - 10) / Math.max(1, o.label.length * 0.62));

function drawOverlay(entry) {
  const svg = entry.el?.querySelector("svg.ov");
  if (!svg || !entry.vp) return;
  const vp = entry.vp;
  const idx = S.pages.indexOf(entry);
  let html = "";
  for (const o of decorObjects(entry, idx, vp)) html += objSvg(entry, o);
  // Replaced text goes under everything else so its cover box never hides a moved picture.
  for (const o of entry.edits) if (o.t === "tedit") html += objSvg(entry, o);
  for (const o of entry.edits) if (o.t !== "tedit") html += objSvg(entry, o);
  if (entry.tmp) html += objSvg(entry, entry.tmp);
  if (S.tool === "edit") {
    for (const m of entry.ximgs || []) { if (entry.edits.some((o) => o.t === "ximg" && o.k === m.k && !o.unchanged)) continue; const a = aabb(vp, m.bbox); html += `<rect x="${r2(a.x)}" y="${r2(a.y)}" width="${r2(a.w)}" height="${r2(a.h)}" fill="rgba(30,136,229,.06)" stroke="#1e88e5" stroke-width="1.2" stroke-dasharray="4 3"/>`; }
    for (const l of entry.xlines || []) { const a = aabb(vp, l.rect); html += `<rect x="${r2(a.x - 1)}" y="${r2(a.y - 1)}" width="${r2(a.w + 2)}" height="${r2(a.h + 2)}" fill="rgba(67,160,71,.05)" stroke="#43a047" stroke-width="0.8" stroke-dasharray="2 3"/>`; }
  }
  for (const h of S.searchHits) if (h.entry === entry.id) { const a = aabb(vp, h.rect); html += `<rect x="${r2(a.x)}" y="${r2(a.y)}" width="${r2(a.w)}" height="${r2(a.h)}" fill="#ffd54f" opacity="${h.cur ? 0.75 : 0.45}" style="mix-blend-mode:multiply"/>`; }
  if (entry.cropBox) { const a = aabb(vp, entry.cropBox); html += `<rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" fill="rgba(43,71,181,.12)" stroke="#2b47b5" stroke-width="2" stroke-dasharray="6 4"/>`; }
  const sel = S.sel && S.sel.entry === entry.id ? entry.edits.find((o) => o.id === S.sel.obj) : null;
  if (sel) {
    const b = objBounds(entry, sel);
    html += `<rect x="${r2(b.x - 3)}" y="${r2(b.y - 3)}" width="${r2(b.w + 6)}" height="${r2(b.h + 6)}" fill="none" stroke="#2b47b5" stroke-width="1.5" stroke-dasharray="5 3"/>`;
    for (const h of handlesOf(entry, sel)) html += `<circle cx="${r2(h.x)}" cy="${r2(h.y)}" r="9" fill="#fff" stroke="#2b47b5" stroke-width="2.5"/>`;
  }
  svg.innerHTML = html;
}
function redrawAll() { for (const e of S.pages) drawOverlay(e); }

// ------------------------------------------------------------------ undo / redo
function serializeState() {
  return clone({ pages: S.pages.map((p) => ({ id: p.id, src: p.src, idx: p.idx, rot: p.rot, blank: p.blank || null, crop: p.crop, edits: p.edits })), decor: S.decor, meta: S.meta });
}
function snapshot() {
  S.undo.push(serializeState());
  if (S.undo.length > 60) S.undo.shift();
  S.redo = [];
  S.dirty = true;
  refreshButtons();
}
async function restoreState(st) {
  const old = new Map(S.pages.map((p) => [p.id, p]));
  S.pages = st.pages.map((p) => { const o = old.get(p.id); return Object.assign({ dim: o?.dim, dimGuess: o?.dimGuess }, p); });
  S.decor = st.decor; S.meta = st.meta; S.sel = null;
  const top = viewer().scrollTop;
  await layoutPages();
  viewer().scrollTop = top;
  closeCtx(); refreshButtons();
}
async function undo() { if (!S.undo.length) return; S.redo.push(serializeState()); await restoreState(S.undo.pop()); S.dirty = true; }
async function redo() { if (!S.redo.length) return; S.undo.push(serializeState()); await restoreState(S.redo.pop()); S.dirty = true; }
function refreshButtons() {
  $("#btnUndo").disabled = !S.undo.length;
  $("#btnRedo").disabled = !S.redo.length;
  const has = S.pages.length > 0;
  $("#btnSave").disabled = !has;
  $("#btnInsert").disabled = false;
}

// ------------------------------------------------------------------ tools
const TOOLS = [
  { id: "select", g: "&#9757;", l: "Select" },
  { id: "edit", g: "&#9998;&#65039;", l: "Edit PDF" },
  { id: "hl", g: "&#128396;", l: "Highlight" },
  { id: "ul", g: "<u>U</u>", l: "Underline" },
  { id: "st", g: "<s>S</s>", l: "Strike" },
  { id: "area", g: "&#9648;", l: "Box mark" },
  { id: "ink", g: "&#9999;&#65039;", l: "Pen" },
  { id: "text", g: "<b>T</b>", l: "Text" },
  { id: "note", g: "&#128466;", l: "Note" },
  { id: "rect", g: "&#9645;", l: "Box" },
  { id: "ell", g: "&#9711;", l: "Oval" },
  { id: "line", g: "&#9585;", l: "Line" },
  { id: "arrow", g: "&#10140;", l: "Arrow" },
  { id: "stamp", g: "&#128278;", l: "Stamp" },
  { id: "sign", g: "&#9997;&#65039;", l: "Sign" },
  { id: "image", g: "&#128444;", l: "Picture" },
  { id: "white", g: "&#11036;", l: "Whiteout" },
  { id: "redact", g: "&#11035;", l: "Redact" },
  { id: "crop", g: "&#9986;&#65039;", l: "Crop" },
];
const DRAW_TOOLS = new Set(["ink", "rect", "ell", "line", "arrow", "area", "white", "redact", "crop"]);

function buildToolbar() {
  const nav = $("#tools");
  nav.innerHTML = TOOLS.map((t) => `<button class="tool" data-tool="${t.id}" title="${t.l}"><span class="g">${t.g}</span><span class="l">${t.l}</span></button>`).join("");
  nav.onclick = (e) => { const b = e.target.closest(".tool"); if (b) setTool(b.dataset.tool); };
}

function setTool(id) {
  closeEditor(); clearTmp();
  S.pending = null;
  if (id === "stamp") return openStampDialog();
  if (id === "sign") return openSignDialog();
  if (id === "image") return $("#imgIn").click();
  S.tool = id;
  $$(".tool").forEach((b) => b.classList.toggle("on", b.dataset.tool === id));
  document.body.className = DRAW_TOOLS.has(id) ? "tool-draw" : "tool-" + id;
  if (id !== "select" && id !== "edit") { S.sel = null; closeCtx(); }
  redrawAll();
  if (id === "edit") analyzeVisible();
  renderPropbar();
}

function renderPropbar() {
  const pb = $("#propbar"), t = S.tool, P = S.prefs;
  const sw = (list, cur, key) => list.map((c) => `<button class="sw ${c.toLowerCase() === (cur || "").toLowerCase() ? "on" : ""}" data-set="${key}" data-val="${c}" style="background:${c}" aria-label="${c}"></button>`).join("");
  const widths = `<label>Width <select data-set="width">${[1, 2, 3, 5, 8, 12].map((w) => `<option ${P.width === w ? "selected" : ""}>${w}</option>`).join("")}</select></label>`;
  let html = "";
  if (t === "hl" || t === "area") html = `<span class="muted">${t === "hl" ? "Select text, then it is marked." : "Drag a box over the area."}</span>` + sw(HL_COLORS, P.hl, "hl");
  else if (t === "ul" || t === "st") html = `<span class="muted">Select the text to mark.</span>` + sw(COLORS, P.color, "color");
  else if (t === "ink") html = sw(COLORS, P.color, "color") + widths + `<label><input type="checkbox" data-set="penOnly" ${P.penOnly ? "checked" : ""}> Pencil only</label>`;
  else if (["rect", "ell", "line", "arrow"].includes(t)) html = sw(COLORS, P.color, "color") + widths;
  else if (t === "text") html = sw(COLORS, P.color, "color") + `<label>Font <select data-set="font">${Object.keys(FONT_NAMES).map((f) => `<option ${P.font === f ? "selected" : ""}>${f}</option>`).join("")}</select></label><label>Size <select data-set="size">${[8, 10, 12, 14, 18, 24, 36].map((w) => `<option ${P.size === w ? "selected" : ""}>${w}</option>`).join("")}</select></label><button class="btn sm ${P.bold ? "on" : ""}" data-set="bold"><b>B</b></button><button class="btn sm ${P.italic ? "on" : ""}" data-set="italic"><i>I</i></button>`;
  else if (t === "edit") html = `<span class="muted">Tap a line of text to change it. Tap a picture to move, resize, replace or delete it.</span><label><input type="checkbox" data-set="removeOldText" ${S.removeOldText ? "checked" : ""}> Remove replaced text for real</label>`;
  else if (t === "note") html = `<span class="muted">Tap the page to add a note.</span>`;
  else if (t === "redact") html = `<span class="muted">Drag over text to redact. Saving permanently removes what is under the boxes.</span>`;
  else if (t === "white") html = `<span class="muted">Drag to cover content with white.</span>`;
  else if (t === "crop") html = `<span class="muted">Drag the area to keep on this page.</span><button class="btn sm" data-act="cropAll">Apply to all pages</button><button class="btn sm" data-act="cropReset">Reset crop</button>`;
  else html = `<span class="muted">Tap an object to edit it. Tap a text line of a form to fill it.</span>`;
  pb.innerHTML = html;
}

$("#propbar").addEventListener("click", (e) => {
  const sw = e.target.closest(".sw"), btn = e.target.closest("button[data-set]"), act = e.target.closest("[data-act]");
  if (act) return propAction(act.dataset.act);
  if (sw) setProp(sw.dataset.set, sw.dataset.val);
  else if (btn && (btn.dataset.set === "bold" || btn.dataset.set === "italic")) setProp(btn.dataset.set, !S.prefs[btn.dataset.set]);
});
$("#propbar").addEventListener("change", (e) => {
  const el = e.target.closest("[data-set]");
  if (!el) return;
  const k = el.dataset.set;
  if (k === "removeOldText") { S.removeOldText = el.checked; return; }
  setProp(k, el.type === "checkbox" ? el.checked : k === "width" || k === "size" ? +el.value : el.value);
});

function setProp(key, val) {
  S.prefs[key] = val;
  const o = selectedObj();
  if (o) {
    snapshot();
    if (key === "color" && o.color !== undefined) o.color = val;
    if (key === "hl" && o.t === "hl") o.color = val;
    if (key === "width" && o.w !== undefined && !BOXED.has(o.t)) o.w = val;
    if (["size", "font", "bold", "italic"].includes(key) && o.t === "text") o[key] = val;
    drawOverlay(entryById(S.sel.entry)); showCtx();
  }
  renderPropbar();
}
const entryById = (id) => S.pages.find((p) => p.id === id);
const selectedObj = () => (S.sel ? entryById(S.sel.entry)?.edits.find((o) => o.id === S.sel.obj) : null);

function propAction(a) {
  const e = S.pages[currentPageIndex()];
  if (a === "cropReset") { snapshot(); (S.cropAll ? S.pages : [e]).forEach((p) => (p.crop = null)); relayoutKeepScroll(); }
  if (a === "cropAll") { S.cropAll = !S.cropAll; toast(S.cropAll ? "The next crop applies to every page." : "The next crop applies to this page only."); }
}
async function relayoutKeepScroll() { const t = viewer().scrollTop; S.pages.forEach((p) => { p.dim = null; }); await layoutPages(); viewer().scrollTop = t; }

// ------------------------------------------------------------------ pointer interaction
let drag = null;
const pagesEl = $("#pages");

function pageAt(e) {
  const el = e.target.closest?.(".page");
  if (!el) return null;
  const entry = S.pages.find((p) => p.el === el);
  if (!entry || !entry.vp) return null;
  const r = el.getBoundingClientRect();
  return { entry, x: e.clientX - r.left, y: e.clientY - r.top };
}
function addObj(entry, o) { snapshot(); o.id = o.id || uid(); entry.edits.push(o); drawOverlay(entry); return o; }
function select(entry, o) {
  S.sel = o ? { entry: entry.id, obj: o.id } : null;
  document.body.classList.toggle("grab", !!o);
  redrawAll(); o ? showCtx() : closeCtx();
}
function clearTmp() { for (const e of S.pages) if (e.tmp || e.cropBox) { e.tmp = null; e.cropBox = null; drawOverlay(e); } }

pagesEl.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".flayer, .tedit, .ctx")) return;
  const hit = pageAt(e);
  if (!hit) return;
  if (S.prefs.penOnly && S.tool === "ink" && e.pointerType === "touch") return;
  const { entry, x, y } = hit;
  const tool = S.tool;
  closeMenu();

  if (S.pending) {
    e.preventDefault();
    placePending(entry, x, y);
    return;
  }
  if (tool === "select") {
    const sel = selectedObj();
    if (sel && S.sel.entry === entry.id) {
      const h = handlesOf(entry, sel).find((h) => Math.hypot(h.x - x, h.y - y) < 18);
      if (h) { e.preventDefault(); snapshot(); drag = { mode: "resize", entry, o: sel, h: h.k }; return; }
    }
    for (let i = entry.edits.length - 1; i >= 0; i--) {
      const o = entry.edits[i];
      if (hitObj(entry, o, x, y)) {
        e.preventDefault();
        select(entry, o);
        drag = { mode: "move", entry, o, x, y, orig: clone(o), snapped: false };
        return;
      }
    }
    if (S.sel) select(entry, null);
    return;
  }
  if (tool === "edit") {
    e.preventDefault();
    const sel = selectedObj();
    if (sel && sel.t === "ximg" && S.sel.entry === entry.id) {
      const h = handlesOf(entry, sel).find((h) => Math.hypot(h.x - x, h.y - y) < 18);
      if (h) { snapshot(); drag = { mode: "resize", entry, o: sel, h: h.k }; return; }
    }
    for (let i = entry.edits.length - 1; i >= 0; i--) {
      const o = entry.edits[i];
      if (o.t === "ximg" && hitObj(entry, o, x, y)) { select(entry, o); drag = { mode: "move", entry, o, x, y, orig: clone(o), snapped: false }; return; }
    }
    if (entry.analyzed) {
      const u = entry.vp.convertToPdfPoint(x, y);
      const onText = (entry.xlines || []).some((l) => u[0] >= l.rect[0] - 2 && u[0] <= l.rect[2] + 2 && u[1] >= l.rect[1] - 1 && u[1] <= l.rect[3] + 1);
      const pic = !onText && pictureAt(entry, u);
      if (pic) { const o = pictureObject(entry, pic); select(entry, o); drag = { mode: "move", entry, o, x, y, orig: clone(o), snapped: false }; return; }
    }
    editPoint(entry, x, y);
    return;
  }
  if (tool === "text") {
    e.preventDefault();
    for (let i = entry.edits.length - 1; i >= 0; i--) if (entry.edits[i].t === "text" && hitObj(entry, entry.edits[i], x, y)) { openTextEditor(entry, entry.edits[i], false); return; }
    const k = entry.vp.scale, P = S.prefs;
    const w = Math.min(220, entry.dim.w - 24);
    const o = { t: "text", p: entry.vp.convertToPdfPoint(x, y), ang: entry.vp.rotation, w, text: "", size: P.size, color: P.color, font: P.font, bold: P.bold, italic: P.italic };
    snapshot(); o.id = uid(); entry.edits.push(o);
    openTextEditor(entry, o, true);
    return;
  }
  if (tool === "note") {
    e.preventDefault();
    const p = entry.vp.convertToPdfPoint(x, y);
    askText("Note", "", (text) => { if (text) addObj(entry, { t: "note", p, text, color: "#fdd835" }); });
    return;
  }
  if (DRAW_TOOLS.has(tool)) {
    e.preventDefault();
    const vp = entry.vp, u = vp.convertToPdfPoint(x, y), P = S.prefs;
    let o;
    if (tool === "ink") o = { t: "ink", pts: [u], color: P.color, w: P.width };
    else if (tool === "area") o = { t: "hl", rects: [], color: P.hl, op: 0.45, a: u };
    else if (tool === "crop") o = { t: "crop", a: u };
    else o = { t, a: u, b: u, color: tool === "redact" ? "#000000" : P.color, w: P.width };
    drag = { mode: "draw", entry, o, id: e.pointerId };
    return;
  }
});

window.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const { entry } = drag;
  const r = entry.el.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top, vp = entry.vp;
  if (drag.mode === "draw") {
    e.preventDefault();
    const o = drag.o, u = vp.convertToPdfPoint(x, y);
    if (o.t === "ink") o.pts.push(u);
    else if (o.t === "hl" || o.t === "crop") { o.b = u; entry.cropBox = null; const rect = [Math.min(o.a[0], u[0]), Math.min(o.a[1], u[1]), Math.max(o.a[0], u[0]), Math.max(o.a[1], u[1])]; if (o.t === "hl") o.rects = [rect]; else entry.cropBox = rect; }
    else o.b = u;
    entry.tmp = o.t === "crop" ? null : o;
    drawOverlay(entry);
  } else if (drag.mode === "move") {
    e.preventDefault();
    if (!drag.snapped && Math.hypot(x - drag.x, y - drag.y) < 4) return;
    if (!drag.snapped) { drag.snapped = true; snapshot(); }
    const a = vp.convertToPdfPoint(drag.x, drag.y), b = vp.convertToPdfPoint(x, y), dx = b[0] - a[0], dy = b[1] - a[1];
    moveObj(drag.o, drag.orig, dx, dy);
    if (drag.o.t === "ximg") drag.o.unchanged = false;
    drawOverlay(entry);
    positionCtx();
  } else if (drag.mode === "resize") {
    e.preventDefault();
    resizeObj(entry, drag.o, drag.h, x, y);
    if (drag.o.t === "ximg") { drag.o.unchanged = false; keepAspect(drag.o, drag.h); }
    drawOverlay(entry);
    positionCtx();
  }
}, { passive: false });

function keepAspect(o, h) {
  const w0 = o.box0[2] - o.box0[0], h0 = o.box0[3] - o.box0[1];
  if (!(w0 > 0 && h0 > 0)) return;
  const asp = h0 / w0;
  const w = Math.max(8, o.b[0] - o.a[0]);
  if (h === "b") { o.b[0] = o.a[0] + w; o.b[1] = o.a[1] + w * asp; } else { o.a[0] = o.b[0] - w; o.a[1] = o.b[1] - w * asp; }
}
function moveObj(o, orig, dx, dy) {
  const mv = (p) => [p[0] + dx, p[1] + dy];
  if (o.p) o.p = mv(orig.p);
  if (o.a) { o.a = mv(orig.a); o.b = mv(orig.b); }
  if (o.pts) o.pts = orig.pts.map(mv);
  if (o.rects) o.rects = orig.rects.map((r) => [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]);
  if (o.segs) o.segs = orig.segs.map((s) => [s[0] + dx, s[1] + dy, s[2] + dx, s[3] + dy]);
}
function resizeObj(entry, o, h, x, y) {
  const vp = entry.vp, k = vp.scale;
  if (BOXED.has(o.t)) {
    const f = boxFrame(entry, o), [lx, ly] = toLocal(f, x, y);
    if (o.t === "text") o.w = Math.max(40, lx / k);
    else if (o.t === "img") { const ratio = o.h / o.w; o.w = Math.max(16, lx / k); o.h = o.w * ratio; }
    else { o.w = Math.max(30, lx / k); o.h = Math.max(14, ly / k); }
  } else o[h] = vp.convertToPdfPoint(x, y);
}

window.addEventListener("pointerup", () => {
  if (!drag) return;
  const d = drag; drag = null;
  const { entry, o } = d;
  if (d.mode === "draw") {
    entry.tmp = null;
    let keep = true;
    if (o.t === "ink") keep = o.pts.length > 1 || true;
    else if (o.t === "hl") { keep = o.rects.length && Math.abs(o.rects[0][2] - o.rects[0][0]) > 3; delete o.a; delete o.b; }
    else if (o.t === "crop") {
      keep = false;
      const rect = entry.cropBox; entry.cropBox = null;
      if (rect && rect[2] - rect[0] > 12 && rect[3] - rect[1] > 12) applyCrop(entry, rect);
    } else keep = Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]) > 4;
    if (keep) { addObj(entry, o); if (o.t === "redact") toast("Redaction is applied when you save: the content under it is destroyed."); }
    drawOverlay(entry);
  } else if (d.mode === "move" || d.mode === "resize") { S.dirty = true; showCtx(); }
});

async function applyCrop(entry, rect) {
  snapshot();
  const targets = S.cropAll ? S.pages : [entry];
  for (const p of targets) {
    let r = rect;
    if (p !== entry) { /* same user-space box on every page, clipped to its media box below */ }
    p.crop = r.slice();
  }
  await relayoutKeepScroll();
  toast("Cropped.");
}

// Native text selection becomes a highlight, underline or strike-out.
let selTimer = 0;
document.addEventListener("selectionchange", () => {
  if (!["hl", "ul", "st"].includes(S.tool)) return;
  clearTimeout(selTimer);
  selTimer = setTimeout(markupFromSelection, 350);
});
function markupFromSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const rects = Array.from(sel.getRangeAt(0).getClientRects()).filter((r) => r.width > 1 && r.height > 1);
  if (!rects.length) return;
  const made = [];
  for (const entry of S.pages) {
    if (!entry.el || !entry.vp) continue;
    const pr = entry.el.getBoundingClientRect(), vp = entry.vp, mine = [];
    for (const r of rects) { const cx = r.left + r.width / 2, cy = r.top + r.height / 2; if (cx >= pr.left && cx <= pr.right && cy >= pr.top && cy <= pr.bottom) mine.push({ x: r.left - pr.left, y: r.top - pr.top, w: r.width, h: r.height }); }
    if (!mine.length) continue;
    let o;
    if (S.tool === "hl") o = { t: "hl", color: S.prefs.hl, op: 0.45, rects: mine.map((m) => userRect(vp, m.x, m.y, m.x + m.w, m.y + m.h)) };
    else o = { t: S.tool, color: S.prefs.color, w: 1.3, segs: mine.map((m) => { const yy = S.tool === "ul" ? m.y + m.h * 0.92 : m.y + m.h * 0.55; const a = vp.convertToPdfPoint(m.x, yy), b = vp.convertToPdfPoint(m.x + m.w, yy); return [a[0], a[1], b[0], b[1]]; }) };
    made.push([entry, o]);
  }
  if (!made.length) return;
  snapshot();
  for (const [entry, o] of made) { o.id = uid(); entry.edits.push(o); drawOverlay(entry); }
  sel.removeAllRanges();
}

// ------------------------------------------------------------------ context bar for the selected object
function closeCtx() { $$(".ctx").forEach((n) => n.remove()); document.body.classList.remove("grab"); }
function showCtx() {
  $$(".ctx").forEach((n) => n.remove());
  const o = selectedObj(), entry = S.sel && entryById(S.sel.entry);
  if (!o || !entry || !entry.el) return;
  const bar = document.createElement("div");
  bar.className = "ctx";
  const btn = (act, label, title) => `<button class="btn sm" data-ctx="${act}" title="${title}">${label}</button>`;
  let h = "";
  if (o.t === "text" || o.t === "note" || o.t === "tedit") h += btn("edit", "Edit", "Edit text");
  if (o.t === "ximg") h += btn("replace", "Replace", "Use a different picture") + btn("xdel", "Delete", "Delete this picture") + btn("reset", "Reset", "Put the original back");
  if (o.t === "tedit") h += btn("reset", "Restore", "Put the original text back");
  if (o.t === "text") h += btn("sizeDown", "A&#8722;", "Smaller") + btn("sizeUp", "A+", "Larger");
  if (["ink", "rect", "ell", "line", "arrow"].includes(o.t)) h += btn("wDown", "&#8722;", "Thinner") + btn("wUp", "+", "Thicker");
  if (o.color !== undefined && o.t !== "note" && o.t !== "redact" && o.t !== "white") h += btn("color", `<span class="sw" style="width:18px;height:18px;background:${o.color}"></span>`, "Color");
  if (o.t !== "ximg" && o.t !== "tedit") h += btn("dup", "Copy", "Duplicate") + btn("del", "Delete", "Delete");
  bar.innerHTML = h;
  bar.onclick = (e) => { const b = e.target.closest("[data-ctx]"); if (b) ctxAction(b.dataset.ctx, b); };
  bar.addEventListener("pointerdown", (e) => e.stopPropagation());
  entry.el.appendChild(bar);
  positionCtx();
}
function positionCtx() {
  const bar = $(".ctx"), o = selectedObj(), entry = S.sel && entryById(S.sel.entry);
  if (!bar || !o || !entry) return;
  const b = objBounds(entry, o);
  bar.style.left = clamp(b.x, 4, Math.max(4, entry.el.offsetWidth - bar.offsetWidth - 4)) + "px";
  bar.style.top = (b.y > 52 ? b.y - 48 : b.y + b.h + 8) + "px";
}
function ctxAction(a, btn) {
  const o = selectedObj(), entry = S.sel && entryById(S.sel.entry);
  if (!o || !entry) return;
  if (o.t === "ximg" && (a === "del" || a === "xdel")) { snapshot(); o.del = true; o.unchanged = false; select(entry, null); drawOverlay(entry); return; }
  if ((o.t === "ximg" || o.t === "tedit") && (a === "reset" || a === "del")) { snapshot(); entry.edits = entry.edits.filter((x) => x !== o); select(entry, null); return; }
  if (a === "replace") return replaceImage(entry, o);
  if (o.t === "tedit" && a === "edit") return openLineEditor(entry, { text: o.text, x0: o.base[0], x1: o.rect[2], y: o.base[1], size: o.size, font: o.font, bold: o.bold, italic: o.italic, rect: o.rect, fg: o.fg, bg: o.bg }, o);
  if (a === "del") { snapshot(); entry.edits = entry.edits.filter((x) => x !== o); select(entry, null); return; }
  if (a === "dup") { snapshot(); const c = clone(o); c.id = uid(); const d = 14 / entry.vp.scale; if (c.p) c.p = [c.p[0] + d, c.p[1] - d]; if (c.a) { c.a = [c.a[0] + d, c.a[1] - d]; c.b = [c.b[0] + d, c.b[1] - d]; } if (c.pts) c.pts = c.pts.map((p) => [p[0] + d, p[1] - d]); if (c.rects) c.rects = c.rects.map((r) => [r[0] + d, r[1] - d, r[2] + d, r[3] - d]); if (c.segs) c.segs = c.segs.map((s) => [s[0] + d, s[1] - d, s[2] + d, s[3] - d]); entry.edits.push(c); select(entry, c); return; }
  if (a === "edit") { if (o.t === "text") openTextEditor(entry, o, false); else askText("Note", o.text, (t) => { snapshot(); o.text = t; }); return; }
  if (a === "sizeUp" || a === "sizeDown") { snapshot(); o.size = clamp(o.size + (a === "sizeUp" ? 2 : -2), 6, 96); }
  if (a === "wUp" || a === "wDown") { snapshot(); o.w = clamp(o.w + (a === "wUp" ? 1 : -1), 0.5, 24); }
  if (a === "color") { showMenu(btn, `<div class="chips">${COLORS.map((c) => `<button class="sw" data-pick="${c}" style="background:${c}"></button>`).join("")}</div>`, (el) => { const c = el.closest("[data-pick]")?.dataset.pick; if (c) { snapshot(); o.color = c; drawOverlay(entry); showCtx(); closeMenu(); } }); return; }
  drawOverlay(entry); positionCtx();
}

// ------------------------------------------------------------------ text editing in place
function closeEditor() { const t = $(".tedit"); if (t) t.blur(); }
function openTextEditor(entry, o, isNew) {
  closeEditor(); select(entry, null);
  if (!isNew) snapshot();
  const k = entry.vp.scale, f = boxFrame(entry, o);
  const ta = document.createElement("textarea");
  ta.className = "tedit";
  ta.value = o.text;
  ta.style.cssText = `left:${f.sx}px;top:${f.sy}px;width:${f.w}px;height:${Math.max(f.h, o.size * LH * k + 6 * k)}px;transform:rotate(${f.rel}deg);transform-origin:0 0;font-size:${o.size * k}px;line-height:${LH};padding:${3 * k}px ${4 * k}px;color:${o.color};font-family:${CSS_FONT[o.font || "Helvetica"]};font-weight:${o.bold ? 700 : 400};font-style:${o.italic ? "italic" : "normal"}`;
  o.editing = true;
  drawOverlay(entry);
  entry.el.appendChild(ta);
  ta.focus();
  const fit = () => { ta.style.height = "auto"; ta.style.height = Math.max(ta.scrollHeight, o.size * LH * k + 6 * k) + "px"; };
  ta.oninput = () => { o.text = ta.value; fit(); };
  ta.onblur = () => {
    ta.remove(); delete o.editing;
    if (!o.text.trim()) { entry.edits = entry.edits.filter((x) => x !== o); if (isNew) S.undo.pop(); refreshButtons(); }
    else { S.dirty = true; if (isNew) { S.dirty = true; } }
    drawOverlay(entry);
    if (o.text.trim()) { setTool("select"); select(entry, o); }
  };
  ta.onkeydown = (e) => { if (e.key === "Escape") ta.blur(); };
  fit();
}

// ------------------------------------------------------------------ small dialogs
function showDialog(html, onMount) {
  $("#dlgBody").innerHTML = html;
  $("#dialog").hidden = false;
  onMount && onMount($("#dlgBody"));
}
function closeDialog() { $("#dialog").hidden = true; $("#dlgBody").innerHTML = ""; }
function askText(title, value, cb) {
  showDialog(`<h3>${esc(title)}</h3><textarea id="askBox" rows="4" style="width:100%">${esc(value || "")}</textarea><div class="actions"><button class="btn" id="askNo">Cancel</button><button class="btn primary" id="askYes">OK</button></div>`, (b) => {
    const box = $("#askBox", b); box.focus();
    $("#askNo", b).onclick = closeDialog;
    $("#askYes", b).onclick = () => { const v = box.value.trim(); closeDialog(); cb(v); };
  });
}

let menuClose = null;
function showMenu(anchor, html, onClick) {
  const m = $("#menu");
  m.innerHTML = html;
  m.hidden = false;
  const r = anchor.getBoundingClientRect();
  m.style.left = clamp(r.left, 6, window.innerWidth - m.offsetWidth - 6) + "px";
  m.style.top = clamp(r.bottom + 6, 6, window.innerHeight - m.offsetHeight - 6) + "px";
  m.onclick = (e) => onClick(e.target);
}
function closeMenu() { $("#menu").hidden = true; }
document.addEventListener("pointerdown", (e) => { if (!e.target.closest("#menu, #btnMore, .ctx")) closeMenu(); });

// ------------------------------------------------------------------ placing signatures, pictures and stamps
function placePending(entry, x, y) {
  const P = S.pending; S.pending = null;
  const vp = entry.vp, k = vp.scale;
  const w = P.w, h = P.h;
  const p = vp.convertToPdfPoint(x - (w * k) / 2, y - (h * k) / 2);
  const o = P.kind === "stamp" ? { t: "stamp", label: P.label, color: P.color, p, ang: vp.rotation, w, h } : { t: "img", img: P.img, p, ang: vp.rotation, w, h };
  setTool("select");
  addObj(entry, o);
  select(entry, o);
}

function setPending(p) {
  S.pending = p;
  S.tool = "select";
  $$(".tool").forEach((b) => b.classList.remove("on"));
  document.body.className = "tool-select";
  renderPropbar();
  toast("Tap the page where it should go.", 4000);
}

function openStampDialog() {
  const presets = ["APPROVED", "REJECTED", "DRAFT", "CONFIDENTIAL", "PAID", "COPY", "RECEIVED", "REVIEWED"];
  const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  let color = "#e53935", label = "APPROVED";
  showDialog(`<h3>Stamp</h3>
    <div class="chips" id="stPresets">${presets.concat(["\u2713", "\u2717", today]).map((t) => `<button class="chip" data-l="${esc(t)}">${esc(t)}</button>`).join("")}</div>
    <label>Custom text</label><input type="text" id="stText" value="APPROVED">
    <label>Color</label><div class="chips" id="stColors">${["#e53935", "#43a047", "#1e88e5", "#8e24aa", "#fb8c00", "#000000"].map((c) => `<button class="sw" data-c="${c}" style="background:${c}"></button>`).join("")}</div>
    <div class="actions"><button class="btn" id="stNo">Cancel</button><button class="btn primary" id="stYes">Place stamp</button></div>`, (b) => {
    b.onclick = (e) => {
      const ch = e.target.closest("[data-l]"), cc = e.target.closest("[data-c]");
      if (ch) { label = ch.dataset.l; $("#stText", b).value = label; }
      if (cc) color = cc.dataset.c;
    };
    $("#stNo", b).onclick = closeDialog;
    $("#stYes", b).onclick = () => {
      label = $("#stText", b).value.trim() || label;
      closeDialog();
      const h = 34, w = Math.max(70, Math.min(320, label.length * 15 + 24));
      setPending({ kind: "stamp", label, color, w, h });
    };
  });
}

async function normalizeImage(file) {
  // pdf-lib embeds PNG and JPEG only; anything else is redrawn as PNG.
  const url = await readDataUrl(file);
  if (/^data:image\/(png|jpeg)/.test(url)) { const im = await loadImage(url); return { url, w: im.naturalWidth, h: im.naturalHeight }; }
  const im = await loadImage(url);
  const c = document.createElement("canvas"); c.width = im.naturalWidth; c.height = im.naturalHeight;
  c.getContext("2d").drawImage(im, 0, 0);
  return { url: c.toDataURL("image/png"), w: c.width, h: c.height };
}

$("#imgIn").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try {
    const im = await normalizeImage(f);
    const w = Math.min(220, im.w * 0.75), h = (w * im.h) / im.w;
    setPending({ kind: "img", img: addImage(im.url), w, h });
  } catch { toast("That picture could not be read."); }
});

// ------------------------------------------------------------------ signatures
function trimCanvas(c) {
  const ctx = c.getContext("2d"), { width: W, height: H } = c, d = ctx.getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 <= x0 || y1 <= y0) return null;
  const pad = 6, out = document.createElement("canvas");
  out.width = x1 - x0 + 1 + pad * 2; out.height = y1 - y0 + 1 + pad * 2;
  out.getContext("2d").drawImage(c, x0, y0, x1 - x0 + 1, y1 - y0 + 1, pad, pad, x1 - x0 + 1, y1 - y0 + 1);
  return out;
}
const loadSigs = () => { try { return JSON.parse(window.wpStore?.getItem("pdf.sigs") || "[]"); } catch { return []; } };
const saveSigs = (a) => { try { window.wpStore?.setItem("pdf.sigs", JSON.stringify(a.slice(0, 8))); } catch {} };

function openSignDialog() {
  const sigs = loadSigs();
  let mode = "draw", color = "#111111", dataUrl = null;
  showDialog(`<h3>Signature</h3>
    ${sigs.length ? `<div class="muted">Saved</div><div class="chips" id="sgSaved">${sigs.map((s, i) => `<img class="sigimg" data-i="${i}" src="${s}" alt="saved signature">`).join("")}</div>` : ""}
    <div class="chips" id="sgTabs"><button class="chip on" data-m="draw">Draw</button><button class="chip" data-m="type">Type</button><button class="chip" data-m="image">Picture</button></div>
    <div id="sgDraw"><canvas class="sigpad" id="sgPad"></canvas></div>
    <div id="sgType" hidden><input type="text" id="sgText" placeholder="Your name"><div class="chips" id="sgFonts"></div><canvas id="sgPrev" class="sigpad" style="height:100px"></canvas></div>
    <div id="sgImage" hidden><input type="file" id="sgFile" accept="image/*"><label><input type="checkbox" id="sgKey" checked> Make the white background transparent</label><canvas id="sgImgPrev" class="sigpad" style="height:120px"></canvas></div>
    <div class="chips" id="sgColors">${["#111111", "#1e3a8a", "#0b6b3a"].map((c) => `<button class="sw ${c === color ? "on" : ""}" data-c="${c}" style="background:${c}"></button>`).join("")}</div>
    <label><input type="checkbox" id="sgKeep" checked> Keep this signature on this device</label>
    <div class="actions"><button class="btn" id="sgClear">Clear</button><button class="btn" id="sgNo">Cancel</button><button class="btn primary" id="sgYes">Use signature</button></div>`, (b) => {
    const pad = $("#sgPad", b), pctx = pad.getContext("2d");
    const sizePad = () => { const r = pad.getBoundingClientRect(); pad.width = Math.max(300, r.width * 2); pad.height = r.height * 2; pctx.lineCap = "round"; pctx.lineJoin = "round"; };
    sizePad();
    let down = false, last = null;
    const pos = (e) => { const r = pad.getBoundingClientRect(); return [((e.clientX - r.left) * pad.width) / r.width, ((e.clientY - r.top) * pad.height) / r.height]; };
    pad.onpointerdown = (e) => { down = true; last = pos(e); pad.setPointerCapture(e.pointerId); pctx.strokeStyle = color; pctx.lineWidth = 5; pctx.beginPath(); pctx.moveTo(...last); pctx.lineTo(last[0] + 0.1, last[1]); pctx.stroke(); };
    pad.onpointermove = (e) => { if (!down) return; const p = pos(e); pctx.strokeStyle = color; pctx.lineWidth = 3 + (e.pressure || 0.5) * 4; pctx.beginPath(); pctx.moveTo(...last); pctx.lineTo(...p); pctx.stroke(); last = p; };
    pad.onpointerup = pad.onpointercancel = () => { down = false; };
    const fonts = ['"Snell Roundhand", "Brush Script MT", cursive', '"Segoe Script", "Bradley Hand", cursive', '"Zapfino", "Apple Chancery", cursive', 'italic 1em "Times New Roman", serif'];
    let fontIdx = 0;
    const prev = $("#sgPrev", b);
    const drawType = () => {
      const r = prev.getBoundingClientRect(); prev.width = Math.max(300, r.width * 2); prev.height = r.height * 2;
      const c = prev.getContext("2d"); c.clearRect(0, 0, prev.width, prev.height);
      const t = $("#sgText", b).value || "";
      c.fillStyle = color; c.textBaseline = "middle"; c.font = `${prev.height * 0.5}px ${fonts[fontIdx]}`; c.fillText(t, 16, prev.height / 2);
    };
    $("#sgFonts", b).innerHTML = fonts.map((f, i) => `<button class="chip ${i === 0 ? "on" : ""}" data-f="${i}" style="font:22px ${f}">Signature</button>`).join("");
    $("#sgText", b).oninput = drawType;
    let imgCanvas = null;
    const imgPrev = $("#sgImgPrev", b);
    const drawImg = (im) => {
      const c = document.createElement("canvas"); c.width = im.naturalWidth; c.height = im.naturalHeight;
      const x = c.getContext("2d"); x.drawImage(im, 0, 0);
      if ($("#sgKey", b).checked) { const d = x.getImageData(0, 0, c.width, c.height), a = d.data; for (let i = 0; i < a.length; i += 4) { const lum = (a[i] + a[i + 1] + a[i + 2]) / 3; if (lum > 215) a[i + 3] = 0; else if (lum > 150) a[i + 3] = Math.round(((215 - lum) / 65) * 255); } x.putImageData(d, 0, 0); }
      imgCanvas = c;
      imgPrev.width = 600; imgPrev.height = 240;
      const px = imgPrev.getContext("2d"); px.clearRect(0, 0, 600, 240); const sc = Math.min(600 / c.width, 240 / c.height); px.drawImage(c, 0, 0, c.width * sc, c.height * sc);
    };
    let lastImg = null;
    $("#sgFile", b).onchange = async (e) => { const f = e.target.files[0]; if (!f) return; lastImg = await loadImage(await readDataUrl(f)); drawImg(lastImg); };
    $("#sgKey", b).onchange = () => lastImg && drawImg(lastImg);
    b.onclick = (e) => {
      const m = e.target.closest("[data-m]"), c = e.target.closest("#sgColors [data-c]"), f = e.target.closest("[data-f]"), s = e.target.closest("[data-i]");
      if (m) { mode = m.dataset.m; $$("#sgTabs .chip", b).forEach((n) => n.classList.toggle("on", n === m)); $("#sgDraw", b).hidden = mode !== "draw"; $("#sgType", b).hidden = mode !== "type"; $("#sgImage", b).hidden = mode !== "image"; if (mode === "type") drawType(); if (mode === "draw") sizePad(); }
      if (c) { color = c.dataset.c; $$("#sgColors .sw", b).forEach((n) => n.classList.toggle("on", n === c)); if (mode === "type") drawType(); }
      if (f) { fontIdx = +f.dataset.f; $$("#sgFonts .chip", b).forEach((n) => n.classList.toggle("on", n === f)); drawType(); }
      if (s) { dataUrl = sigs[+s.dataset.i]; $("#sgYes", b).click(); }
    };
    $("#sgClear", b).onclick = () => { pctx.clearRect(0, 0, pad.width, pad.height); };
    $("#sgNo", b).onclick = closeDialog;
    $("#sgYes", b).onclick = async () => {
      let url = dataUrl;
      if (!url) {
        const src = mode === "draw" ? pad : mode === "type" ? prev : imgCanvas;
        const t = src && trimCanvas(src);
        if (!t) { toast("Draw, type or choose a signature first."); return; }
        url = t.toDataURL("image/png");
        if ($("#sgKeep", b).checked) saveSigs([url, ...sigs.filter((x) => x !== url)]);
      }
      closeDialog();
      const im = await loadImage(url), w = 150, h = (w * im.naturalHeight) / im.naturalWidth;
      setPending({ kind: "img", img: addImage(url), w, h });
    };
  });
}

// ------------------------------------------------------------------ thumbnails, page tools
const thumbSel = new Set();
let thumbObserver = null;
function buildThumbs() {
  const host = $("#thumbs");
  host.innerHTML = "";
  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = new IntersectionObserver((items) => { for (const it of items) if (it.isIntersecting) { const e = S.pages.find((p) => p.id === it.target.dataset.id); if (e) renderThumb(e, it.target); } }, { root: $("#tab-thumbs"), rootMargin: "400px 0px" });
  S.pages.forEach((entry, i) => {
    const d = document.createElement("div");
    d.className = "thumb" + (thumbSel.has(entry.id) ? " sel" : "");
    d.dataset.id = entry.id;
    d.innerHTML = `<input type="checkbox" class="ck" ${thumbSel.has(entry.id) ? "checked" : ""} aria-label="Select page ${i + 1}"><div class="cv"></div><div class="n">${i + 1}</div>`;
    host.appendChild(d);
    thumbObserver.observe(d);
  });
  renderPageActions();
}
async function renderThumb(entry, node) {
  const cv = $(".cv", node);
  if (cv.firstChild && cv.dataset.key === entry.rot + "|" + (entry.crop || "") + "|" + entry.edits.length) return;
  try {
    const vp0 = await viewportFor(entry, 1);
    const k = 130 / vp0.width;
    const vp = await viewportFor(entry, k);
    const c = document.createElement("canvas");
    c.width = Math.floor(vp.width * 1.5); c.height = Math.floor(vp.height * 1.5);
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    if (!entry.blank) { const page = await getPageObj(entry); await page.render({ canvasContext: ctx, viewport: vp, transform: [1.5, 0, 0, 1.5, 0, 0], annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise; }
    cv.innerHTML = ""; cv.appendChild(c); cv.dataset.key = entry.rot + "|" + (entry.crop || "") + "|" + entry.edits.length;
  } catch {}
}
function updateThumbFor(entry) {
  const node = $(`.thumb[data-id="${entry.id}"]`);
  if (node && !$("#side").hidden) { const cv = $(".cv", node); cv.dataset.key = ""; renderThumb(entry, node); }
}
$("#thumbs").addEventListener("click", (e) => {
  const node = e.target.closest(".thumb");
  if (!node) return;
  const id = node.dataset.id;
  if (e.target.classList.contains("ck")) { thumbSel.has(id) ? thumbSel.delete(id) : thumbSel.add(id); node.classList.toggle("sel", thumbSel.has(id)); return; }
  const i = S.pages.findIndex((p) => p.id === id);
  scrollToPage(i);
  if (window.innerWidth <= 1000) $("#side").hidden = true;
});

function renderPageActions() {
  $("#pageActions").innerHTML = ["rotL|&#10226; Left", "rotR|&#10227; Right", "up|&#9650; Up", "down|&#9660; Down", "dup|Copy", "del|Delete", "blank|+ Blank", "extract|Extract", "all|All", "none|None"].map((s) => { const [a, l] = s.split("|"); return `<button class="btn sm" data-pa="${a}">${l}</button>`; }).join("");
}
$("#pageActions").addEventListener("click", (e) => { const b = e.target.closest("[data-pa]"); if (b) pageAction(b.dataset.pa); });

function targetEntries() {
  const sel = S.pages.filter((p) => thumbSel.has(p.id));
  return sel.length ? sel : [S.pages[currentPageIndex()]].filter(Boolean);
}
async function refreshEntry(entry) {
  entry.renderedKey = null; entry.rtoken++;
  if (entry.dim) entry.dim = null;
  try { const vp = await viewportFor(entry, 1); entry.dim = { w: vp.width, h: vp.height }; } catch {}
  sizePageEl(entry);
  queueRender(entry);
  updateThumbFor(entry);
}
async function pageAction(a) {
  if (!S.pages.length) return;
  if (a === "all") { S.pages.forEach((p) => thumbSel.add(p.id)); return buildThumbs(); }
  if (a === "none") { thumbSel.clear(); return buildThumbs(); }
  const ts = targetEntries();
  if (a === "rotL" || a === "rotR") { snapshot(); for (const e of ts) { e.rot = (e.rot + (a === "rotR" ? 90 : 270)) % 360; await refreshEntry(e); } return; }
  if (a === "del") { if (ts.length >= S.pages.length) return toast("A document needs at least one page."); snapshot(); S.pages = S.pages.filter((p) => !ts.includes(p)); ts.forEach((p) => thumbSel.delete(p.id)); await relayoutKeepScroll(); return; }
  if (a === "dup") { snapshot(); const out = []; for (const p of S.pages) { out.push(p); if (ts.includes(p)) { const c = clone({ ...p, el: null, vp: null, rtask: null }); c.id = uid(); c.edits.forEach((o) => (o.id = uid())); c.dim = p.dim; out.push(c); } } S.pages = out; await relayoutKeepScroll(); return; }
  if (a === "up" || a === "down") {
    snapshot();
    const arr = S.pages.slice();
    const idxs = ts.map((t) => arr.indexOf(t)).sort((x, y) => x - y);
    if (a === "up") { if (idxs[0] === 0) { S.undo.pop(); return; } for (const i of idxs) [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; }
    else { if (idxs[idxs.length - 1] === arr.length - 1) { S.undo.pop(); return; } for (const i of idxs.reverse()) [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]]; }
    S.pages = arr; await relayoutKeepScroll(); return;
  }
  if (a === "blank") return openBlankDialog();
  if (a === "extract") { const only = new Set(ts.map((t) => t.id)); const bytes = await buildPdf({ only }); downloadBlob(new Blob([bytes], { type: "application/pdf" }), baseName(S.fileName) + "-extract.pdf"); return toast(`Extracted ${only.size} page(s).`); }
}

function openBlankDialog() {
  const cur = S.pages[currentPageIndex()];
  showDialog(`<h3>Insert blank pages</h3>
    <label>Size</label><select id="bkSize"><option value="same">Same as the current page</option>${Object.keys(PAPER).map((k) => `<option ${k.startsWith("Folio") ? "selected" : ""}>${k}</option>`).join("")}</select>
    <div class="two"><div><label>How many</label><input type="number" id="bkN" min="1" max="50" value="1"></div><div><label>Where</label><select id="bkWhere"><option value="after">After the current page</option><option value="before">Before it</option><option value="end">At the end</option></select></div></div>
    <div class="actions"><button class="btn" id="bkNo">Cancel</button><button class="btn primary" id="bkYes">Insert</button></div>`, (b) => {
    $("#bkNo", b).onclick = closeDialog;
    $("#bkYes", b).onclick = async () => {
      const sz = $("#bkSize", b).value, n = clamp(+$("#bkN", b).value || 1, 1, 50), where = $("#bkWhere", b).value;
      let dim = sz === "same" ? { w: cur?.dim?.w || 612, h: cur?.dim?.h || 792 } : { w: PAPER[sz][0], h: PAPER[sz][1] };
      closeDialog(); snapshot();
      const at = where === "end" ? S.pages.length : currentPageIndex() + (where === "after" ? 1 : 0);
      const add = Array.from({ length: n }, () => ({ id: uid(), src: -1, idx: 0, rot: 0, edits: [], crop: null, blank: { w: dim.w, h: dim.h } }));
      S.pages.splice(at, 0, ...add);
      await relayoutKeepScroll(); scrollToPage(at);
    };
  });
}

// Insert pages from another PDF, or pictures as pages.
async function insertFiles(files, at) {
  if (!files.length) return;
  toast("Adding pages...", 0);
  try {
    snapshot();
    const add = [];
    for (const f of files) {
      if (/pdf$/i.test(f.type) || /\.pdf$/i.test(f.name)) {
        const src = await openPdfBytes(await readFile(f), f.name);
        S.sources.push(src);
        add.push(...newEntries(S.sources.length - 1, src.pdf.numPages));
      } else if (f.type.startsWith("image/")) {
        const im = await normalizeImage(f);
        add.push(imagePageEntry(im));
      }
    }
    if (!add.length) { S.undo.pop(); return toast("Nothing to add."); }
    if (at === undefined) at = S.pages.length ? currentPageIndex() + 1 : 0;
    S.pages.splice(at, 0, ...add);
    $("#empty").hidden = true;
    await relayoutKeepScroll(); scrollToPage(at);
    toast(`Added ${add.length} page(s).`);
  } catch (e) { console.error(e); toast("Could not add those files."); }
}
function imagePageEntry(im, paper = "Folio 8.5 x 13 in") {
  let [pw, ph] = PAPER[paper] || PAPER["Letter 8.5 x 11 in"];
  const land = im.w > im.h; if (land) [pw, ph] = [ph, pw];
  const m = 24, sc = Math.min((pw - 2 * m) / im.w, (ph - 2 * m) / im.h);
  const w = im.w * sc, h = im.h * sc;
  const e = { id: uid(), src: -1, idx: 0, rot: 0, crop: null, blank: { w: pw, h: ph }, edits: [] };
  e.edits.push({ id: uid(), t: "img", img: addImage(im.url), p: [(pw - w) / 2, ph - (ph - h) / 2], ang: 0, w, h });
  return e;
}


// ------------------------------------------------------------------ editing what is already on the page
const mmul = (A, B) => [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3], A[4] * B[0] + A[5] * B[2] + B[4], A[4] * B[1] + A[5] * B[3] + B[5]];
const minv = (M) => { const d = M[0] * M[3] - M[1] * M[2]; return d ? [M[3] / d, -M[1] / d, -M[2] / d, M[0] / d, (M[2] * M[5] - M[3] * M[4]) / d, (M[1] * M[4] - M[0] * M[5]) / d] : [1, 0, 0, 1, 0, 0]; };
const latin = (u8, a, b) => { let s = ""; for (let i = a; i < b; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(b, i + 8192))); return s; };
const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set("()<>[]{}/%".split("").map((c) => c.charCodeAt(0)));

// Reads a page's drawing instructions and reports every picture it draws (`/Name Do`) with the
// transform in force, so the picture's place on the page and its exact bytes in the stream are known.
function scanContent(u8) {
  const n = u8.length, found = [], opd = [], stack = [], blocks = [];
  let ctm = [1, 0, 0, 1, 0, 0], i = 0, cur = null, tm = [1, 0, 0, 1, 0, 0], tlm = tm, lead = 0;
  while (i < n) {
    const c = u8[i];
    if (WS.has(c)) { i++; continue; }
    if (c === 0x25) { while (i < n && u8[i] !== 10 && u8[i] !== 13) i++; continue; }
    const a = i;
    if (c === 0x28) { let depth = 1; i++; while (i < n && depth) { const d = u8[i]; if (d === 0x5c) i += 2; else { if (d === 0x28) depth++; else if (d === 0x29) depth--; i++; } } opd.push({ t: "str", a, b: i }); continue; }
    if (c === 0x3c) { if (u8[i + 1] === 0x3c) { i += 2; opd.push({ t: "dict", a, b: i }); } else { while (i < n && u8[i] !== 0x3e) i++; i++; opd.push({ t: "hex", a, b: i }); } continue; }
    if (c === 0x3e) { i += u8[i + 1] === 0x3e ? 2 : 1; opd.push({ t: "dict", a, b: i }); continue; }
    if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x29) { i++; opd.push({ t: "delim", a, b: i }); continue; }
    if (c === 0x2f) { i++; while (i < n && !WS.has(u8[i]) && !DELIM.has(u8[i])) i++; opd.push({ t: "name", a, b: i, text: latin(u8, a + 1, i) }); continue; }
    while (i < n && !WS.has(u8[i]) && !DELIM.has(u8[i])) i++;
    const text = latin(u8, a, i);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) { opd.push({ t: "num", a, b: i, v: parseFloat(text) }); continue; }
    if (text === "q") stack.push(ctm);
    else if (text === "Q") { if (stack.length) ctm = stack.pop(); }
    else if (text === "cm") { const nums = opd.filter((o) => o.t === "num").slice(-6); if (nums.length === 6) ctm = mmul(nums.map((o) => o.v), ctm); }
    else if (text === "BT") { cur = { shows: [], complex: false }; tm = [1, 0, 0, 1, 0, 0]; tlm = tm; }
    else if (text === "ET") { if (cur) { blocks.push(cur); cur = null; } }
    else if (cur && text === "Tm") { const nums = opd.filter((o) => o.t === "num").slice(-6); if (nums.length === 6) { tm = nums.map((o) => o.v); tlm = tm; } }
    else if (cur && (text === "Td" || text === "TD")) { const nums = opd.filter((o) => o.t === "num").slice(-2); if (nums.length === 2) { tlm = mmul([1, 0, 0, 1, nums[0].v, nums[1].v], tlm); tm = tlm; if (text === "TD") lead = -nums[1].v; } }
    else if (cur && text === "TL") { const nm = opd.filter((o) => o.t === "num").slice(-1); if (nm.length) lead = nm[0].v; }
    else if (cur && text === "T*") { tlm = mmul([1, 0, 0, 1, 0, -lead], tlm); tm = tlm; }
    else if (cur && (text === "Tj" || text === "TJ")) {
      let k = opd.length - 1;
      if (text === "TJ") { while (k >= 0 && !(opd[k].t === "delim" && latin(u8, opd[k].a, opd[k].b) === "[")) k--; } 
      const start = k >= 0 ? opd[k].a : a;
      cur.shows.push({ x: tm[4] * ctm[0] + tm[5] * ctm[2] + ctm[4], y: tm[4] * ctm[1] + tm[5] * ctm[3] + ctm[5], a: start, b: i });
    }
    else if (cur && (text === "'" || text === '"')) cur.complex = true;
    else if (text === "Do") { const nm = opd[opd.length - 1]; if (nm && nm.t === "name") found.push({ name: nm.text, ctm: ctm.slice(), a: nm.a, b: i }); }
    else if (text === "BI") {
      let j = i;
      while (j < n - 2 && !(u8[j] === 0x49 && u8[j + 1] === 0x44 && WS.has(u8[j - 1]) && (j + 2 >= n || WS.has(u8[j + 2])))) j++;
      j += 3;
      while (j < n - 1 && !(u8[j] === 0x45 && u8[j + 1] === 0x49 && WS.has(u8[j - 1]) && (j + 2 >= n || WS.has(u8[j + 2])))) j++;
      i = j + 2;
    }
    opd.length = 0;
  }
  return { found, blocks };
}

function pageContentBytes(pg) {
  const node = pg.node, ctx = node.context;
  const c = node.Contents();
  const list = c instanceof PDFArray ? c.asArray().map((r) => ctx.lookup(r)) : c ? [c] : [];
  const parts = [];
  for (const st of list) {
    if (!st) continue;
    if (st instanceof L.PDFRawStream) parts.push(L.decodePDFRawStream(st).decode());
    else if (st.getUnencodedContents) parts.push(st.getUnencodedContents());
  }
  let len = 0; parts.forEach((x) => (len += x.length + 1));
  const out = new Uint8Array(len); let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; out[o++] = 10; }
  return out;
}
function pageResources(pg) {
  let node = pg.node, guard = 0;
  while (node && guard++ < 24) {
    const r = node.lookupMaybe(PDFName.of("Resources"), L.PDFDict);
    if (r) return r;
    node = node.lookupMaybe(PDFName.of("Parent"), L.PDFDict);
  }
  return null;
}
// The pictures (not forms) the page draws, in drawing order, numbered k = 0, 1, 2...
function pagePictures(pg) {
  const bytes = pageContentBytes(pg), res = pageResources(pg);
  const xo = res && res.lookupMaybe(PDFName.of("XObject"), L.PDFDict);
  const pics = [];
  for (const f of scanContent(bytes).found) {
    const obj = xo && xo.lookup(PDFName.of(f.name));
    const st = obj && obj.dict && obj.dict.get(PDFName.of("Subtype"));
    if (st !== PDFName.of("Image")) continue;
    const xs = [0, 1, 1, 0].map((u, j) => f.ctm[0] * u + f.ctm[2] * [0, 0, 1, 1][j] + f.ctm[4]);
    const ys = [0, 1, 1, 0].map((u, j) => f.ctm[1] * u + f.ctm[3] * [0, 0, 1, 1][j] + f.ctm[5]);
    pics.push({ k: pics.length, name: f.name, ctm: f.ctm, a: f.a, b: f.b, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
  }
  return { pics, bytes, res };
}
async function sourceLib(srcIdx) {
  const src = S.sources[srcIdx];
  if (!src.lib) src.lib = await PDFDocument.load(src.bytes, { ignoreEncryption: true, updateMetadata: false });
  return src.lib;
}

// Text lines (runs on the same baseline) the user can edit.
async function buildLines(entry) {
  const page = await getPageObj(entry);
  const tc = await page.getTextContent({ disableNormalization: true });
  const items = [];
  for (const it of tc.items) {
    if (it.str === undefined || !it.transform || !it.str.trim() && !it.str.length) continue;
    const t = it.transform;
    if (Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01) continue;
    const size = Math.abs(t[3]) || it.height || 10;
    let name = "", family = (tc.styles[it.fontName] || {}).fontFamily || "sans-serif";
    try { if (page.commonObjs.has(it.fontName)) name = page.commonObjs.get(it.fontName).name || ""; } catch {}
    const fam = /courier|mono|consolas/i.test(name) || family === "monospace" ? "Courier" : /times|serif|georgia|cambria|garamond|book|palatino/i.test(name) || family === "serif" ? "Times" : "Helvetica";
    items.push({ s: it.str, x: t[4], y: t[5], w: it.width || 0, size, fam, bold: /bold|black|heavy/i.test(name), italic: /italic|oblique/i.test(name) });
  }
  items.sort((p, q) => q.y - p.y || p.x - q.x);
  const lines = [];
  for (const it of items) {
    const ln = lines.find((l) => Math.abs(l.y - it.y) < 0.4 * Math.max(l.size, it.size) && it.x >= l.x1 - l.size * 0.3 && it.x - l.x1 < Math.max(l.size, it.size) * 2.5);
    if (ln) {
      const gap = it.x - ln.x1;
      if (gap > it.size * 0.18 && !ln.text.endsWith(" ") && !it.s.startsWith(" ")) ln.text += " ";
      ln.text += it.s; ln.x1 = it.x + it.w; ln.size = Math.max(ln.size, it.size);
    } else lines.push({ text: it.s, x0: it.x, x1: it.x + it.w, y: it.y, size: it.size, font: it.fam, bold: it.bold, italic: it.italic });
  }
  return lines.filter((l) => l.text.trim()).map((l) => ({ ...l, rect: [l.x0, l.y - 0.25 * l.size, Math.max(l.x1, l.x0 + 4), l.y + 0.9 * l.size] }));
}

async function ensureAnalysis(entry) {
  if (entry.blank || !S.sources[entry.src] || entry.analyzed) return;
  entry.analyzed = true;
  try { const lib = await sourceLib(entry.src); entry.ximgs = pagePictures(lib.getPage(entry.idx)).pics; } catch (e) { console.warn("pictures", e); entry.ximgs = []; }
  try { entry.xlines = await buildLines(entry); } catch (e) { console.warn("text lines", e); entry.xlines = []; }
}
async function analyzeVisible() {
  for (const e of S.pages) { if (e.vp && e.el) { await ensureAnalysis(e); drawOverlay(e); } }
}

function sampleColors(entry, rect) {
  const cv = entry.el.querySelector("canvas.pg");
  const out = { fg: "#000000", bg: "#ffffff" };
  if (!cv) return out;
  const a = aabb(entry.vp, rect), r = cv.width / entry.vp.width;
  const x = Math.max(0, Math.floor(a.x * r)), y = Math.max(0, Math.floor(a.y * r)), w = Math.max(1, Math.min(cv.width - x, Math.ceil(a.w * r))), h = Math.max(1, Math.min(cv.height - y, Math.ceil(a.h * r)));
  try {
    const d = cv.getContext("2d").getImageData(x, y, w, h).data;
    const counts = new Map(); let dark = null, darkL = 999;
    for (let i = 0; i < d.length; i += 4) {
      const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
      counts.set(key, (counts.get(key) || 0) + 1);
      const l = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
      if (l < darkL) { darkL = l; dark = [d[i], d[i + 1], d[i + 2]]; }
    }
    let best = 0, bk = 0xfff; counts.forEach((v, k) => { if (v > best) { best = v; bk = k; } });
    const bg = [((bk >> 8) & 15) * 17, ((bk >> 4) & 15) * 17, (bk & 15) * 17];
    const hex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
    out.bg = hex(bg);
    const bgL = bg[0] * 0.3 + bg[1] * 0.59 + bg[2] * 0.11;
    if (dark && bgL - darkL > 60) out.fg = hex(dark);
    else out.fg = bgL > 128 ? "#000000" : "#ffffff";
  } catch {}
  return out;
}

async function editPoint(entry, x, y) {
  const vp = entry.vp;
  for (let i = entry.edits.length - 1; i >= 0; i--) {
    const o = entry.edits[i];
    if ((o.t === "tedit" || o.t === "ximg") && hitObj(entry, o, x, y)) {
      if (o.t === "tedit") return openLineEditor(entry, { text: o.text, x0: o.base[0], x1: o.rect[2], y: o.base[1], size: o.size, font: o.font, bold: o.bold, italic: o.italic, rect: o.rect, fg: o.fg, bg: o.bg }, o);
      return select(entry, o);
    }
  }
  await ensureAnalysis(entry);
  const u = vp.convertToPdfPoint(x, y);
  const line = (entry.xlines || []).find((l) => u[0] >= l.rect[0] - 2 && u[0] <= l.rect[2] + 2 && u[1] >= l.rect[1] - 1 && u[1] <= l.rect[3] + 1);
  if (line) {
    if (vp.rotation !== 0) return toast("Text on a rotated page can't be edited here. Rotate the page back first.", 4000);
    return openLineEditor(entry, { ...line, ...sampleColors(entry, line.rect) }, null);
  }
  const pic = pictureAt(entry, u);
  if (pic) return select(entry, pictureObject(entry, pic));
  select(entry, null);
}

const pictureAt = (entry, u) => (entry.ximgs || []).slice().reverse().find((m) => u[0] >= m.bbox[0] && u[0] <= m.bbox[2] && u[1] >= m.bbox[1] && u[1] <= m.bbox[3]);
function pictureObject(entry, pic) {
  const vp = entry.vp, a = aabb(vp, pic.bbox), cv = entry.el.querySelector("canvas.pg");
  let prev = null;
  if (cv) {
    const r = cv.width / vp.width, t = document.createElement("canvas");
    t.width = Math.max(1, Math.round(a.w * r)); t.height = Math.max(1, Math.round(a.h * r));
    t.getContext("2d").drawImage(cv, a.x * r, a.y * r, a.w * r, a.h * r, 0, 0, t.width, t.height);
    prev = addImage(t.toDataURL("image/png"));
  }
  const o = { id: uid(), t: "ximg", k: pic.k, box0: pic.bbox.slice(), a: [pic.bbox[0], pic.bbox[1]], b: [pic.bbox[2], pic.bbox[3]], unchanged: true, del: false, prev, img: null };
  entry.edits.push(o);
  return o;
}

function openLineEditor(entry, line, existing) {
  closeEditor(); select(entry, null);
  const vp = entry.vp, k = vp.scale, a = aabb(vp, line.rect);
  const inp = document.createElement("input");
  inp.type = "text"; inp.className = "tedit"; inp.value = line.text; inp.spellcheck = false;
  inp.setAttribute("autocapitalize", "off"); inp.setAttribute("autocomplete", "off");
  const fam = CSS_FONT[line.font || "Helvetica"];
  const meas = document.createElement("canvas").getContext("2d");
  const fit = () => { meas.font = `${line.italic ? "italic " : ""}${line.bold ? "700 " : ""}${line.size * k}px ${fam}`; inp.style.width = Math.max(a.w, meas.measureText(inp.value).width) + 20 * k + "px"; };
  inp.style.cssText = `left:${a.x - 2}px;top:${a.y - 2}px;height:${a.h + 4}px;font-size:${line.size * k}px;line-height:${a.h + 4}px;padding:0 2px;border:1px solid #2b47b5;background:${line.bg || "#fff"};color:${line.fg || "#000"};font-family:${fam};font-weight:${line.bold ? 700 : 400};font-style:${line.italic ? "italic" : "normal"};`;
  fit();
  entry.el.appendChild(inp);
  inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
  let done = false;
  const finish = (commit) => {
    if (done) return; done = true;
    const text = inp.value;
    inp.remove();
    if (!commit) return;
    const orig = existing ? existing.orig : line.text;
    if (existing) {
      if (text === orig) { snapshot(); entry.edits = entry.edits.filter((o) => o !== existing); }
      else if (text !== existing.text) { snapshot(); existing.text = text; }
    } else if (text !== orig) {
      snapshot();
      entry.edits.push({ id: uid(), t: "tedit", rect: line.rect.slice(), base: [line.x0, line.y], size: line.size, font: line.font, bold: !!line.bold, italic: !!line.italic, fg: line.fg || "#000000", bg: line.bg || "#ffffff", orig, text });
    }
    drawOverlay(entry);
  };
  inp.oninput = fit;
  inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); finish(true); } else if (e.key === "Escape") { e.preventDefault(); finish(false); } };
  inp.onblur = () => finish(true);
}

function replaceImage(entry, o) {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = "image/*";
  inp.onchange = async () => {
    const f = inp.files[0];
    if (!f) return;
    try {
      const im = await normalizeImage(f);
      snapshot();
      const bw = o.box0[2] - o.box0[0], bh = o.box0[3] - o.box0[1], sc = Math.min(bw / im.w, bh / im.h);
      const w = im.w * sc, h = im.h * sc, cx = (o.box0[0] + o.box0[2]) / 2, cy = (o.box0[1] + o.box0[3]) / 2;
      o.img = addImage(im.url); o.del = false; o.unchanged = false;
      o.a = [cx - w / 2, cy - h / 2]; o.b = [cx + w / 2, cy + h / 2];
      drawOverlay(entry); showCtx();
    } catch { toast("That picture could not be read."); }
  };
  inp.click();
}

// ------------------------------------------------------------------ writing the PDF (pdf-lib)
async function drawBoxImage(out, pg, o, url, w, h, emb) {
  let img = emb.get(url);
  if (!img) { const bytes = dataUrlBytes(url); img = /^data:image\/png/.test(url) ? await out.embedPng(bytes) : await out.embedJpg(bytes); emb.set(url, img); }
  const a = ((o.ang || 0) * Math.PI) / 180;
  pg.drawImage(img, { x: o.p[0] + h * Math.sin(a), y: o.p[1] - h * Math.cos(a), width: w, height: h, rotate: degrees(o.ang || 0) });
}

function textAsImage(o, lines) {
  const k = 3, c = document.createElement("canvas");
  c.width = Math.ceil(o.w * k); c.height = Math.ceil(textBox(o).h * k);
  const x = c.getContext("2d");
  x.fillStyle = o.color; x.textBaseline = "alphabetic";
  x.font = `${o.italic ? "italic " : ""}${o.bold ? "700 " : ""}${o.size * k}px ${CSS_FONT[o.font || "Helvetica"]}`;
  lines.forEach((ln, i) => x.fillText(ln, 4 * k, (3 + o.size * 0.82 + i * o.size * LH) * k));
  return c.toDataURL("image/png");
}

async function drawObjects(out, pg, objs, ctx) {
  const { getFont, emb } = ctx;
  for (const o of objs) {
    switch (o.t) {
      case "hl": for (const r of o.rects) pg.drawRectangle({ x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1], color: pdfColor(o.color), opacity: o.op ?? 0.45, blendMode: BlendMode.Multiply }); break;
      case "ul": case "st": for (const s of o.segs) pg.drawLine({ start: { x: s[0], y: s[1] }, end: { x: s[2], y: s[3] }, thickness: o.w || 1.2, color: pdfColor(o.color), lineCap: L.LineCapStyle.Round }); break;
      case "ink":
        if (o.pts.length === 1) pg.drawCircle({ x: o.pts[0][0], y: o.pts[0][1], size: o.w / 2, color: pdfColor(o.color) });
        for (let i = 1; i < o.pts.length; i++) pg.drawLine({ start: { x: o.pts[i - 1][0], y: o.pts[i - 1][1] }, end: { x: o.pts[i][0], y: o.pts[i][1] }, thickness: o.w, color: pdfColor(o.color), lineCap: L.LineCapStyle.Round });
        break;
      case "rect": pg.drawRectangle({ x: Math.min(o.a[0], o.b[0]), y: Math.min(o.a[1], o.b[1]), width: Math.abs(o.b[0] - o.a[0]), height: Math.abs(o.b[1] - o.a[1]), borderColor: pdfColor(o.color), borderWidth: o.w, color: o.fill ? pdfColor(o.color) : undefined }); break;
      case "ell": pg.drawEllipse({ x: (o.a[0] + o.b[0]) / 2, y: (o.a[1] + o.b[1]) / 2, xScale: Math.abs(o.b[0] - o.a[0]) / 2, yScale: Math.abs(o.b[1] - o.a[1]) / 2, borderColor: pdfColor(o.color), borderWidth: o.w }); break;
      case "line": case "arrow": {
        pg.drawLine({ start: { x: o.a[0], y: o.a[1] }, end: { x: o.b[0], y: o.b[1] }, thickness: o.w, color: pdfColor(o.color), lineCap: L.LineCapStyle.Round });
        if (o.t === "arrow") {
          const ang = Math.atan2(o.b[1] - o.a[1], o.b[0] - o.a[0]), s = Math.max(8, o.w * 4);
          const p1 = [o.b[0] - s * Math.cos(ang - 0.45), o.b[1] - s * Math.sin(ang - 0.45)], p2 = [o.b[0] - s * Math.cos(ang + 0.45), o.b[1] - s * Math.sin(ang + 0.45)];
          pg.drawSvgPath(`M ${o.b[0]} ${-o.b[1]} L ${p1[0]} ${-p1[1]} L ${p2[0]} ${-p2[1]} Z`, { x: 0, y: 0, color: pdfColor(o.color), borderWidth: 0 });
        }
        break;
      }
      case "redact": pg.drawRectangle({ x: Math.min(o.a[0], o.b[0]), y: Math.min(o.a[1], o.b[1]), width: Math.abs(o.b[0] - o.a[0]), height: Math.abs(o.b[1] - o.a[1]), color: rgb(0, 0, 0) }); break;
      case "white": pg.drawRectangle({ x: Math.min(o.a[0], o.b[0]), y: Math.min(o.a[1], o.b[1]), width: Math.abs(o.b[0] - o.a[0]), height: Math.abs(o.b[1] - o.a[1]), color: rgb(1, 1, 1) }); break;
      case "note": {
        const c = out.context;
        const ref = c.register(c.obj({ Type: "Annot", Subtype: "Text", Rect: [o.p[0], o.p[1] - 20, o.p[0] + 20, o.p[1]], Contents: PDFHexString.fromText(o.text), Name: "Comment", C: [1, 0.85, 0], F: 4, T: PDFHexString.fromText("WriterPad") }));
        pg.node.addAnnot(ref);
        break;
      }
      case "img": await drawBoxImage(out, pg, o, IMGS.get(o.img), o.w, o.h, emb); break;
      case "stamp": {
        const a = ((o.ang || 0) * Math.PI) / 180, u = [Math.cos(a), Math.sin(a)], v = [-Math.sin(a), Math.cos(a)];
        const font = await getFont("HelveticaBold"), size = stampFont(o), tw = font.widthOfTextAtSize(o.label, size), bw = Math.max(1.5, o.h * 0.06);
        const bl = [o.p[0] + o.h * Math.sin(a), o.p[1] - o.h * Math.cos(a)];
        pg.drawRectangle({ x: bl[0], y: bl[1], width: o.w, height: o.h, rotate: degrees(o.ang || 0), borderColor: pdfColor(o.color), borderWidth: bw });
        const c = [o.p[0] + u[0] * (o.w / 2) - v[0] * (o.h / 2), o.p[1] + u[1] * (o.w / 2) - v[1] * (o.h / 2)];
        try { pg.drawText(o.label, { x: c[0] - u[0] * (tw / 2) - v[0] * (size * 0.35), y: c[1] - u[1] * (tw / 2) - v[1] * (size * 0.35), size, font, color: pdfColor(o.color), rotate: degrees(o.ang || 0) }); }
        catch { const url = textAsImage({ ...o, text: o.label, size, bold: true, font: "Helvetica", w: o.w }, [o.label]); await drawBoxImage(out, pg, o, url, o.w, o.h, emb); }
        break;
      }
      case "text": {
        const font = await getFont(fontKey(o)), { lines } = textBox(o);
        let ok = true;
        for (const ln of lines) { try { font.encodeText(ln); } catch { ok = false; } }
        if (!ok) { await drawBoxImage(out, pg, o, textAsImage(o, lines), o.w, textBox(o).h, emb); break; }
        const a = ((o.ang || 0) * Math.PI) / 180, u = [Math.cos(a), Math.sin(a)], v = [-Math.sin(a), Math.cos(a)];
        lines.forEach((ln, i) => {
          if (!ln) return;
          const off = 3 + o.size * 0.82 + i * o.size * LH;
          pg.drawText(ln, { x: o.p[0] + u[0] * 4 - v[0] * off, y: o.p[1] + u[1] * 4 - v[1] * off, size: o.size, font, color: pdfColor(o.color), rotate: degrees(o.ang || 0) });
        });
        break;
      }
      case "wm": {
        const font = await getFont("HelveticaBold"), tw = font.widthOfTextAtSize(o.text, o.size), phi = (((o.ang || 0) + 45) * Math.PI) / 180;
        const dx = -tw / 2, dy = -o.size * 0.35;
        pg.drawText(o.text, { x: o.c[0] + dx * Math.cos(phi) - dy * Math.sin(phi), y: o.c[1] + dx * Math.sin(phi) + dy * Math.cos(phi), size: o.size, font, color: pdfColor(o.color), opacity: o.op, rotate: degrees((o.ang || 0) + 45) });
        break;
      }
      case "ximg": break;
      case "tedit": {
        const font = await getFont(fontKey(o)), pad = 1.2;
        if (!o._removed) pg.drawRectangle({ x: o.rect[0] - pad, y: o.rect[1] - pad, width: o.rect[2] - o.rect[0] + 2 * pad, height: o.rect[3] - o.rect[1] + 2 * pad, color: pdfColor(o.bg) });
        if (!o.text) break;
        let ok = true;
        try { font.encodeText(o.text); } catch { ok = false; }
        if (ok) pg.drawText(o.text, { x: o.base[0], y: o.base[1], size: o.size, font, color: pdfColor(o.fg) });
        else {
          const k = 3, c = document.createElement("canvas"), x = c.getContext("2d");
          x.font = `${o.italic ? "italic " : ""}${o.bold ? "700 " : ""}${o.size * k}px ${CSS_FONT[o.font || "Helvetica"]}`;
          c.width = Math.ceil(x.measureText(o.text).width) + 8; c.height = Math.ceil(o.size * k * 1.4);
          x.font = `${o.italic ? "italic " : ""}${o.bold ? "700 " : ""}${o.size * k}px ${CSS_FONT[o.font || "Helvetica"]}`;
          x.fillStyle = o.fg; x.textBaseline = "alphabetic"; x.fillText(o.text, 2, o.size * k * 1.05);
          await drawBoxImage(out, pg, { p: [o.base[0] - 2 / k, o.base[1] + o.size * 1.05], ang: 0 }, c.toDataURL("image/png"), c.width / k, c.height / k, emb);
        }
        break;
      }
      case "ocr": {
        const font = await getFont("Helvetica");
        for (const w of o.words) { try { pg.drawText(w.s, { x: w.p[0], y: w.p[1], size: Math.max(2, w.size), font, opacity: 0, rotate: degrees(w.ang || 0) }); } catch {} }
        break;
      }
    }
  }
}

// Pictures the user moved, resized, replaced or deleted, and old text that was replaced, are changed
// where the page itself draws them (not covered up).
async function applyImageEdits(out, pg, p) {
  const edits = p.edits.filter((o) => o.t === "ximg" && !o.unchanged);
  const teds = p.edits.filter((o) => o.t === "tedit");
  teds.forEach((o) => (o._removed = false));
  if (!edits.length && !teds.length) return;
  const { pics, bytes, res } = pagePictures(pg);
  const repl = [], fmt = (v) => String(+v.toFixed(5));
  let ownXo = null, n = 0;
  for (const o of edits) {
    const pic = pics[o.k];
    if (!pic) continue;
    if (o.del) { repl.push({ a: pic.a, b: pic.b, text: " " }); continue; }
    const x0 = Math.min(o.a[0], o.b[0]), y0 = Math.min(o.a[1], o.b[1]), x1 = Math.max(o.a[0], o.b[0]), y1 = Math.max(o.a[1], o.b[1]);
    const w0 = o.box0[2] - o.box0[0] || 1, h0 = o.box0[3] - o.box0[1] || 1, sx = (x1 - x0) / w0, sy = (y1 - y0) / h0;
    const Sm = [sx, 0, 0, sy, x0 - sx * o.box0[0], y0 - sy * o.box0[1]];
    const M = mmul(mmul(pic.ctm, Sm), minv(pic.ctm));
    let name = pic.name;
    if (o.img) {
      const url = IMGS.get(o.img), data = dataUrlBytes(url);
      const image = /^data:image\/png/.test(url) ? await out.embedPng(data) : await out.embedJpg(data);
      if (!ownXo) {
        const r2 = (res || out.context.obj({})).clone();
        const x0d = r2.lookupMaybe(PDFName.of("XObject"), L.PDFDict);
        ownXo = x0d ? x0d.clone() : out.context.obj({});
        r2.set(PDFName.of("XObject"), ownXo);
        pg.node.set(PDFName.of("Resources"), r2);
      }
      name = "WPpic" + ++n + "x" + Math.floor(Math.random() * 1e6);
      ownXo.set(PDFName.of(name), image.ref);
    }
    repl.push({ a: pic.a, b: pic.b, text: `q ${M.map(fmt).join(" ")} cm /${name} Do Q` });
  }
  if (teds.length) {
    const used = new Set();
    for (const blk of scanContent(bytes).blocks) {
      if (blk.complex || blk.shows.length !== 1) continue;
      const sh = blk.shows[0];
      const hit = teds.find((o) => sh.x >= o.rect[0] - 2 && sh.x <= o.rect[2] + 2 && Math.abs(sh.y - o.base[1]) <= 0.35 * o.size);
      if (hit && !used.has(sh.a)) { used.add(sh.a); hit._removed = true; repl.push({ a: sh.a, b: sh.b, text: " " }); }
    }
  }
  if (!repl.length) return;
  repl.sort((x, y) => x.a - y.a);
  const enc = new TextEncoder(), parts = [];
  let at = 0;
  for (const r of repl) { parts.push(bytes.subarray(at, r.a), enc.encode(r.text)); at = r.b; }
  parts.push(bytes.subarray(at));
  let len = 0; parts.forEach((x) => (len += x.length));
  const all = new Uint8Array(len); let o = 0;
  for (const x of parts) { all.set(x, o); o += x.length; }
  pg.node.set(PDFName.of("Contents"), out.context.register(out.context.flateStream(all)));
}

function applyFormValues(out) {
  let form;
  try { form = out.getForm(); } catch { return; }
  for (const [name, f] of Object.entries(S.fields)) {
    const cur = f.type === "check" ? f.on : f.value;
    if (cur === f.orig) continue;
    try {
      const field = form.getField(name);
      if (f.type === "text" && field instanceof L.PDFTextField) field.setText(f.value || undefined);
      else if (f.type === "check" && field instanceof L.PDFCheckBox) f.on ? field.check() : field.uncheck();
      else if (f.type === "radio" && field instanceof L.PDFRadioGroup && f.value) field.select(f.value);
      else if (field instanceof L.PDFDropdown && f.value) { try { field.select(f.value); } catch { field.addOptions([f.value]); field.select(f.value); } }
      else if (field instanceof L.PDFOptionList && f.value) field.select(f.value);
    } catch (e) { console.warn("form field", name, e); }
  }
  try { form.updateFieldAppearances(); } catch (e) { console.warn("appearances", e); }
  if (S.flatten) { try { form.flatten(); } catch (e) { console.warn("flatten", e); } }
}

async function buildPdf(opts = {}) {
  const src0 = S.sources[0];
  const out = src0 ? await PDFDocument.load(src0.bytes, { ignoreEncryption: true, updateMetadata: false }) : await PDFDocument.create();
  if (src0 && !opts.noForms) applyFormValues(out);
  const pages = opts.only ? S.pages.filter((p) => opts.only.has(p.id)) : S.pages;
  const orig = src0 ? out.getPages() : [];
  const used = new Map(), donors = new Map(), final = [];
  for (const p of pages) {
    if (p.blank) { final.push(out.addPage([p.blank.w, p.blank.h])); continue; }
    const key = p.src + ":" + p.idx, n = used.get(key) || 0;
    used.set(key, n + 1);
    if (p.src === 0 && n === 0) { final.push(orig[p.idx]); continue; }
    let donor = out;
    if (p.src !== 0) { donor = donors.get(p.src); if (!donor) { donor = await PDFDocument.load(S.sources[p.src].bytes, { ignoreEncryption: true }); donors.set(p.src, donor); } }
    const [cp] = await out.copyPages(donor, [p.idx]);
    final.push(cp);
  }
  for (let i = out.getPageCount() - 1; i >= 0; i--) out.removePage(i);
  final.forEach((pg, i) => out.insertPage(i, pg));

  const fc = new Map();
  const ctx = { emb: new Map(), getFont: async (k) => { if (!fc.has(k)) fc.set(k, await out.embedFont(StandardFonts[k])); return fc.get(k); } };
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i], pg = out.getPage(i);
    const vp = await viewportFor(p, 1);
    await applyImageEdits(out, pg, p);
    const objs = p.edits.concat(decorObjects(p, i, vp));
    await drawObjects(out, pg, objs, ctx);
    if (p.rot) pg.setRotation(degrees((pg.getRotation().angle + p.rot) % 360));
    if (p.crop) pg.setCropBox(p.crop[0], p.crop[1], p.crop[2] - p.crop[0], p.crop[3] - p.crop[1]);
  }
  if (S.meta) {
    if (S.meta.title !== undefined) out.setTitle(S.meta.title);
    if (S.meta.author !== undefined) out.setAuthor(S.meta.author);
    if (S.meta.subject !== undefined) out.setSubject(S.meta.subject);
    if (S.meta.keywords !== undefined) out.setKeywords(S.meta.keywords.split(",").map((s) => s.trim()).filter(Boolean));
  }
  out.setProducer("WriterPad PDF");
  let bytes = await out.save({ useObjectStreams: true });
  if (!opts.skipRedact) bytes = await applyRedactions(bytes, pages);
  return bytes;
}

async function renderPageToCanvas(pdf, pageNo, scale, after) {
  const page = await pdf.getPage(pageNo);
  const vp = page.getViewport({ scale });
  const c = document.createElement("canvas");
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: x, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
  if (after) after(x, vp);
  return { canvas: c, vp };
}


// A page turned into a picture loses its text; put it back as an invisible layer (except under redaction boxes).
async function restoreTextLayer(doc, font, newPage, srcPage, redactRects) {
  if (srcPage.rotate % 360 !== 0) return;
  const [vx0, vy0] = srcPage.view;
  let tc;
  try { tc = await srcPage.getTextContent(); } catch { return; }
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const h = Math.abs(it.transform[3]) || it.height || 10, x = it.transform[4], y = it.transform[5], w = it.width || 0;
    const box = [x, y - 0.25 * h, x + w, y + 0.9 * h];
    if (redactRects.some((r) => box[0] < r[2] && box[2] > r[0] && box[1] < r[3] && box[3] > r[1])) continue;
    try { newPage.drawText(it.str, { x: x - vx0, y: y - vy0, size: Math.max(2, h), font, opacity: 0 }); } catch {}
  }
}

// Redaction: pages with redaction boxes become pictures with the boxes burned in, so the text under them is gone.
async function applyRedactions(bytes, pages) {
  const wantsRaster = (p) => p.edits.some((o) => o.t === "redact" || (S.removeOldText && o.t === "tedit" && !o._removed));
  const idxs = pages.map((p, i) => (wantsRaster(p) ? i : -1)).filter((i) => i >= 0);
  if (!idxs.length) return bytes;
  const pdf = await pdfjsLib.getDocument(getDocOpts(bytes.slice())).promise;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  for (const i of idxs) {
    const base = (await pdf.getPage(i + 1)).getViewport({ scale: 1 });
    const k = Math.min(2.8, 4200 / Math.max(base.width, base.height));
    const reds = pages[i].edits.filter((o) => o.t === "redact");
    const { canvas, vp } = await renderPageToCanvas(pdf, i + 1, k, (x, vp) => {
      x.fillStyle = "#000";
      for (const o of reds) { const a = aabbAB(vp, o.a, o.b); x.fillRect(a.x, a.y, a.w, a.h); }
    });
    const jpg = await doc.embedJpg(dataUrlBytes(canvas.toDataURL("image/jpeg", 0.88)));
    const w = vp.width / k, h = vp.height / k;
    const np = doc.insertPage(i, [w, h]);
    np.drawImage(jpg, { x: 0, y: 0, width: w, height: h });
    const edited = S.removeOldText ? pages[i].edits.filter((o) => o.t === "tedit" && !o._removed) : [];
    const srcPage = await pdf.getPage(i + 1);
    await restoreTextLayer(doc, helv, np, srcPage, reds.map((o) => [Math.min(o.a[0], o.b[0]), Math.min(o.a[1], o.b[1]), Math.max(o.a[0], o.b[0]), Math.max(o.a[1], o.b[1])]).concat(edited.map((o) => o.rect)));
    for (const o of edited) { if (o.text && srcPage.rotate % 360 === 0) { try { np.drawText(o.text, { x: o.base[0] - srcPage.view[0], y: o.base[1] - srcPage.view[1], size: o.size, font: helv, opacity: 0 }); } catch {} } }
    doc.removePage(i + 1);
  }
  pdf.destroy();
  return await doc.save({ useObjectStreams: true });
}

async function rasterize(bytes, dpi, quality, progress) {
  const pdf = await pdfjsLib.getDocument(getDocOpts(bytes.slice())).promise;
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pdf.numPages; i++) {
    progress && progress(i - 1, pdf.numPages);
    const base = (await pdf.getPage(i)).getViewport({ scale: 1 });
    const { canvas } = await renderPageToCanvas(pdf, i, dpi / 72);
    const jpg = await doc.embedJpg(dataUrlBytes(canvas.toDataURL("image/jpeg", quality)));
    const pg = doc.addPage([base.width, base.height]);
    pg.drawImage(jpg, { x: 0, y: 0, width: base.width, height: base.height });
    await restoreTextLayer(doc, helv, pg, await pdf.getPage(i), []);
    canvas.width = canvas.height = 0;
  }
  progress && progress(pdf.numPages, pdf.numPages);
  pdf.destroy();
  return await doc.save({ useObjectStreams: true });
}

// ------------------------------------------------------------------ save, share, export
function pdfBlob(bytes) { return new Blob([bytes], { type: "application/pdf" }); }
function openSaveDialog() {
  if (!S.pages.length) return;
  const hasForm = Object.keys(S.fields).length > 0;
  showDialog(`<h3>Save PDF</h3>
    <label>File name</label><input type="text" id="svName" value="${esc(baseName(S.fileName))}-edited.pdf">
    ${hasForm ? `<label><input type="checkbox" id="svFlat" ${S.flatten ? "checked" : ""}> Flatten form fields (make the answers permanent)</label>` : ""}
    ${S.pages.some((p) => p.edits.some((o) => o.t === "tedit")) ? `<label><input type="checkbox" id="svOld" ${S.removeOldText ? "checked" : ""}> Make sure the old text is really gone</label><div class="muted">The old words are removed from the page when possible. If a line cannot be removed cleanly, this turns that page into a picture (text stays searchable); unticked, the old words would stay hidden under the new ones.</div>` : ""}
    <p class="muted">Your changes are written into a new copy. The original file is not touched.</p>
    <div class="actions"><button class="btn" id="svNo">Cancel</button><button class="btn" id="svShare">Share...</button><button class="btn primary" id="svYes">Download</button></div>`, (b) => {
    $("#svNo", b).onclick = closeDialog;
    const go = async (share) => {
      let name = $("#svName", b).value.trim() || "document.pdf";
      if (!/\.pdf$/i.test(name)) name += ".pdf";
      if (hasForm) S.flatten = $("#svFlat", b).checked;
      if ($("#svOld", b)) S.removeOldText = $("#svOld", b).checked;
      closeDialog(); toast("Saving...", 0);
      try {
        const bytes = await buildPdf();
        const blob = pdfBlob(bytes);
        if (share && navigator.canShare && navigator.canShare({ files: [new File([blob], name, { type: "application/pdf" })] })) await navigator.share({ files: [new File([blob], name, { type: "application/pdf" })], title: name });
        else downloadBlob(blob, name);
        S.dirty = false; toast("Saved " + name + " (" + (bytes.length / 1048576).toFixed(2) + " MB)");
      } catch (e) { console.error(e); if (e?.name !== "AbortError") toast("Could not save: " + (e.message || e), 6000); else toast("Cancelled."); }
    };
    $("#svYes", b).onclick = () => go(false);
    $("#svShare", b).onclick = () => go(true);
  });
}

function progressDialog(title) {
  showDialog(`<h3>${esc(title)}</h3><div class="progress"><div id="pgBar"></div></div><div class="muted" id="pgMsg">Working...</div>`);
  return (done, total, msg) => { const bar = $("#pgBar"); if (bar) bar.style.width = (total ? (done / total) * 100 : 0) + "%"; const m = $("#pgMsg"); if (m && msg) m.textContent = msg; };
}

function openCompressDialog() {
  showDialog(`<h3>Smaller file (compress)</h3>
    <p class="muted">Pages are turned into pictures at the quality you pick. Good for scanned documents. Text stops being selectable unless you run OCR afterwards.</p>
    <label>Quality</label><select id="cpQ"><option value="100|0.6">Small (100 dpi)</option><option value="150|0.72" selected>Balanced (150 dpi)</option><option value="200|0.85">Sharp (200 dpi)</option></select>
    <div class="actions"><button class="btn" id="cpNo">Cancel</button><button class="btn primary" id="cpYes">Compress and download</button></div>`, (b) => {
    $("#cpNo", b).onclick = closeDialog;
    $("#cpYes", b).onclick = async () => {
      const [dpi, q] = $("#cpQ", b).value.split("|").map(Number);
      const prog = progressDialog("Compressing");
      try {
        const full = await buildPdf();
        const out = await rasterize(full, dpi, q, (d, t) => prog(d, t, `Page ${Math.min(d + 1, t)} of ${t}`));
        closeDialog();
        downloadBlob(pdfBlob(out), baseName(S.fileName) + "-small.pdf");
        toast(`${(full.length / 1048576).toFixed(2)} MB to ${(out.length / 1048576).toFixed(2)} MB`);
      } catch (e) { console.error(e); closeDialog(); toast("Compression failed: " + (e.message || e), 6000); }
    };
  });
}

function openExportImagesDialog() {
  showDialog(`<h3>Pages as pictures</h3>
    <div class="two"><div><label>Format</label><select id="exF"><option value="jpeg">JPEG</option><option value="png">PNG</option></select></div><div><label>Resolution</label><select id="exD"><option value="100">100 dpi</option><option value="150" selected>150 dpi</option><option value="200">200 dpi</option><option value="300">300 dpi</option></select></div></div>
    <div class="actions"><button class="btn" id="exNo">Cancel</button><button class="btn primary" id="exYes">Export ZIP</button></div>`, (b) => {
    $("#exNo", b).onclick = closeDialog;
    $("#exYes", b).onclick = async () => {
      const fmt = $("#exF", b).value, dpi = +$("#exD", b).value;
      const prog = progressDialog("Exporting pictures");
      try {
        const full = await buildPdf();
        const pdf = await pdfjsLib.getDocument(getDocOpts(full.slice())).promise;
        const files = [];
        for (let i = 1; i <= pdf.numPages; i++) {
          prog(i - 1, pdf.numPages, `Page ${i} of ${pdf.numPages}`);
          const { canvas } = await renderPageToCanvas(pdf, i, dpi / 72);
          const blob = await new Promise((r) => canvas.toBlob(r, "image/" + fmt, 0.9));
          files.push({ name: `${baseName(S.fileName)}-${String(i).padStart(3, "0")}.${fmt === "jpeg" ? "jpg" : "png"}`, data: new Uint8Array(await blob.arrayBuffer()) });
          canvas.width = canvas.height = 0;
        }
        pdf.destroy(); closeDialog();
        downloadBlob(makeZip(files), baseName(S.fileName) + "-pictures.zip");
      } catch (e) { console.error(e); closeDialog(); toast("Export failed: " + (e.message || e), 6000); }
    };
  });
}

async function exportText() {
  toast("Reading text...", 0);
  const full = await buildPdf({ skipRedact: false });
  const pdf = await pdfjsLib.getDocument(getDocOpts(full.slice())).promise;
  let txt = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    let line = "", lastY = null;
    for (const it of tc.items) { if (lastY !== null && Math.abs(it.transform[5] - lastY) > 2) { txt += line.trimEnd() + "\n"; line = ""; } line += it.str + (it.hasEOL ? "\n" : ""); lastY = it.transform[5]; }
    txt += line.trimEnd() + "\n\n--- page " + i + " ---\n\n";
  }
  pdf.destroy();
  downloadBlob(new Blob([txt], { type: "text/plain" }), baseName(S.fileName) + ".txt");
  toast("Text exported.");
}

function openSplitDialog() {
  const n = S.pages.length;
  showDialog(`<h3>Split into several PDFs</h3>
    <label>Split every</label><input type="number" id="spN" min="1" max="${n}" value="${Math.min(n, 1)}"><div class="muted">pages (${n} pages in this document)</div>
    <div class="actions"><button class="btn" id="spNo">Cancel</button><button class="btn primary" id="spYes">Split to ZIP</button></div>`, (b) => {
    $("#spNo", b).onclick = closeDialog;
    $("#spYes", b).onclick = async () => {
      const step = clamp(+$("#spN", b).value || 1, 1, n);
      const prog = progressDialog("Splitting");
      try {
        const files = [], parts = Math.ceil(n / step);
        for (let i = 0; i < parts; i++) {
          prog(i, parts, `Part ${i + 1} of ${parts}`);
          const only = new Set(S.pages.slice(i * step, (i + 1) * step).map((p) => p.id));
          files.push({ name: `${baseName(S.fileName)}-part${String(i + 1).padStart(2, "0")}.pdf`, data: await buildPdf({ only }) });
        }
        closeDialog(); downloadBlob(makeZip(files), baseName(S.fileName) + "-split.zip");
      } catch (e) { console.error(e); closeDialog(); toast("Split failed: " + (e.message || e), 6000); }
    };
  });
}

// ------------------------------------------------------------------ document settings dialogs
function openDecorDialog() {
  const D = S.decor, pn = D.pn || { pos: "bottom-center", fmt: "Page {n} of {N}", start: 1 };
  const pos = ["bottom-center", "bottom-right", "bottom-left", "top-center", "top-right", "top-left"];
  showDialog(`<h3>Page numbers, header and footer</h3>
    <label>Page numbers</label><select id="dcPos"><option value="">None</option>${pos.map((p) => `<option value="${p}" ${D.pn && D.pn.pos === p ? "selected" : ""}>${p.replace("-", " ")}</option>`).join("")}</select>
    <div class="two"><div><label>Format</label><select id="dcFmt">${["{n}", "Page {n}", "Page {n} of {N}", "{n} / {N}"].map((f) => `<option ${pn.fmt === f ? "selected" : ""}>${f}</option>`).join("")}</select></div><div><label>Start at</label><input type="number" id="dcStart" value="${pn.start || 1}" min="0"></div></div>
    <label>Header (top of every page)</label><input type="text" id="dcHead" value="${esc(D.header)}">
    <label>Footer (bottom of every page)</label><input type="text" id="dcFoot" value="${esc(D.footer)}">
    <div class="actions"><button class="btn" id="dcNo">Cancel</button><button class="btn primary" id="dcYes">Apply</button></div>`, (b) => {
    $("#dcNo", b).onclick = closeDialog;
    $("#dcYes", b).onclick = () => {
      snapshot();
      const p = $("#dcPos", b).value;
      S.decor.pn = p ? { pos: p, fmt: $("#dcFmt", b).value, start: +$("#dcStart", b).value || 1 } : null;
      S.decor.header = $("#dcHead", b).value; S.decor.footer = $("#dcFoot", b).value;
      closeDialog(); redrawAll();
    };
  });
}
function openWatermarkDialog() {
  const w = S.decor.wm || { text: "DRAFT", color: "#9e9e9e", size: 90, op: 0.25 };
  showDialog(`<h3>Watermark</h3>
    <label>Text</label><input type="text" id="wmText" value="${esc(w.text)}">
    <div class="two"><div><label>Size</label><input type="number" id="wmSize" min="12" max="300" value="${w.size}"></div><div><label>Opacity</label><input type="number" id="wmOp" min="0.05" max="1" step="0.05" value="${w.op}"></div></div>
    <label>Color</label><div class="chips" id="wmCols">${["#9e9e9e", "#e53935", "#1e88e5", "#43a047", "#000000"].map((c) => `<button class="sw ${c === w.color ? "on" : ""}" data-c="${c}" style="background:${c}"></button>`).join("")}</div>
    <div class="actions"><button class="btn" id="wmNo">Cancel</button><button class="btn" id="wmDel">Remove</button><button class="btn primary" id="wmYes">Apply to all pages</button></div>`, (b) => {
    let color = w.color;
    $("#wmCols", b).onclick = (e) => { const c = e.target.closest("[data-c]"); if (c) { color = c.dataset.c; $$("#wmCols .sw", b).forEach((n) => n.classList.toggle("on", n === c)); } };
    $("#wmNo", b).onclick = closeDialog;
    $("#wmDel", b).onclick = () => { snapshot(); S.decor.wm = null; closeDialog(); redrawAll(); };
    $("#wmYes", b).onclick = () => { const text = $("#wmText", b).value.trim(); if (!text) return; snapshot(); S.decor.wm = { text, color, size: +$("#wmSize", b).value || 90, op: clamp(+$("#wmOp", b).value || 0.25, 0.05, 1) }; closeDialog(); redrawAll(); };
  });
}
async function openMetaDialog() {
  let info = {};
  try { info = (await S.sources[0]?.pdf.getMetadata())?.info || {}; } catch {}
  const m = Object.assign({ title: info.Title || "", author: info.Author || "", subject: info.Subject || "", keywords: info.Keywords || "" }, S.meta || {});
  showDialog(`<h3>Document info</h3>
    <label>Title</label><input type="text" id="mdT" value="${esc(m.title)}"><label>Author</label><input type="text" id="mdA" value="${esc(m.author)}">
    <label>Subject</label><input type="text" id="mdS" value="${esc(m.subject)}"><label>Keywords (comma separated)</label><input type="text" id="mdK" value="${esc(m.keywords)}">
    <div class="actions"><button class="btn" id="mdNo">Cancel</button><button class="btn primary" id="mdYes">OK</button></div>`, (b) => {
    $("#mdNo", b).onclick = closeDialog;
    $("#mdYes", b).onclick = () => { snapshot(); S.meta = { title: $("#mdT", b).value, author: $("#mdA", b).value, subject: $("#mdS", b).value, keywords: $("#mdK", b).value }; closeDialog(); };
  });
}

// ------------------------------------------------------------------ OCR (Tesseract.js, loaded the first time it is used)
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("The OCR engine could not be downloaded. Connect to the internet and try again.")); document.head.appendChild(s); });
}
async function getTesseract() {
  if (window.Tesseract) return window.Tesseract;
  await loadScript("https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js");
  return window.Tesseract;
}
function paintImageObjects(ctx, entry, vp) {
  return (async () => {
    for (const o of entry.edits) {
      if (o.t !== "img") continue;
      const im = await loadImage(IMGS.get(o.img)), f = (() => { const [sx, sy] = pt(vp, o.p[0], o.p[1]); return { sx, sy, rel: vp.rotation - (o.ang || 0), w: o.w * vp.scale, h: o.h * vp.scale }; })();
      ctx.save(); ctx.translate(f.sx, f.sy); ctx.rotate((f.rel * Math.PI) / 180); ctx.drawImage(im, 0, 0, f.w, f.h); ctx.restore();
    }
  })();
}
async function runOcr(entries, lang, prog) {
  const T = await getTesseract();
  const worker = await T.createWorker(lang, 1, { logger: (m) => { if (m.status === "recognizing text") prog.sub && prog.sub(m.progress); } });
  snapshot();
  let words = 0;
  try {
    for (let n = 0; n < entries.length; n++) {
      const entry = entries[n];
      prog(n, entries.length, `Reading page ${S.pages.indexOf(entry) + 1} (${n + 1} of ${entries.length})`);
      const k0 = 200 / 72;
      const vp1 = await viewportFor(entry, 1);
      const k = Math.min(k0, 4200 / Math.max(vp1.width, vp1.height));
      const vp = await viewportFor(entry, k);
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      const x = canvas.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, canvas.width, canvas.height);
      if (!entry.blank) { const page = await getPageObj(entry); await page.render({ canvasContext: x, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise; }
      await paintImageObjects(x, entry, vp);
      const { data } = await worker.recognize(canvas);
      let list = data.words;
      if (!list && data.blocks) list = data.blocks.flatMap((b) => b.paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words)));
      const ws = [];
      for (const w of list || []) {
        const s = (w.text || "").trim();
        if (!s || w.confidence < 35) continue;
        const bb = w.bbox, h = bb.y1 - bb.y0;
        ws.push({ s, p: vp.convertToPdfPoint(bb.x0, bb.y1 - h * 0.22), size: Math.max(3, (h / k) * 0.85), ang: vp.rotation });
      }
      entry.edits = entry.edits.filter((o) => o.t !== "ocr");
      if (ws.length) entry.edits.push({ id: uid(), t: "ocr", words: ws });
      words += ws.length;
      canvas.width = canvas.height = 0;
    }
  } finally { await worker.terminate(); }
  prog(entries.length, entries.length);
  return words;
}
function openOcrDialog() {
  const hasSel = thumbSel.size > 0;
  showDialog(`<h3>Make searchable (OCR)</h3>
    <p class="muted">Reads the text in scanned pages and hides it behind the picture, so you can search and copy it. The first run downloads the reading engine (about 15 MB) and needs internet.</p>
    <label>Language</label><select id="ocL"><option value="eng">English</option><option value="fil">Filipino</option><option value="eng+fil">English + Filipino</option></select>
    <label>Pages</label><select id="ocP"><option value="cur">This page</option>${hasSel ? `<option value="sel">Selected pages (${thumbSel.size})</option>` : ""}<option value="all">All ${S.pages.length} pages</option></select>
    <div class="actions"><button class="btn" id="ocNo">Cancel</button><button class="btn primary" id="ocYes">Start</button></div>`, (b) => {
    $("#ocNo", b).onclick = closeDialog;
    $("#ocYes", b).onclick = async () => {
      const lang = $("#ocL", b).value, scope = $("#ocP", b).value;
      const entries = scope === "all" ? S.pages.slice() : scope === "sel" ? S.pages.filter((p) => thumbSel.has(p.id)) : [S.pages[currentPageIndex()]];
      const prog = progressDialog("Reading text");
      try { const n = await runOcr(entries, lang, prog); closeDialog(); toast(n ? `Found ${n} words. Save to keep the searchable text.` : "No text was found on those pages.", 5000); }
      catch (e) { console.error(e); closeDialog(); toast("OCR failed: " + (e.message || e), 7000); }
    };
  });
}

// ------------------------------------------------------------------ outline and search
const outlineDests = new Map();
async function buildOutline() {
  const host = $("#tab-outline");
  host.innerHTML = `<div class="muted">This document has no outline.</div>`;
  outlineDests.clear();
  const src = S.sources[0];
  if (!src) return;
  let ol = null;
  try { ol = await src.pdf.getOutline(); } catch {}
  if (!ol || !ol.length) return;
  let n = 0;
  const mk = (items) => `<ul class="ol">${items.map((it) => { const id = "d" + n++; outlineDests.set(id, it.dest); return `<li><a data-d="${id}">${esc(it.title || "(untitled)")}</a>${it.items && it.items.length ? mk(it.items) : ""}</li>`; }).join("")}</ul>`;
  host.innerHTML = mk(ol);
}
$("#tab-outline").addEventListener("click", async (e) => {
  const a = e.target.closest("[data-d]");
  if (!a) return;
  const src = S.sources[0];
  let dest = outlineDests.get(a.dataset.d);
  try {
    if (typeof dest === "string") dest = await src.pdf.getDestination(dest);
    if (!Array.isArray(dest)) return;
    const ref = dest[0];
    const idx = typeof ref === "object" ? await src.pdf.getPageIndex(ref) : ref;
    const at = S.pages.findIndex((p) => p.src === 0 && p.idx === idx);
    if (at >= 0) scrollToPage(at);
  } catch {}
});

async function runSearch(q) {
  S.searchHits = [];
  const list = $("#searchResults"), info = $("#searchInfo");
  list.innerHTML = ""; q = q.trim();
  if (!q) { info.textContent = ""; return redrawAll(); }
  info.textContent = "Searching...";
  const needle = q.toLowerCase();
  const results = [];
  for (let pi = 0; pi < S.pages.length && S.searchHits.length < 600; pi++) {
    const entry = S.pages[pi];
    if (entry.blank || !S.sources[entry.src]) continue;
    const tc = await (await getPageObj(entry)).getTextContent();
    for (const it of tc.items) {
      if (!it.str) continue;
      const low = it.str.toLowerCase();
      let from = 0, at;
      while ((at = low.indexOf(needle, from)) >= 0) {
        const h = Math.abs(it.transform[3]) || it.height || 10, w = it.width || 0, f0 = at / it.str.length, f1 = (at + needle.length) / it.str.length;
        const hit = { entry: entry.id, rect: [it.transform[4] + f0 * w, it.transform[5] - h * 0.2, it.transform[4] + f1 * w, it.transform[5] + h * 0.85], page: pi + 1, text: it.str };
        S.searchHits.push(hit); results.push(hit);
        from = at + needle.length;
        if (S.searchHits.length >= 600) break;
      }
    }
  }
  info.textContent = results.length ? `${results.length} match${results.length === 1 ? "" : "es"}` : "No matches.";
  list.innerHTML = results.slice(0, 200).map((h, i) => `<div class="hit" data-h="${i}"><b>Page ${h.page}</b> ${esc(h.text.slice(0, 80))}</div>`).join("");
  S._results = results;
  redrawAll();
}
$("#searchResults").addEventListener("click", (e) => {
  const d = e.target.closest("[data-h]");
  if (!d) return;
  const h = S._results[+d.dataset.h];
  S.searchHits.forEach((x) => (x.cur = x === h));
  const i = S.pages.findIndex((p) => p.id === h.entry);
  scrollToPage(i); redrawAll();
});

// ------------------------------------------------------------------ menus
function openMoreMenu() {
  const items = [
    ["hd", "Document"], ["save", "Save or share..."], ["flatten", (S.flatten ? "\u2713 " : "") + "Flatten form fields when saving"], ["meta", "Document info..."],
    ["hd", "Pages"], ["blank", "Insert blank pages..."], ["insPdf", "Insert pages from a PDF or pictures..."], ["split", "Split into several PDFs..."],
    ["hd", "Layout"], ["decor", "Page numbers, header and footer..."], ["wm", "Watermark..."],
    ["hd", "Convert"], ["ocr", "Make searchable (OCR)..."], ["compress", "Smaller file..."], ["exImg", "Pages as pictures (ZIP)..."], ["exTxt", "Export text..."],
    ["hd", "Help"], ["about", "About and licenses"],
  ];
  showMenu($("#btnMore"), items.map(([a, l]) => (a === "hd" ? `<div class="hd">${l}</div>` : `<button data-m="${a}">${esc(l)}</button>`)).join(""), (t) => {
    const b = t.closest("[data-m]");
    if (!b) return;
    closeMenu();
    const needDoc = !["about", "insPdf"].includes(b.dataset.m);
    if (needDoc && !S.pages.length) return toast("Open a PDF first.");
    ({ save: openSaveDialog, flatten: () => { S.flatten = !S.flatten; toast(S.flatten ? "Form fields will be flattened when you save." : "Form fields stay fillable."); }, meta: openMetaDialog, blank: openBlankDialog, insPdf: () => { $("#fileIns").dataset.at = ""; $("#fileIns").click(); }, split: openSplitDialog, decor: openDecorDialog, wm: openWatermarkDialog, ocr: openOcrDialog, compress: openCompressDialog, exImg: openExportImagesDialog, exTxt: exportText, about: openAbout })[b.dataset.m]();
  });
}
function openAbout() {
  showDialog(`<h3>WriterPad PDF</h3>
    <p>View, mark up, fill in, sign, redact and organize PDFs. Files never leave your device.</p>
    <p class="muted">Built with <b>PDF.js</b> (Mozilla, Apache License 2.0) for display and <b>pdf-lib</b> (Andrew Dillon, MIT License) for saving. OCR uses <b>Tesseract.js</b> (Apache License 2.0), downloaded on first use. Licence texts: <a href="../licenses/index.html">licences page</a>.</p>
    <p class="muted">Redaction destroys the text under the black boxes by turning that page into a picture. Digital certificate signatures, password protection and editing the existing text of a page are not available.</p>
    <div class="actions"><button class="btn primary" id="abOk">OK</button></div>`, (b) => { $("#abOk", b).onclick = closeDialog; });
}

// ------------------------------------------------------------------ wiring
async function openFromFile(file) {
  if (!file) return;
  try {
    if (/\.pdf$/i.test(file.name) || /pdf/.test(file.type)) {
      if (S.dirty && S.pages.length && !confirm("Discard your unsaved changes and open another file?")) return;
      toast("Opening...", 0);
      await loadDocument(await readFile(file), file.name);
      toast(`${S.pages.length} page${S.pages.length === 1 ? "" : "s"}`);
      fitWidthSoon();
    } else if (file.type.startsWith("image/")) await insertFiles([file], S.pages.length);
    else toast("That kind of file can't be opened here.");
  } catch (e) {
    console.error(e);
    toast(e?.name === "PasswordException" ? "That PDF needs a password." : "Could not open that file. Is it a PDF?", 5000);
  }
}
let fitTimer = 0;
function fitWidthSoon() { clearTimeout(fitTimer); fitTimer = setTimeout(fitWidth, 120); }

$("#btnOpen").onclick = $("#btnOpen2").onclick = () => $("#fileIn").click();
$("#fileIn").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; openFromFile(f); };
$("#btnInsert").onclick = () => { if (!S.pages.length) return $("#fileIn").click(); $("#fileIns").click(); };
$("#btnFromImages").onclick = () => $("#fileIns").click();
$("#fileIns").onchange = async (e) => { const fs = Array.from(e.target.files); e.target.value = ""; if (!S.pages.length && fs.length === 1 && /pdf/i.test(fs[0].type + fs[0].name)) return openFromFile(fs[0]); const wasEmpty = !S.pages.length; await insertFiles(fs, wasEmpty ? 0 : undefined); if (wasEmpty) { S.fileName = "pictures.pdf"; fitWidthSoon(); } };
$("#btnSave").onclick = openSaveDialog;
$("#btnUndo").onclick = undo;
$("#btnRedo").onclick = redo;
$("#btnPrev").onclick = () => scrollToPage(currentPageIndex() - 1);
$("#btnNext").onclick = () => scrollToPage(currentPageIndex() + 1);
$("#pageNum").onchange = (e) => scrollToPage((+e.target.value || 1) - 1);
$("#btnZoomIn").onclick = () => setScale(S.scale * 1.2);
$("#btnZoomOut").onclick = () => setScale(S.scale / 1.2);
$("#zoomLabel").onclick = fitWidth;
$("#btnMore").onclick = openMoreMenu;
$("#btnPanels").onclick = () => { const s = $("#side"); s.hidden = !s.hidden; if (!s.hidden) buildThumbs(); };
$(".tabs").onclick = (e) => { const b = e.target.closest("[data-tab]"); if (!b) return; $$(".tabs button").forEach((n) => n.classList.toggle("on", n === b)); $$(".tabbody").forEach((n) => (n.hidden = n.id !== "tab-" + b.dataset.tab)); if (b.dataset.tab === "search") $("#searchBox").focus(); };
$("#btnFind").onclick = () => runSearch($("#searchBox").value);
$("#searchBox").onkeydown = (e) => { if (e.key === "Enter") runSearch(e.target.value); };
$("#dialog").addEventListener("pointerdown", (e) => { if (e.target.id === "dialog") closeDialog(); });

viewer().addEventListener("scroll", () => {
  const i = currentPageIndex();
  const pn = $("#pageNum");
  if (document.activeElement !== pn) pn.value = i + 1;
  $$(".thumb").forEach((t, k) => t.classList.toggle("cur", k === i));
}, { passive: true });

// Keyboard
window.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); openSaveDialog(); return; }
  if (typing) return;
  if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); $("#side").hidden = false; $(".tabs [data-tab=search]").click(); return; }
  if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); setScale(S.scale * 1.2); return; }
  if (mod && e.key === "-") { e.preventDefault(); setScale(S.scale / 1.2); return; }
  if ((e.key === "Delete" || e.key === "Backspace") && S.sel) { e.preventDefault(); ctxAction("del"); return; }
  if (e.key === "Escape") { S.pending = null; select(S.pages[0] || {}, null); setTool("select"); return; }
  if (e.key === "PageDown") scrollToPage(currentPageIndex() + 1);
  if (e.key === "PageUp") scrollToPage(currentPageIndex() - 1);
});

// Pinch to zoom
(() => {
  const v = viewer();
  let d0 = 0, s0 = 1, f = 1, active = false;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  v.addEventListener("touchstart", (e) => { if (e.touches.length === 2) { d0 = dist(e.touches); s0 = S.scale; f = 1; active = true; } }, { passive: true });
  v.addEventListener("touchmove", (e) => {
    if (!active || e.touches.length !== 2) return;
    e.preventDefault();
    f = clamp(dist(e.touches) / d0, 0.4, 3);
    pagesEl.style.transform = `scale(${f})`;
    pagesEl.style.transformOrigin = "50% 0";
  }, { passive: false });
  const end = () => { if (!active) return; active = false; pagesEl.style.transform = ""; if (Math.abs(f - 1) > 0.03) setScale(s0 * f); };
  v.addEventListener("touchend", (e) => { if (e.touches.length < 2) end(); });
  v.addEventListener("touchcancel", end);
  v.addEventListener("wheel", (e) => { if (e.ctrlKey) { e.preventDefault(); setScale(S.scale * (e.deltaY < 0 ? 1.08 : 1 / 1.08)); } }, { passive: false });
})();

// Drag and drop
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f) openFromFile(f); });
window.addEventListener("beforeunload", (e) => { if (S.dirty && S.pages.length) { e.preventDefault(); e.returnValue = ""; } });
window.addEventListener("resize", () => positionCtx());

// Start
(async function init() {
  try { await window.wpStore?.ready; } catch {}
  await initMeasure();
  buildToolbar();
  setTool("select");
  if (innerWidth > 1000) $("#side").hidden = false;
  $("#zoomLabel").textContent = Math.round(S.scale * 100) + "%";
  window.__pdfApp = { S, addImage, editPoint, ensureAnalysis, scanContent, pagePictures, IMGS, loadDocument, buildPdf, setTool, runSearch, pageAction, addObj, uid, snapshot, undo, redo, openFromFile, insertFiles, viewportFor, drawOverlay, select, ctxAction, applyFormValues, setScale, fitWidth, makeZip, rasterize };
  document.body.dataset.ready = "1";
})();
