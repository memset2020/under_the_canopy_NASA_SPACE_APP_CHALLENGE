// The village flood card (D-104): the shown pass as one picture a relief worker or a union office
// can print or forward on a phone: where water lies under the trees, which settlements are next to
// it, how long they stayed flooded this season, the roads under water and when NISAR passes next.
// In the interface's language (Bengali for Sylhet's villages). In the Sylhet flash flood of 2022
// only 23 % of last-mile households got an official warning (GDPC 2026); this card is not a
// warning: NISAR's maps arrive days after the pass, so it is for planning relief and checking
// where water hides, and it says so on the card itself. Drawn in the browser from the site's own
// files, so it works offline.
import { h } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate, fmtNumber } from "./i18n.js";
import { nextPasses } from "./orbitmath.js";
import { setNote } from "./readable.js";

export const id = "floodcard";
export const slot = "sidebar";

const W = 1080;
const H = 1600;
const PAD = 64;
const MAX_PLACES = 9;
const FOOT = 190; // the disclaimer and credit at the bottom, kept clear
const C = { bg: "#0d1414", panel: "#152020", text: "#eef3f1", muted: "#9fb0ab", rule: "#2a3838", amber: "#e69f00", blue: "#0072b2" };
const FONT = '"Segoe UI", "Noto Sans Bengali", "Noto Sans", system-ui, sans-serif';

// The settlements to name: nearest to water under the trees first, then longest flooded.
export function placesForCard(places, n = MAX_PLACES) {
  return [...(places ?? [])]
    .filter((p) => p.nearest_flood_m !== null && p.nearest_flood_m !== undefined)
    .sort((a, b) => a.nearest_flood_m - b.nearest_flood_m || (b.days_flooded ?? 0) - (a.days_flooded ?? 0))
    .slice(0, n);
}

function wrap(ctx, text, maxW) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > maxW && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function text(ctx, str, x, y, { size = 28, weight = 400, color = C.text, maxW = W - 2 * PAD, lh = 1.3, align = "left" } = {}) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  const lines = wrap(ctx, str, maxW);
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * size * lh));
  return y + lines.length * size * lh;
}

const loadImage = (src) =>
  new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = fail;
    img.src = src;
  });

