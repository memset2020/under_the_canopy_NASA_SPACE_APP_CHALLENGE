// The project's notebooks, one per site, event and glacier, in Google Colab (docs/10 D-098).
// data/notebooks.json is written by notebooks/sync_to_drive.py when the notebooks are published;
// the app only reads that file and links out, so nothing is fetched from elsewhere (rule 5). A
// place without a published notebook simply shows no link.
import { h } from "./svg.js";

const cache = new Map();

export function loadNotebooks(base = "data/") {
  // Notebooks are built from the real published data only: the simulator's sites reuse real names,
  // and a real notebook beside synthetic data would pass one off as the other (CLAUDE.md rule 3).
  if (base !== "data/") return Promise.resolve(null);
  if (!cache.has(base)) {
    cache.set(
      base,
      fetch(`${base}notebooks.json`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    );
  }
  return cache.get(base);
}

// The entry for one place: kind is "water", "fire", "ground" or "ice".
export function entryFor(index, kind, id) {
  return index?.notebooks?.[`${kind}/${id}`] ?? null;
}

// "Run in Colab" and "Download (.ipynb)" for one entry, as list items or inline links.
export function notebookLinks(entry, t, { asList = false } = {}) {
  if (!entry) return [];
  const out = (href, cls, key, title) =>
    h("a", { href, target: "_blank", rel: "noopener noreferrer", class: cls, title: title ? t(title) : undefined, text: t(key) });
  const links = [
    out(entry.colab, "colab-run", "notebook.run", "download.colab_hint"),
    out(entry.download, "notebook-file", "notebook.file"),
  ];
  return asList ? links.map((a) => h("li", {}, a)) : links;
}

// Fill `el` with this place's notebook links (or hide it), whenever the place changes.
export async function showNotebook(el, base, kind, id, t) {
  el.dataset.place = `${kind}/${id}`;
  const entry = entryFor(await loadNotebooks(base), kind, id);
  if (el.dataset.place !== `${kind}/${id}`) return; // the place changed while the index loaded
  el.replaceChildren(...notebookLinks(entry, t));
  el.hidden = !entry;
}
