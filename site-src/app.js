import { grade, fmtBytes } from "../src/browser.ts";
import { SAMPLES } from "./samples.js";
import { VB_W, VB_H, GW, GH, terrain, quantile, floodPath, contourPaths, pickPoints, toGrid, el } from "./map.js";

const $ = (s) => document.querySelector(s);
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const svg = $("#map");
const plural = (n, w) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ease = (t) => 1 - Math.pow(1 - t, 3);

// ---------- static map furniture ----------
const defs = el("defs", {}, svg);
defs.innerHTML = `
  <pattern id="hatch-ve" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="9" height="9" fill="rgba(212,96,10,.3)"/><line x1="0" y1="0" x2="0" y2="9" stroke="#d4600a" stroke-width="2.2" stroke-opacity=".9"/></pattern>
  <pattern id="dots-ae" width="9" height="9" patternUnits="userSpaceOnUse"><rect width="9" height="9" fill="rgba(184,150,46,.22)"/><circle cx="4.5" cy="4.5" r="1.4" fill="#b8962e"/></pattern>
  <clipPath id="inner"><rect id="inner-r" x="14" y="14" width="${VB_W - 28}" height="${VB_H - 28}"/></clipPath>`;
const gContours = el("g", { "aria-hidden": "true" }, svg);
const gAE = el("path", { class: "flood-ae", d: "" }, svg);
const gVE = el("path", { class: "flood-ve", d: "" }, svg);
// cloud-sync history drawn as a levee along the Zone VE shore (FIRM levee symbol: line + teeth on the protected side)
const gLevee = el("g", { class: "levee-g", "aria-hidden": "true", "clip-path": "url(#inner)" }, svg);
const gRiver = el("g", { "aria-hidden": "true" }, svg);
const gFurn = el("g", { "aria-hidden": "true" }, svg);
const gBm = el("g", {}, svg);

// neatline ticks, north arrow
for (let i = 1; i < 16; i++) {
  const x = (VB_W / 16) * i;
  el("line", { class: "tick", x1: x, y1: 0, x2: x, y2: i % 4 ? 6 : 12 }, gFurn);
  el("line", { class: "tick", x1: x, y1: VB_H, x2: x, y2: VB_H - (i % 4 ? 6 : 12) }, gFurn);
}
for (let i = 1; i < 9; i++) {
  const y = (VB_H / 9) * i;
  el("line", { class: "tick", x1: 0, y1: y, x2: i % 3 ? 6 : 12, y2: y }, gFurn);
  el("line", { class: "tick", x1: VB_W, y1: y, x2: VB_W - (i % 3 ? 6 : 12), y2: y }, gFurn);
}
// visible slice of the sheet in viewBox units; the share image (?og) crops top and bottom
const view = { x0: 0, x1: VB_W, y0: 0, y1: VB_H };
const north = el("g", { class: "north", transform: `translate(${VB_W - 62},86)` }, gFurn);
el("path", { d: "M0 -30 L9 12 L0 5 L-9 12 Z", fill: "#14232e" }, north);
el("path", { d: "M0 -30 L0 5 L-9 12 Z", fill: "#cfdce3", stroke: "#14232e", "stroke-width": 1.2 }, north);
el("text", { x: 0, y: 34, "text-anchor": "middle" }, north).textContent = "N";
const scale = el("g", { class: "scalebar", transform: `translate(34,${VB_H - 72})` }, gFurn);
const leveeKey = el("g", { class: "levee-key" }, gFurn);
function placeFurniture() {
  north.setAttribute("transform", `translate(${view.x1 - 62},${view.y0 + 86})`);
  scale.setAttribute("transform", `translate(${view.x0 + 34},${view.y1 - 72})`);
  const r = $("#inner-r");
  r.setAttribute("x", view.x0 + 14);
  r.setAttribute("width", view.x1 - view.x0 - 28);
}

// Which cloud history, if any, holds back the water: the first verified provider, else the first one undomap
// found but couldn't confirm (a "provisionally accredited" levee, dashed), else iCloud (deletes only, dotted).
const PROVIDER = /^(iCloud Drive|Dropbox|OneDrive|Google Drive)/;
function leveeOf(r) {
  const cs = r.probes.filter((p) => p.name === "cloud sync" && p.status !== "absent" && PROVIDER.test(p.detail));
  if (!cs.length) return null;
  const p = cs.find((q) => q.status === "ok" && q.counts) ?? cs.find((q) => q.status === "unknown") ?? cs[0];
  const provider = p.detail.match(PROVIDER)[1];
  const state = p.status === "ok" && p.counts ? "verified" : p.status === "ok" ? "partial" : "unverified";
  const kept = r.findings.filter((f) => f.zone === "AE" && f.kind === "cloud" && f.why.includes(provider));
  return { provider, state, kept };
}

