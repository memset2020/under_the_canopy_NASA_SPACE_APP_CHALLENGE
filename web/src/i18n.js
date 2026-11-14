// Every user-facing string goes through t() (CLAUDE.md rule 7).

export const LANGUAGES = ["en", "bn", "pt"];
let dict = {};
let lang = "en";
const warned = new Set();

export function setDictionary(entries, language = "en") {
  dict = { ...entries };
  lang = language;
}

// English is always loaded underneath, so a missing translation shows English, not a key.
export async function loadLocale(language = "en", fetchFn = fetch, base = "i18n/") {
  const get = async (code) => {
    const res = await fetchFn(`${base}${code}.json`);
    if (!res.ok) throw new Error(`locale ${code}: HTTP ${res.status}`);
    return res.json();
  };
  const en = await get("en");
  let extra = {};
  if (language !== "en") {
    try {
      extra = await get(language);
    } catch {
      language = "en"; // an unavailable language falls back to English
    }
  }
  setDictionary({ ...en, ...extra }, language);
  return dict;
}

// t("common.km2", { v: "12.3" }) → "12.3 km²"; a missing key returns the key.
export function t(key, params = {}) {
  const template = dict[key];
  if (template === undefined) {
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(`i18n: missing key ${key}`);
    }
    return key;
  }
  return template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}

export function has(key) {
  return key in dict;
}

export function language() {
  return lang;
}

export function fmtNumber(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return t("common.none");
  return new Intl.NumberFormat(lang, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

// Years without digit grouping, in the language's digits: "2021", "২০২১".
export function fmtYear(year) {
  return new Intl.NumberFormat(lang, { useGrouping: false }).format(year);
}

// Modelled totals (people, areas summed over 28 km cells) to two significant figures:
// "49,000,000", not "49,032,395", which would claim a precision the inputs do not have.
export function fmtApprox(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return t("common.none");
  const a = Math.abs(value);
  if (a < 100) return fmtNumber(value, 0);
  const step = 10 ** (Math.floor(Math.log10(a)) - 1);
  return fmtNumber(Math.round(value / step) * step, 0);
}

export function fmtDate(iso, style = "medium") {
  if (!iso) return t("common.none");
  const d = new Date(`${iso}T00:00:00Z`);
  const opts =
    style === "short"
      ? { day: "numeric", month: "short", timeZone: "UTC" }
      : style === "month"
        ? { month: "long", year: "numeric", timeZone: "UTC" }
        : { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" };
  return new Intl.DateTimeFormat(lang, opts).format(d);
}
