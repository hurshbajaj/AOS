import { CONSTELLATIONS, GROUND_STATIONS, buildFleet, sceneRadius } from "./data.js";
import { propagateAt } from "./catalogue.js";

const DEG = Math.PI / 180;
const ELEVATION_MASK = 10 * DEG;

export const HAZARD_LIMITS = {
  severity: [0, 1],
  radius: [0.1, 2],
  durationMin: [1, 10080],
  lat: [-90, 90],
  lon: [-180, 180],
};

const clamp = (value, [low, high]) => Math.max(low, Math.min(value, high));

function bound(patch) {
  const out = { ...patch };
  for (const [key, range] of Object.entries(HAZARD_LIMITS)) {
    if (Number.isFinite(out[key])) {
      out[key] = clamp(out[key], range);
    } else if (out[key] !== undefined) {
      delete out[key];
    }
  }
  return out;
}

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const length = (a) => Math.sqrt(dot(a, a));
const scale = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });

const norm = (x, y, z) => Math.sqrt(x * x + y * y + z * z);

function unitGap(point, centre, floor) {
  const radius = norm(point.x, point.y, point.z);
  const k = 1 / (floor ? Math.max(radius, 1e-6) : radius);
  return norm(point.x * k - centre.x, point.y * k - centre.y, point.z * k - centre.z);
}

const SEAM = { seam: true };
const byElevation = (x, y) => y.elevation - x.elevation;

function clearsEarth(a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const dd = abx * abx + aby * aby + abz * abz;
  const t = Math.min(Math.max(-(a.x * abx + a.y * aby + a.z * abz) / dd, 0), 1);
  return norm(a.x + abx * t, a.y + aby * t, a.z + abz * t) > 1.002;
}

export function geodetic(latDeg, lonDeg, radius = 1) {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  return {
    x: radius * Math.cos(lat) * Math.cos(lon),
    y: radius * Math.sin(lat),
    z: -radius * Math.cos(lat) * Math.sin(lon),
  };
}

function orbitalPosition(radius, inclinationDeg, raanDeg, uDeg) {
  const i = inclinationDeg * DEG;
  const o = raanDeg * DEG;
  const u = uDeg * DEG;
  const xp = radius * Math.cos(u);
  const yp = radius * Math.sin(u);
  const x1 = xp;
  const y1 = yp * Math.cos(i);
  const z1 = yp * Math.sin(i);
  return {
    x: x1 * Math.cos(o) - z1 * Math.sin(o),
    y: y1,
    z: x1 * Math.sin(o) + z1 * Math.cos(o),
  };
}

export const HAZARD_KINDS = {
  flare: {
    id: "flare",
    name: "Solar flare",
    glyph: "✸",
    colour: "#ffb067",
    affects: "link",
    unit: "X-class",
    defaults: { severity: 0.6, radius: 0.9, durationMin: 90 },
    blurb: "Ionospheric absorption and receiver desense across the sunlit hemisphere.",
  },
  storm: {
    id: "storm",
    name: "Geomagnetic storm",
    glyph: "≋",
    colour: "#7fd4ff",
    affects: "orbit",
    unit: "Kp",
    defaults: { severity: 0.5, radius: 1.3, durationMin: 720 },
    blurb: "Thermospheric expansion raises drag; low shells decay and ephemeris ages faster.",
  },
  debris: {
    id: "debris",
    name: "Debris conjunction",
    glyph: "✦",
    colour: "#ff7a7a",
    affects: "asset",
    unit: "Pc",
    defaults: { severity: 0.7, radius: 0.35, durationMin: 240 },
    blurb: "Tracked fragment cloud crossing the shell. Screening window is open.",
  },
  outage: {
    id: "outage",
    name: "Ground outage",
    glyph: "▣",
    colour: "#c9a6ff",
    affects: "ground",
    unit: "load",
    defaults: { severity: 0.8, radius: 0.5, durationMin: 180 },
    blurb: "Gateway offline. Feeder traffic must find another aperture.",
  },
  jam: {
    id: "jam",
    name: "RF interference",
    glyph: "⌁",
    colour: "#9dff8f",
    affects: "link",
    unit: "C/N0",
    defaults: { severity: 0.55, radius: 0.45, durationMin: 300 },
    blurb: "Uplink interference degrading navigation and feeder carriers over the footprint.",
  },
};