/** Inset key in the lower right of the visible sheet; returns its box so labels steer clear. */
function drawLeveeKey(lev) {
  leveeKey.innerHTML = "";
  leveeKey.classList.remove("on");
  if (!lev) return null;
  const k = labelK > 1.25 ? labelK : 1;
  const l1 = lev.state === "verified" ? `LEVEE · ${lev.provider.toUpperCase()} HISTORY` : lev.state === "partial" ? `LEVEE · ${lev.provider.toUpperCase()}, DELETES ONLY` : `LEVEE · PROVISIONAL`;
  const l2 = lev.state === "verified" ? (lev.kept.length ? `holds ${plural(lev.kept.length, "place")} · ${fmtBytes(lev.kept.reduce((a, f) => a + f.bytes, 0))}` : "client running · history verified") : lev.state === "partial" ? "keeps deletes 30 days, not overwrites" : `${lev.provider} history unverified`;
  // wide sheets: two lines in the lower right; phones: one line stacked on the scale inset
  const one = k > 1;
  const box = el("rect", { class: "key-box" }, leveeKey);
  const sym = el("g", { class: `levee ${lev.state}`, transform: `translate(12,${one ? 16 : 25})` }, leveeKey);
  el("path", { class: "teeth", d: "M0 0 L44 0" }, sym);
  el("path", { class: "line", d: "M0 0 L44 0" }, sym);
  const t1 = el("text", { class: "k1", x: 62, y: one ? 20.5 : 21 }, leveeKey);
  t1.textContent = l1;
  const t2 = one ? null : el("text", { class: "k2", x: 62, y: 38 }, leveeKey);
  if (t2) t2.textContent = l2;
  // size the inset to the lettering as rendered (display faces are wide; estimates overflow), again once fonts land
  const fit = () => {
    const tw = Math.max(t1.getComputedTextLength() || l1.length * 9, t2 ? t2.getComputedTextLength() || l2.length * 7.4 : 0);
    const w = (tw + 76) * k, h = (one ? 32 : 50) * k;
    box.setAttribute("width", (w / k).toFixed(1));
    box.setAttribute("height", (h / k).toFixed(1));
    const x0 = one ? view.x0 + 22 : view.x1 - 30 - w, y0 = one ? view.y1 - 116 - h : view.y1 - 30 - h;
    leveeKey.setAttribute("transform", `translate(${x0.toFixed(1)},${y0.toFixed(1)}) scale(${k.toFixed(3)})`);
    return { x0, y0, w, h };
  };
  const { x0, y0, w, h } = fit();
  document.fonts?.ready.then(() => t1.isConnected && fit());
  return { x0: x0 - 6, y0: y0 - 6, x1: x0 + w + 6, y1: y0 + h + 6 };
}

// grid column of section A–A′: left third of whatever part of the sheet is visible
const sectionCol = () => Math.round((view.x0 + (view.x1 - view.x0) * 0.29) / S);

// ---------- state ----------
let current = null; // { report, t, pts }
let anim = 0;
const tag = document.createElement("div");
tag.className = "tag";
tag.setAttribute("role", "tooltip");
document.body.appendChild(tag);

function shares(r) {
  const tot = r.totals.VE.bytes + r.totals.AE.bytes + r.totals.X.bytes || 1;
  let ve = r.totals.VE.bytes / tot, ae = r.totals.AE.bytes / tot;
  // keep tiny-but-real losses visible; never drown the whole sheet
  const dry = r.totals.X.files ? 0.14 : 0.04; // the high ground stays visible when anything is tracked
  if (r.totals.VE.places) ve = Math.min(0.7, Math.max(0.05, ve));
  if (r.totals.AE.places) ae = Math.min(1 - dry - ve, Math.max(0.06, ae));
  return { ve: r.totals.VE.places ? ve : 0, ae: r.totals.AE.places ? ae : 0, tot };
}

const S = VB_W / GW; // viewBox units per grid cell (square cells)
const viewRows = () => [Math.ceil(view.y0 / S) + 6, Math.floor(view.y1 / S) - 6];
const viewCols = () => [Math.ceil(view.x0 / S) + 6, Math.floor(view.x1 / S) - 8];
// Fit the visible window to the screen: the full 2:1 sheet on wide screens, a centred 5:4 window on phones
// (benchmarks and labels are placed inside the window, so nothing important is cut off).
function fitView() {
  const og = document.body.classList.contains("og");
  const fr = svg.getBoundingClientRect();
  const narrow = fr.width < 640;
  // share image: the frame's own aspect (the map column of the card)
  const w = og ? Math.min(VB_W, Math.round((VB_H * fr.width) / fr.height)) : narrow ? Math.round(VB_H * 1.25) : VB_W;
  view.x0 = Math.round((VB_W - w) / 2);
  view.x1 = view.x0 + w;
  view.y0 = 0;
  view.y1 = VB_H;
  svg.setAttribute("viewBox", `${view.x0} 0 ${w} ${VB_H}`);
  // keep map lettering about 13px on screen whatever the sheet's scale
  const px = svg.getBoundingClientRect().width / w;
  labelK = Math.min(2.4, Math.max(1, 13 / (15 * px)));
  svg.style.setProperty("--k", labelK.toFixed(3));
  document.body.classList.toggle("big-labels", labelK > 1.25);
}
let labelK = 1;

