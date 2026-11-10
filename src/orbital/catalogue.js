
import { PLATFORMS, sceneRadius } from "./data.js";

const SATELLITE = "https://esm.sh/satellite.js@5.0.0";
const CELESTRAK = "/api/catalogue";
const TIMEOUT_MS = 20000;

const GROUPS = [
  { group: "gps-ops", constellation: "gnss", limit: 32 },
  { group: "starlink", constellation: "mesh", limit: 80 },
  { group: "geo", constellation: "geo", limit: 14 },
];

function seeded(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

let library = null;

async function load() {
  if (!library) {
    library = await import(SATELLITE);
  }
  return library;
}

export function parseTle(text) {
  const lines = text.split("\n").map((line) => line.trimEnd());
  const sets = [];
  for (let i = 0; i + 2 < lines.length + 1; i += 1) {
    if (lines[i]?.startsWith("1 ") && lines[i + 1]?.startsWith("2 ")) {
      sets.push({ name: (lines[i - 1] ?? "").trim() || `NORAD ${lines[i].slice(2, 7)}`, one: lines[i], two: lines[i + 1] });
      i += 1;
    }
  }
  return sets;
}

export function sample(items, limit) {
  if (items.length <= limit) {
    return items;
  }
  const step = items.length / limit;
  return Array.from({ length: limit }, (_, i) => items[Math.floor(i * step)]);
}

const CACHE = "aos-catalogue-v1";

async function fetchGroup(group) {
  const url = `${CELESTRAK}/${group}`;
  const store = globalThis.caches ? await caches.open(CACHE).catch(() => null) : null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (response.ok) {
      await store?.put(url, response.clone()).catch(() => {});
      return parseTle(await response.text());
    }
    const held = await store?.match(url);
    if (held) {
      return parseTle(await held.text());
    }
    throw new Error(`CelesTrak returned ${response.status} for ${group}`);
  } catch (error) {
    const held = await store?.match(url);
    if (held) {
      return parseTle(await held.text());
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchFleet() {
  const { twoline2satrec } = await load();
  const fleet = [];
  const counts = {};

  const groups = await Promise.all(GROUPS.map((spec) => fetchGroup(spec.group).catch(() => null)));
  groups.forEach((sets, index) => {
    if (!sets) {
      return;
    }
    const spec = GROUPS[index];
    const chosen = sample(sets, spec.limit);
    counts[spec.constellation] = chosen.length;
    for (const set of chosen) {
      const satrec = twoline2satrec(set.one, set.two);
      if (!satrec || satrec.error) {
        continue;
      }
      const noradId = String(satrec.satnum).padStart(5, "0");
      const roll = seeded(Number(satrec.satnum) || 1);
      const nav = spec.constellation === "gnss";
      const budget = nav ? 48 + roll() * 34 : 12 + roll() * 20;
      fleet.push({
        id: `${spec.constellation}-${noradId}`,
        noradId,
        name: set.name,
        constellation: spec.constellation,
        satrec,
        tle: [set.one, set.two],
        period: (2 * Math.PI) / satrec.no / 60 * 3600,
        inclination: (satrec.inclo * 180) / Math.PI,
        eccentricity: satrec.ecco,
        platform: PLATFORMS[nav ? "nav" : "comms"],
        deltaVBudget: budget,
        deltaVSpent: budget * roll() * 0.55,
        powerMargin: 0.38 + roll() * 0.5,
        modelled: ["deltaVBudget", "deltaVSpent", "powerMargin"],
        source: "catalogue",
        status: "nominal",
        health: 1,
      });
    }
  });

  if (!fleet.length) {
    throw new Error("no usable elements");
  }
  return { fleet, counts, fetched: new Date().toISOString() };
}

export const SCREENING_GROUPS = [
  { group: "cosmos-2251-debris", label: "Cosmos 2251 debris" },
  { group: "fengyun-1c-debris", label: "Fengyun-1C debris" },
  { group: "iridium-33-debris", label: "Iridium 33 debris" },
  { group: "active", label: "Active satellites" },
];

export async function fetchScreeningSet(onProgress = () => {}) {
  const objects = [];
  const sources = [];
  for (const spec of SCREENING_GROUPS) {
    onProgress({ stage: "fetch", group: spec.label });
    const sets = await fetchGroup(spec.group).catch(() => null);
    if (!sets?.length) {
      sources.push({ ...spec, n: 0, ok: false });
      continue;
    }
    for (const set of sets) {
      objects.push({ name: set.name, tle: [set.one, set.two], group: spec.group });
    }
    sources.push({ ...spec, n: sets.length, ok: true });
  }
  return { objects, sources };
}

export function propagateAt(satellite, date, { gstime, propagate, eciToGeodetic }) {
  const state = propagate(satellite.satrec, date);
  if (!state?.position) {
    return null;
  }
  const geodetic = eciToGeodetic(state.position, gstime(date));
  const latitude = (geodetic.latitude * 180) / Math.PI;
  const longitude = (((geodetic.longitude * 180) / Math.PI + 540) % 360) - 180;
  return {
    latitude,
    longitude,
    altitudeKm: geodetic.height,
    radius: sceneRadius(geodetic.height),
    velocityKms: state.velocity ? Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z) : null,
  };
}

export async function propagator() {
  const { gstime, propagate, eciToGeodetic } = await load();
  return { gstime, propagate, eciToGeodetic };
}
