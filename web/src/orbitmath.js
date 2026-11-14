// Geometry for satellite ground tracks (orbits.js): where a track passed a place, when, and the
// angle the side-looking radar saw it at. Pure functions; lon/lat in degrees, distances in km.

export const EARTH_KM = 6371.0;
export const NISAR_ALT_KM = 747; // NASA NISAR quick facts
export const NISAR_REPEAT_DAYS = 12;

const RAD = Math.PI / 180;

export function haversineKm([lon1, lat1], [lon2, lat2]) {
  const a = Math.sin(((lat2 - lat1) * RAD) / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(((lon2 - lon1) * RAD) / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Closest point to `p` on a polyline, in a local equirectangular frame around `p` (good to a
// few km over the ~1000 km scales that matter here). Returns { point, km, segment, t }.
export function closestOnLine(line, p) {
  const k = Math.cos(p[1] * RAD);
  const xy = ([lon, lat]) => [wrap(lon - p[0]) * k * 111.32, (lat - p[1]) * 111.32];
  let best = null;
  for (let i = 0; i + 1 < line.length; i += 1) {
    const [ax, ay] = xy(line[i]);
    const [bx, by] = xy(line[i + 1]);
    if (Math.abs(line[i + 1][0] - line[i][0]) > 180) continue; // a segment across the antimeridian
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const km = Math.hypot(cx, cy);
    if (!best || km < best.km) {
      const lon = line[i][0] + t * wrap(line[i + 1][0] - line[i][0]);
      const lat = line[i][1] + t * (line[i + 1][1] - line[i][1]);
      best = { point: [lon, lat], km, segment: i, t, east: cx < 0 };
    }
  }
  return best;
}

const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

// Incidence angle (degrees from the vertical at the ground) for a target `groundKm` from the
// ground track, spherical Earth: off-nadir look angle plus the Earth-centre angle.
export function incidenceDeg(groundKm, altKm = NISAR_ALT_KM) {
  const g = groundKm / EARTH_KM;
  const look = Math.atan2(EARTH_KM * Math.sin(g), EARTH_KM + altKm - EARTH_KM * Math.cos(g));
  return (look + g) / RAD;
}

// Next repeats of a 12-day exact-repeat orbit after `today` (ISO dates), from the last pass.
export function nextPasses(lastIso, todayIso, n = 3, repeatDays = NISAR_REPEAT_DAYS) {
  const day = 86400000;
  const last = Date.parse(`${lastIso}T00:00:00Z`);
  const today = Date.parse(`${todayIso}T00:00:00Z`);
  let k = Math.max(1, Math.ceil((today - last) / (repeatDays * day)));
  const out = [];
  while (out.length < n) {
    const t = last + k * repeatDays * day;
    if (t >= today) out.push(new Date(t).toISOString().slice(0, 10));
    k += 1;
  }
  return out;
}

// Time to the next repeat of the last pass, from `nowMs`. The clock time is the last granule's
// own time stamp (an exact-repeat orbit crosses the same place at the same time of day, to within
// minutes); without one only the date is known, `timeKnown` is false and the count stops at days.
// Returns { targetIso, targetMs, timeKnown, totalSec, days, hours, minutes, isToday } or null.
export function passCountdown(lastIso, nowMs = Date.now(), acquiredUtc = null, repeatDays = NISAR_REPEAT_DAYS) {
  if (!lastIso) return null;
  const todayIso = new Date(nowMs).toISOString().slice(0, 10);
  const time = /T(\d{2}:\d{2}:\d{2})/.exec(acquiredUtc ?? "")?.[1] ?? null;
  const [first, second] = nextPasses(lastIso, todayIso, 2, repeatDays);
  let targetIso = first;
  let targetMs = Date.parse(`${targetIso}T${time ?? "00:00:00"}Z`);
  // With a known time, a pass earlier today has gone: the next one is a repeat later.
  if (time && targetMs <= nowMs) {
    targetIso = second;
    targetMs = Date.parse(`${targetIso}T${time}Z`);
  }
  const totalSec = Math.max(0, Math.floor((targetMs - nowMs) / 1000));
  const days = time ? Math.floor(totalSec / 86400) : Math.round((Date.parse(`${targetIso}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86400000);
  return {
    targetIso,
    targetMs,
    timeKnown: Boolean(time),
    totalSec,
    days,
    hours: Math.floor((totalSec % 86400) / 3600),
    minutes: Math.floor((totalSec % 3600) / 60),
    isToday: targetIso === todayIso,
  };
}