function drawScale(r, s) {
  scale.innerHTML = "";
  const W = labelK > 1.25 ? 200 : 300; // phones: shorter, so the inset stays clear of section A–A′
  // a paper inset, like a printed scale: water and levees never run through the lettering
  const paper = el("rect", { class: "key-box", x: -12, y: -29, width: W + 24, height: 66 }, scale);
  el("rect", { x: 0, y: 0, width: W, height: 9, fill: "#cfdce3", stroke: "#14232e", "stroke-width": 1.2 }, scale);
  el("rect", { x: 0, y: 0, width: W * s.ve, height: 9, fill: "url(#hatch-ve)" }, scale);
  el("rect", { x: W * s.ve, y: 0, width: W * s.ae, height: 9, fill: "url(#dots-ae)" }, scale);
  for (const q of labelK > 1.25 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]) {
    el("line", { x1: W * q, y1: -4, x2: W * q, y2: 13, stroke: "#14232e", "stroke-width": 1 }, scale);
    el("text", { x: W * q, y: 28, "text-anchor": "middle" }, scale).textContent = q === 0 ? "0" : `${q * 100}%`;
  }
  // phones letter the scale ~2x bigger, so only the title fits the inset
  const title = el("text", { x: 0, y: -12 }, scale);
  title.textContent = labelK > 1.25 ? "SCALE OF LOSS" : `SCALE OF LOSS · flood area ∝ share of ${fmtBytes(s.tot)} mapped`;
  const fit = () => paper.setAttribute("width", Math.max(W + 36, (title.getComputedTextLength() || 0) + 24).toFixed(1));
  fit();
  document.fonts?.ready.then(() => title.isConnected && fit());
}

