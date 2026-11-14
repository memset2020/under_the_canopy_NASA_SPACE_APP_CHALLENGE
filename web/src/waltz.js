// Earth's waltz (D-105): the challenge calls Earth's surface "a constant waltz", and NISAR's
// 12-day repeat is its beat. The season is played in 3/4, one bar per radar pass, and the map steps
// through the passes in time. Beat one, the bass, follows the open water; beats two and three, the
// melody, follow the water under the trees. Where C-band radar missed part of that water, beat two
// carries a clashing semitone that resolves on beat three: the moment NISAR sees what the other
// radar did not. Every note is computed from the site's published numbers (waltzScore, tested).
// A poster draws the same season from the radar itself, to download.
import { h, s } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate, fmtNumber } from "./i18n.js";
import { paintRadar } from "./layers.js";
import { setNote } from "./readable.js";

export const id = "waltz";
export const slot = "sidebar";

const BEAT_S = 60 / 156; // a lively Viennese tempo: 156 beats a minute
const D_MAJOR = [0, 2, 4, 5, 7, 9, 11]; // scale steps above D
const BASS_ROOT = 38; // D2 (MIDI)
const MELODY_ROOT = 62; // D4
const CLASH_SHARE = 0.15; // C-band missed at least this share of the water under the trees

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
// The n-th note of D major from a root, n = 0, 1, 2, ...
const degree = (root, n) => root + 12 * Math.floor(n / 7) + D_MAJOR[((n % 7) + 7) % 7];
const step = (v, max, steps) => (max > 0 ? Math.round((Math.max(0, v) / max) * (steps - 1)) : 0);

// One bar per pass: { bass, melody, chord: [3 notes], clash: bool, missedShare } in MIDI numbers.
export function waltzScore(summary) {
  const passes = summary.passes;
  const maxOpen = Math.max(0, ...passes.map((p) => p.open_water_km2 ?? 0));
  const maxHidden = Math.max(0, ...passes.map((p) => p.flooded_veg_km2 ?? 0));
  return passes.map((p) => {
    const b = step(p.open_water_km2 ?? 0, maxOpen, 8); // an octave of D major for the river
    const m = step(p.flooded_veg_km2 ?? 0, maxHidden, 15); // two octaves for the hidden flood
    const missedShare =
      p.hidden_from_cband_km2 === null || p.hidden_from_cband_km2 === undefined || !(p.flooded_veg_km2 > 0)
        ? null
        : p.hidden_from_cband_km2 / p.flooded_veg_km2;
    return {
      date: p.date,
      bass: degree(BASS_ROOT, b),
      chord: [degree(BASS_ROOT + 12, b), degree(BASS_ROOT + 12, b + 2), degree(BASS_ROOT + 12, b + 4)],
      melody: degree(MELODY_ROOT, m),
      clash: missedShare !== null && missedShare >= CLASH_SHARE,
      missedShare,
    };
  });
}

