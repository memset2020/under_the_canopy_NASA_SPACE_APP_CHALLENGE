// Landing page (landing.html, docs/10 D-084). The HTML carries English text so the page reads
// even if this script cannot run; with it, every string comes from i18n (CLAUDE.md rule 7) and
// every number, chart and map dot is drawn from the published data, never typed in.
import { LANGUAGES, fmtApprox, fmtDate, fmtNumber, language, loadLocale, t } from "./i18n.js";
import { methaneLedger } from "./methane.js";
import { drawCard } from "./floodcard.js";
import { waltzScore } from "./waltz.js";
import { decodePlanes, fillSurface, iceLut, paintPlane, speedRange } from "./glaciermaps.js";
import { hillshade, readBinary, toCanvas } from "./motionmaps.js";

const SVGNS = "http://www.w3.org/2000/svg";
const REVEAL_SITE = "sylhet";
const REVEAL_PASS = "p01";

function sv(tag, attrs = {}, parent = null) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
}

function svText(parent, x, y, text, attrs = {}) {
  const e = sv("text", { x, y, ...attrs }, parent);
  e.textContent = text;
  return e;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- text

// Keys whose text needs numbers wait for the data (fillNumbers); the HTML's English stays
// until then, so a failed fetch never shows a placeholder.
function applyText(root) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    const text = t(el.dataset.i18n);
    if (!/\{\w+\}/.test(text)) el.textContent = text;
  }
  for (const el of root.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll("[data-i18n-alt]")) el.setAttribute("alt", t(el.dataset.i18nAlt));
  document.title = t("landing.page_title");
}

function setText(key, params) {
  for (const el of document.querySelectorAll(`[data-i18n="${key}"]`)) el.textContent = t(key, params);
}

function setNum(name, text) {
  for (const el of document.querySelectorAll(`[data-num="${name}"]`)) {
    if (!el.dataset.i18n) el.textContent = text;
  }
}

// Links into the app keep the chosen language.
function carryLanguage(lang) {
  if (lang === "en") return;
  for (const a of document.querySelectorAll('a[href^="index.html"]')) {
    const url = new URL(a.getAttribute("href"), location.href);
    url.searchParams.set("lang", lang);
    a.setAttribute("href", `index.html${url.search}`);
  }
}

// ---------------------------------------------------------------- the film

const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function initFilm(lang) {
  const section = document.getElementById("film");
  const video = document.getElementById("film-video");
  const ui = document.getElementById("film-ui");
  const bar = document.getElementById("film-bar");
  const play = document.getElementById("film-play");
  const sound = document.getElementById("film-sound");
  if (!section || !video) return;
  // Tall screens get the portrait cut; a missing file falls back towards English landscape. English
  // plays the narrated film (the narrator's cloned voice, docs/10 D-115) with its captions; Bengali
  // and Portuguese keep the film without a voice, since an English voice would not match their words.
  const portrait = matchMedia("(max-aspect-ratio: 4/5)").matches;
  const cut = portrait ? "-portrait" : "";
  const tries = [...new Set([
    ...(lang === "en" ? [`media/intro-en${cut}-vo-clone.mp4`] : []),
    `media/intro-${lang}${cut}.mp4`,
    `media/intro-en${cut}.mp4`,
    "media/intro-en.mp4",
  ])];
  const narrated = () => tries[k].includes("-vo-clone");
  let k = 0;
  video.removeAttribute("controls");
  video.muted = true;
  video.setAttribute("muted", "");
  // The poster is the title card: for people who asked for less motion, and for no script.
  // Before autoplay it would flash the ending first, so the film starts from black instead.
  if (reduceMotion()) video.poster = `media/intro-${lang}.jpg`;
  else video.removeAttribute("poster");
  ui.hidden = false;
  // The voice's captions (WCAG 1.2.2; Space Apps asks for English subtitles). They show only while
  // the sound is on: muted, the film's own on-screen words already carry it.
  let captions = null;
  const load = () => {
    video.src = tries[k];
    captions?.remove();
    captions = null;
    if (narrated()) {
      captions = document.createElement("track");
      Object.assign(captions, { kind: "captions", srclang: "en", label: t("landing.film_captions"), src: "media/intro-en-vo-clone.vtt" });
      video.append(captions);
    }
    video.load();
  };
  const showCaptions = () => {
    if (captions?.track) captions.track.mode = video.muted ? "hidden" : "showing";
  };
  video.addEventListener("error", () => {
    if (++k < tries.length) {
      if (k === tries.length - 1 && reduceMotion()) video.poster = "media/intro-en.jpg";
      load();
      if (!reduceMotion()) start();
    }
  });

  const icon = (btn, id) => btn.querySelector("use").setAttribute("href", `#${id}`);
  const label = (btn, key) => (btn.querySelector("span").textContent = t(key));
  let userPaused = false;
  const render = () => {
    const ended = video.ended;
    section.classList.toggle("ended", ended);
    if (ended) {
      icon(play, "i-replay");
      label(play, "landing.film_replay");
    } else if (video.paused) {
      icon(play, "i-play");
      label(play, "landing.film_play");
    } else {
      icon(play, "i-pause");
      label(play, "landing.film_pause");
    }
    icon(sound, video.muted ? "i-sound-off" : "i-sound-on");
    label(sound, video.muted ? "landing.film_sound_on" : "landing.film_sound_off");
    showCaptions();
  };
  const start = () =>
    video.play().catch(() => {
      if (!video.muted) {
        video.muted = true;
        video.play().catch(() => {});
      }
      render();
    });
  play.addEventListener("click", () => {
    if (video.ended) video.currentTime = 0;
    if (video.paused) {
      userPaused = false;
      section.classList.remove("paused-start");
      start();
    } else {
      userPaused = true;
      video.pause();
    }
  });
  sound.addEventListener("click", () => {
    video.muted = !video.muted;
    if (!video.muted && video.paused) {
      section.classList.remove("paused-start");
      start();
    }
    render();
  });
  for (const ev of ["play", "pause", "ended", "volumechange"]) video.addEventListener(ev, render);
  const tick = () => {
    if (video.duration) bar.style.width = `${(100 * video.currentTime) / video.duration}%`;
    if (!video.paused) requestAnimationFrame(tick);
  };
  video.addEventListener("play", () => requestAnimationFrame(tick));
  video.addEventListener("seeked", tick);

  load();
  // Moving pictures that start on their own must be stoppable (WCAG 2.2.2); people who asked
  // for less motion get the title card and a Play button instead.
  if (reduceMotion()) section.classList.add("paused-start");
  else start();
  render();

  // Once the page slides over the film, it stops; it picks up again when you scroll back to it.
  let pausedByScroll = false;
  let scrollingToWatch = false;
  const onScroll = () => {
    const covered = scrollY > section.offsetHeight * 0.35;
    if (scrollingToWatch) {
      if (!covered) scrollingToWatch = false;
      return;
    }
    if (covered && !video.paused) {
      pausedByScroll = true;
      video.pause();
    } else if (!covered && pausedByScroll && !userPaused && !video.ended) {
      pausedByScroll = false;
      start();
    }
  };
  addEventListener("scroll", () => requestAnimationFrame(onScroll), { passive: true });

  for (const a of document.querySelectorAll('a[href="#film"]')) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      userPaused = false;
      pausedByScroll = false;
      scrollingToWatch = true;
      section.classList.remove("ended", "paused-start");
      video.currentTime = 0;
      video.muted = false;
      window.scrollTo({ top: 0, behavior: reduceMotion() ? "auto" : "smooth" });
      start();
      render();
      if (location.hash !== "#film") history.pushState(null, "", "#film");
    });
  }
}