function benchmarkLabel(f) {
  const p = f.kind === "symlink-escape" ? `${f.path} → ${f.target}` : f.path === "*" ? "./* loose files" : f.path.replace(/^\.\//, "") || "./";
  if (f.kind === "tracked") return { a: `${fmtBytes(f.bytes)} tracked`, b: `${f.path === "./" ? "" : f.path + " "}${plural(f.files, "file")}` };
  let b = p;
  if (f.kind === "symlink-escape" && b.length > 30) {
    // keep the link's own name; shorten the target from the left, whole segments first
    const seg = f.target.split(/[\\/]/).filter(Boolean);
    for (const n of [2, 1]) if (b.length > 30) b = `${f.path} → …/${seg.slice(-n).join("/")}`;
  }
  return { a: f.kind === "unpushed" ? `${f.unpushed} unpushed` : fmtBytes(f.bytes), b: b.length > 30 ? "…" + b.slice(-29) : b };
}

function placeBenchmarks(r, t, lv, features) {
  gBm.innerHTML = "";
  const taken = features.map((b) => [(b.x0 + b.x1) / 2 / S, (b.y0 + b.y1) / 2 / S]);
  const groups = [
    ["VE", r.findings.filter((f) => f.zone === "VE").slice(0, 7), t.min - 1, lv.ve],
    ["AE", r.findings.filter((f) => f.zone === "AE").slice(0, 4), lv.ve, lv.ae],
    ["X", r.findings.filter((f) => f.zone === "X").slice(0, 2), lv.ae, t.max + 1],
  ];
  const boxes = [...features];
  const out = [];
  let n = 0;
  // site every benchmark first, so no label is lettered across a triangle placed after it
  const k0 = labelK > 1.25 ? labelK : 1, tri = 13 * Math.min(k0, 1.8);
  const sited = [];
  for (const [zone, fs, lo, hi] of groups) {
    if (!fs.length) continue;
    const ridgeBox = features[features.length - 1];
    const pts = pickPoints(t, lo, hi, fs.length, toGrid({ ...ridgeBox, y0: ridgeBox.y0 - 30, y1: ridgeBox.y1 + 24 }), taken, viewRows(), viewCols());
    pts.forEach((p, i) => {
      taken.push([p.x / S, p.y / S]);
      sited.push([zone, fs[i], p]);
      // the triangle (and stake), plus room above it for the bare number if its label finds no room; halos pad 4
      boxes.push({ x0: p.x - tri - 4, x1: p.x + tri + 4, y0: p.y - (fs[i].forcedBy ? 2.4 : 1) * tri - 6 - 12 * k0, y1: p.y + 0.6 * tri + 4 });
    });
  }
  sited.forEach(([zone, f, p]) => {
    n++;
    const g = el("g", { class: `bm ${zone.toLowerCase()} wait`, transform: `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`, tabindex: 0, role: "button", "aria-label": `${zone} ${fmtBytes(f.bytes)} ${f.path}: ${f.why}` }, gBm);
    g.dataset.i = String(r.findings.indexOf(f));
    el("circle", { class: "ring", r: 6 }, g);
    el("path", { d: "M0 -13 L11.5 7 L-11.5 7 Z" }, g);
    el("circle", { class: "disc", cy: 1, r: 3 }, g);
    // staked by the surveyor: .undomap.json says permanent
    if (f.forcedBy) el("path", { class: "stake", d: "M0 -13 V-31 M0 -30 L13 -25.5 L0 -21 Z" }, g);
    const lab = benchmarkLabel(f);
    // phones show one bigger label line (see .narrow-map in style.css), so boxes scale with it
    const k = labelK > 1.25 ? labelK : 1;
    const w = (k > 1 ? `BM ${n} · ${lab.a}`.length * 9.1 : Math.max(`BM ${n} · ${lab.a}`.length * 9.1, lab.b.length * 7.9)) * k + 10;
    const bh = k > 1 ? 34 : 36;
    // try right, left, below, above
    const opts = [[18, -2, "start"], [-18, -2, "end"], [-w / 2, 34, "start"], [-w / 2, -34, "start"]].map(([x, y, a]) => [x * k, y * k, a]);
    let pick = null;
    for (const o of [...opts, [26 * k, -16 * k, "start"], [-26 * k, -16 * k, "end"], [26 * k, 14 * k, "start"], [-26 * k, 14 * k, "end"]]) {
      const x0 = p.x + (o[2] === "end" ? o[0] - w : o[0]), y0 = p.y + o[1] - 16 * k;
      const box = { x0, y0, x1: x0 + w, y1: y0 + bh * (k > 1 ? 1.2 : 1) };
      const inside = box.x0 > view.x0 + 8 && box.x1 < view.x1 - 8 && box.y0 > view.y0 + 8 && box.y1 < view.y1 - 8;
      const clash = boxes.some((q) => !(box.x1 < q.x0 || box.x0 > q.x1 || box.y1 < q.y0 || box.y0 > q.y1));
      if (inside && !clash) {
        pick = o;
        boxes.push(box);
        break;
      }
    }
    // no room: the triangle stays, the survey tag (hover/focus) carries the label
    if (pick) {
      const tx = el("text", { x: pick[0], y: pick[1], "text-anchor": pick[2] }, g);
      const t1 = el("tspan", { class: "lab1 halo", x: pick[0] }, tx);
      t1.textContent = `BM ${n} · ${lab.a}`;
      const t2 = el("tspan", { class: "lab2 halo", x: pick[0], dy: 17 }, tx);
      t2.textContent = lab.b;
    } else {
      const tx = el("text", { x: 0, y: -(f.forcedBy ? 2.4 : 1) * tri - 5, "text-anchor": "middle" }, g);
      el("tspan", { class: "lab1 halo" }, tx).textContent = String(n);
    }
    out.push({ g, h: p.h, f, zone });
  });
  return out;
}

function drawRiver(t, extra = []) {
  gRiver.innerHTML = "";
  const d = "M" + t.river.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join("L");
  const path = el("path", { class: "river", d, id: "river" }, gRiver);
  const len = path.getTotalLength();
  // map furniture first, so the river names can steer clear of it
  const sx = sectionCol() * S;
  const boxes = [
    { x0: view.x1 - 110, x1: view.x1, y0: view.y0 + 30, y1: view.y0 + 140 }, // north arrow
    { x0: view.x0 + 20, x1: view.x0 + (labelK > 1.25 ? 260 : 360), y0: view.y1 - 110, y1: view.y1 - 30 }, // scale bar
    { x0: sx - 6, x1: sx + 30, y0: view.y0 + 20, y1: view.y0 + 60 },
    { x0: sx - 6, x1: sx + 30, y0: view.y1 - 60, y1: view.y1 - 20 },
    ...extra,
  ];
  const secLine = { x0: sx - 14, x1: sx + 14, y0: view.y0, y1: view.y1 }; // river names don't cross section A–A′
  const hit = (b) => [...boxes, secLine].some((q) => !(b.x1 < q.x0 || b.x0 > q.x1 || b.y1 < q.y0 || b.y0 > q.y1));
  let from = 0;
  for (const text of ["rm  −rf  creek", "git  clean  −fdx"]) {
    for (let at = from; at < 0.95; at += 0.02) {
      const a = path.getPointAtLength(len * at), b = path.getPointAtLength(Math.min(len, len * at + 190));
      const box = { x0: Math.min(a.x, b.x) - 10, x1: Math.max(a.x, b.x) + 10, y0: Math.min(a.y, b.y) - 34, y1: Math.max(a.y, b.y) + 8 };
      if (box.x0 < view.x0 + 12 || box.x1 > view.x1 - 12 || hit(box)) continue;
      const tx = el("text", { class: "feature", dy: -9 }, gRiver);
      el("textPath", { href: "#river", startOffset: `${(at * 100).toFixed(1)}%` }, tx).textContent = text;
      boxes.push(box);
      from = at + 0.3 * ((view.x1 - view.x0) / VB_W);
      break;
    }
  }
  // the ridge label sits on the true summit of this terrain
  const [r0, r1] = viewRows();
  const kk = labelK > 1.25 ? labelK : 1;
  const half = 150 * kk; // half the width of "GIT CHECKOUT HEIGHTS" at this lettering size
  let best = -Infinity, bx = 20, by = 12;
  // keep the name off the section line; a phone's narrow window may leave no room, so then it may cross it
  for (const offSection of [true, false]) {
    for (let y = r0 + 2; y < r1 + 2; y++)
      for (let x = Math.ceil((view.x0 + half) / S) + 2; x < Math.floor((view.x1 - half) / S) - 2; x++) {
        if (offSection && Math.abs(x * S - sectionCol() * S) < half + 16) continue;
        if (x > view.x1 / S - 30 && y < r0 + 12) continue; // north arrow
        const b = { x0: x * S - half, x1: x * S + half, y0: y * S - 14 * kk, y1: y * S + 12 * kk };
        if (boxes.some((q) => !(b.x1 < q.x0 || b.x0 > q.x1 || b.y1 < q.y0 || b.y0 > q.y1))) continue; // scale, key
        const h = t.v[y * GW + x];
        if (h > best) (best = h), (bx = x), (by = y);
      }
    if (best > -Infinity) break;
  }
  const rg = el("text", { class: "ridge", x: bx * S, y: by * S + 6, "text-anchor": "middle" }, gRiver);
  rg.textContent = "GIT CHECKOUT HEIGHTS";
  boxes.push({ x0: bx * S - half, x1: bx * S + half, y0: by * S - 14 * kk, y1: by * S + 12 * kk });
  return boxes;
}

function drawContours(t) {
  gContours.innerHTML = "";
  contourPaths(t).forEach((c, i) => {
    const p = el("path", { class: `contour${c.index ? " index" : ""}${reduce ? "" : " draw"}`, d: c.d, pathLength: 1 }, gContours);
    if (!reduce) p.style.animationDelay = `${(i * 0.035).toFixed(3)}s`;
  });
}

function setReadout(r, bytes, places) {
  const ro = $(".readout");
  ro.classList.toggle("none", r.totals.VE.places === 0);
  $("#ve-bytes").textContent = fmtBytes(bytes);
  $("#ve-rest").textContent = r.totals.VE.places === 0 ? "— nothing here your agent can erase for good" : `across ${plural(places, "place")} your agent can erase forever`;
}

function render(report, seed, { instant = reduce } = {}) {
  cancelAnimationFrame(anim);
  const t = terrain(seed);
  const s = shares(report);
  const lv = { ve: s.ve ? quantile(t, s.ve) : t.min - 1, ae: s.ae ? quantile(t, s.ve + s.ae) : s.ve ? quantile(t, s.ve) : t.min - 1 };
  fitView();
  placeFurniture();
  drawContours(t);
  const lev = report.totals.VE.places ? leveeOf(report) : null;
  const keyBox = drawLeveeKey(lev);
  const features = drawRiver(t, keyBox ? [keyBox] : []);
  drawScale(report, s);
  const bms = placeBenchmarks(report, t, lv, features);
  drawProfile(t, lv, report);
  gLevee.innerHTML = "";
  gLevee.classList.remove("on");
  if (lev) {
    const g = el("g", { class: `levee ${lev.state}` }, gLevee);
    const d = floodPath(t, lv.ve, true);
    el("path", { class: "teeth", d }, g);
    el("path", { class: "line", d }, g);
  }
  const raise = () => {
    gLevee.classList.add("on");
    leveeKey.classList.add("on");
  };
  current = { report, t, bms, seed };
  renderRegister(report);
  const flash = (b) => {
    b.g.classList.remove("wait");
    if (!instant) b.g.classList.add("flash");
  };
  if (instant) {
    gVE.setAttribute("d", floodPath(t, lv.ve, true));
    gAE.setAttribute("d", floodPath(t, lv.ae, true));
    bms.forEach(flash);
    raise();
    setReadout(report, report.totals.VE.bytes, report.totals.VE.places);
    return;
  }
  gVE.setAttribute("d", "");
  gAE.setAttribute("d", "");
  setReadout(report, 0, 0);
  $("#ve-rest").textContent = "surveying…"; // until the water starts rising
  const t0 = performance.now() + 650;
  const DVE = 1700, DAE = 1100;
  const veB = bms.filter((b) => b.zone === "VE");
  const step = (now) => {
    const e = now - t0;
    if (e < 0) return (anim = requestAnimationFrame(step));
    const pv = Math.min(1, e / DVE);
    const levelVE = t.min + (lv.ve - t.min) * ease(pv);
    gVE.setAttribute("d", floodPath(t, levelVE, pv === 1));
    let bytes = 0, places = 0;
    for (const b of veB) if (b.h <= levelVE + 1e-9 && b.g.classList.contains("wait")) flash(b);
    for (const b of veB) if (!b.g.classList.contains("wait")) { bytes += b.f.bytes; places++; }
    // the readout climbs with the water, landing on the exact total
    if (pv === 1) { bytes = report.totals.VE.bytes; places = report.totals.VE.places; }
    else bytes = Math.max(bytes, report.totals.VE.bytes * ease(pv) * 0.97);
    setReadout(report, bytes, Math.max(places, Math.round(report.totals.VE.places * pv)));
    if (e > DVE) {
      if (lev && !gLevee.classList.contains("on")) raise();
      const pa = Math.min(1, (e - DVE) / DAE);
      const levelAE = lv.ve + (lv.ae - lv.ve) * ease(pa);
      gAE.setAttribute("d", floodPath(t, Math.max(levelAE, lv.ve), pa === 1));
      for (const b of bms) if (b.zone === "AE" && b.h <= levelAE && b.g.classList.contains("wait")) flash(b);
      if (pa === 1) {
        for (const b of bms) if (b.g.classList.contains("wait")) flash(b);
        return;
      }
    }
    anim = requestAnimationFrame(step);
  };
  anim = requestAnimationFrame(step);
}

// ---------- Section A–A′ (a real cross-section of the current terrain) ----------
const prof = $("#profile");
const gSec = el("g", { "aria-hidden": "true" });
svg.insertBefore(gSec, gFurn); // insets (scale, levee key) are opaque paper over the section line
function drawProfile(t, lv, r) {
  prof.innerHTML = "";
  gSec.innerHTML = "";
  const col = sectionCol();
  // phones: letter the section at ~11px on screen and keep labels short (the station list below spells them out)
  const pw = prof.getBoundingClientRect().width || 1200;
  const pk = pw < 640 ? Math.max(1, (11 * 1200) / (pw * 12)) : 1;
  const W = 1200, H = 300, top = 14 + 26 * pk, bot = 250; // headroom for a station label on the highest ground
  prof.style.setProperty("--pk", pk.toFixed(3));
  const cw = 7.4 * pk; // mono advance at this size
  const hs = Array.from({ length: GH }, (_, y) => t.v[y * GW + col]);
  const lo = Math.min(...hs), hi = Math.max(...hs);
  const X = (y) => 40 + (y / (GH - 1)) * (W - 80);
  const Y = (h) => bot - ((h - lo) / (hi - lo || 1)) * (bot - top);
  const ground = hs.map((h, y) => `${X(y).toFixed(1)},${Y(h).toFixed(1)}`).join(" L");
  const water = (level, cls) => {
    if (level <= lo) return;
    const poly = `M${X(0)},${Y(level)} ` + hs.map((h, y) => `L${X(y).toFixed(1)},${Y(Math.min(h, level)).toFixed(1)}`).join(" ") + ` L${X(GH - 1)},${Y(level)} Z`;
    el("path", { class: cls, d: poly }, prof);
    el("line", { class: "lvl", x1: 40, x2: W - 40, y1: Y(level), y2: Y(level), stroke: cls === "w-ve" ? "#d4600a" : "#b8962e" }, prof);
  };
  water(Math.min(lv.ae, hi), "w-ae");
  water(Math.min(lv.ve, hi), "w-ve");
  el("path", { class: "ground", d: `M${X(0)},${H - 14} L${ground} L${X(GH - 1)},${H - 14} Z` }, prof);
  el("text", { x: 14, y: H - 20, class: "big" }, prof).textContent = "A";
  el("text", { x: W - 14, y: H - 20, class: "big", "text-anchor": "end" }, prof).textContent = "A′";
  // survey stations along the section (the five questions undomap asks of every path)
  const taken = [];
  ["git status", "regenerable?", "remotes", "snapshots", "cloud sync"].forEach((name, i) => {
    const label = pk > 1 ? `BM ${i + 1}` : `BM ${i + 1} ${name}`;
    const y = Math.round((GH - 1) * (0.08 + i * 0.2));
    const sx = X(y), sy = Y(hs[y]) - 4;
    const g = el("g", { class: "stn", transform: `translate(${sx.toFixed(1)},${sy.toFixed(1)})` }, prof);
    el("path", { d: "M0 -12 L10 5 L-10 5 Z", transform: `scale(${Math.min(pk, 1.8).toFixed(2)})` }, g);
    el("text", { x: 0, y: -14 - 6 * pk, "text-anchor": "middle" }, g).textContent = label;
    const hw = (label.length * cw) / 2 + 6;
    taken.push({ x0: sx - hw, x1: sx + hw, y0: sy - 14 - 18 * pk, y1: sy + 8 });
  });
  // zone labels ride their water line; slide along it (right, centre, left), then lift, to stay off the stations
  const zoneLabel = (level, text) => {
    const w = text.length * cw + 8;
    const yl = Y(Math.min(level, hi)) - 6;
    for (let lift = 0; lift < 100 * pk; lift += 16 * pk)
      for (const x1 of [W - 44, W / 2 + w / 2, 48 + w]) {
        const b = { x0: x1 - w, x1, y0: yl - lift - 13 * pk, y1: yl - lift + 3 };
        if (taken.some((q) => !(b.x1 < q.x0 || b.x0 > q.x1 || b.y1 < q.y0 || b.y0 > q.y1))) continue;
        taken.push(b);
        el("text", { x: x1, y: yl - lift, "text-anchor": "end", class: "zl" }, prof).textContent = text;
        return;
      }
  };
  if (r.totals.VE.places && lv.ve > lo) zoneLabel(lv.ve, pk > 1 ? `VE · ${fmtBytes(r.totals.VE.bytes)}` : `ZONE VE · ${fmtBytes(r.totals.VE.bytes)} · no way back`);
  if (r.totals.AE.places && lv.ae > lv.ve) zoneLabel(lv.ae, pk > 1 ? `AE · ${fmtBytes(r.totals.AE.bytes)}` : `ZONE AE · ${fmtBytes(r.totals.AE.bytes)} · slow undo`);
  // the section line on the map itself
  const x = col * S + S / 2;
  el("line", { x1: x, x2: x, y1: view.y0 + 24, y2: view.y1 - 24, stroke: "#14232e", "stroke-width": 1.4, "stroke-dasharray": "10 6 2 6", opacity: 0.7 }, gSec);
  el("text", { x: x + 8, y: view.y0 + 40, class: "feature", style: "font-style:normal;font-weight:600;letter-spacing:0" }, gSec).textContent = "A";
  // where the scale inset covers the foot of the line (narrow share-image crops), letter A′ just above the inset
  const inset = scale.querySelector(".key-box");
  const insetRight = view.x0 + 22 + Number(inset?.getAttribute("width") || 0);
  const yA = x + 8 < insetRight ? view.y1 - 108 : view.y1 - 30;
  el("text", { x: x + 8, y: yA, class: "feature", style: "font-style:normal;font-weight:600;letter-spacing:0" }, gSec).textContent = "A′";
}

// ---------- register below the map ----------
function copyBtn(text) {
  return `<button type="button" data-copy="${esc(text)}">copy</button>`;
}
function renderRegister(r) {
  const ve = r.findings.filter((f) => f.zone === "VE");
  const ae = r.findings.filter((f) => f.zone === "AE");
  const max = ve[0]?.bytes || 1;
  const bmIndex = new Map(current.bms.map((b, i) => [b.f, i + 1]));
  $("#rows-ve").innerHTML = ve.length
    ? ve
        .map((f, i) => {
          const n = bmIndex.get(f);
          const p = f.kind === "symlink-escape" ? `${f.path} → ${f.target}` : f.path === "*" ? "./* (loose files)" : f.path.replace(/^\.\/(?=.)/, "");
          return `<li data-i="${r.findings.indexOf(f)}"><span class="bmn">${n ? "BM " + n : "VE " + (i + 1)}</span><span class="by">${fmtBytes(f.bytes)}${f.capped ? "+" : ""}<i class="bar" style="width:${Math.max(3, (f.bytes / max) * 100).toFixed(1)}%"></i></span><span class="p">${esc(p)}<span class="why">${esc(f.why)}${f.files > 1 ? " · " + plural(f.files, "file") : ""}</span></span><span class="fx">${f.fix ? esc(cap(f.fix.say)) + (f.fix.run ? `<code><span class="c">$ ${esc(f.fix.run)}</span>${copyBtn(f.fix.run)}</code>` : "") : ""}</span></li>`;
        })
        .join("")
    : `<li><span class="empty"><b>0 B</b> in Zone VE — nothing here your agent can erase for good.</span></li>`;
  $("#reg-sub").textContent = ve.length
    ? `${fmtBytes(r.totals.VE.bytes)} across ${plural(r.totals.VE.places, "place")} in ${r.root}. Biggest first, each with the cheapest fix that actually protects it.`
    : `Nothing in the velocity zone at ${r.root}.`;
  $("#ae-sum").textContent = ae.length ? `${fmtBytes(r.totals.AE.bytes)} across ${plural(ae.length, "place")}` : "nothing";
  $("#rows-ae").innerHTML = ae
    .slice(0, 8)
    .map((f) => `<li data-i="${r.findings.indexOf(f)}"><span class="bmn">${bmIndex.get(f) ? "BM " + bmIndex.get(f) : "AE"}</span><span class="by">${f.kind === "unpushed" ? "—" : fmtBytes(f.bytes)}</span><span class="p">${esc(f.path.replace(/^\.\/(?=.)/, ""))}<span class="why">${esc(f.why)}</span></span></li>`)
    .join("");
  $("#x-sum").textContent = r.totals.X.files ? `${fmtBytes(r.totals.X.bytes)} · ${plural(r.totals.X.files, "tracked file")} — git checkout / git restore` : "no clean tracked files";
  $("#probes").innerHTML = "probes&nbsp; " + r.probes.map((p) => `${esc(p.name)} <span class="${p.status === "ok" ? (p.counts ? "ok" : "") : p.status === "absent" ? "no" : ""}">${p.status === "ok" ? (p.counts ? "✓" : "~") : p.status === "absent" ? "✗" : "?"}</span> ${esc(p.detail)}`).join(" &nbsp;·&nbsp; ");
}

// ---------- hover / focus survey tag ----------
function showTag(g, x, y) {
  const f = current.report.findings[Number(g.dataset.i)];
  if (!f) return;
  tag.innerHTML = `<span class="z ${f.zone}">ZONE ${f.zone}</span><b>${esc(fmtBytes(f.bytes))}</b> · ${esc(f.path)}<br>${esc(f.why)}${f.fix ? `<br><i>${esc(cap(f.fix.say))}</i>${f.fix.run ? `<code>$ ${esc(f.fix.run)}</code>` : ""}` : ""}`;
  const w = 360;
  tag.style.left = `${Math.min(innerWidth - w - 12, x + 16)}px`;
  tag.style.top = `${Math.max(8, y - 20)}px`;
  tag.classList.add("on");
  document.querySelectorAll(`.rows li[data-i="${g.dataset.i}"]`).forEach((li) => li.classList.add("hot"));
}
function hideTag() {
  tag.classList.remove("on");
  document.querySelectorAll(".rows li.hot").forEach((li) => li.classList.remove("hot"));
}
gBm.addEventListener("pointerover", (e) => {
  const g = e.target.closest(".bm");
  if (g) showTag(g, e.clientX, e.clientY);
});
gBm.addEventListener("pointerout", hideTag);
gBm.addEventListener("focusin", (e) => {
  const g = e.target.closest(".bm");
  if (g) {
    const b = g.getBoundingClientRect();
    showTag(g, b.right, b.top);
  }
});
gBm.addEventListener("focusout", hideTag);
document.addEventListener("pointerover", (e) => {
  const li = e.target.closest?.(".rows li[data-i]");
  document.querySelectorAll("#map .bm.hot").forEach((g) => g.classList.remove("hot"));
  if (li) document.querySelector(`#map .bm[data-i="${li.dataset.i}"]`)?.classList.add("hot");
});

// ---------- copy buttons ----------
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-copy]");
  if (!b) return;
  try {
    await navigator.clipboard.writeText(b.dataset.copy);
    const was = b.textContent;
    b.textContent = "copied";
    b.classList.add("ok");
    setTimeout(() => ((b.textContent = was), b.classList.remove("ok")), 1400);
  } catch {
    b.textContent = "select";
  }
});

