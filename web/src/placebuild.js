// Analyse here (F36). Named placebuild.js: uBlock Origin's lists block a file called
// "analyse.js" (D-058). When the app is served by `python cli.py serve` on this machine, build a
// detailed hidden-flood map for the picked place. The local server is the only API this
// ever calls (docs/10 D-055); on GitHub Pages /api is absent and the card stays hidden.
import { h } from "./svg.js";
import { watch } from "./state.js";
import { fmtNumber } from "./i18n.js";

export const id = "placebuild";
export const slot = "sidebar";

const POLL_MS = 5000;

export function init({ store, t, root }) {
  const where = h("p", { class: "analyse-where" });
  const start = h("button", { type: "button", class: "btn btn-primary", text: t("analyse.start") });
  const status = h("p", { class: "analyse-status", "aria-live": "polite" });
  const log = h("pre", { class: "analyse-log", hidden: true });
  const open = h("a", { class: "btn", hidden: true, text: t("analyse.open") });
  root.append(
    h("h2", { text: t("analyse.title") }),
    h("p", { class: "muted small", text: t("analyse.help") }),
    where,
    start,
    status,
    open,
    log,
  );
  root.hidden = true;
  let available = false;
  let timer = 0;

  // The local server marks its responses; static hosting never does. Read from the manifest
  // the app already loaded, so no extra request is made.
  watch(store, ["manifest"], ({ manifest }) => {
    available = Boolean(manifest?.localServer);
    render(store.get());
  });

  function render({ picked }) {
    root.hidden = !available || !picked;
    if (root.hidden) return;
    const lat = `${fmtNumber(Math.abs(picked.lat), 2)}°${picked.lat >= 0 ? "N" : "S"}`;
    const lon = `${fmtNumber(Math.abs(picked.lon), 2)}°${picked.lon >= 0 ? "E" : "W"}`;
    where.textContent = t("analyse.where", { lat, lon });
    const enough = (picked.nisarPasses ?? 0) >= 6;
    start.disabled = !enough || Boolean(timer);
    if (!timer) status.textContent = enough ? "" : t("analyse.no_passes");
  }

  async function poll(job) {
    try {
      const r = await fetch(`api/jobs/${job}`, { cache: "no-store" });
      const j = await r.json();
      log.hidden = !j.log?.length;
      log.textContent = (j.log ?? []).join("\n");
      if (j.status === "done") {
        clearInterval(timer);
        timer = 0;
        status.textContent = t("analyse.done");
        open.href = `?site=${encodeURIComponent(j.site_id)}`;
        open.hidden = false;
      } else if (j.status === "failed" || j.status === "no_coverage") {
        clearInterval(timer);
        timer = 0;
        status.textContent = t("analyse.failed", { why: j.message ?? j.status });
      } else {
        status.textContent = t("analyse.running", { step: j.step || "…" });
      }
    } catch {
      status.textContent = t("analyse.lost");
    }
    render(store.get());
  }

  start.addEventListener("click", async () => {
    const { picked } = store.get();
    if (!picked) return;
    open.hidden = true;
    status.textContent = t("analyse.starting");
    try {
      const r = await fetch("api/analyse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lon: picked.lon, lat: picked.lat }),
      });
      const j = await r.json();
      if (!r.ok) {
        status.textContent = t("analyse.failed", { why: j.error ?? r.status });
        return;
      }
      timer = setInterval(() => poll(j.job), POLL_MS);
      poll(j.job);
    } catch {
      status.textContent = t("analyse.lost");
    }
  });

  watch(store, ["picked"], render);
}