function initNav() {
  const nav = document.getElementById("nav");
  const film = document.getElementById("film");
  if (!nav || !film) return;
  const update = () => (nav.dataset.over = scrollY < film.offsetHeight * 0.6 ? "film" : "page");
  addEventListener("scroll", () => requestAnimationFrame(update), { passive: true });
  update();
}

// ---------------------------------------------------------------- the hero reveal

function initReveal(nums) {
  const fig = document.getElementById("reveal");
  if (!fig) return;
  const imgs = [...fig.querySelectorAll("img[data-layer]")];
  // A missing image means the data folder is not published: drop the figure, keep the page.
  for (const img of imgs) img.addEventListener("error", () => fig.remove(), { once: true });
  const tabs = [...fig.querySelectorAll('[role="tab"]')];
  const numEl = document.getElementById("readout-num");
  const textEl = document.getElementById("readout-text");
  const readout = {
    photo: () => [`${fmtNumber(nums.cloud_pct, 0)} %`, t("landing.readout_photo")],
    cband: () => [`${fmtNumber(nums.missed_km2, 1)} km²`, t("landing.readout_cband")],
    nisar: () => [`${fmtNumber(nums.hidden_km2, 1)} km²`, t("landing.readout_nisar_n", { missed: fmtNumber(nums.missed_km2, 1) })],
  };
  const show = (layer, focus = false) => {
    fig.dataset.layer = layer;
    for (const img of imgs) img.classList.toggle("on", img.dataset.layer === layer);
    for (const tab of tabs) {
      const on = tab.dataset.layer === layer;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    }
    const [num, text] = readout[layer]();
    numEl.textContent = num;
    textEl.textContent = text;
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => show(tab.dataset.layer));
    tab.addEventListener("keydown", (e) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      show(tabs[(i + step + tabs.length) % tabs.length].dataset.layer, true);
    });
  });
  show("photo");
  // Camera, then other radar, then NISAR, once the reveal is on screen; never with reduced
  // motion or after the viewer has taken over.
  if (reduceMotion()) return;
  let touched = false;
  fig.addEventListener("pointerdown", () => (touched = true), { once: true });
  fig.addEventListener("keydown", () => (touched = true), { once: true });
  const io = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting) return;
    io.disconnect();
    setTimeout(() => !touched && show("cband"), 1600);
    setTimeout(() => !touched && show("nisar"), 3600);
  }, { threshold: 0.6 });
  io.observe(fig);
}

// ---------------------------------------------------------------- tabs

function initTabs(list) {
  if (!list) return;
  const tabs = [...list.querySelectorAll('[role="tab"]')];
  const select = (tab, focus = false) => {
    for (const other of tabs) {
      const on = other === tab;
      other.setAttribute("aria-selected", String(on));
      other.tabIndex = on ? 0 : -1;
      document.getElementById(other.getAttribute("aria-controls")).hidden = !on;
    }
    if (focus) tab.focus();
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (e) => {
      const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      select(tabs[(i + step + tabs.length) % tabs.length], true);
    });
  });
}