// ---------- sites ----------
const panels = SAMPLES.map((s) => ({ ...s, report: grade(s.inv, { config: s.config }) }));
const sites = $("#sites");
function select(i, opts) {
  const s = panels[i];
  [...sites.children].forEach((b, j) => b.setAttribute("aria-selected", String(j === i)));
  document.querySelectorAll("[data-panel]").forEach((n) => (n.textContent = String(i + 1).padStart(2, "0")));
  $("[data-panel-kind]").textContent = `Survey panel ${String(i + 1).padStart(2, "0")}`;
  $("#root").textContent = s.report.root;
  $("#story").textContent = s.story + " ";
  const src = $("#story-src");
  src.textContent = s.source ? `Source: ${s.source.text}` : "";
  src.href = s.source?.href ?? "#";
  render(s.report, s.seed, opts);
}
panels.forEach((s, i) => {
  const b = document.createElement("button");
  b.type = "button";
  b.setAttribute("role", "tab");
  b.innerHTML = `<span class="n">${String(i + 1).padStart(2, "0")}</span>${esc(s.label)}`;
  b.addEventListener("click", () => select(i));
  sites.appendChild(b);
});
document.querySelectorAll("[data-panels]").forEach((n) => (n.textContent = String(panels.length).padStart(2, "0")));

