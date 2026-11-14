// Label mode (task D-04): mark spots you can identify, then download them for
// `python cli.py calibrate --site <id>`. Labels stay in this browser until downloaded.
import { h } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate, fmtNumber } from "./i18n.js";
import { note } from "./readable.js";

export const id = "labels";
export const slot = "sidebar";

const CLASSES = ["flooded_veg", "open_water", "dry_veg", "dry_open", "built"];
const storageKey = (siteId) => `canopy-labels-${siteId}`;

function readStored(siteId) {
  try {
    return JSON.parse(localStorage.getItem(storageKey(siteId)) ?? "[]");
  } catch {
    return [];
  }
}

function writeStored(siteId, labels) {
  try {
    localStorage.setItem(storageKey(siteId), JSON.stringify(labels));
  } catch {
    // Private mode or blocked storage: labels still work for this session.
  }
}

export function init({ store, t, root }) {
  const toggle = h("button", { type: "button", class: "btn", "aria-pressed": "false", text: t("labels.start") });
  const help = note("info", t("labels.help"));
  const prompt = h("p", { class: "labels-prompt", "aria-live": "polite" });
  const choices = h(
    "div",
    { class: "labels-choices", role: "group", "aria-label": t("labels.choose") },
    CLASSES.map((c) => h("button", { type: "button", class: "btn btn-small", dataset: { label: c }, text: t(`labels.class_${c}`) })),
  );
  const summary = h("p", { class: "labels-summary" });
  const undo = h("button", { type: "button", class: "btn btn-small", text: t("labels.undo") });
  const clear = h("button", { type: "button", class: "btn btn-small", text: t("labels.clear") });
  const download = h("button", { type: "button", class: "btn btn-small btn-primary", text: t("labels.download") });
  const panel = h("div", { class: "labels-panel", hidden: true }, prompt, choices, summary, h("div", { class: "labels-actions" }, undo, clear, download));
  root.append(h("h2", { text: t("labels.title") }), help, toggle, panel);

  let labels = [];
  const site = () => store.get().site;

  function render() {
    const counts = Object.fromEntries(CLASSES.map((c) => [c, labels.filter((l) => l.label === c).length]));
    summary.textContent = labels.length
      ? t("labels.summary", { n: labels.length, detail: CLASSES.filter((c) => counts[c]).map((c) => `${t(`labels.class_${c}`)} ${counts[c]}`).join(", ") })
      : t("labels.none");
    undo.disabled = clear.disabled = download.disabled = !labels.length;
    const { selected, passIndex } = store.get();
    const s = site();
    choices.hidden = !selected;
    prompt.textContent = selected && s
      ? t("labels.prompt", { date: fmtDate(s.summary.passes[passIndex].date) })
      : t("labels.click_map");
  }

  function persist() {
    writeStored(store.get().siteId, labels);
    render();
  }

  toggle.addEventListener("click", () => {
    const on = toggle.getAttribute("aria-pressed") !== "true";
    toggle.setAttribute("aria-pressed", String(on));
    toggle.textContent = t(on ? "labels.stop" : "labels.start");
    panel.hidden = !on;
    render();
  });

  choices.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-label]");
    const { selected, passIndex } = store.get();
    const s = site();
    if (!btn || !selected || !s) return;
    const [lon, lat] = s.gridToLonLat(selected.row, selected.col);
    labels.push({
      pass_id: s.summary.passes[passIndex].id,
      date: s.summary.passes[passIndex].date,
      row: selected.row,
      col: selected.col,
      lon: Number(fmtNumber(lon, 5).replace(/,/g, "")),
      lat: Number(fmtNumber(lat, 5).replace(/,/g, "")),
      label: btn.dataset.label,
    });
    persist();
  });

  undo.addEventListener("click", () => {
    labels.pop();
    persist();
  });
  clear.addEventListener("click", () => {
    if (window.confirm(t("labels.clear_confirm"))) {
      labels = [];
      persist();
    }
  });
  download.addEventListener("click", () => {
    const s = site();
    const body = JSON.stringify({ site: s.summary.site.id, labels }, null, 1);
    const a = h("a", { href: URL.createObjectURL(new Blob([body], { type: "application/json" })), download: `${s.summary.site.id}.json` });
    document.body.append(a);
    a.click();
    a.remove();
  });

  watch(store, ["site"], ({ site: s, siteId }) => {
    root.hidden = !s;
    labels = s ? readStored(siteId) : [];
    render();
  });
  watch(store, ["selected", "passIndex"], () => render());
}