// ---------------------------------------------------------------- the scrolling picture

// A wave drawn along a polyline: a sine across the path, tapering at both ends.
export function wavePath(pts, lam, amp, step = 4) {
  const segs = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const L = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    segs.push([pts[i - 1], pts[i], total, L]);
    total += L;
  }
  const out = [];
  for (let s = 0; s <= total; s += step) {
    const [p, q, a, L] = segs.find(([, , a0, L0]) => s <= a0 + L0) ?? segs.at(-1);
    const f = (s - a) / L;
    const dx = (q[0] - p[0]) / L;
    const dy = (q[1] - p[1]) / L;
    const off = amp * Math.min(1, s / 20, (total - s) / 20) * Math.sin((2 * Math.PI * s) / lam);
    out.push(`${out.length ? "L" : "M"}${(p[0] + (q[0] - p[0]) * f - dy * off).toFixed(1)} ${(p[1] + (q[1] - p[1]) * f + dx * off).toFixed(1)}`);
  }
  return out.join("");
}

function initScrolly() {
  const fig = document.getElementById("sensors");
  if (!fig) return;
  // The straight rays in the HTML become waves: short ones for most radar, long for NISAR.
  document.getElementById("ray-c")?.setAttribute("d", wavePath([[600, 96], [640, 266]], 14, 7, 3));
  document.getElementById("ray-l")?.setAttribute("d", wavePath([[1000, 96], [850, 520], [911, 500], [1054, 96]], 52, 11));
  const scatter = document.getElementById("scatter");
  if (scatter) {
    const c = [640, 270];
    [...scatter.querySelectorAll("path")].forEach((p, i) => {
      const a = ([-160, -128, -96, -64, -32][i] * Math.PI) / 180;
      const L = 70 + (i % 2) * 20;
      const from = [c[0] + Math.cos(a) * 14, c[1] + Math.sin(a) * 14];
      const to = [c[0] + Math.cos(a) * (14 + L), c[1] + Math.sin(a) * (14 + L)];
      p.setAttribute("d", wavePath([from, to], 12, 5, 3));
    });
  }
  const steps = [...document.querySelectorAll(".scrolly-steps .step")];
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        for (const s of steps) s.classList.toggle("active", s === e.target);
        fig.dataset.step = e.target.dataset.step;
      }
    },
    { rootMargin: "-45% 0px -45% 0px" },
  );
  steps.forEach((s) => io.observe(s));
}

// ---------------------------------------------------------------- charts

const DAY = 86400000;
const toDay = (iso) => Date.parse(`${iso}T00:00:00Z`) / DAY;
const monthName = (day) => new Intl.DateTimeFormat(language(), { month: "short", timeZone: "UTC" }).format(new Date(day * DAY));

function tipFor(root) {
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  root.append(tip);
  return (x, y, lines) => {
    if (!lines) {
      tip.hidden = true;
      return;
    }
    tip.replaceChildren(...lines.map((l, i) => {
      const d = document.createElement("div");
      d.textContent = l;
      if (i === 0) d.style.fontWeight = "600";
      return d;
    }));
    tip.style.left = `${x}%`;
    tip.style.top = `${y}%`;
    tip.hidden = false;
  };
}

// A visually hidden table twin for every chart (the WCAG-clean equivalent).
function tableFor(root, caption, head, rows) {
  const wrap = document.createElement("div");
  wrap.className = "sr-only";
  const table = document.createElement("table");
  wrap.append(table);
  table.createCaption().textContent = caption;
  const tr = table.createTHead().insertRow();
  for (const h of head) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = h;
    tr.append(th);
  }
  const body = table.createTBody();
  for (const r of rows) {
    const row = body.insertRow();
    for (const c of r) row.insertCell().textContent = c;
  }
  root.append(wrap);
}

