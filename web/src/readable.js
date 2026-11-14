// How the sidebar explains (docs/10 D-093): the finding first, one fact per row with its number
// in bold, a picture where the idea is spatial, then sources and limits as marked notes, so a
// card reads at a glance and every sentence it had is still there. Pure DOM builders; no data
// is ever written as HTML (CLAUDE.md JS conventions).
import { h, s } from "./svg.js";

// Numbers (with their unit) inside a sentence, so the eye finds them first.
const NUMBER = /([−+±-]?[\d০-৯](?:[\d০-৯,.]*[\d০-৯])?(?:\s?(?:million tonnes|tonnes|km²|km|m³\/s|mm|cm|m|%|°[NSEW]?|dB|days?|passes|people)(?![A-Za-z]))?)/g;

// The sentence as parts, numbers marked: [{ text, strong }].
export function splitNumbers(text) {
  const str = String(text);
  const out = [];
  let last = 0;
  for (const m of str.matchAll(NUMBER)) {
    // Skip digits glued to letters (track names like 162A, model names like RL06.3).
    const before = str[m.index - 1];
    const after = str[m.index + m[1].length];
    if ((before && /[A-Za-z_]/.test(before)) || (after && /[A-Za-z_]/.test(after))) continue;
    if (/^[\d০-৯]{4}$/.test(m[1])) continue; // a year reads as a date, not a quantity
    // Part of an ISO date or a range of codes ("2026-10-09").
    if (/[\d০-৯]-$/.test(str.slice(Math.max(0, m.index - 2), m.index + 1)) || /^-?[\d০-৯]+-[\d০-৯]/.test(str.slice(m.index, m.index + 12))) continue;
    // A track number is a name ("Track 54", "trilha 54").
    if (/(?:[Tt]rack|[Tt]rilha|ট্র্যাক)\s$/.test(str.slice(Math.max(0, m.index - 8), m.index))) continue;
    // A day after a month name is part of a date ("Jun 21"), not a quantity.
    if (/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s$/.test(str.slice(Math.max(0, m.index - 12), m.index))) continue;
    if (m.index > last) out.push({ text: str.slice(last, m.index), strong: false });
    out.push({ text: m[1], strong: true });
    last = m.index + m[1].length;
  }
  if (last < str.length) out.push({ text: str.slice(last), strong: false });
  return out;
}

export function strongNumbers(text) {
  return splitNumbers(text).map((p) => (p.strong ? h("strong", { text: p.text }) : p.text));
}

// Small line icons, one per kind of fact (drawn on a 20 px grid, stroke = currentColor).
const ICONS = {
  forest: ["M10 2 L15 9 H12 L16 14 H4 L8 9 H5 Z", "M10 14 V18"],
  water: ["M2 13 C5 11 7 15 10 13 S15 11 18 13", "M2 17 C5 15 7 19 10 17 S15 15 18 17", "M10 2 C12 5 13 7 13 8.5 A3 3 0 0 1 7 8.5 C7 7 8 5 10 2 Z"],
  satellite: ["M7 7 L13 13", "M4 4 L8 8 L6 10 L2 6 Z", "M12 12 L16 16 L14 18 L10 14 Z", "M13 4 A5 5 0 0 1 16 7", "M13 1 A8 8 0 0 1 19 7"],
  people: ["M7 8 A2.5 2.5 0 1 0 7 3 A2.5 2.5 0 1 0 7 8 Z", "M2 17 C2 12 12 12 12 17", "M14 9 A2 2 0 1 0 14 5", "M15 12 C17 12 18 14 18 16"],
  drop: ["M10 2 C14 7 16 10 16 12.5 A6 6 0 0 1 4 12.5 C4 10 6 7 10 2 Z"],
  gas: ["M5 15 C2 15 2 10 6 10 C6 6 12 5 13 9 C17 8 18 14 14 15 Z", "M7 18 H13"],
  pointer: ["M4 3 L15 10 L10 11 L13 17 L11 18 L8 12 L4 15 Z"],
  zoom: ["M8 14 A6 6 0 1 0 8 2 A6 6 0 1 0 8 14 Z", "M12.5 12.5 L18 18", "M5 8 H11", "M8 5 V11"],
  info: ["M10 18 A8 8 0 1 0 10 2 A8 8 0 1 0 10 18 Z", "M10 9 V14", "M10 6 V6.5"],
  source: ["M4 3 H12 L16 7 V17 H4 Z", "M12 3 V7 H16", "M7 10 H13", "M7 13 H13"],
  clock: ["M10 18 A8 8 0 1 0 10 2 A8 8 0 1 0 10 18 Z", "M10 5 V10 L13 12"],
  alert: ["M10 2 L18 17 H2 Z", "M10 8 V12", "M10 14.5 V15"],
  calendar: ["M3 5 H17 V17 H3 Z", "M3 9 H17", "M7 3 V6", "M13 3 V6"],
  ruler: ["M2 13 L13 2 L18 7 L7 18 Z", "M6 9 L8 11", "M9 6 L11 8", "M12 3 L14 5"],
  check: ["M10 18 A8 8 0 1 0 10 2 A8 8 0 1 0 10 18 Z", "M6 10 L9 13 L14 7"],
  cloud: ["M5 15 C1.5 15 1.5 10 5.5 10 C6 6.5 11.5 5.5 13 9 C17 8.5 18.5 15 14 15 Z"],
  road: ["M7 2 L4 18", "M13 2 L16 18", "M10 4 V6", "M10 9 V11", "M10 14 V16"],
  chart: ["M3 17 H17", "M5 14 L9 9 L12 11 L16 5"],
  rain: ["M5 10 C2 10 2 5.5 5.5 5.5 C6 2.5 11 1.5 12.5 4.5 C16 4 17 10 13 10 Z", "M6 13 L5 16", "M10 13 L9 16", "M14 13 L13 16"],
  ice: ["M10 2 V18", "M3 6 L17 14", "M3 14 L17 6"],
  fire: ["M10 2 C12 6 16 8 15 13 A5 5 0 0 1 5 13 C5 10 7 9 8 6 C9 8 10 8 10 2 Z"],
};

