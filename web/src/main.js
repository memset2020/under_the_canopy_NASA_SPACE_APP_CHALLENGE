// App bootstrap. Adding a feature = one path in FEATURES (CLAUDE.md).
import { sourceFlags } from "./sourceflags.js";
import { createStore, watch } from "./state.js";
import { LANGUAGES, fmtNumber, language, loadLocale, t } from "./i18n.js";
import { loadManifest, loadSite, passById } from "./data.js";
import { createMap } from "./map.js";
import { h } from "./svg.js";
import { createDock, mapOf, mapsOf } from "./dock.js";
import { note } from "./readable.js";

// Features load one by one: a module that fails (blocked by a content blocker, a network
// error, a bug) is skipped and logged instead of stopping the whole app. A static import
// of every feature would fail as a unit and leave a blank page (docs/10 D-058).
export const FEATURES = [
  "./timeline.js",
  "./layers.js",
  "./compare.js",
  "./chart.js",
  "./explain.js",
  "./annotate.js",
  "./globe.js",
  "./here.js",
  "./belt.js",
  "./placebuild.js",
  "./live.js",
  "./activefire.js", // NASA FIRMS active fires from GIBS vector tiles (D-138)
  "./basemap.js",
  "./orbits.js",
  "./events.js",
  "./level.js",
  "./drivers.js",
  "./canopy.js",
  "./validation.js",
  "./basin.js",
  "./outlook.js",
  "./burn.js",
  "./ice.js",
  "./glaciers.js",
  "./season.js",
  "./ridges.js",
  "./flows.js",
  "./exposure.js",
  "./floodcard.js",
  "./methane.js",
  "./waltz.js",
  "./scientist.js",
  "./tools.js",
  "./space.js",
  "./labels.js",
  "./download.js",
  "./changes.js",
  "./overpass.js",
  "./story.js",
  "./share.js",
  "./sonify.js",
  "./physics.js",
  "./lang.js",
  "./motion.js",
  "./motionprofile.js",
  "./motionchecks.js",
  "./cards.js", // last: it adds a collapse toggle to every card above
];

async function loadFeatures() {
  const results = await Promise.allSettled(FEATURES.map((path) => import(path)));
  return results.flatMap((r, i) => {
    if (r.status === "fulfilled") return [r.value];
    console.error(`feature module ${FEATURES[i]} did not load`, r.reason);
    return [];
  });
}

// Real sites in data/; the simulator in data-synthetic/ (tests, demo). Only these two.
const DATA_FOLDERS = ["data", "data-synthetic"];
const DATA_BASE = `${DATA_FOLDERS.includes(new URLSearchParams(location.search).get("data")) ? new URLSearchParams(location.search).get("data") : "data"}/`;
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const VIEWS = ["flood", "hydroperiod", "level", "canopy", "radar", "change", "terrain", "burn"];
const COMPARE_MODES = ["off", "optical", "cband"];
// Modes (docs/06 §3): each sidebar card belongs to one or more. A site's three readings are
// tabs over the findings (site, evidence, tools); world, motion and ice are maps of their own,
// opened from the header (docs/10 D-092).
const MODES = ["site", "world", "evidence", "tools", "motion", "ice"];
const MODE_OF = {
  compare: "site",
  explain: "site",
  chart: "site",
  level: "site",
  drivers: "site",
  canopy: "site",
  exposure: "site",
  floodcard: "site",
  methane: "site",
  waltz: "site",
  validation: "site evidence",
  basin: "site evidence",
  outlook: "site evidence",
  burn: "site evidence",
  ice: "site evidence",
  glaciers: "ice",
  annotate: "site",
  season: "evidence",
  ridges: "evidence",
  flows: "evidence",
  globe: "world",
  here: "world",
  live: "site world",
  activefire: "site world",
  orbits: "site world",
  overpass: "site world",
  events: "world",
  placebuild: "world",
  belt: "world",
  download: "evidence",
  notes: "evidence",
  scientist: "tools",
  tools: "tools",
  space: "tools",
  labels: "tools",
  motion: "motion",
  motionprofile: "motion",
  motionchecks: "motion",
};
const WORLD_VIEW = { center: [15, 10], zoom: 3 };