// ---------- your own JSON ----------
function loadYours(text) {
  const err = $("#yours-err");
  err.textContent = "";
  let r;
  try {
    r = JSON.parse(text);
  } catch {
    err.textContent = "That isn't JSON. Run undomap --json > undomap.json and drop that file.";
    return;
  }
  if (r?.tool !== "undomap" || !Array.isArray(r.findings) || !r.totals) {
    err.textContent = "This JSON isn't an undomap report (expected \"tool\": \"undomap\" with findings and totals).";
    return;
  }
  [...sites.children].forEach((b) => b.setAttribute("aria-selected", "false"));
  $("[data-panel-kind]").textContent = "Your survey";
  $("#root").textContent = r.root;
  $("#story").textContent = `Drawn from your undomap ${r.version} report of ${r.findings.length} places. Nothing left this tab.`;
  $("#story-src").textContent = "";
  let seed = 0;
  for (const c of String(r.root)) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  document.querySelector(".sheet").scrollIntoView({ behavior: reduce ? "auto" : "smooth" });
  render(r, seed || 5);
}
$("#file").addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (f) loadYours(await f.text());
});
const drop = $("#drop");
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.add("over"))));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove("over")));
drop.addEventListener("drop", async (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) loadYours(await f.text());
});
$("#paste-go").addEventListener("click", () => loadYours($("#paste").value));