export function icon(name, cls = "") {
  return s(
    "svg",
    { class: `rd-icon ${cls}`.trim(), width: 18, height: 18, viewBox: "0 0 20 20", "aria-hidden": "true" },
    (ICONS[name] ?? ICONS.info).map((d) => s("path", { d, fill: "none", stroke: "currentColor", "stroke-width": 1.5, "stroke-linecap": "round", "stroke-linejoin": "round" })),
  );
}

// One fact per row: an icon, the sentence with its numbers in bold.
export function factRow(iconName, text, cls = "") {
  return h("li", { class: `rd-fact ${cls}`.trim() }, icon(iconName), h("span", { class: "rd-fact-text" }, strongNumbers(text)));
}

export function factList(rows) {
  return h("ul", { class: "rd-facts" }, rows.filter(Boolean).map(([iconName, text, cls]) => factRow(iconName, text, cls)));
}

// A finding sentence, its numbers in bold, written into an existing element.
export function setLead(el, text) {
  el.replaceChildren(...strongNumbers(text));
}

// A finding paragraph, its numbers in bold.
export function leadP(text, cls = "") {
  return h("p", { class: `rd-lead ${cls}`.trim() }, strongNumbers(text));
}

// Fills an existing list in place (cards that update on every pass keep their element).
export function setFacts(list, rows) {
  list.replaceChildren(...rows.filter(Boolean).map(([iconName, text, cls]) => factRow(iconName, text, cls)));
}

// One independent check: its status (done, a caution, still to come), its name, what it found.
// An empty text hides the row (a check this site does not have).
const STATUS_ICON = { done: "check", caution: "alert", pending: "clock" };
export function checkRow(cls = "") {
  return h("li", { class: `rd-check ${cls}`.trim(), hidden: true });
}

export function fillCheck(li, status, name, text) {
  li.hidden = !text;
  li.replaceChildren(
    ...(text
      ? [icon(STATUS_ICON[status] ?? "check", `rd-st-${status}`), h("span", { class: "rd-check-body" }, h("strong", { class: "rd-check-name", text: name }), h("span", {}, strongNumbers(text)))]
      : []),
  );
}

// A source or a limit, marked as such so it never reads as the finding.
export function note(kind, text) {
  return h("p", { class: `rd-note rd-note-${kind}` }, icon(kind === "limit" ? "alert" : kind === "source" ? "source" : "info"), h("span", { text }));
}

// The same, rewritten in place (cards that update on every pass keep their element).
export function setNote(el, kind, text) {
  el.classList.remove("rd-note-info", "rd-note-source", "rd-note-limit", "muted", "small");
  el.classList.add("rd-note", `rd-note-${kind}`);
  el.hidden = !text;
  el.replaceChildren(...(text ? [icon(kind === "limit" ? "alert" : kind === "source" ? "source" : "info"), h("span", { text })] : []));
}

// Spec tiles: a value and what it is ("747 km" / "up").
export function tiles(items) {
  return h(
    "dl",
    { class: "rd-tiles" },
    items.map(([value, label]) => h("div", { class: "rd-tile" }, h("dt", { text: label }), h("dd", { text: value }))),
  );
}

// A share as a bar: the part (filled) of the whole, both named.
export function shareBar(part, whole, partLabel, wholeLabel, cls = "") {
  const pct = whole > 0 ? Math.max(0, Math.min(100, (100 * part) / whole)) : 0;
  return h(
    "div",
    { class: `rd-share ${cls}`.trim() },
    h("div", { class: "rd-share-track", "aria-hidden": "true" }, h("span", { class: "rd-share-fill", style: `width:${pct.toFixed(1)}%` })),
    h("p", { class: "rd-share-labels" }, h("span", { class: "rd-share-part" }, strongNumbers(partLabel)), h("span", {}, strongNumbers(wholeLabel))),
  );
}

// Counts as coloured chips ("1 red alert").
export function chips(items) {
  return h("p", { class: "rd-chips" }, items.map(([text, cls]) => h("span", { class: `rd-chip ${cls}`, text })));
}

// The method and its limits, one click away; the summary says so, so the depth is never hidden.
export function more(label, ...children) {
  return h("details", { class: "rd-more" }, h("summary", { text: label }), h("div", { class: "rd-more-body" }, children));
}
