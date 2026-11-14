// The map panel (docs/10 D-092): every choice about what the map shows sits in one panel left of
// the map, in the same order in every mode: Layer (with its key), Display, On top, Compare,
// Basemap. Feature modules hand their own controls to it (ctx.dock.place), so a control keeps
// its listeners and its owner; the findings stay in the sidebar on the right. A section shows
// only when it has something for the map on screen, and its heading names the current choice.
import { h, s } from "./svg.js";

export const SECTIONS = ["layer", "display", "overlays", "compare", "basemap"];
const FOLD_KEY = "utc.dockFolded";
const OPEN_KEY = "utc.dockOpen";
const OPEN_DEFAULT = { layer: true, display: true, overlays: true, compare: true, basemap: false };

// Below 1180 px the map would be narrower than the panel and the findings together: the panel
// opens folded to its icons there (and is a sheet on a phone).
export const foldedByDefault = (width) => width < 1180;

// The map a mode shows: the three readings of a site (findings, evidence, tools) share its map.
export const mapOf = (mode) => (["site", "evidence", "tools"].includes(mode) ? "site" : mode);
export const mapsOf = (modes) => [...new Set(String(modes ?? "site").split(/\s+/).filter(Boolean).map(mapOf))].join(" ");

// A select or a checkbox is "on" unless it is set to nothing.
const OFF_VALUES = new Set(["", "off", "none"]);

// What a section's heading says, from plain descriptions of its visible controls:
// { kind: "pressed" | "select" | "check", text, value, checked }.
export function summarise(section, controls, t) {
  if (section === "overlays") {
    const n = controls.filter((c) => (c.kind === "check" && c.checked) || (c.kind === "select" && !OFF_VALUES.has(c.value))).length;
    return n ? t("dock.n_on", { n }) : t("dock.none_on");
  }
  const pressed = controls.find((c) => c.kind === "pressed");
  if (pressed && section !== "display") return pressed.text;
  return controls.find((c) => c.kind === "select")?.text ?? "";
}

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback; // private window or blocked storage
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // the choice is simply not kept
  }
}

const ICON_PATHS = {
  layer: ["M11 3 L19 7.5 L11 12 L3 7.5 Z", "M3 11.5 L11 16 L19 11.5"],
  display: ["M11 4 A7 7 0 1 0 11 18 A7 7 0 1 0 11 4 Z", "M11 4 A7 7 0 0 1 11 18 Z"],
  overlays: ["M4 4 H13 V13 H4 Z", "M9 9 H18 V18 H9 Z"],
  compare: ["M3 5 H19 V17 H3 Z", "M11 3 V19"],
  basemap: ["M3 6 L8 4 L14 6 L19 4 V16 L14 18 L8 16 L3 18 Z", "M8 4 V16 M14 6 V18"],
};

export function sectionIcon(section) {
  return s(
    "svg",
    { class: `dock-icon dock-icon-${section}`, width: 20, height: 20, viewBox: "0 0 22 22", "aria-hidden": "true" },
    ICON_PATHS[section].map((d, i) => s("path", { d, fill: section === "display" && i === 1 ? "currentColor" : "none", stroke: "currentColor", "stroke-width": 1.7, "stroke-linejoin": "round" })),
  );
}