// ---------- go ----------
const qs = new URLSearchParams(location.search);
if (qs.has("og")) {
  // share-image mode (scripts/make_assets.sh): the map and its collar, nothing else
  document.body.classList.add("og");
  // headless screenshots can lay out before the final viewport size; take the card size from the URL
  const ogH = Number(qs.get("h")) || innerHeight;
  document.documentElement.style.setProperty("--og-h", ogH + "px");
}
select(Number(qs.get("panel") ?? 0) || 0, { instant: reduce || qs.has("still") || qs.has("og") });
// Re-survey when the sheet changes size (window resize, fonts settling, share-image viewport):
// the visible window and the lettering scale depend on it.
let resizeT = 0, lastW = 0, lastH = 0;
new ResizeObserver(([e]) => {
  const { width, height } = e.contentRect;
  if (Math.abs(width - lastW) < 2 && Math.abs(height - lastH) < 2) return;
  const first = !lastW;
  lastW = width;
  lastH = height;
  if (first) return;
  clearTimeout(resizeT);
  resizeT = setTimeout(() => current && render(current.report, current.seed ?? 7, { instant: true }), 200);
}).observe($(".frame"));
// QA hook for headless checks (scripts/qa.sh): report horizontal overflow and the widest offender.
if (new URLSearchParams(location.search).has("qa")) {
  const cw = document.documentElement.clientWidth;
  let worst = null, max = cw;
  for (const n of document.querySelectorAll("body *")) {
    const r = n.getBoundingClientRect();
    if (r.width && r.right > max + 0.5 && getComputedStyle(n).position !== "fixed") (max = r.right), (worst = n);
  }
  const box = (q) => { const r = $(q)?.getBoundingClientRect(); return r ? [q, Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(":") : q + ":none"; };
  document.body.dataset.rects = [".sheet", ".frame", "#map", ".collar", ".c-title", ".c-title h1"].map(box).join(" ") + " vb:" + svg.getAttribute("viewBox");
  document.body.dataset.overflow = String(document.documentElement.scrollWidth - cw) + (worst ? ` ${worst.tagName.toLowerCase()}.${worst.className?.baseVal ?? worst.className}` : "");
}
