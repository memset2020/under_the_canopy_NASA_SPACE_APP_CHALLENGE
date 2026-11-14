// F15 sonification: hear the flood pulse. Pitch follows the hidden flood; a second,
// quieter voice follows what C-band saw, so the gap between them is audible.
import { h, icon } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate, fmtNumber } from "./i18n.js";

export const id = "sonify";
// In the timeline bar, next to Play: it plays the same season (docs/10 D-080).
export const slot = "map-bottom";

const LOW_HZ = 196; // G3
const HIGH_HZ = 784; // G5
const NOTE_S = 0.42;

export function init({ store, t, root }) {
  const label = h("span", { class: "btn-label", text: t("sonify.listen") });
  const btn = h("button", { type: "button", class: "btn icon-label-btn listen-btn", "aria-pressed": "false" }, icon("sound"), label);
  const live = h("span", { class: "sr-only", "aria-live": "polite" });
  root.append(btn, live);
  let audio = null;

  const pitch = (km2, max) => LOW_HZ * (HIGH_HZ / LOW_HZ) ** (max > 0 ? km2 / max : 0);

  function note(freq, gain, when, type) {
    const osc = audio.createOscillator();
    const g = audio.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, when + NOTE_S);
    osc.connect(g).connect(audio.destination);
    osc.start(when);
    osc.stop(when + NOTE_S + 0.05);
  }

  function playPass(site, i) {
    const passes = site.summary.passes;
    const max = Math.max(...passes.map((p) => p.flooded_km2));
    const p = passes[i];
    const now = audio.currentTime + 0.02;
    note(pitch(p.flooded_km2, max), 0.18, now, "sine");
    if (p.hidden_from_cband_km2 !== null) {
      note(pitch(p.flooded_km2 - p.hidden_from_cband_km2, max), 0.07, now, "triangle");
    }
    live.textContent = t("sonify.announce", { date: fmtDate(p.date), km2: fmtNumber(p.flooded_km2) });
  }

  btn.addEventListener("click", async () => {
    const on = !store.get().audio;
    if (on && !audio) {
      const Ctx = window.AudioContext ?? window.webkitAudioContext;
      if (!Ctx) {
        btn.disabled = true;
        btn.title = t("sonify.unsupported");
        return;
      }
      audio = new Ctx(); // created on a click, as browsers require
    }
    if (on) await audio.resume();
    store.set({ audio: on, playing: on ? true : store.get().playing });
  });

  watch(store, ["audio"], ({ audio: on }) => {
    btn.setAttribute("aria-pressed", String(Boolean(on)));
    label.textContent = t(on ? "sonify.stop" : "sonify.listen");
  });
  watch(store, ["passIndex"], ({ site, passIndex, audio: on }) => {
    if (on && audio && site) playPass(site, passIndex);
  });
}