export async function drawCard(canvas, site, passIndex, t, todayIso) {
  const s = site.summary;
  const pass = s.passes[passIndex];
  const ex = s.exposure;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = C.amber;
  ctx.fillRect(0, 0, W, 10);

  let y = text(ctx, t("floodcard.kicker").toUpperCase(), PAD, 76, { size: 22, weight: 700, color: C.amber });
  y = text(ctx, s.site.name, PAD, y + 22, { size: 50, weight: 700 });
  y = text(ctx, t("floodcard.radar_of", { date: fmtDate(pass.date), i: fmtNumber(passIndex + 1, 0), n: fmtNumber(s.passes.length, 0) }), PAD, y + 6, { size: 26, color: C.muted });

  // The map: this pass's classes, fitted into the panel, with the settlements on it.
  const top = y + 24;
  const boxW = W - 2 * PAD;
  const boxH = 470;
  ctx.fillStyle = C.panel;
  ctx.fillRect(PAD, top, boxW, boxH);
  const img = await loadImage(site.url(pass.class_png));
  const k = Math.min(boxW / img.width, boxH / img.height);
  const mw = img.width * k;
  const mh = img.height * k;
  const mx = PAD + (boxW - mw) / 2;
  const my = top + (boxH - mh) / 2;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, mx, my, mw, mh);
  ctx.strokeStyle = C.text;
  ctx.lineWidth = 2;
  ctx.strokeRect(mx, my, mw, mh);
  const [west, south, east, north] = s.grid.bounds;
  const places = placesForCard(ex?.places);

  // Legend under the map.
  y = top + boxH + 40;
  ctx.fillStyle = C.amber;
  ctx.fillRect(PAD, y - 20, 24, 24);
  text(ctx, t("floodcard.key_hidden"), PAD + 36, y, { size: 24, color: C.muted, maxW: 420 });
  ctx.fillStyle = C.blue;
  ctx.fillRect(PAD + 480, y - 20, 24, 24);
  text(ctx, t("floodcard.key_open"), PAD + 516, y, { size: 24, color: C.muted, maxW: 420 });

  // Roads, people, the next passes: first, then as many settlements as fit.
  const room = () => y < H - FOOT - 40;
  y += 48;
  const facts = [];
  const peak = s.passes.find((p) => p.id === s.peak_pass) ?? pass;
  if (ex?.roads_flooded_km) facts.push(t("floodcard.roads", { km: fmtNumber(ex.roads_flooded_km, 0), date: fmtDate(peak.date, "short") }));
  if (ex?.population_near_hidden_flood) facts.push(t("floodcard.people", { n: fmtNumber(ex.population_near_hidden_flood, 0) }));
  const next = nextPasses(s.passes.at(-1).date, todayIso, 2);
  if (next.length) facts.push(t("floodcard.next", { dates: next.map((d) => fmtDate(d, "short")).join(", ") }));
  for (const f of facts) y = text(ctx, `• ${f}`, PAD, y + 4, { size: 23, lh: 1.22, color: C.text });

  // The settlements.
  y += 24;
  y = text(ctx, t("floodcard.places_title"), PAD, y, { size: 28, weight: 700 });
  y += 6;
  let shown = 0;
  places.forEach((p, i) => {
    if (!room()) return;
    shown += 1;
    const line = t("floodcard.place_line", {
      i: fmtNumber(i + 1, 0),
      name: p.name,
      m: fmtNumber(Math.round(p.nearest_flood_m / 10) * 10, 0),
      days: fmtNumber(p.days_flooded ?? 0, 0),
    });
    y = text(ctx, line, PAD, y + 4, { size: 23, lh: 1.22 });
  });
  if (!places.length) y = text(ctx, t("floodcard.no_places"), PAD, y + 4, { size: 25, color: C.muted });
  // Markers last, for the settlements the list had room for.
  places.slice(0, shown).forEach((p, i) => {
    const px = mx + ((p.lon - west) / (east - west)) * mw;
    const py = my + ((north - p.lat) / (north - south)) * mh;
    if (px < mx || px > mx + mw || py < my || py > my + mh) return;
    ctx.beginPath();
    ctx.arc(px, py, 17, 0, Math.PI * 2);
    ctx.fillStyle = C.text;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = C.bg;
    ctx.stroke();
    text(ctx, fmtNumber(i + 1, 0), px, py + 8, { size: 22, weight: 700, color: C.bg, align: "center" });
  });


  // What it is and is not, and where it comes from: on the card, so it travels with it.
  ctx.fillStyle = C.rule;
  ctx.fillRect(PAD, H - FOOT, boxW, 2);
  const fy = text(ctx, t("floodcard.disclaimer"), PAD, H - FOOT + 40, { size: 20, color: C.muted, lh: 1.35 });
  text(ctx, t("floodcard.credit"), PAD, Math.max(fy + 8, H - 34), { size: 18, color: C.muted });
  return canvas;
}

export function init({ store, t, root }) {
  const heading = h("h2", { text: t("floodcard.title") });
  const lead = h("p", { text: t("floodcard.lead") });
  const make = h("button", { type: "button", class: "btn", text: t("floodcard.make") });
  const preview = h("img", { class: "floodcard-preview", alt: "", hidden: true });
  const save = h("a", { class: "btn btn-small", hidden: true, text: t("floodcard.download") });
  const print = h("button", { type: "button", class: "btn btn-small", hidden: true, text: t("floodcard.print") });
  const actions = h("div", { class: "floodcard-actions" }, save, print);
  const limit = h("p");
  setNote(limit, "limit", t("floodcard.limit"));
  root.append(heading, lead, make, preview, actions, limit);
  const canvas = document.createElement("canvas");

  make.addEventListener("click", async () => {
    const { site, passIndex } = store.get();
    if (!site) return;
    make.disabled = true;
    try {
      await drawCard(canvas, site, passIndex, t, new Date().toISOString().slice(0, 10));
      const url = canvas.toDataURL("image/png");
      preview.src = url;
      preview.alt = t("floodcard.alt", { site: site.summary.site.name, date: fmtDate(site.summary.passes[passIndex].date) });
      save.href = url;
      save.download = `flood-card-${site.summary.site.id}-${site.summary.passes[passIndex].date}.png`;
      for (const el of [preview, save, print]) el.hidden = false;
    } finally {
      make.disabled = false;
    }
  });
  print.addEventListener("click", () => {
    const win = window.open("", "_blank");
    if (!win) return;
    const doc = win.document;
    const img = doc.createElement("img");
    img.src = preview.src;
    img.style.width = "100%";
    doc.body.style.margin = "0";
    doc.body.append(img);
    img.onload = () => win.print();
  });

  watch(store, ["site", "passIndex"], ({ site }) => {
    root.hidden = !site || !site.summary.exposure?.places?.length;
    for (const el of [preview, save, print]) el.hidden = true; // a card is for one pass
  });
}
