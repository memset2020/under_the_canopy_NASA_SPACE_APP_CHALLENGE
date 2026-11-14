// Collapsible cards: the sidebar holds many cards, so each gets a small toggle at its top-right
// and the sidebar a "collapse all / expand all" pair. A separate button, not the heading itself,
// because several modules rewrite their own titles. Kept per browser (try/catch: storage can fail).
import { h } from "./svg.js";

export const id = "cards";
export const slot = "sidebar";

const KEY = "utc.collapsed";

function load() {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

function save(set) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...set]));
  } catch {
    // private window or blocked storage: the choice is simply not kept
  }
}

export function init({ t, root }) {
  root.hidden = true;
  const sidebar = root.parentElement;
  const collapsed = load();
  const all = () => [...sidebar.querySelectorAll(":scope > .feature")].filter((sec) => sec.dataset.feature !== "cards" && sec.querySelector(":scope > h2"));

  function setState(sec, closed) {
    sec.classList.toggle("is-collapsed", closed);
    const btn = sec.querySelector(":scope > .card-toggle");
    if (btn) {
      btn.setAttribute("aria-expanded", String(!closed));
      btn.setAttribute("aria-label", t(closed ? "cards.expand" : "cards.collapse", { title: sec.querySelector(":scope > h2")?.textContent ?? "" }));
    }
  }

  for (const sec of all()) {
    const btn = h("button", { type: "button", class: "card-toggle" });
    btn.addEventListener("click", () => {
      const closed = !sec.classList.contains("is-collapsed");
      setState(sec, closed);
      if (closed) collapsed.add(sec.dataset.feature);
      else collapsed.delete(sec.dataset.feature);
      save(collapsed);
    });
    sec.prepend(btn);
    setState(sec, collapsed.has(sec.dataset.feature));
  }

  const collapseAll = h("button", { type: "button", class: "btn btn-small", text: t("cards.collapse_all") });
  const expandAll = h("button", { type: "button", class: "btn btn-small", text: t("cards.expand_all") });
  const bar = h("div", { class: "cards-bar" }, collapseAll, expandAll);
  sidebar.prepend(bar);
  const visible = () => all().filter((sec) => !sec.hidden && getComputedStyle(sec).display !== "none");
  collapseAll.addEventListener("click", () => {
    for (const sec of visible()) {
      setState(sec, true);
      collapsed.add(sec.dataset.feature);
    }
    save(collapsed);
  });
  expandAll.addEventListener("click", () => {
    for (const sec of visible()) {
      setState(sec, false);
      collapsed.delete(sec.dataset.feature);
    }
    save(collapsed);
  });
}
