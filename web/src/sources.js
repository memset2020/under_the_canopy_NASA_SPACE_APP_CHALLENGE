// The sources page (D-110, catalogue in D-111): every source in one place. The evidence web is the
// way in: each cell (a family × a change) counts its sources and, chosen, lists them beside the
// web and filters the catalogue below. The catalogue is a reference list, one aligned row a source
// (name and provider, what it tells us, where it is used, its licence) that opens to its citation.
import { fmtNumber, language, loadLocale, t } from "./i18n.js";
import { h } from "./svg.js";
import { SOURCES, UMBRELLAS, byUmbrella } from "./sources-registry.js";
import { pennant } from "./sourceflags.js";

const USES = ["water", "fire", "ground", "ice", "world"];
const state = { umbrella: null, use: null, q: "" };
const umOf = (id) => UMBRELLAS.find((u) => u.id === id);
const inCell = (x) => (!state.umbrella || x.umbrella === state.umbrella) && (!state.use || x.used.includes(state.use));
const matches = (x) => inCell(x) && (!state.q || `${x.name} ${x.provider} ${x.cite} ${x.role}`.toLowerCase().includes(state.q));

function usesStrip(x) {
  return h("span", { class: "uses" }, ...USES.map((u) => h("i", { class: x.used.includes(u) ? `on use-${u}` : "", title: t(`sources.use_${u}`) })));
}

// The web as a grid of buttons: rows are families, columns the four changes and the world map.
function matrix(root) {
  const count = (um, u) => SOURCES.filter((x) => x.umbrella === um && x.used.includes(u)).length;
  const max = Math.max(...UMBRELLAS.flatMap((um) => USES.map((u) => count(um.id, u))));
  const cell = (um, u) => {
    const n = count(um.id, u);
    if (!n) return h("span", { class: "mx-cell empty" });
    const on = state.umbrella === um.id && state.use === u;
    const b = h(
      "button",
      { type: "button", class: `mx-cell${on ? " on" : ""}`, style: `--c:${um.colour}; --s:${(0.45 + 0.55 * Math.sqrt(n / max)).toFixed(2)}`, "aria-pressed": String(on), "aria-label": t("sources.cell_aria", { um: t(`sources.u_${um.id}`), use: t(`sources.use_${u}`), n }) },
      h("span", { class: "dot", text: fmtNumber(n, 0) }),
    );
    b.addEventListener("click", () => select(on ? null : um.id, on ? null : u));
    return b;
  };
  const head = h("div", { class: "mx-row mx-head" }, h("span", { class: "mx-name" }), ...USES.map((u) => {
    const b = h("button", { type: "button", class: `mx-col${state.use === u && !state.umbrella ? " on" : ""}`, text: t(`sources.use_${u}`) });
    b.addEventListener("click", () => select(null, state.use === u && !state.umbrella ? null : u));
    return b;
  }), h("span", { class: "mx-total-h", text: "Σ" }));
  const rows = UMBRELLAS.map((um) => {
    const n = SOURCES.filter((x) => x.umbrella === um.id).length;
    const name = h("button", { type: "button", class: `mx-name${state.umbrella === um.id && !state.use ? " on" : ""}` }, pennant(um.colour), h("span", { text: t(`sources.u_${um.id}`) }));
    name.addEventListener("click", () => select(state.umbrella === um.id && !state.use ? null : um.id, null));
    return h("div", { class: "mx-row" }, name, ...USES.map((u) => cell(um, u)), h("span", { class: "mx-total", text: fmtNumber(n, 0) }));
  });
  const totals = h("div", { class: "mx-row mx-foot" }, h("span", { class: "mx-name", text: t("sources.total") }), ...USES.map((u) => h("span", { class: "mx-total", text: fmtNumber(SOURCES.filter((x) => x.used.includes(u)).length, 0) })), h("span", { class: "mx-total strong", text: fmtNumber(SOURCES.length, 0) }));
  root.replaceChildren(head, ...rows, totals);
}

// Beside the web: the sources of the chosen cell, row or column, or an overview.
function detail(root) {
  if (!state.umbrella && !state.use) {
    const top = [...UMBRELLAS].map((um) => [um, SOURCES.filter((x) => x.umbrella === um.id).length]).sort((a, b) => b[1] - a[1]);
    root.replaceChildren(
      h("p", { class: "wd-kicker", text: t("sources.wd_overview") }),
      h("p", { class: "wd-big" }, h("b", { text: fmtNumber(SOURCES.length, 0) }), h("span", { text: t("sources.wd_sources_in", { n: fmtNumber(UMBRELLAS.length, 0) }) })),
      h("ul", { class: "wd-bars" }, ...top.map(([um, n]) => h("li", { style: `--c:${um.colour}; --w:${(n / top[0][1]) * 100}%` }, h("span", { text: t(`sources.u_${um.id}`) }), h("b", { text: fmtNumber(n, 0) })))),
      h("p", { class: "wd-hint", text: t("sources.wd_hint") }),
    );
    return;
  }
  const list = SOURCES.filter(inCell);
  const title = [state.umbrella && t(`sources.u_${state.umbrella}`), state.use && t(`sources.use_${state.use}`)].filter(Boolean).join(" × ");
  const clear = h("button", { type: "button", class: "wd-clear", text: t("sources.clear") });
  clear.addEventListener("click", () => select(null, null));
  root.replaceChildren(
    h("p", { class: "wd-kicker", text: t("sources.wd_selected") }),
    h("h3", { class: "wd-title", style: state.umbrella ? `--c:${umOf(state.umbrella).colour}` : "" }, state.umbrella ? pennant(umOf(state.umbrella).colour) : null, h("span", { text: title })),
    h("ol", { class: "wd-list" }, ...list.map((x) => {
      const a = h("a", { href: `#${x.id}` }, h("b", { text: x.name }), h("span", { text: x.role }));
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        open(x.id, true);
      });
      return h("li", { style: `--c:${umOf(x.umbrella).colour}` }, a);
    })),
    clear,
  );
}