// River level and NISAR's flood area on one time axis, in two panels: two quantities in
// different units never share one y-scale (no dual axes).
function riverChart(root, gauge) {
  const W = 420;
  const H = 300;
  const L = 40;
  const R = 10;
  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": t("landing.ev1_t") }, root);
  const stage = gauge.stage_daily.map(([d, m]) => [toDay(d), m]);
  const passes = gauge.series.map((p) => [toDay(p.date), p.flooded_km2, p.stage_m, p.date]);
  const x0 = stage[0][0];
  const x1 = stage.at(-1)[0];
  const X = (d) => L + ((d - x0) / (x1 - x0)) * (W - L - R);
  const panel = (pts, top, h, title, colour, digits, dots) => {
    const ys = pts.map((p) => p[1]);
    const lo = Math.min(...ys);
    const hi = Math.max(...ys);
    const pad = (hi - lo) * 0.12 || 1;
    const Y = (v) => top + h - ((v - lo + pad) / (hi - lo + 2 * pad)) * h;
    svText(svg, 0, top - 10, title);
    for (const v of [lo, hi]) {
      sv("line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: "grid" }, svg);
      svText(svg, L - 6, Y(v) + 4, fmtNumber(v, digits), { "text-anchor": "end" });
    }
    sv("path", { d: pts.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join(""), fill: "none", stroke: colour, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
    if (dots) for (const p of pts) sv("circle", { cx: X(p[0]), cy: Y(p[1]), r: 4.5, fill: colour, stroke: "#0e171a", "stroke-width": 2 }, svg);
    return Y;
  };
  const yRiver = panel(stage, 30, 86, t("landing.ev1_river"), "#8fa3ad", 1, false);
  const yFlood = panel(passes, 168, 86, t("landing.ev1_flood"), "#2b8fd6", 0, true);
  sv("line", { x1: L, x2: W - R, y1: 274, y2: 274, class: "axis" }, svg);
  for (let d = Math.ceil(x0); d <= x1; d++) {
    if (new Date(d * DAY).getUTCDate() !== 1) continue;
    sv("line", { x1: X(d), x2: X(d), y1: 274, y2: 279, class: "axis" }, svg);
    svText(svg, X(d), 294, monthName(d), { "text-anchor": "middle" });
  }
  // Hover and touch: the nearest radar pass, both panels at once.
  const cross = sv("line", { y1: 24, y2: 274, stroke: "#e8eeea", "stroke-width": 1, opacity: 0 }, svg);
  const hit = sv("rect", { x: L, y: 20, width: W - L - R, height: 256, class: "hit" }, svg);
  const tip = tipFor(root);
  const move = (ev) => {
    const box = svg.getBoundingClientRect();
    const vx = ((ev.clientX - box.left) / box.width) * W;
    const p = passes.reduce((a, b) => (Math.abs(X(b[0]) - vx) < Math.abs(X(a[0]) - vx) ? b : a));
    cross.setAttribute("x1", X(p[0]));
    cross.setAttribute("x2", X(p[0]));
    cross.setAttribute("opacity", "0.6");
    tip((X(p[0]) / W) * 100, (Math.min(yRiver(p[2]), yFlood(p[1])) / H) * 100, [
      fmtDate(p[3]),
      t("landing.tip_river", { v: fmtNumber(p[2], 2) }),
      t("landing.tip_flood", { v: fmtNumber(p[1], 1) }),
    ]);
  };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerdown", move);
  hit.addEventListener("pointerleave", () => {
    cross.setAttribute("opacity", "0");
    tip();
  });
  tableFor(root, t("landing.ev1_t"), [t("landing.col_date"), t("landing.ev1_river"), t("landing.ev1_flood")],
    passes.map((p) => [fmtDate(p[3]), fmtNumber(p[2], 2), fmtNumber(p[1], 1)]));
}

// Burned area after each radar pass, with NASA MODIS's total as a reference line.
function burnChart(root, burn) {
  const W = 420;
  const H = 300;
  const L = 52;
  const R = 12;
  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": t("landing.ev2_t") }, root);
  const pts = burn.by_pass.map((p) => [toDay(p.date), p.burned_km2, p.date]);
  const modis = burn.validation.ref_burned_km2;
  const top = Math.ceil(Math.max(modis, ...pts.map((p) => p[1])) / 500) * 500;
  const x0 = pts[0][0];
  const x1 = pts.at(-1)[0];
  const X = (d) => L + ((d - x0) / (x1 - x0)) * (W - L - R);
  const Y = (v) => 250 - (v / top) * 210;
  for (let v = 0; v <= top; v += 1000) {
    sv("line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v), class: v ? "grid" : "axis" }, svg);
    svText(svg, L - 6, Y(v) + 4, fmtNumber(v, 0), { "text-anchor": "end" });
  }
  svText(svg, 0, 20, t("landing.ev2_axis"));
  sv("line", { x1: L, x2: W - R, y1: Y(modis), y2: Y(modis), stroke: "#8fa3ad", "stroke-width": 1.5 }, svg);
  svText(svg, W - R, Y(modis) + 18, t("landing.ev2_modis", { v: fmtNumber(modis, 0) }), { "text-anchor": "end", class: "val" });
  const step = pts.map((p, i) => (i ? `H${X(p[0]).toFixed(1)}V${Y(p[1]).toFixed(1)}` : `M${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`)).join("");
  sv("path", { d: step, fill: "none", stroke: "#e0607e", "stroke-width": 2, "stroke-linejoin": "round" }, svg);
  const tip = tipFor(root);
  for (const p of pts) {
    const g = sv("g", { tabindex: "0", role: "img", "aria-label": `${fmtDate(p[2])}: ${t("landing.tip_burn", { v: fmtNumber(p[1], 0) })}` }, svg);
    sv("circle", { cx: X(p[0]), cy: Y(p[1]), r: 12, class: "hit" }, g);
    sv("circle", { cx: X(p[0]), cy: Y(p[1]), r: 4.5, fill: "#e0607e", stroke: "#0e171a", "stroke-width": 2 }, g);
    const show = () => tip((X(p[0]) / W) * 100, (Y(p[1]) / H) * 100, [fmtDate(p[2]), t("landing.tip_burn", { v: fmtNumber(p[1], 0) })]);
    g.addEventListener("pointerenter", show);
    g.addEventListener("focus", show);
    g.addEventListener("pointerleave", () => tip());
    g.addEventListener("blur", () => tip());
  }
  const last = pts.at(-1);
  svText(svg, X(last[0]), Y(last[1]) - 12, t("landing.ev2_nisar", { v: fmtNumber(last[1], 0) }), { "text-anchor": "end", class: "val" });
  svText(svg, X(x0), 272, fmtDate(pts[0][2], "short"), { "text-anchor": "start" });
  svText(svg, X(x1), 272, fmtDate(last[2], "short"), { "text-anchor": "end" });
  tableFor(root, t("landing.ev2_t"), [t("landing.col_date"), t("landing.ev2_axis")], pts.map((p) => [fmtDate(p[2]), fmtNumber(p[1], 0)]));
}

// GPS and NISAR sinking speeds at one station, as a dumbbell on one axis.
function gpsChart(root, station) {
  const W = 420;
  const H = 200;
  const L = 12;
  const R = 16;
  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": t("landing.ev3_t") }, root);
  const gps = Math.abs(station.rate_u_cm_yr);
  const nisar = Math.abs(station.nisar.rate_up_cm_yr);
  const top = Math.ceil(Math.max(gps, nisar) / 10) * 10;
  const X = (v) => L + (v / top) * (W - L - R);
  const y = 110;
  for (let v = 0; v <= top; v += 10) {
    sv("line", { x1: X(v), x2: X(v), y1: 70, y2: 150, class: v ? "grid" : "axis" }, svg);
    svText(svg, X(v), 172, fmtNumber(v, 0), { "text-anchor": "middle" });
  }
  svText(svg, L, 196, t("landing.ev3_axis"));
  sv("line", { x1: X(nisar), x2: X(gps), y1: y, y2: y, stroke: "#5b6d73", "stroke-width": 3 }, svg);
  sv("circle", { cx: X(gps), cy: y, r: 8, fill: "#8fa3ad", stroke: "#0e171a", "stroke-width": 2 }, svg);
  sv("circle", { cx: X(nisar), cy: y, r: 8, fill: "#9b86e6", stroke: "#0e171a", "stroke-width": 2 }, svg);
  svText(svg, X(gps), y - 22, t("landing.ev3_gps", { v: fmtNumber(gps, 1) }), { "text-anchor": "middle", class: "val" });
  svText(svg, X(nisar), y + 30, t("landing.ev3_nisar", { v: fmtNumber(nisar, 1) }), { "text-anchor": "middle", class: "val" });
  tableFor(root, t("landing.ev3_t"), [t("landing.col_source"), t("landing.ev3_axis")], [
    [t("landing.ev3_gps_name"), fmtNumber(gps, 1)],
    [t("landing.ev3_nisar_name"), fmtNumber(nisar, 1)],
  ]);
}

// ---------------------------------------------------------------- the world map

function worldMap(manifest, events, world) {
  const svg = document.getElementById("world-dots");
  const tipEl = document.getElementById("world-tip");
  if (!svg || !tipEl) return;
  const X = (lon) => ((lon + 180) / 360) * world.width;
  const Y = (lat) => ((world.lat_top - lat) / (world.lat_top - world.lat_bottom)) * world.height;
  const dot = (href, lon, lat, cls, r, name) => {
    const a = sv("a", { href, "aria-label": name }, svg);
    sv("circle", { cx: X(lon).toFixed(1), cy: Y(lat).toFixed(1), r, class: cls }, a);
    const show = () => {
      tipEl.textContent = name;
      tipEl.style.left = `${(X(lon) / world.width) * 100}%`;
      tipEl.style.top = `${(Y(lat) / world.height) * 100}%`;
      tipEl.hidden = false;
    };
    a.addEventListener("pointerenter", show);
    a.addEventListener("focus", show);
    a.addEventListener("pointerleave", () => (tipEl.hidden = true));
    a.addEventListener("blur", () => (tipEl.hidden = true));
  };
  const lang = language();
  const q = lang === "en" ? "" : `&lang=${lang}`;
  // Detailed cells first, so the named study sites sit on top.
  const cell = (s) => /^(hot|here)_/.test(s.id);
  const sites = [...manifest.sites].filter((s) => !s.synthetic).sort((a, b) => cell(b) - cell(a));
  for (const s of sites) {
    const [w, so, e, n] = s.bounds;
    dot(`index.html?site=${encodeURIComponent(s.id)}${q}`, (w + e) / 2, (so + n) / 2, (s.kind ?? "flood") === "fire" ? "fire" : "flood", cell(s) ? 4.5 : 7, s.name);
  }
  for (const ev of events.events) {
    const [w, so, e, n] = ev.bounds;
    dot(`index.html?mode=motion${q}`, (w + e) / 2, (so + n) / 2, "ground", 7, ev.name);
  }
}

// ---------------------------------------------------------------- numbers

async function loadNumbers() {
  // Ice mode is optional: a build without glaciers keeps the HTML's line rather than losing every number.
  const glaciersP = getJson("data/glaciers/index.json").catch(() => null);
  const [manifest, sylhet, fire, quake, sink, events, world] = await Promise.all([
    getJson("data/manifest.json"),
    getJson(`data/${REVEAL_SITE}/summary.json`),
    getJson("data/thunder_bay_36/summary.json"),
    getJson("data/motion/venezuela_2026/motion.json"),
    getJson("data/motion/mexico_city/motion.json"),
    getJson("data/motion/index.json"),
    getJson("media/world.json"),
  ]);
  const glaciers = await glaciersP;
  // The landing page quotes real results only (CLAUDE.md rule 3).
  if (sylhet.synthetic || fire.synthetic) throw new Error("synthetic summary");
  return { manifest, sylhet, fire, quake, sink, events, world, glaciers };
}

function fillNumbers(d) {
  const floodSites = d.manifest.sites.filter((s) => !s.synthetic && (s.kind ?? "flood") === "flood").length;
  const pass = d.sylhet.passes.find((p) => p.id === REVEAL_PASS);
  const hydro = d.sylhet.products.hydroperiod;
  const burn = d.fire.products.burn;
  const gauge = d.sylhet.validation.gauge;
  const station = d.sink.gnss[0];
  // "Up to about": the 1st percentile, rounded to 5 (the README's 70 cm and 30 cm a year).
  const about = (v) => fmtNumber(Math.round(Math.abs(v) / 5) * 5, 0);
  const quakeCm = about(d.quake.headline.east_p01_cm);
  const sinkCm = about(d.sink.headline.up_p01_cm_yr);
  const mainQuake = d.quake.quakes.reduce((a, b) => (b.mag > a.mag ? b : a));
  const burned = burn.by_pass.filter((p) => p.new_km2 > 0);
  const people = fmtApprox(d.sylhet.exposure.population_near_hidden_flood);

  setNum("flooded-any", fmtNumber(hydro.flooded_any_km2, 0));
  setNum("burned", fmtNumber(burn.burned_km2, 0));
  setNum("quake", quakeCm);
  setNum("sink", sinkCm);
  setNum("people", people);
  setNum("burn-first", fmtDate(burned[0].date, "short"));
  setNum("burn-last", fmtDate(burned.at(-1).date, "short"));
  setText("landing.cov_flood_how", { n: fmtNumber(floodSites, 0) });
  if (d.glaciers?.glaciers?.length) {
    setText("landing.cov_glacier_how", { n: fmtNumber(d.glaciers.glaciers.length, 0) });
    sceneGlacier(d.glaciers);
  }
  setText("landing.days_max", { n: fmtNumber(hydro.season_days, 0) });
  setText("landing.where_lead", { n: fmtNumber(floodSites, 0) });
  setText("landing.ev1_note", { n: fmtNumber(gauge.n, 0), r: fmtNumber(gauge.r, 2) });
  setText("landing.ev3_note", { id: station.id });
  setText("landing.lim1", { pct: fmtNumber(burn.flood_lookalike.in_burned_pct, 0) });
  setText("landing.chg3_d", { cm: quakeCm, cmy: sinkCm, date: fmtDate(mainQuake.utc.slice(0, 10)) });
  // The ground key's colour ranges are the rendered maps' own (media/maps.json).
  getJson("media/maps.json")
    .then((m) => {
      setText("landing.gk_quake", { v: fmtNumber(m.quake.hi, 0), date: fmtDate(mainQuake.utc.slice(0, 10)) });
      setText("landing.gk_sink", { v: fmtNumber(m.sink.hi, 0) });
    })
    .catch(() => {});
  setText("landing.film_text_people", { n: people });
  setText("landing.sc_village_fig", { n: people });
  initScales(d.manifest, d.sylhet);
  initColab(d.sylhet);
  setText("landing.film_text_season", { n: fmtNumber(hydro.max_days, 0) });
  setText("landing.film_text_fire", { km2: fmtNumber(burn.burned_km2, 0) });
  setText("landing.film_text_ground", { cm: quakeCm, cmy: sinkCm });

  riverChart(document.getElementById("chart-river"), gauge);
  burnChart(document.getElementById("chart-burn"), burn);
  gpsChart(document.getElementById("chart-gps"), station);
  worldMap(d.manifest, d.events, d.world);
  return {
    cloud_pct: Math.round(d.sylhet.products.optical.cloud_fraction * 100),
    hidden_km2: pass.flooded_veg_km2,
    missed_km2: pass.hidden_from_cband_km2,
  };
}

// The notebooks section (D-098): counts and links from the published index, and the window's
// output from Sylhet's own passes, the lines its notebook prints and checks against the app.
function initColab(sylhet) {
  const out = document.getElementById("nb-out");
  if (out) {
    out.textContent = sylhet.passes
      .slice(0, 3)
      .map((p) => `${p.id}  ${p.date}  ${p.flooded_veg_km2.toFixed(3).padStart(7)}  ${p.open_water_km2.toFixed(3).padStart(8)}`)
      .join("\n");
  }
  getJson("data/notebooks.json")
    .then((idx) => {
      const n = { water: 0, ice: 0, fire: 0, ground: 0 };
      for (const key of Object.keys(idx.notebooks)) n[key.split("/")[0]] = (n[key.split("/")[0]] ?? 0) + 1;
      for (const [k, v] of Object.entries(n)) setNum(`nb-${k}`, fmtNumber(v, 0));
      const e = idx.notebooks[`water/${REVEAL_SITE}`];
      if (e) {
        document.getElementById("colab-run")?.setAttribute("href", e.colab);
        document.getElementById("colab-dl")?.setAttribute("href", e.download);
      }
    })
    .catch(() => {}); // without the index the HTML's featured links stay
}

// The challenge image's loupe: the full-resolution original at its own pixels, under the cursor.
function initLoupe() {
  const frame = document.getElementById("cf-frame");
  if (!frame || reduceMotion() || !matchMedia("(hover: hover)").matches) return;
  const img = frame.querySelector("img");
  const lens = frame.querySelector(".cf-lens");
  frame.addEventListener("pointermove", (e) => {
    const r = frame.getBoundingClientRect();
    // The original's own pixels, 1:1: the loupe never enlarges past what the image holds.
    const ZOOM = Math.max(1.5, (img.naturalWidth || 1600) / r.width);
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    lens.style.left = `${x}px`;
    lens.style.top = `${y}px`;
    lens.style.backgroundImage = `url("${img.currentSrc || img.src}")`;
    lens.style.backgroundSize = `${r.width * ZOOM}px ${r.height * ZOOM}px`;
    lens.style.backgroundPosition = `${-(x * ZOOM - 100)}px ${-(y * ZOOM - 100)}px`;
    frame.classList.add("lens-on");
  });
  frame.addEventListener("pointerleave", () => frame.classList.remove("lens-on"));
}

// The fourth change: Greenland's fastest glacier, drawn as the app draws it (ITS_LIVE speed on the
// ice, Copernicus relief under it), with the index's own numbers.
const HERO_GLACIER = "jakobshavn";
function sceneGlacier(index) {
  const g = index.glaciers.find((x) => x.id === HERO_GLACIER) ?? index.glaciers[0];
  const max = Math.max(...index.glaciers.map((x) => x.max_m_yr ?? 0));
  setNum("glacier-day", fmtNumber(Math.round(g.max_m_yr / 365.25), 0));
  setText("landing.film_text_ice", { v: fmtNumber(Math.round(g.max_m_yr / 365.25), 0) });
  setNum("glacier-n", fmtNumber(index.glaciers.length, 0));
  setText("landing.stat_glaciers", { c: fmtNumber(new Set(index.glaciers.map((x) => x.country)).size, 0) });
  setText("landing.ice_hi", { v: fmtNumber(Math.round(max / 100) * 100, 0) });
  const lut = iceLut();
  const stops = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const j = Math.round(f * 255) * 3;
    return `rgb(${lut[j]} ${lut[j + 1]} ${lut[j + 2]}) ${f * 100}%`;
  });
  const ramp = document.getElementById("glacier-ramp");
  if (ramp) ramp.style.background = `linear-gradient(90deg, ${stops.join(", ")})`;
  const host = document.getElementById("glacier-map");
  if (!host) return;
  const draw = async () => {
    const doc = await getJson(`data/glaciers/${g.path}`);
    const planes = decodePlanes(doc, await readBinary(`data/glaciers/${g.path.replace("glacier.json", "glacier.bin.gz")}`));
    const { width: w, height: hgt, cell_m: cell } = doc.grid;
    const relief = planes.dem ? hillshade(planes.dem, w, hgt, cell) : null;
    const rgba = fillSurface(paintPlane(planes.speed, "speed", speedRange(doc.stats)), w, hgt, planes.surface ?? null, w, hgt, undefined, relief);
    host.prepend(toCanvas(rgba, w, hgt));
  };
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      io.disconnect();
      draw().catch((err) => console.error("landing: glacier map", err));
    }
  }, { rootMargin: "400px" });
  io.observe(host);
}

