// DOM and SVG builders. No innerHTML with data anywhere (CLAUDE.md JS conventions).

const SVG_NS = "http://www.w3.org/2000/svg";

function apply(el, attrs, children) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// h("button", { class: "x", onclick }, "Label")
export function h(tag, attrs, ...children) {
  return apply(document.createElement(tag), attrs, children);
}

// s("path", { d: "M0 0" })
export function s(tag, attrs, ...children) {
  return apply(document.createElementNS(SVG_NS, tag), attrs, children);
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

// Linear scale: scale([d0, d1], [r0, r1])(x)
export function scale([d0, d1], [r0, r1]) {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return (x) => r0 + (x - d0) * k;
}

// About n round tick values covering [lo, hi].
export function ticks(lo, hi, n = 4) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((v) => raw <= v) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

// A visually hidden table: the text equivalent of a chart (docs/06 §5).
export function srTable(caption, headers, rows) {
  return h(
    "table",
    { class: "sr-only" },
    h("caption", { text: caption }),
    h("thead", {}, h("tr", {}, headers.map((x) => h("th", { scope: "col", text: x })))),
    h("tbody", {}, rows.map((r) => h("tr", {}, r.map((x) => h("td", { text: x }))))),
  );
}

// Small stroke icons for buttons that also carry a text label (the label names the button;
// narrow screens hide it visually, never from screen readers). docs/10 D-080.
const ICONS = {
  link: "M7.5 10.5 L10.5 7.5 M6 8 L4.5 9.5 A2.5 2.5 0 0 0 8.5 13.5 L10 12 M8 6 L9.5 4.5 A2.5 2.5 0 0 1 13.5 8.5 L12 10",
  info: "M9 8 V13 M9 5.2 V5.4 M16 9 A7 7 0 1 1 2 9 A7 7 0 1 1 16 9",
  sound: "M3 7 H6 L10 4 V14 L6 11 H3 Z M12.5 6.5 A3.5 3.5 0 0 1 12.5 11.5",
};
export function icon(name) {
  return s("svg", { class: "btn-icon", width: 18, height: 18, viewBox: "0 0 18 18", "aria-hidden": "true" },
    s("path", { d: ICONS[name], fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" }));
}
