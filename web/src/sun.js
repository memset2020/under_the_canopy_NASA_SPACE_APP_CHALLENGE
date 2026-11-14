// The Sun at a moment (orbits.js): where it is overhead, the local solar time and its height above
// the horizon anywhere, and the line between day and night. NOAA's solar-calculator algorithm
// (after Meeus, Astronomical Algorithms), good to about 0.01° for 1800-2100; a spherical Earth and
// no refraction (the true sunset comes about 0.8° of sun height later). Pure functions; degrees, ms.

const RAD = Math.PI / 180;
const MERCATOR_LAT = 85.0511287798;
const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

// Declination, equation of time (minutes) and the subsolar point [lon, lat].
export function solarPosition(ms) {
  const T = (ms / 86400000 + 2440587.5 - 2451545) / 36525; // Julian centuries since J2000
  const L0 = (((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360) + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C =
    Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * M * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * RAD); // apparent longitude
  const eps = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60 + 0.00256 * Math.cos(omega * RAD);
  const declDeg = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) / RAD;
  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eqTimeMin =
    (4 / RAD) *
    (y * Math.sin(2 * L0 * RAD) -
      2 * e * Math.sin(M * RAD) +
      4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) -
      0.5 * y * y * Math.sin(4 * L0 * RAD) -
      1.25 * e * e * Math.sin(2 * M * RAD));
  const utcHours = ((ms / 3600000) % 24 + 24) % 24;
  // Overhead where the apparent solar time is noon.
  return { declDeg, eqTimeMin, subsolar: [wrapLon(15 * (12 - utcHours - eqTimeMin / 60)), declDeg] };
}

// Apparent local solar time (hours, 0-24) at a longitude.
export function localSolarHours(ms, lon) {
  const utcHours = ((ms / 3600000) % 24 + 24) % 24;
  return (((utcHours + lon / 15 + solarPosition(ms).eqTimeMin / 60) % 24) + 24) % 24;
}

// Height of the Sun's centre above the horizon (degrees; negative below).
export function sunElevationDeg(ms, [lon, lat]) {
  const { subsolar, declDeg } = solarPosition(ms);
  const H = (lon - subsolar[0]) * RAD;
  const s = Math.sin(lat * RAD) * Math.sin(declDeg * RAD) + Math.cos(lat * RAD) * Math.cos(declDeg * RAD) * Math.cos(H);
  return Math.asin(Math.max(-1, Math.min(1, s))) / RAD;
}

// The day-night line, west to east, clamped to the Web-Mercator latitude limit.
export function terminator(ms, stepDeg = 2) {
  const { subsolar, declDeg } = solarPosition(ms);
  // At an equinox the line is two meridians: keep the declination off zero so tan() stays finite.
  const d = (Math.sign(declDeg) || 1) * Math.max(Math.abs(declDeg), 1e-4) * RAD;
  const out = [];
  for (let lon = -180; lon <= 180 + 1e-9; lon += stepDeg) {
    const lat = Math.atan(-Math.cos((lon - subsolar[0]) * RAD) / Math.tan(d)) / RAD;
    out.push([lon, Math.max(-MERCATOR_LAT, Math.min(MERCATOR_LAT, lat))]);
  }
  return out;
}

// The night side as one closed ring: the line, closed along the pole that is in darkness
// (the south pole while the Sun is north of the equator, and the other way round).
export function nightRing(ms, stepDeg = 2) {
  const line = terminator(ms, stepDeg);
  const pole = solarPosition(ms).declDeg >= 0 ? -MERCATOR_LAT : MERCATOR_LAT;
  return [...line, [180, pole], [-180, pole], line[0]];
}