// Two scales (D-103 to D-107): each card shows a real picture from the data. The flood card is
// drawn by the app's own code; the ledger is a barcode of every flooded forest's season; the replay
// wipes between Limpopo's passes; the score is Sylhet's waltz. The summaries (about 1 MB) load only
// when the section comes into view.
function sceneVillage(sylhet) {
  const host = document.querySelector("#sc-vis-village .sc-phone");
  if (!host) return;
  const site = { summary: sylhet, url: (rel) => `data/${REVEAL_SITE}/${rel}` };
  const canvas = document.createElement("canvas");
  drawCard(canvas, site, 0, t, new Date().toISOString().slice(0, 10))
    .then(() => host.replaceChildren(canvas))
    .catch((err) => console.error("landing: flood card", err));
}

function scenePlanet(ledgers) {
  const host = document.getElementById("sc-vis-planet");
  if (!host || !ledgers.length) return;
  const rows = [...ledgers].sort((a, b) => b.l.total.mid - a.l.total.mid);
  const W = 520;
  const H = 180;
  const max = Math.sqrt(rows[0].l.total.mid);
  const bw = W / rows.length;
  const svg = sv("svg", { class: "sc-barcode", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none" });
  rows.forEach(({ name, l }, i) => {
    // Square-root heights: the largest season does not flatten the rest.
    const hAll = (Math.sqrt(l.total.mid) / max) * H;
    const hMiss = hAll * (l.missedShare ?? 0);
    const x = i * bw + bw * 0.15;
    const g = sv("g", {}, svg);
    sv("rect", { x, y: H - hAll, width: bw * 0.7, height: hAll, rx: 1.5, class: "b-all" }, g);
    if (hMiss > 0) sv("rect", { x, y: H - hMiss, width: bw * 0.7, height: hMiss, rx: 1.5, class: "b-missed" }, g);
    const tip = sv("title", {}, g);
    tip.textContent = `${name}: ${fmtNumber(l.total.lo, 0)}–${fmtNumber(l.total.hi, 0)} t`;
  });
  const cap = document.createElement("p");
  cap.className = "sc-caption";
  cap.textContent = t("landing.sc_planet_axis");
  host.replaceChildren(svg, cap);
}

function sceneGame() {
  const grid = document.querySelector("#sc-vis-play .sc-grid");
  if (!grid) return;
  const hot = new Set([10, 19, 21, 28, 34]);
  grid.replaceChildren(...Array.from({ length: 40 }, (_, i) => Object.assign(document.createElement("i"), { className: hot.has(i) ? "hot" : "" })));
}

function sceneWaltz(sylhet) {
  const host = document.getElementById("sc-vis-waltz");
  if (!host) return;
  const bars = waltzScore(sylhet);
  const W = 520;
  const H = 150;
  const lo = Math.min(...bars.map((b) => b.bass));
  const hi = Math.max(...bars.map((b) => b.melody + 1));
  const y = (m) => H - 10 - ((m - lo) / Math.max(1, hi - lo)) * (H - 24);
  const bw = W / bars.length;
  const svg = sv("svg", { class: "sc-score", viewBox: `0 0 ${W} ${H}` });
  const pts = [];
  bars.forEach((b, i) => {
    const x0 = i * bw;
    const bx = (k) => x0 + (k + 0.5) * (bw / 3);
    sv("rect", { x: x0 + 2, y: 2, width: bw - 4, height: H - 4, rx: 6, class: "bar" }, svg);
    sv("circle", { cx: bx(0), cy: y(b.bass), r: 6, class: "bass" }, svg);
    sv("circle", { cx: bx(1), cy: y(b.melody), r: b.clash ? 7.5 : 5, class: b.clash ? "clash" : "mel" }, svg);
    sv("circle", { cx: bx(2), cy: y(b.melody), r: 5, class: "mel" }, svg);
    pts.push(`${bx(1)},${y(b.melody)}`, `${bx(2)},${y(b.melody)}`);
  });
  svg.prepend(sv("polyline", { points: pts.join(" "), class: "line" })); // the tune, under its notes
  host.replaceChildren(svg);
}

function initScales(manifest, sylhet) {
  const el = document.getElementById("scales");
  if (!el) return;
  sceneGame();
  const ids = manifest.sites.filter((s) => !s.synthetic && (s.kind ?? "flood") === "flood").map((s) => s.id);
  const run = async () => {
    sceneVillage(sylhet);
    sceneWaltz(sylhet);
    const all = await Promise.all(ids.map((id) => getJson(`data/${id}/summary.json`).catch(() => null)));
    const lim = all.find((s) => s?.site.id === "limpopo_2026");
    if (lim && !lim.synthetic) {
      const [a, b] = lim.passes.slice(-2);
      const p = {
        a: fmtNumber(a.flooded_km2, 0),
        b: fmtNumber(b.flooded_km2, 0),
        d1: fmtDate(a.date, "short"),
        d2: fmtDate(b.date, "short"),
        cloud: fmtNumber(100 * (lim.products.optical?.cloud_fraction ?? 0), 0),
      };
      for (const k of ["fig", "before", "after", "d"]) setText(`landing.sc_replay_${k}`, p);
    }
    // The ledger is for flood seasons: an early-data disaster replay is not one.
    const seasons = all.filter((s) => s && !s.synthetic && !s.warnings.some((w) => w.code === "early_mission_data"));
    const ledgers = seasons.map((s) => ({ name: s.site.name, l: methaneLedger(s) })).filter((x) => x.l && x.l.km2Days > 0);
    const sum = (f) => ledgers.reduce((a, x) => a + (f(x.l) ?? 0), 0);
    const r = (v) => fmtNumber(Math.round(v / 10) * 10, 0);
    const p = { n: fmtNumber(ledgers.length, 0), lo: r(sum((m) => m.total.lo)), hi: r(sum((m) => m.total.hi)), mlo: r(sum((m) => m.missed?.lo)), mhi: r(sum((m) => m.missed?.hi)) };
    setText("landing.sc_planet_fig", p);
    setText("landing.sc_planet_d", p);
    scenePlanet(ledgers);
  };
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      io.disconnect();
      run().catch((err) => console.error("landing: two scales", err));
    }
  }, { rootMargin: "400px" });
  io.observe(el);
}

// ---------------------------------------------------------------- start

async function main() {
  const q = new URLSearchParams(location.search).get("lang");
  try {
    await loadLocale(LANGUAGES.includes(q) ? q : "en");
  } catch (err) {
    // The English in the HTML stays; the film keeps its own controls, the rest stays static.
    console.error("landing: interface text did not load", err);
    return;
  }
  const lang = language();
  document.documentElement.lang = lang;
  applyText(document);
  carryLanguage(lang);
  initNav();
  initFilm(lang);
  initTabs(document.querySelector(".tour-tabs"));
  initTabs(document.querySelector(".aud-tabs"));
  initLoupe();
  initScrolly();
  let nums = null;
  try {
    nums = fillNumbers(await loadNumbers());
  } catch (err) {
    console.error("landing: data did not load", err);
  }
  if (nums) initReveal(nums);
}

// Imported by the unit tests in Node, which have no page.
if (typeof document !== "undefined") main();
