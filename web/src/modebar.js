// The time bar under the map for the modes that are not a site (Ground, Ice): the same place
// and look as the site timeline (timeline.js, F01) — step buttons, the round play button, bars
// per step over a slider with its end dates, and the date shown — so play is in one place in
// every mode (owner's request; docs/10 D-089). The owner module feeds the steps and
// reacts to changes; this module only draws and plays.
import { h } from "./svg.js";

const STEP_MS = 900;

// ctx: { t, ariaLabel }. Returns { el, setSteps, setIndex, show, stop, onChange }.
export function createModeBar({ t, ariaLabel, stepMs = STEP_MS }) {
  const prev = h("button", { type: "button", class: "icon-btn", "aria-label": t("timeline.prev") }, "‹");
  const next = h("button", { type: "button", class: "icon-btn", "aria-label": t("timeline.next") }, "›");
  const play = h("button", { type: "button", class: "play-btn", "aria-pressed": "false", "aria-label": t("timeline.play") }, "▶");
  const range = h("input", { type: "range", min: "0", max: "0", step: "1", "aria-label": ariaLabel });
  const date = h("output", { class: "timeline-date", "aria-live": "polite" });
  const ends = h("div", { class: "timeline-ends", "aria-hidden": "true" });
  const bars = h("div", { class: "timeline-bars", "aria-hidden": "true" });
  const caption = h("p", { class: "timeline-caption" });
  const el = h(
    "section",
    { class: "timeline mode-timeline", hidden: true },
    h("div", { class: "timeline-controls" }, prev, play, next),
    h("div", { class: "timeline-track" }, bars, range, ends),
    h("div", { class: "timeline-now" }, date, caption),
  );
  let steps = []; // [{ label, short, caption, height (0-1) }]
  let index = 0;
  let timer = 0;
  const listeners = new Set();

  function emit() {
    for (const fn of listeners) fn(index);
  }
  function render() {
    const s = steps[index];
    range.value = String(index);
    range.setAttribute("aria-valuetext", s?.label ?? "");
    date.value = s?.label ?? "";
    caption.textContent = s?.caption ?? "";
    bars.querySelectorAll(".tbar").forEach((b, i) => b.classList.toggle("is-current", i === index));
  }
  function go(i, fromUser = true) {
    if (!steps.length) return;
    index = Math.max(0, Math.min(steps.length - 1, i));
    render();
    if (fromUser) emit();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = 0;
    play.setAttribute("aria-pressed", "false");
    play.textContent = "▶";
    play.setAttribute("aria-label", t("timeline.play"));
  }
  function start() {
    if (!steps.length) return;
    if (index >= steps.length - 1) go(0);
    play.setAttribute("aria-pressed", "true");
    play.textContent = "❚❚";
    play.setAttribute("aria-label", t("timeline.pause"));
    timer = setInterval(() => {
      if (index >= steps.length - 1) return stop();
      go(index + 1);
    }, stepMs);
  }

  prev.addEventListener("click", () => {
    stop();
    go(index - 1);
  });
  next.addEventListener("click", () => {
    stop();
    go(index + 1);
  });
  range.addEventListener("input", () => {
    stop();
    go(Number(range.value));
  });
  play.addEventListener("click", () => (timer ? stop() : start()));
  bars.addEventListener("click", (ev) => {
    const bar = ev.target.closest(".tbar");
    if (!bar) return;
    stop();
    go(Number(bar.dataset.index));
  });

  return {
    el,
    // New steps; keeps the index in range without telling the owner (it set them).
    setSteps(list, at = list.length - 1) {
      steps = list;
      range.max = String(Math.max(0, list.length - 1));
      bars.replaceChildren(
        ...list.map((s, i) =>
          h("div", { class: `tbar${s.kind ? ` tbar-${s.kind}` : ""}`, dataset: { index: String(i) }, title: s.label }, h("span", { class: "tbar-mode", style: `height:${Math.round(100 * Math.max(0.04, Math.min(1, s.height ?? 0.5)))}%` })),
        ),
      );
      ends.replaceChildren(h("span", { text: list[0]?.short ?? "" }), h("span", { text: list.at(-1)?.short ?? "" }));
      go(at, false);
    },
    setIndex(i) {
      go(i, false);
    },
    // Returns true when the bar appeared or went away (the map's height changed with it).
    show(on) {
      const changed = el.hidden === on;
      el.hidden = !on;
      if (!on) stop();
      return changed;
    },
    stop,
    onChange(fn) {
      listeners.add(fn);
    },
  };
}
