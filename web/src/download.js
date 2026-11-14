// F11 open data: download what the map shows.
import { h } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate } from "./i18n.js";
import { note } from "./readable.js";
import { entryFor, loadNotebooks, notebookLinks } from "./notebook.js";

export const id = "download";
export const slot = "sidebar";

export function init({ store, t, root }) {
  const list = h("ul", { class: "downloads" });
  root.append(h("h2", { text: t("download.title") }), note("info", t("download.intro")), list);

  const link = (href, label, name) => h("li", {}, h("a", { href, download: name, text: label }));

  watch(store, ["site", "passIndex"], ({ site, passIndex }) => {
    root.hidden = !site;
    if (!site) return;
    const s = site.summary;
    const pass = s.passes[passIndex];
    const items = s.downloads.map((d) =>
      link(site.url(d.path), t(d.label_key), `${s.site.id}_${d.path.split("/").pop()}`),
    );
    items.push(
      link(site.url(pass.class_png), t("download.pass_png", { date: fmtDate(pass.date) }), `${s.site.id}_${pass.id}_flood.png`),
      link(site.url(s.products.hydroperiod.png), t("download.hydro_png"), `${s.site.id}_hydroperiod.png`),
      link(`${site.base}summary.json`, t("download.summary"), `${s.site.id}_summary.json`),
    );
    list.replaceChildren(...items);
    // This site's notebook in Colab, when one is published (data/notebooks.json, D-098).
    const kind = (store.get().manifest?.sites.find((e) => e.id === s.site.id)?.kind ?? "flood") === "fire" ? "fire" : "water";
    loadNotebooks(store.get().dataBase).then((index) => {
      if (store.get().site !== site || list.querySelector(".colab-run")) return;
      list.append(...notebookLinks(entryFor(index, kind, s.site.id), t, { asList: true }));
    });
  });
}
