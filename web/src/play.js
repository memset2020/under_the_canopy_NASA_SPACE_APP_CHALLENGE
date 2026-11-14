// "Find the hidden water" (D-106): a game on real NISAR maps. Each round shows a place the way a
// camera saw it (often cloud, or a closed forest roof) and asks the player to tap where water lies
// under the trees. NISAR's L-band map then reveals the answer cell by cell, beside what C-band
// radar saw. It teaches the project's one finding by letting people fail at it first. Scored from
// the published class images (amber = water under vegetation), so nothing is invented; the end
// screen links to the map and to label mode, where people who know a place can mark it.
import { fmtDate, fmtNumber, loadLocale, t } from "./i18n.js";
import { h } from "./svg.js";

export const GRID = 8; // cells a side
export const PICKS = 5;
export const HIDDEN_MIN = 0.1; // a cell "has hidden water" when a tenth of its pixels are amber
// Amber, with room for the browser's alpha rounding when it reads a 235-alpha pixel back.
const isAmber = (r, g, b, a) => a > 0 && Math.abs(r - 230) <= 6 && Math.abs(g - 159) <= 6 && b <= 8;
const ROUNDS = ["sylhet", "janauaca", "mamiraua", "atchafalaya", "everglades"];

// Share of water-under-vegetation pixels in each of n × n cells of an RGBA image.
export function cellTruth(rgba, w, hgt, n = GRID) {
  const hits = new Float64Array(n * n);
  const all = new Float64Array(n * n);
  for (let r = 0; r < hgt; r += 1) {
    const cr = Math.min(n - 1, Math.floor((r / hgt) * n));
    for (let c = 0; c < w; c += 1) {
      const cc = Math.min(n - 1, Math.floor((c / w) * n));
      const o = (r * w + c) * 4;
      all[cr * n + cc] += 1;
      if (isAmber(rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3])) hits[cr * n + cc] += 1;
    }
  }
  return Array.from(hits, (v, i) => (all[i] ? v / all[i] : 0));
}

// Points: 20 a hit, and a bonus for picking the very wettest cells.
export function scoreRound(picks, truth, min = HIDDEN_MIN) {
  const wet = truth.map((v, i) => [v, i]).filter(([v]) => v >= min);
  const hits = picks.filter((i) => truth[i] >= min);
  const best = new Set([...wet].sort((a, b) => b[0] - a[0]).slice(0, PICKS).map(([, i]) => i));
  const bonus = picks.filter((i) => best.has(i)).length * 5;
  return { hits: hits.length, wetCells: wet.length, points: hits.length * 20 + bonus };
}

const load = (src) =>
  new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = fail;
    img.src = src;
  });

function pixels(img) {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height).data;
}

async function roundData(id) {
  const s = await (await fetch(`data/${id}/summary.json`)).json();
  if (s.synthetic || !s.products.optical) return null;
  const peak = s.passes.find((p) => p.id === s.peak_pass) ?? s.passes[0];
  const cls = await load(`data/${id}/${peak.class_png}`);
  return {
    id,
    summary: s,
    pass: peak,
    photo: `data/${id}/${s.products.optical.png}`,
    classes: `data/${id}/${peak.class_png}`,
    cband: peak.cband_png ? `data/${id}/${peak.cband_png}` : null,
    truth: cellTruth(pixels(cls), cls.naturalWidth, cls.naturalHeight),
  };
}