// Builds the panel inside `root` (the <nav id="dock"> in index.html).
export function createDock({ root, t, onTools }) {
  const open = { ...OPEN_DEFAULT, ...load(OPEN_KEY, {}) };
  const bodies = {};
  const heads = {};
  const values = {};
  const sections = {};
  const items = []; // { item, section }

  const foldBtn = h("button", { type: "button", class: "dock-fold" });
  const head = h(
    "div",
    { class: "dock-head" },
    h("h2", { class: "dock-title", text: t("dock.title") }),
    h("span", { class: "dock-sub", text: t("dock.sub") }),
    foldBtn,
  );
  const body = h("div", { class: "dock-body" });
  for (const sec of SECTIONS) {
    values[sec] = h("span", { class: "dock-sec-v" });
    heads[sec] = h(
      "button",
      { type: "button", class: "dock-sec-h", id: `dock-h-${sec}`, "aria-controls": `dock-b-${sec}`, title: t(`dock.${sec}`) },
      sectionIcon(sec),
      h("span", { class: "dock-sec-n", text: t(`dock.${sec}`) }),
      values[sec],
      h("span", { class: "dock-chevron", "aria-hidden": "true" }),
    );
    bodies[sec] = h("div", { class: "dock-sec-b", id: `dock-b-${sec}`, role: "region", "aria-labelledby": `dock-h-${sec}` });
    sections[sec] = h("section", { class: "dock-sec", dataset: { sec } }, h("h3", { class: "dock-sec-title" }, heads[sec]), bodies[sec]);
    heads[sec].addEventListener("click", () => {
      if (document.body.classList.contains("dock-folded")) {
        setFolded(false);
        setOpen(sec, true);
        heads[sec].scrollIntoView({ block: "nearest" });
        return;
      }
      setOpen(sec, !open[sec]);
    });
    body.append(sections[sec]);
  }
  const toolsLink = h(
    "button",
    { type: "button", class: "dock-tools" },
    s("svg", { width: 18, height: 18, viewBox: "0 0 22 22", "aria-hidden": "true", class: "dock-icon" }, s("path", { d: "M4 18 L10 12 M13 4 L18 9 L11 16 L6 11 Z", fill: "none", stroke: "currentColor", "stroke-width": 1.7, "stroke-linejoin": "round" })),
    h("span", { class: "dock-tools-text" }, h("span", { text: t("dock.tools_lead") }), h("span", { class: "dock-tools-go", text: t("dock.tools_open") })),
  );
  toolsLink.addEventListener("click", () => onTools?.());
  body.append(toolsLink);
  root.append(head, body);

  function setOpen(sec, on) {
    open[sec] = on;
    sections[sec].classList.toggle("is-open", on);
    heads[sec].setAttribute("aria-expanded", String(on));
    save(OPEN_KEY, open);
  }
  for (const sec of SECTIONS) setOpen(sec, open[sec]);

  function setFolded(folded, remember = true) {
    document.body.classList.toggle("dock-folded", folded);
    foldBtn.setAttribute("aria-expanded", String(!folded));
    foldBtn.setAttribute("aria-label", t(folded ? "dock.unfold" : "dock.fold"));
    foldBtn.title = foldBtn.getAttribute("aria-label");
    if (remember) save(FOLD_KEY, folded);
    window.dispatchEvent(new Event("resize")); // the map measures its new width
  }
  foldBtn.addEventListener("click", () => setFolded(!document.body.classList.contains("dock-folded")));
  const stored = load(FOLD_KEY, null);
  setFolded(typeof stored === "boolean" ? stored : foldedByDefault(window.innerWidth), false);

  // ---- what is shown, and what each heading says
  const shownMap = () => document.body.dataset.map ?? "site";
  function isShown(item) {
    if (item.hidden || !item.dataset.maps.split(" ").includes(shownMap())) return false;
    if (getComputedStyle(item).display === "none") return false;
    return [...item.children].some((c) => !c.hidden && getComputedStyle(c).display !== "none");
  }
  function describe(el) {
    const out = [];
    for (const c of el.querySelectorAll("[aria-pressed='true'], select, input[type='checkbox']")) {
      if (c.closest("[hidden]") || c.disabled) continue;
      if (c.tagName === "SELECT") out.push({ kind: "select", value: c.value, text: c.selectedOptions[0]?.textContent.trim() ?? "" });
      else if (c.tagName === "INPUT") out.push({ kind: "check", checked: c.checked });
      else if (c.classList.contains("seg-btn")) out.push({ kind: "pressed", text: c.textContent.trim() });
    }
    return out;
  }
  function refresh() {
    for (const sec of SECTIONS) {
      const shown = items.filter((x) => x.section === sec && isShown(x.item));
      if (sections[sec].hidden !== !shown.length) sections[sec].hidden = !shown.length;
      const text = shown.length ? summarise(sec, shown.flatMap((x) => describe(x.item)), t) : "";
      if (values[sec].textContent !== text) values[sec].textContent = text;
    }
  }
  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      refresh();
    });
  }
  new MutationObserver(schedule).observe(body, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "aria-pressed", "disabled"] });
  body.addEventListener("change", schedule);

  // A feature hands over a control. `maps`: the maps it belongs to (default: its modes');
  // `follow`: the control hides whenever the feature's own card hides (no data, offline, wrong
  // kind of site), and also whenever `also` hides (a part of the card the control belongs to);
  // `only`: the card keeps nothing else, so it leaves the sidebar.
  function place(featureId, featureRoot, section, el, { maps, follow = true, also = null, only = false } = {}) {
    const item = h("div", { class: "dock-item", dataset: { owner: featureId, maps } }, el);
    bodies[section].append(item);
    items.push({ item, section });
    if (only) featureRoot.classList.add("dock-only");
    if (follow) {
      const sync = () => {
        item.hidden = featureRoot.hidden || Boolean(also?.hidden);
        schedule();
      };
      for (const el2 of [featureRoot, also].filter(Boolean)) new MutationObserver(sync).observe(el2, { attributes: true, attributeFilter: ["hidden"] });
      sync();
    }
    schedule();
    return item;
  }

  return { place, refresh: schedule, setOpen, setFolded };
}