let hazardSeq = 0;

function nextLabel(hazards, name) {
  const taken = hazards.filter((hazard) => hazard.label === name || hazard.label.startsWith(`${name} (#`));
  if (!taken.length) {
    return name;
  }
  const highest = taken.reduce((best, hazard) => {
    const match = /\(#(\d+)\)$/.exec(hazard.label);
    return Math.max(best, match ? Number(match[1]) : 1);
  }, 1);
  return `${name} (#${highest + 1})`;
}

export class World extends EventTarget {
  #planeCache = null;
  #planeCacheFor = null;
  #visible = [];
  #meshPlanes = [];
  #inView = [];
  #inViewPool = [];
  #navScratch = [];
  #feederScratch = [];
  #centre = { x: 0, y: 0, z: 0 };
  #elevation = { elevation: 0 };

  constructor() {
    super();
    this.satellites = buildFleet();
    this.stations = GROUND_STATIONS.map((station) => ({
      ...station,
      position: geodetic(station.lat, station.lon, 1.004),
      online: true,
      load: 0,
    }));
    this.hazards = [];
    this.time = 0;
    this.rate = 1;
    this.epoch = Date.now();
    this.source = "modelled";
    this.propagator = null;
    this.filters = {
      constellations: new Set(Object.keys(CONSTELLATIONS)),
      links: new Set(["isl", "feeder", "nav"]),
      orbits: true,
      stations: true,
      density: 0.45,
    };
    this.links = [];
    this.tick(0);
  }

  at() {
    return new Date(this.epoch + this.time * 1000);
  }

  adopt({ fleet, propagator }) {
    if (!fleet?.length || !propagator) {
      return false;
    }
    this.satellites = fleet;
    this.propagator = propagator;
    this.source = "catalogue";
    this.filters.constellations = new Set(fleet.map((craft) => craft.constellation));
    this.tick(0);
    this.dispatchEvent(new CustomEvent("change", { detail: { what: "fleet" } }));
    return true;
  }

  get injected() {
    return this.hazards.filter((hazard) => hazard.origin === "injected");
  }

  addHazard({ kind, lat, lon, severity, radius, durationMin, origin = "injected", label, confidence = null }) {
    const spec = HAZARD_KINDS[kind];
    if (!spec) {
      throw new Error(`Unknown hazard kind: ${kind}`);
    }
    hazardSeq += 1;
    ({ lat, lon, severity, radius, durationMin } = bound({ lat, lon, severity, radius, durationMin }));
    const hazard = {
      id: `hz-${String(hazardSeq).padStart(3, "0")}`,
      kind,
      spec,
      label: label ?? nextLabel(this.hazards, spec.name),
      lat: lat ?? (Math.random() * 120 - 60),
      lon: lon ?? (Math.random() * 360 - 180),
      severity: severity ?? spec.defaults.severity,
      radius: radius ?? spec.defaults.radius,
      durationMin: durationMin ?? spec.defaults.durationMin,
      origin,
      confidence,
      startedAt: this.time,
    };
    hazard.centre = geodetic(hazard.lat, hazard.lon, 1);
    this.hazards.push(hazard);
    this.#changed("hazards");
    return hazard;
  }

  updateHazard(id, patch) {
    const hazard = this.hazards.find((item) => item.id === id);
    if (!hazard) {
      return null;
    }
    Object.assign(hazard, bound(patch));
    if (patch.lat !== undefined || patch.lon !== undefined) {
      hazard.centre = geodetic(hazard.lat, hazard.lon, 1);
    }
    this.#changed("hazards");
    return hazard;
  }

  removeHazard(id) {
    const before = this.hazards.length;
    this.hazards = this.hazards.filter((item) => item.id !== id);
    if (this.hazards.length !== before) {
      this.#changed("hazards");
    }
  }

  setFilter(patch) {
    Object.assign(this.filters, patch);
    this.#changed("filters");
  }

  tick(dt) {
    this.time += dt * this.rate;
    const now = this.propagator ? this.at() : null;
    for (const satellite of this.satellites) {
      if (satellite.satrec && now) {
        const state = propagateAt(satellite, now, this.propagator);
        if (state) {
          satellite.latitude = state.latitude;
          satellite.longitude = state.longitude;
          satellite.altitudeKm = state.altitudeKm;
          satellite.radius = state.radius;
          satellite.speedKms = state.velocityKms;
          satellite.position = geodetic(state.latitude, state.longitude, state.radius);
        }
      } else {
        const sweep = (this.time / satellite.period) * 360;
        satellite.u = satellite.phase + sweep;
        satellite.position = orbitalPosition(satellite.radius, satellite.inclination, satellite.raan, satellite.u);
      }
      satellite.status = "nominal";
      satellite.health = 1;
    }
    this.#applyHazards();
    this.#buildLinks();
  }

  #applyHazards() {
    for (const station of this.stations) {
      station.online = true;
    }
    for (const hazard of this.hazards) {
      if (hazard.spec.affects === "ground") {
        const centre = hazard.centre;
        for (const station of this.stations) {
          const p = station.position;
          if (norm(p.x - centre.x, p.y - centre.y, p.z - centre.z) < hazard.radius) {
            station.online = false;
          }
        }
        continue;
      }
      if (hazard.spec.affects !== "asset" && hazard.spec.affects !== "orbit") {
        continue;
      }
      for (const satellite of this.satellites) {
        if (unitGap(satellite.position, hazard.centre, false) < hazard.radius) {
          satellite.health = Math.min(satellite.health, 1 - hazard.severity);
          satellite.status = hazard.spec.affects === "asset" ? "at risk" : "degraded";
        }
      }
    }
  }

  #hazardPenalty(point) {
    let penalty = 0;
    for (const hazard of this.hazards) {
      if (hazard.spec.affects === "asset") {
        continue;
      }
      const reach = hazard.radius * (hazard.spec.affects === "link" ? 1.25 : 1);
      const distance = unitGap(point, hazard.centre, true);
      if (distance < reach) {
        penalty = Math.max(penalty, hazard.severity * (1 - distance / reach));
      }
    }
    return penalty;
  }

  #clearsEarth(a, b) {
    return clearsEarth(a, b);
  }

  #planeGroups() {
    if (this.#planeCache && this.#planeCacheFor === this.satellites) {
      return this.#planeCache;
    }
    const byPlane = new Map();
    for (const satellite of this.satellites) {
      const key = `${satellite.constellation}-${satellite.plane}`;
      let ring = byPlane.get(key);
      if (!ring) {
        ring = [];
        byPlane.set(key, ring);
      }
      ring.push(satellite);
    }
    const groups = [];
    for (const [key, ring] of byPlane) {
      groups.push({
        key,
        constellation: ring[0].constellation,
        mesh: key.startsWith("mesh"),
        ring: [...ring].sort((x, y) => x.slot - y.slot),
      });
    }
    this.#planeCache = groups;
    this.#planeCacheFor = this.satellites;
    return groups;
  }

  #buildLinks() {
    const { constellations, links: kinds, density } = this.filters;
    const out = [];
    const visible = this.#visible;
    visible.length = 0;
    for (const satellite of this.satellites) {
      if (constellations.has(satellite.constellation)) {
        visible.push(satellite);
      }
    }
    const groups = this.#planeGroups();

    const push = (kind, a, b, extra) => {
      const pa = a.position;
      const pb = b.position;
      const centre = this.#centre;
      centre.x = (pa.x + pb.x) / 2;
      centre.y = (pa.y + pb.y) / 2;
      centre.z = (pa.z + pb.z) / 2;
      const penalty = this.hazards.length ? this.#hazardPenalty(centre) : 0;
      const link = {
        kind,
        a,
        b,
        quality: Math.max(0, 1 - penalty),
        degraded: penalty > 0.15,
      };
      if (extra) {
        Object.assign(link, extra);
      }
      out.push(link);
    };

    if (kinds.has("isl")) {
      for (const group of groups) {
        if (!constellations.has(group.constellation)) {
          continue;
        }
        const ordered = group.ring;
        for (let index = 0; index < ordered.length; index += 1) {
          const a = ordered[index];
          const b = ordered[(index + 1) % ordered.length];
          if (ordered.length > 2 && clearsEarth(a.position, b.position)) {
            push("isl", a, b);
          }
        }
      }
      const planes = this.#meshPlanes;
      planes.length = 0;
      for (const group of groups) {
        if (group.mesh && constellations.has(group.constellation)) {
          planes.push(group);
        }
      }
      for (let index = 0; index < planes.length; index += 1) {
        const here = planes[index].ring;
        const next = planes[(index + 1) % planes.length].ring;
        const span = Math.max(1, Math.round(here.length * density));
        for (let k = 0; k < span; k += 1) {
          const a = here[Math.floor((k / span) * here.length)];
          const ap = a.position;
          let pick = null;
          let best = 0;
          for (const candidate of next) {
            const cp = candidate.position;
            const d = norm(cp.x - ap.x, cp.y - ap.y, cp.z - ap.z);
            if (!pick || d < best) {
              pick = candidate;
              best = d;
            }
          }
          if (pick && clearsEarth(ap, pick.position)) {
            push("isl", a, pick, SEAM);
          }
        }
      }
    }

    if (kinds.has("feeder") || kinds.has("nav")) {
      const wantNav = kinds.has("nav");
      const wantFeeder = kinds.has("feeder");
      const inView = this.#inView;
      const pool = this.#inViewPool;
      const navLinks = this.#navScratch;
      const feeders = this.#feederScratch;
      const feederCap = Math.max(1, Math.round(4 * density));

      for (const station of this.stations) {
        if (!station.online) {
          continue;
        }
        const sp = station.position;
        const k = 1 / norm(sp.x, sp.y, sp.z);
        const ux = sp.x * k;
        const uy = sp.y * k;
        const uz = sp.z * k;

        inView.length = 0;
        let used = 0;
        for (const satellite of visible) {
          const p = satellite.position;
          const tx = p.x - sp.x;
          const ty = p.y - sp.y;
          const tz = p.z - sp.z;
          const elevation = Math.asin((tx * ux + ty * uy + tz * uz) / norm(tx, ty, tz));
          if (elevation > ELEVATION_MASK) {
            let slot = pool[used];
            if (!slot) {
              slot = { satellite: null, elevation: 0 };
              pool[used] = slot;
            }
            slot.satellite = satellite;
            slot.elevation = elevation;
            used += 1;
            inView.push(slot);
          }
        }
        inView.sort(byElevation);

        navLinks.length = 0;
        feeders.length = 0;
        for (const entry of inView) {
          if (entry.satellite.constellation === "gnss") {
            if (navLinks.length < 4) {
              navLinks.push(entry);
            }
          } else if (feeders.length < feederCap) {
            feeders.push(entry);
          }
        }

        if (wantNav) {
          for (const entry of navLinks) {
            this.#elevation.elevation = entry.elevation;
            push("nav", entry.satellite, station, this.#elevation);
          }
        }
        if (wantFeeder) {
          for (const entry of feeders) {
            this.#elevation.elevation = entry.elevation;
            push("feeder", entry.satellite, station, this.#elevation);
          }
        }
        station.load = feeders.length;
      }
    }

    this.links = out;
  }

  summary() {
    const total = this.links.length;
    const degraded = this.links.filter((link) => link.degraded).length;
    const atRisk = this.satellites.filter((satellite) => satellite.status !== "nominal").length;
    const offline = this.stations.filter((station) => !station.online).length;
    const navFixes = this.stations.filter((station) => station.online).map((station) => this.links.filter((link) => link.kind === "nav" && link.b === station).length);
    const solvable = navFixes.filter((count) => count >= 4).length;
    return {
      total,
      degraded,
      atRisk,
      offline,
      navCoverage: navFixes.length ? solvable / navFixes.length : 0,
      capacity: total ? this.links.reduce((sum, link) => sum + link.quality, 0) / total : 0,
    };
  }

  #changed(what) {
    this.dispatchEvent(new CustomEvent("change", { detail: { what } }));
  }
}