function voice(audio, out, midi, when, dur, gain, type) {
  const osc = audio.createOscillator();
  const g = audio.createGain();
  osc.type = type;
  osc.frequency.value = hz(midi);
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(gain, when + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  osc.connect(g).connect(out);
  osc.start(when);
  osc.stop(when + dur + 0.05);
}

// Poster: the season's radar as a strip of passes (HH red, HV green, HH−HV blue, as on the map),
// the peak pass large, and the score beneath. Drawn from the site's own files, offline.
export function drawPoster(canvas, site, bars, t) {
  const S = site.summary;
  const W = 1600;
  const tmp = document.createElement("canvas");
  const peak = Math.max(0, S.passes.findIndex((p) => p.id === S.peak_pass));
  paintRadar(site, peak, "radar", tmp);
  const ratio = tmp.height / tmp.width;
  // Layout first, so the canvas is as tall as its content: title, the peak pass (at most 1100 px
  // tall), the passes in a row, the score, the key and the credit.
  const bigH = Math.min(1100, Math.round((W - 200) * ratio));
  const big = Math.round(bigH / ratio);
  const n = S.passes.length;
  const gap = 12;
  const cell = (W - 200 - gap * (n - 1)) / n;
  const top = 340 + bigH + 90;
  const sy = top + cell * ratio + 70;
  const H = Math.round(sy + 420);
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0b1111";
  ctx.fillRect(0, 0, W, H);
  const font = (w, px) => `${w} ${px}px "Segoe UI", "Noto Sans Bengali", system-ui, sans-serif`;
  ctx.fillStyle = "#e69f00";
  ctx.font = font(700, 30);
  ctx.fillText(t("waltz.poster_kicker").toUpperCase(), 100, 130);
  ctx.fillStyle = "#eef3f1";
  ctx.font = font(700, 72);
  ctx.fillText(S.site.name, 100, 220, W - 200);
  ctx.fillStyle = "#9fb0ab";
  ctx.font = font(400, 32);
  ctx.fillText(t("waltz.poster_sub", { first: fmtDate(S.passes[0].date), last: fmtDate(S.passes.at(-1).date), n: fmtNumber(S.passes.length, 0) }), 100, 280, W - 200);

  ctx.imageSmoothingEnabled = false;
  paintRadar(site, peak, "radar", tmp);
  const bx = (W - big) / 2;
  ctx.drawImage(tmp, bx, 340, big, bigH);
  ctx.fillStyle = "#9fb0ab";
  ctx.font = font(400, 26);
  ctx.fillText(t("waltz.poster_peak", { date: fmtDate(S.passes[peak].date) }), 100, 340 + bigH + 44, W - 200);

  // Every pass, small, left to right: the season's dance.
  S.passes.forEach((_, i) => {
    paintRadar(site, i, "radar", tmp);
    ctx.drawImage(tmp, 100 + i * (cell + gap), top, cell, cell * ratio);
  });
  // The score: three beats a bar, bass low, melody high, clashes in amber.
  const lo = Math.min(...bars.map((b) => b.bass));
  const hi = Math.max(...bars.map((b) => b.melody + 1));
  const y = (m) => sy + 220 - ((m - lo) / Math.max(1, hi - lo)) * 220;
  bars.forEach((b, i) => {
    const x0 = 100 + i * (cell + gap);
    ctx.strokeStyle = "#2a3838";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, sy - 10);
    ctx.lineTo(x0, sy + 240);
    ctx.stroke();
    const beat = (k) => x0 + (k + 0.5) * (cell / 3);
    ctx.fillStyle = "#56b4e9";
    ctx.beginPath();
    ctx.arc(beat(0), y(b.bass), 12, 0, Math.PI * 2);
    ctx.fill();
    for (const k of [1, 2]) {
      ctx.fillStyle = b.clash && k === 1 ? "#e69f00" : "#eef3f1";
      ctx.beginPath();
      ctx.arc(beat(k), y(b.melody), b.clash && k === 1 ? 14 : 10, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  ctx.fillStyle = "#9fb0ab";
  ctx.font = font(400, 24);
  ctx.fillText(t("waltz.poster_key"), 100, sy + 300, W - 200);
  ctx.fillText(t("waltz.poster_credit"), 100, sy + 350, W - 200);
  return canvas;
}

export function init({ store, t, root }) {
  const heading = h("h2", { text: t("waltz.title") });
  const lead = h("p", { text: t("waltz.lead") });
  const play = h("button", { type: "button", class: "btn", "aria-pressed": "false", text: t("waltz.play") });
  const svg = s("svg", { class: "waltz-score", viewBox: "0 0 320 120", role: "img" });
  const key = h(
    "ul",
    { class: "legend-inline" },
    h("li", {}, h("span", { class: "swatch", style: "background:#56b4e9" }), t("waltz.key_bass")),
    h("li", {}, h("span", { class: "swatch", style: "background:#eef3f1" }), t("waltz.key_melody")),
    h("li", {}, h("span", { class: "swatch swatch-hidden" }), t("waltz.key_clash")),
  );
  const posterBtn = h("button", { type: "button", class: "btn btn-small", text: t("waltz.poster") });
  const posterImg = h("img", { class: "waltz-poster", alt: "", hidden: true });
  const posterSave = h("a", { class: "btn btn-small", hidden: true, text: t("waltz.poster_download") });
  const live = h("span", { class: "sr-only", "aria-live": "polite" });
  const note = h("p");
  setNote(note, "info", t("waltz.note"));
  root.append(heading, lead, play, svg, key, note, h("div", { class: "floodcard-actions" }, posterBtn, posterSave), posterImg, live);

  let audio = null;
  let stopAt = 0;
  let timers = [];
  let bars = [];

  function drawScore(current = -1) {
    const n = bars.length;
    if (!n) return;
    const lo = Math.min(...bars.map((b) => b.bass));
    const hi = Math.max(...bars.map((b) => b.melody + 1));
    const y = (m) => 104 - ((m - lo) / Math.max(1, hi - lo)) * 92;
    const bw = 312 / n;
    svg.replaceChildren(
      ...bars.flatMap((b, i) => {
        const x0 = 4 + i * bw;
        const bx = (k) => x0 + (k + 0.5) * (bw / 3);
        return [
          s("rect", { x: x0, y: 2, width: bw - 2, height: 112, rx: 3, class: i === current ? "waltz-bar is-now" : "waltz-bar" }),
          s("circle", { cx: bx(0), cy: y(b.bass), r: 3.2, class: "waltz-bass" }),
          s("circle", { cx: bx(1), cy: y(b.melody), r: b.clash ? 4 : 2.8, class: b.clash ? "waltz-clash" : "waltz-mel" }),
          s("circle", { cx: bx(2), cy: y(b.melody), r: 2.8, class: "waltz-mel" }),
          s("title", {}, t("waltz.bar_tip", { date: fmtDate(b.date), pct: b.missedShare === null ? "–" : fmtNumber(100 * b.missedShare, 0) })),
        ];
      }),
    );
    svg.setAttribute("aria-label", t("waltz.score_aria", { n, clashes: bars.filter((b) => b.clash).length }));
  }

  function stop() {
    for (const id of timers) clearTimeout(id);
    timers = [];
    play.setAttribute("aria-pressed", "false");
    play.textContent = t("waltz.play");
    drawScore();
  }

  async function start() {
    const Ctx = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctx) {
      play.disabled = true;
      play.title = t("sonify.unsupported");
      return;
    }
    audio ??= new Ctx(); // created on a click, as browsers require
    await audio.resume();
    const out = audio.createGain();
    out.gain.value = 0.9;
    out.connect(audio.destination);
    const t0 = audio.currentTime + 0.08;
    bars.forEach((b, i) => {
      const at = t0 + i * 3 * BEAT_S;
      voice(audio, out, b.bass, at, 2.6 * BEAT_S, 0.22, "sine");
      for (const k of [1, 2]) {
        for (const c of b.chord) voice(audio, out, c, at + k * BEAT_S, 0.8 * BEAT_S, 0.045, "triangle");
        voice(audio, out, b.melody, at + k * BEAT_S, 0.9 * BEAT_S, 0.12, "sine");
      }
      if (b.clash) voice(audio, out, b.melody + 1, at + BEAT_S, 0.9 * BEAT_S, 0.09, "triangle");
      timers.push(
        setTimeout(() => {
          store.set({ passIndex: i, playing: false }); // the map dances with the music
          drawScore(i);
          live.textContent = t("waltz.announce", { date: fmtDate(b.date) });
        }, (at - audio.currentTime) * 1000),
      );
    });
    stopAt = t0 + bars.length * 3 * BEAT_S;
    timers.push(setTimeout(stop, (stopAt - audio.currentTime) * 1000 + 300));
    play.setAttribute("aria-pressed", "true");
    play.textContent = t("waltz.stop");
  }

  play.addEventListener("click", () => (play.getAttribute("aria-pressed") === "true" ? stop() : start()));
  posterBtn.addEventListener("click", () => {
    const site = store.get().site;
    if (!site) return;
    const c = drawPoster(document.createElement("canvas"), site, bars, t);
    const url = c.toDataURL("image/png");
    posterImg.src = url;
    posterImg.alt = t("waltz.poster_alt", { site: site.summary.site.name });
    posterSave.href = url;
    posterSave.download = `earths-waltz-${site.summary.site.id}.png`;
    posterImg.hidden = posterSave.hidden = false;
  });

  watch(store, ["site"], ({ site }) => {
    stop();
    root.hidden = !site || site.summary.site?.kind === "fire" || site.summary.passes.length < 2;
    if (root.hidden) return;
    bars = waltzScore(site.summary);
    posterImg.hidden = posterSave.hidden = true;
    drawScore();
  });
}