function row(x) {
  const um = umOf(x.umbrella);
  const btn = h(
    "button",
    { type: "button", class: "cat-row", "aria-expanded": "false", "aria-controls": `${x.id}-cite` },
    h("span", { class: "cat-src" }, h("b", { text: x.name }), h("span", { text: x.provider })),
    h("span", { class: "cat-role", text: x.role }),
    usesStrip(x),
    h("span", { class: "cat-lic", text: x.licence }),
  );
  const copy = h("button", { type: "button", class: "cat-copy", text: t("sources.copy_cite") });
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(x.cite);
      copy.textContent = t("sources.copied");
      setTimeout(() => (copy.textContent = t("sources.copy_cite")), 1600);
    } catch {
      /* clipboard refused: the citation stays selectable */
    }
  });
  const more = h(
    "div",
    { class: "cat-more", id: `${x.id}-cite`, hidden: true },
    h("p", { class: "cat-cite-h", text: t("sources.how_cite") }),
    h("p", { class: "cat-cite", text: x.cite }),
    h("div", { class: "cat-actions" }, copy, x.url ? h("a", { href: x.url, target: "_blank", rel: "noopener noreferrer", text: t("sources.open") }) : null),
  );
  btn.addEventListener("click", () => {
    const on = btn.getAttribute("aria-expanded") !== "true";
    btn.setAttribute("aria-expanded", String(on));
    more.hidden = !on;
  });
  return h("div", { class: "cat-item", id: x.id, style: `--c:${um.colour}`, dataset: { id: x.id } }, btn, more);
}

function open(id, scroll) {
  const item = document.getElementById(id);
  if (!item) return;
  if (item.hidden) select(null, null);
  const b = item.querySelector(".cat-row");
  b.setAttribute("aria-expanded", "true");
  item.querySelector(".cat-more").hidden = false;
  item.classList.remove("flash");
  void item.offsetWidth;
  item.classList.add("flash");
  if (scroll) item.scrollIntoView({ block: "center", behavior: "smooth" });
  history.replaceState(null, "", `#${id}`);
}

function applyFilter() {
  let n = 0;
  for (const item of document.querySelectorAll(".cat-item")) {
    const x = SOURCES.find((s) => s.id === item.dataset.id);
    item.hidden = !matches(x);
    if (!item.hidden) n += 1;
  }
  for (const sec of document.querySelectorAll(".cat-group")) sec.hidden = !sec.querySelector(".cat-item:not([hidden])");
  document.getElementById("src-count").textContent = t("sources.showing", { n: fmtNumber(n, 0), all: fmtNumber(SOURCES.length, 0) });
  const act = document.getElementById("src-active");
  act.hidden = !state.umbrella && !state.use;
  if (!act.hidden) {
    const x = h("button", { type: "button", "aria-label": t("sources.clear"), text: "×" });
    x.addEventListener("click", () => select(null, null));
    act.replaceChildren(h("span", { text: [state.umbrella && t(`sources.u_${state.umbrella}`), state.use && t(`sources.use_${state.use}`)].filter(Boolean).join(" × ") }), x);
  }
}

function select(umbrella, use) {
  state.umbrella = umbrella;
  state.use = use;
  matrix(document.getElementById("src-matrix"));
  detail(document.getElementById("web-detail"));
  applyFilter();
}

async function main() {
  const lang = new URLSearchParams(location.search).get("lang") ?? "en";
  await loadLocale(lang);
  document.documentElement.lang = language();
  document.title = t("sources.page_title");
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
  const papers = SOURCES.filter((x) => x.umbrella === "science").length;
  const openLic = SOURCES.filter((x) => /Open|CC|public domain|ODbL|Free|CC0/i.test(x.licence)).length;
  document.getElementById("src-stats").replaceChildren(
    ...[[SOURCES.length, "sources.stat_sources"], [UMBRELLAS.length, "sources.stat_umbrellas"], [papers, "sources.stat_papers"], [openLic, "sources.stat_open"]].map(([n, k]) => h("li", {}, h("b", { text: fmtNumber(n, 0) }), h("span", { text: t(k) }))),
  );
  document.getElementById("cat-uses-h").replaceChildren(h("b", { text: t("sources.col_uses") }), h("span", { class: "uses key" }, ...USES.map((u) => h("i", { class: `on use-${u}`, title: t(`sources.use_${u}`) }))));
  document.getElementById("src-list").replaceChildren(
    ...byUmbrella(SOURCES).map(({ umbrella: um, list }) =>
      h(
        "section",
        { class: "cat-group", id: `u-${um.id}`, style: `--c:${um.colour}` },
        h("header", { class: "cat-group-h" }, pennant(um.colour), h("h2", { text: t(`sources.u_${um.id}`) }), h("span", { class: "cat-n", text: fmtNumber(list.length, 0) }), h("p", { text: t(`sources.u_${um.id}_d`) })),
        ...list.map(row),
      ),
    ),
  );
  const search = document.getElementById("src-search");
  search.addEventListener("input", () => {
    state.q = search.value.trim().toLowerCase();
    applyFilter();
  });
  select(null, null);
  // A link from the app names a family (#u-…) or a source (#id): open it there.
  const hash = location.hash.slice(1);
  if (hash.startsWith("u-")) {
    select(hash.slice(2), null);
    document.getElementById(hash)?.scrollIntoView({ block: "start" });
  } else if (hash && hash !== "top") open(hash, true);
}

if (typeof document !== "undefined" && document.getElementById("src-list")) main();