function applyStaticText(root) {
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll("[data-i18n-aria]")) {
    el.setAttribute("aria-label", t(el.dataset.i18nAria));
  }
  document.title = t("app.title");
}

function showError(message) {
  const box = document.getElementById("app-error");
  box.textContent = message;
  box.hidden = false;
}

function announce(message) {
  document.getElementById("status").textContent = message;
}

function renderNotes(root, summary) {
  const warnings = summary.warnings.filter((w) => w.code !== "synthetic_data");
  const codes = [...new Set(warnings.map((w) => w.code))];
  // Warnings as limits; each source as what it is, what it is used for, and who provides it (D-093).
  root.replaceChildren(
    h("h2", { text: t("notes.title") }),
    ...(codes.length ? codes.map((c) => note("limit", t(`warning.${c}`))) : [h("p", { class: "muted", text: t("notes.none") })]),
    // Sources as flags to the one sources page (D-110), not a list repeated on every site.
    sourceFlags(summary.sources, t),
  );
}

// Deep links (T-14, F19): ?site=…&pass=p07|7&view=hydroperiod&compare=cband&px=120,88&lang=pt
function readRoute() {
  const q = new URLSearchParams(location.search);
  return {
    site: q.get("site"),
    pass: q.get("pass"),
    view: VIEWS.includes(q.get("view")) ? q.get("view") : "flood",
    compare: COMPARE_MODES.includes(q.get("compare")) ? q.get("compare") : "off",
    basemap: q.get("basemap") !== "off",
    px: /^\d+,\d+$/.test(q.get("px") ?? "") ? q.get("px").split(",").map(Number) : null,
    lang: LANGUAGES.includes(q.get("lang")) ? q.get("lang") : "en",
    mode: MODES.includes(q.get("mode")) ? q.get("mode") : "site",
  };
}

function writeRoute(state) {
  if (!state.site) return;
  const q = new URLSearchParams(location.search);
  q.set("site", state.siteId);
  q.set("pass", state.site.summary.passes[state.passIndex].id);
  q.set("view", state.view);
  if (state.compare === "off") q.delete("compare");
  else q.set("compare", state.compare);
  if (state.selected) q.set("px", `${state.selected.row},${state.selected.col}`);
  else q.delete("px");
  if (state.mode === "site") q.delete("mode");
  else q.set("mode", state.mode);
  history.replaceState(null, "", `${location.pathname}?${q}`);
}

function resolvePass(summary, pass) {
  if (pass !== null && pass !== undefined) {
    const byId = passById(summary, pass);
    if (byId >= 0) return byId;
    const n = Number(pass);
    if (Number.isInteger(n) && n >= 1 && n <= summary.passes.length) return n - 1;
  }
  return Math.max(0, passById(summary, summary.peak_pass));
}

