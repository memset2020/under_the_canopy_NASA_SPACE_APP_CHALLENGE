// Header pill: when NISAR is next due over this place, predicted from the site's last pass and the
// 12-day exact repeat. It is that pass's track only (other tracks may image the place in between),
// and a prediction, not a published schedule. The clock time is the granule's own time stamp;
// without one only the date is claimed. Clicking shows the track on the map (store.showOrbit,
// drawn by orbits.js) where the map can draw it.
import { h, s } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate, fmtNumber } from "./i18n.js";
import { NISAR_ALT_KM, NISAR_REPEAT_DAYS, passCountdown } from "./orbitmath.js";

export const id = "overpass";
export const slot = "header";

// orbits.js draws the track in these modes only; elsewhere the pill would point at nothing.
const MODES = ["site", "world"];
const TICK_MS = 30000; // the pill shows minutes at most

export function init({ store, t, root }) {
  const timer = h("span", { class: "overpass-timer" });
  const badge = h("span", { class: "overpass-track-tag" });
  const pill = h(
    "button",
    { type: "button", class: "overpass-chip", id: "overpass-chip" },
    h("span", { class: "overpass-pulse-dot", "aria-hidden": "true" }),
    s(
      "svg",
      { class: "overpass-icon", viewBox: "0 0 24 24", width: "15", height: "15", "aria-hidden": "true" },
      s("path", { d: "M9 9l6 6", stroke: "currentColor", "stroke-width": "1.5" }),
      s("rect", { x: "8.5", y: "8.5", width: "7", height: "7", rx: "1.5", transform: "rotate(45 12 12)", fill: "currentColor" }),
      s("path", { d: "M3 7l4-4 3 3-4 4zM21 17l-4 4-3-3 4-4z", fill: "currentColor" }),
      s("path", { d: "M17.5 3.5a3 3 0 0 1 3 3", fill: "none", stroke: "currentColor", "stroke-width": "1.5" }),
    ),
    h("span", { class: "overpass-content" }, h("span", { class: "overpass-tag", text: t("overpass.label") }), timer),
    badge,
  );
  root.replaceChildren(pill);

  // The track can be drawn only with NASA's tiles (online, NISAR in the GIBS catalogue).
  const canDraw = (st) => Boolean(st.online && st.gibs?.orbits?.some((o) => o.key === "nisar"));

  function when(c) {
    if (!c.timeKnown) return c.isToday ? t("overpass.today") : t("overpass.on_date", { date: fmtDate(c.targetIso, "short") });
    if (c.days > 0) return t("overpass.next_days", { days: fmtNumber(c.days, 0), hours: fmtNumber(c.hours, 0) });
    if (c.hours > 0) return t("overpass.next_hours", { hours: fmtNumber(c.hours, 0), mins: fmtNumber(c.minutes, 0) });
    return t("overpass.next_mins", { mins: fmtNumber(Math.max(1, c.minutes), 0) });
  }

  function update() {
    const st = store.get();
    pill.hidden = !MODES.includes(st.mode);
    if (pill.hidden) return;
    const drawable = canDraw(st);
    // Not disabled when it cannot draw: the countdown still reads (and its tooltip shows) offline.
    if (drawable) pill.setAttribute("aria-pressed", String(Boolean(st.showOrbit)));
    else pill.removeAttribute("aria-pressed");
    pill.classList.toggle("is-active", drawable && Boolean(st.showOrbit));
    const hint = drawable ? ` ${t("overpass.toggle_track")}` : "";

    const summary = st.mode === "site" ? st.site?.summary : null;
    const last = summary?.passes?.at(-1);
    const c = last ? passCountdown(last.date, Date.now(), last.acquired_utc) : null;
    if (!c) {
      timer.textContent = t("overpass.world_active", { days: fmtNumber(NISAR_REPEAT_DAYS, 0) });
      badge.textContent = t("overpass.alt_badge", { km: fmtNumber(NISAR_ALT_KM, 0) });
      pill.title = t("overpass.title_world", { days: fmtNumber(NISAR_REPEAT_DAYS, 0), km: fmtNumber(NISAR_ALT_KM, 0) }) + hint;
      pill.setAttribute("aria-label", pill.title);
      return;
    }
    const track = summary.track?.number;
    timer.textContent = when(c);
    badge.textContent = track ? t("overpass.track_badge", { track }) : "";
    const parts = {
      date: fmtDate(c.targetIso),
      time: c.timeKnown ? new Date(c.targetMs).toISOString().slice(11, 16) : "",
      last: fmtDate(last.date),
      track: track ?? "?",
      dir: summary.track?.direction ? t(`orbits.dir_${summary.track.direction}`) : "",
      days: fmtNumber(NISAR_REPEAT_DAYS, 0),
    };
    pill.title = t(c.timeKnown ? "overpass.title_time" : "overpass.title_date", parts) + hint;
    pill.setAttribute("aria-label", `${t("overpass.label")}: ${timer.textContent}. ${pill.title}`);
  }

  pill.addEventListener("click", () => {
    if (canDraw(store.get())) store.set({ showOrbit: !store.get().showOrbit });
  });
  watch(store, ["site", "mode", "showOrbit", "online", "gibs"], update);
  setInterval(update, TICK_MS);
}
