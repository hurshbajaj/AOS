
const BASE = "https://services.swpc.noaa.gov";
const GEOMAGNETIC = `${BASE}/text/daily-geomagnetic-indices.txt`;
const SOLAR = `${BASE}/text/daily-solar-indices.txt`;
const KP_NOW = `${BASE}/json/planetary_k_index_1m.json`;
const BAKED = "assets/data/kp-recent.json";
const TIMEOUT_MS = 12000;

const date = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

export function parseGeomagnetic(text) {
  const days = [];
  for (const line of text.split("\n")) {
    if (!/^\d{4}\s/.test(line)) {
      continue;
    }
    const f = line.trim().split(/\s+/);
    if (f.length < 30) {
      continue;
    }
    const kp = f.slice(-8).map(Number);
    if (kp.some((value) => !Number.isFinite(value) || value < 0)) {
      continue;
    }
    days.push({
      date: date(Number(f[0]), Number(f[1]), Number(f[2])),
      kpMax: Math.max(...kp),
      kpMean: mean(kp),
      ap: Number(f[f.length - 9]),
    });
  }
  return days;
}

export function parseSolar(text) {
  const days = [];
  for (const line of text.split("\n")) {
    if (!/^\d{4}\s/.test(line)) {
      continue;
    }
    const f = line.trim().split(/\s+/);
    if (f.length < 13) {
      continue;
    }
    const f107 = Number(f[3]);
    days.push({
      date: date(Number(f[0]), Number(f[1]), Number(f[2])),
      f107: f107 > 0 ? f107 : null,
      sunspots: Number(f[4]) >= 0 ? Number(f[4]) : null,
      flares: { c: Number(f[9]) || 0, m: Number(f[10]) || 0, x: Number(f[11]) || 0 },
    });
  }
  return days;
}

export function splice(baked, live) {
  const byDate = new Map(baked.map((day) => [day.date, { ...day }]));
  for (const day of live) {
    const existing = byDate.get(day.date) ?? { date: day.date };
    byDate.set(day.date, {
      ...existing,
      ...Object.fromEntries(Object.entries(day).filter(([, value]) => value !== null && value !== undefined)),
    });
  }
  return [...byDate.values()]
    .filter((day) => Number.isFinite(day.kpMax) && day.f107 !== null && day.f107 !== undefined)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function combine(geomagnetic, solar) {
  const bySolar = new Map(solar.map((day) => [day.date, day]));
  return geomagnetic.map((day) => ({ ...day, ...(bySolar.get(day.date) ?? {}) }));
}

async function get(url, parse) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${url} returned ${response.status}`);
    }
    return parse(await (parse === JSON.parse ? response.text() : response.text()));
  } finally {
    clearTimeout(timer);
  }
}

export async function current() {
  const notes = [];
  let baked = [];
  try {
    const response = await fetch(BAKED);
    baked = (await response.json()).days ?? [];
  } catch (error) {
    notes.push("no baked history");
  }

  let live = [];
  try {
    const [geomagnetic, solar] = await Promise.all([
      get(GEOMAGNETIC, parseGeomagnetic),
      get(SOLAR, parseSolar),
    ]);
    live = combine(geomagnetic, solar);
  } catch (error) {
    notes.push("NOAA unreachable");
  }

  let now = null;
  try {
    const rows = await get(KP_NOW, JSON.parse);
    const last = rows[rows.length - 1];
    now = { kp: Number(last.estimated_kp), at: `${last.time_tag}Z` };
  } catch (error) {
    notes.push("no live Kp");
  }

  const days = splice(baked, live);
  return {
    days,
    now,
    notes,
    live: live.length > 0,
    through: days.length ? days[days.length - 1].date : null,
    flares: live.length ? live[live.length - 1].flares ?? null : null,
  };
}