async function main() {
  const route = readRoute();
  try {
    await loadLocale(route.lang);
  } catch (err) {
    // The only untranslated string: shown when the dictionary itself cannot load.
    showError(`Could not load interface text (${err.message}). Serve the web/ folder over HTTP.`);
    return;
  }
  document.documentElement.lang = language();
  applyStaticText(document);

  const store = createStore({
    siteId: null,
    site: null,
    passIndex: 0,
    view: route.view,
    compare: route.compare,
    selected: null,
    playing: false,
    scientist: { enabled: false, thresholds: null },
    layers: { roads: false },
    audio: false,
    manifest: null,
    dataBase: DATA_BASE,
    mode: route.mode,
    picked: null,
    global: null,
    gibs: null, // NASA GIBS catalogue (live.js loads it)
    tool: null, // analyst tool taking map clicks: distance | area | profile (tools.js)
    showOrbit: false, // NISAR ground track on the map (orbits.js; the story turns it on)
    online: route.basemap, // ?basemap=off also turns off NASA live tiles (offline demo, tests)
  });

  const map = createMap(document.getElementById("map"), {
    tileUrl: route.basemap ? TILE_URL : null,
    attribution: route.basemap ? t("map.attribution") : "",
    center: [0, 10],
    zoom: 3,
  });

  const slots = {
    header: document.getElementById("slot-header"),
    map: document.getElementById("slot-map"),
    "map-bottom": document.getElementById("slot-map-bottom"),
    sidebar: document.getElementById("slot-sidebar"),
  };
  const ctx = { store, map, t, data: { get site() { return store.get().site; } } };
  const dock = createDock({ root: document.getElementById("dock"), t, onTools: () => goMode("tools") });
  for (const feature of await loadFeatures()) {
    const root = h("section", { class: "feature", dataset: { feature: feature.id, modes: MODE_OF[feature.id] ?? "site" } });
    (slots[feature.slot ?? "sidebar"] ?? slots.sidebar).append(root);
    // A feature's map controls go to the map panel (dock.js), shown for the maps of its modes.
    const featureDock = {
      place: (section, el, opts = {}) => dock.place(feature.id, root, section, el, { maps: mapsOf(MODE_OF[feature.id] ?? "site"), ...opts }),
    };
    try {
      feature.init({ ...ctx, root, dock: featureDock });
    } catch (err) {
      // One broken feature must not take the demo down.
      console.error(`feature ${feature.id} failed`, err);
      root.hidden = true;
    }
  }
  const notes = h("section", { class: "feature notes-section", dataset: { feature: "notes", modes: MODE_OF.notes } });
  slots.sidebar.append(notes);
  // The tabs head the sidebar; Fold all / Open all (cards.js) sits under them.
  document.querySelector(".panel-tabs").after(...slots.sidebar.querySelectorAll(":scope > .cards-bar"));

  let manifest;
  try {
    manifest = await loadManifest(DATA_BASE);
  } catch (err) {
    showError(t("error.no_manifest", { detail: err.message }));
    return;
  }
  if (!manifest.sites.length) {
    showError(t("error.no_sites"));
    return;
  }

  store.set({ manifest });
  const select = document.getElementById("site-select");
  // Sites grouped by the change they show (v13 site kind): water under the trees, burned forest.
  const groups = [["flood", "changes.group_water"], ["fire", "changes.group_fire"]]
    .map(([kind, key]) => [key, manifest.sites.filter((s) => (s.kind ?? "flood") === kind)])
    .filter(([, list]) => list.length);
  const option = (s) => h("option", { value: s.id, text: s.name });
  select.replaceChildren(
    ...(groups.length > 1 ? groups.map(([key, list]) => h("optgroup", { label: t(key) }, list.map(option))) : manifest.sites.map(option)),
  );

  async function selectSite(siteId, pass = null) {
    const entry = manifest.sites.find((s) => s.id === siteId) ?? manifest.sites[0];
    select.value = entry.id;
    document.body.classList.add("is-loading");
    try {
      const bundle = await loadSite(DATA_BASE, entry);
      const summary = bundle.summary;
      store.set({
        siteId: entry.id,
        site: bundle,
        passIndex: resolvePass(summary, pass),
        selected: null,
        playing: false,
        scientist: { ...store.get().scientist, thresholds: { ...summary.thresholds } },
      });
      if (store.get().mode === "world") map.setView(WORLD_VIEW.center, WORLD_VIEW.zoom);
      else if (store.get().mode === "motion" || store.get().mode === "ice") {
        // motion.js and glaciers.js frame their own places
      } else {
        map.fitBounds(summary.grid.bounds);
      }
      renderNotes(notes, summary);
      const peak = summary.passes.find((p) => p.id === summary.peak_pass);
      announce(t("status.site_loaded", { site: entry.name, km2: fmtNumber(peak.flooded_km2) }));
    } catch (err) {
      showError(t("error.site_load", { site: entry.name, detail: err.message }));
    } finally {
      document.body.classList.remove("is-loading");
    }
  }

  select.addEventListener("change", () => {
    store.set({ mode: "site" });
    selectSite(select.value);
  });

  // The world button (header) and the tabs over the findings: both set the mode, and the map moves
  // to where that mode looks. Moving between a site's tabs keeps the map where it is.
  function goMode(mode) {
    const before = store.get().mode;
    store.set({ mode });
    const site = store.get().site;
    if (mode === "world") map.setView(WORLD_VIEW.center, WORLD_VIEW.zoom);
    else if (site && mode !== "motion" && mode !== "ice" && mapOf(before) !== "site") map.fitBounds(site.summary.grid.bounds); // motion.js and glaciers.js frame their own
    document.getElementById("slot-sidebar").scrollTop = 0;
  }
  const worldBtn = document.querySelector(".world-btn");
  worldBtn.addEventListener("click", () => goMode(store.get().mode === "world" ? "site" : "world"));
  const tabs = [...document.querySelectorAll(".panel-tab")];
  for (const tab of tabs) tab.addEventListener("click", () => goMode(tab.dataset.mode));
  // Arrow keys move between the tabs (WAI-ARIA tabs pattern).
  document.querySelector(".panel-tabs").addEventListener("keydown", (ev) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0 || !["ArrowLeft", "ArrowRight"].includes(ev.key)) return;
    const next = tabs[(i + (ev.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    next.focus();
    next.click();
  });
  watch(store, ["mode"], ({ mode }) => {
    document.body.dataset.mode = mode;
    document.body.dataset.map = mapOf(mode);
    worldBtn.setAttribute("aria-pressed", String(mode === "world"));
    for (const tab of tabs) {
      tab.setAttribute("aria-selected", String(tab.dataset.mode === mode));
      tab.tabIndex = tab.dataset.mode === mode ? 0 : -1;
    }
    dock.refresh();
  });

  // Phone: the map panel is a sheet over the map; Findings scrolls to the cards; Story.
  const phoneNav = document.querySelector(".phone-nav");
  const sheetBtn = phoneNav.querySelector('[data-action="dock"]');
  function setSheet(on) {
    document.body.classList.toggle("dock-sheet-open", on);
    sheetBtn.setAttribute("aria-expanded", String(on));
  }
  phoneNav.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".phone-btn");
    if (!btn) return;
    if (btn.dataset.action === "dock") setSheet(!document.body.classList.contains("dock-sheet-open"));
    else {
      setSheet(false);
      if (btn.dataset.action === "story") document.querySelector('section.feature[data-feature="story"] button')?.click();
      else document.getElementById("slot-sidebar").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && document.body.classList.contains("dock-sheet-open")) setSheet(false);
  });

  // The SYNTHETIC badge is driven only by the data flag and is never optional (rule 3).
  const badge = document.getElementById("synthetic-badge");
  const realChip = document.getElementById("provenance-chip");
  watch(store, ["site"], ({ site }) => {
    const synthetic = Boolean(site?.summary.synthetic);
    badge.hidden = !synthetic;
    realChip.hidden = !site || synthetic;
    document.body.classList.toggle("is-synthetic", synthetic);
  });
  store.subscribe((state, _prev, changed) => {
    if (changed.some((k) => ["siteId", "passIndex", "view", "compare", "selected", "mode"].includes(k))) {
      writeRoute(state);
    }
  });

  await selectSite(route.site ?? manifest.default_site, route.pass);
  const site = store.get().site;
  if (site && route.px) {
    const [row, col] = route.px;
    if (row < site.height && col < site.width) store.set({ selected: { row, col } });
  }
  document.body.classList.add("is-ready");
}

main();