async function main() {
  const lang = new URLSearchParams(location.search).get("lang") ?? "en";
  await loadLocale(lang);
  document.documentElement.lang = lang;
  document.title = t("play.title");
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  const root = document.getElementById("play");
  const rounds = (await Promise.all(ROUNDS.map((id) => roundData(id).catch(() => null)))).filter(Boolean);
  let k = 0;
  let total = 0;
  const log = [];

  function playRound() {
    const R = rounds[k];
    const picks = [];
    const photo = h("img", { class: "play-layer on", src: R.photo, alt: t("play.photo_alt", { site: R.summary.site.name }) });
    const nisar = h("img", { class: "play-layer", src: R.classes, alt: "" });
    const cband = R.cband ? h("img", { class: "play-layer", src: R.cband, alt: "" }) : null;
    const cells = Array.from({ length: GRID * GRID }, (_, i) =>
      h("button", {
        type: "button",
        class: "play-cell",
        "aria-pressed": "false",
        "aria-label": t("play.cell", { r: fmtNumber(Math.floor(i / GRID) + 1, 0), c: fmtNumber((i % GRID) + 1, 0) }),
        onclick: () => toggle(i),
      }),
    );
    const grid = h("div", { class: "play-grid", style: `--n:${GRID}` }, ...cells);
    const stage = h("div", { class: "play-stage" }, photo, ...(cband ? [cband] : []), nisar, grid);
    const left = h("p", { class: "play-left" });
    const reveal = h("button", { type: "button", class: "btn btn-primary", disabled: true, text: t("play.reveal") });
    const result = h("div", { class: "play-result", hidden: true });
    const tabs = h("div", { class: "reveal-tabs play-tabs", role: "tablist", hidden: true });
    const opt = optical(R);
    root.replaceChildren(
      h("p", { class: "play-kicker", text: t("play.round", { k: fmtNumber(k + 1, 0), n: fmtNumber(rounds.length, 0), score: fmtNumber(total, 0) }) }),
      h("h1", { text: R.summary.site.name }),
      h("p", { class: "play-prompt", text: opt }),
      h("div", { class: "play-body" }, stage, h("div", { class: "play-side" }, left, reveal, tabs, result)),
    );
    const update = () => {
      left.textContent = t("play.left", { n: fmtNumber(PICKS - picks.length, 0) });
      reveal.disabled = picks.length === 0;
    };
    function toggle(i) {
      if (!result.hidden) return;
      const at = picks.indexOf(i);
      if (at >= 0) picks.splice(at, 1);
      else if (picks.length < PICKS) picks.push(i);
      cells.forEach((c, j) => c.setAttribute("aria-pressed", String(picks.includes(j))));
      update();
    }
    function show(which) {
      photo.classList.toggle("on", which === "photo");
      nisar.classList.toggle("on", which === "nisar");
      cband?.classList.toggle("on", which === "cband");
      for (const b of tabs.querySelectorAll("button")) b.setAttribute("aria-selected", String(b.dataset.layer === which));
    }
    reveal.addEventListener("click", () => {
      const sc = scoreRound(picks, R.truth);
      total += sc.points;
      log.push({ site: R.summary.site.name, ...sc });
      cells.forEach((c, i) => {
        c.disabled = true;
        c.classList.toggle("is-wet", R.truth[i] >= HIDDEN_MIN);
        c.classList.toggle("is-hit", picks.includes(i) && R.truth[i] >= HIDDEN_MIN);
        c.classList.toggle("is-miss", picks.includes(i) && R.truth[i] < HIDDEN_MIN);
      });
      const tab = (layer, key) => h("button", { type: "button", role: "tab", dataset: { layer }, onclick: () => show(layer) }, h("span", { class: "tab-name", text: t(key) }));
      tabs.replaceChildren(tab("photo", "play.tab_photo"), ...(cband ? [tab("cband", "play.tab_cband")] : []), tab("nisar", "play.tab_nisar"));
      tabs.hidden = false;
      show("nisar");
      reveal.hidden = left.hidden = true;
      const next = h("button", { type: "button", class: "btn btn-primary", text: t(k + 1 < rounds.length ? "play.next" : "play.finish") });
      next.addEventListener("click", () => {
        k += 1;
        if (k < rounds.length) playRound();
        else finish();
      });
      result.replaceChildren(
        h("p", { class: "play-points", text: t("play.points", { p: fmtNumber(sc.points, 0) }) }),
        h("p", { text: t("play.hits", { hits: fmtNumber(sc.hits, 0), picks: fmtNumber(picks.length, 0), wet: fmtNumber(sc.wetCells, 0), cells: fmtNumber(GRID * GRID, 0) }) }),
        h("p", {
          class: "muted",
          text: t("play.truth", {
            km2: fmtNumber(R.pass.flooded_veg_km2, 1),
            date: fmtDate(R.pass.date),
            missed: R.pass.hidden_from_cband_km2 === null ? "–" : fmtNumber(R.pass.hidden_from_cband_km2, 1),
          }),
        }),
        next,
      );
      result.hidden = false;
      next.focus();
    });
    update();
  }

  // The prompt says what the camera saw: cloud, or the forest roof.
  function optical(R) {
    const cloud = R.summary.products.optical.cloud_fraction ?? 0;
    return cloud > 0.5
      ? t("play.prompt_cloud", { pct: fmtNumber(100 * cloud, 0), date: fmtDate(R.summary.products.optical.date) })
      : t("play.prompt_clear", { date: fmtDate(R.summary.products.optical.date) });
  }

  function finish() {
    const max = rounds.length * (PICKS * 25);
    root.replaceChildren(
      h("p", { class: "play-kicker", text: t("play.done_kicker") }),
      h("h1", { text: t("play.done", { score: fmtNumber(total, 0), max: fmtNumber(max, 0) }) }),
      h("p", { class: "play-prompt", text: t("play.lesson") }),
      h("ul", { class: "play-log" }, ...log.map((l) => h("li", { text: t("play.log_line", { site: l.site, hits: fmtNumber(l.hits, 0), p: fmtNumber(l.points, 0) }) }))),
      h(
        "div",
        { class: "play-cta" },
        h("a", { class: "btn btn-primary", href: `index.html?site=sylhet&lang=${lang}`, text: t("play.open_map") }),
        h("a", { class: "btn", href: `index.html?site=sylhet&mode=tools&lang=${lang}`, text: t("play.know_place") }),
        h("button", { type: "button", class: "btn", text: t("play.again"), onclick: () => ((k = 0), (total = 0), (log.length = 0), playRound()) }),
      ),
    );
  }

  if (rounds.length) playRound();
  else root.replaceChildren(h("p", { text: t("play.no_data") }));
}

if (typeof document !== "undefined" && document.getElementById("play")) main();
