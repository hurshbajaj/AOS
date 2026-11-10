
import { HAZARD_KINDS } from "./world.js";

const PLACES = {
  "north atlantic": [48, -35],
  atlantic: [12, -30],
  "south atlantic": [-30, -15],
  pacific: [5, -150],
  "north pacific": [38, -170],
  "south pacific": [-28, -130],
  "indian ocean": [-12, 78],
  arctic: [78, 10],
  antarctic: [-72, 20],
  europe: [50, 10],
  africa: [2, 20],
  asia: [35, 95],
  india: [21, 79],
  "south asia": [21, 79],
  america: [39, -98],
  "north america": [45, -100],
  "south america": [-14, -58],
  australia: [-25, 134],
  japan: [36, 138],
  equator: [0, 0],
  poles: [85, 0],
};

export function createTools(world, globe) {
  return {
    list_hazard_kinds: () => Object.values(HAZARD_KINDS).map(({ id, name, unit, affects }) => ({ id, name, unit, affects })),

    inject_hazard: ({ kind, lat, lon, severity, radius, durationMin, label }) =>
      world.addHazard({ kind, lat, lon, severity, radius, durationMin, label, origin: "injected" }),

    update_hazard: ({ id, ...patch }) => world.updateHazard(id, patch),

    clear_hazard: ({ id }) => {
      world.removeHazard(id);
      return { id, cleared: true };
    },

    list_hazards: () =>
      world.hazards.map(({ id, kind, label, severity, lat, lon, origin }) => ({ id, kind, label, severity, lat, lon, origin })),

    network_summary: () => world.summary(),

    query_satellite: ({ id }) => {
      const satellite = world.satellites.find((item) => item.id === id);
      if (!satellite) {
        return null;
      }
      return {
        id: satellite.id,
        constellation: satellite.constellation,
        status: satellite.status,
        altitudeKm: satellite.altitudeKm,
        deltaVRemaining: satellite.deltaVBudget - satellite.deltaVSpent,
        links: world.links.filter((link) => link.a === satellite || link.b === satellite).length,
      };
    },

    worst_affected: ({ limit = 5 } = {}) =>
      world.satellites
        .filter((satellite) => satellite.status !== "nominal")
        .sort((a, b) => a.health - b.health)
        .slice(0, limit)
        .map(({ id, status, health }) => ({ id, status, health })),

    focus_satellite: ({ id }) => {
      const satellite = world.satellites.find((item) => item.id === id);
      if (satellite) {
        globe.select(satellite);
      }
      return satellite ? { focused: satellite.id } : null;
    },
  };
}

function findKind(text) {
  if (/flare|solar/.test(text)) return "flare";
  if (/storm|geomag|kp|drag/.test(text)) return "storm";
  if (/debris|conjunction|collision|fragment/.test(text)) return "debris";
  if (/outage|gateway|ground station down|station down/.test(text)) return "outage";
  if (/jam|interfer|rf|spoof/.test(text)) return "jam";
  return null;
}

function findPlace(text) {
  const match = Object.keys(PLACES)
    .sort((a, b) => b.length - a.length)
    .find((name) => text.includes(name));
  return match ? { name: match, lat: PLACES[match][0], lon: PLACES[match][1] } : null;
}

function findSeverity(text) {
  const explicit = text.match(/severity\s*(?:of\s*)?([01]?\.?\d+)/);
  if (explicit) {
    return Math.min(Math.max(Number(explicit[1]), 0.05), 1);
  }
  if (/\b(severe|extreme|major|x-class|worst)\b/.test(text)) return 0.9;
  if (/\b(moderate|medium)\b/.test(text)) return 0.55;
  if (/\b(minor|mild|small|light)\b/.test(text)) return 0.25;
  return null;
}

export function interpret(text, tools) {
  const lower = text.toLowerCase();

  if (/^(help|what can you do|commands)/.test(lower)) {
    return {
      reply:
        "I drive the simulation through tools. Try: “inject a severe solar flare over the Indian Ocean”, “status”, “what's worst affected”, “clear hz-001”, or “raise hz-001 to 0.9”.",
      meta: "8 tools available",
    };
  }

  if (/^(status|report|summary|how are we|sitrep)/.test(lower)) {
    const summary = tools.network_summary();
    return {
      reply: `${summary.total} links up, ${summary.degraded} degraded. ${summary.atRisk} craft off nominal, ${summary.offline} gateway${summary.offline === 1 ? "" : "s"} offline. Mean link quality ${Math.round(summary.capacity * 100)}%, navigation fix coverage ${Math.round(summary.navCoverage * 100)}%.`,
      meta: "network_summary()",
    };
  }

  if (/worst|most affected|at risk|triage/.test(lower)) {
    const worst = tools.worst_affected({ limit: 5 });
    if (!worst.length) {
      return { reply: "Nothing off nominal right now.", meta: "worst_affected()" };
    }
    return {
      reply: `Worst affected: ${worst.map((item) => `${item.id} (${item.status}, health ${Math.round(item.health * 100)}%)`).join(", ")}.`,
      meta: "worst_affected()",
    };
  }

  const clear = lower.match(/(?:clear|remove|stop|end)\s+(hz-\d+)/);
  if (clear) {
    tools.clear_hazard({ id: clear[1] });
    return { reply: `Cleared ${clear[1]}.`, meta: `clear_hazard({ id: "${clear[1]}" })` };
  }

  if (/clear all|reset hazards|stand down/.test(lower)) {
    const all = tools.list_hazards();
    all.forEach(({ id }) => tools.clear_hazard({ id }));
    return { reply: `Cleared ${all.length} hazard${all.length === 1 ? "" : "s"}.`, meta: "clear_hazard() ×" + all.length };
  }

  const raise = lower.match(/(?:raise|set|lower|change)\s+(hz-\d+).*?([01]?\.\d+|\d{1,3}%)/);
  if (raise) {
    const raw = raise[2];
    const severity = raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
    const updated = tools.update_hazard({ id: raise[1], severity: Math.min(Math.max(severity, 0.05), 1) });
    if (!updated) {
      return { reply: `No hazard called ${raise[1]}.`, meta: "update_hazard() → null" };
    }
    const summary = tools.network_summary();
    return {
      reply: `${raise[1]} now at ${updated.severity.toFixed(2)}. ${summary.degraded} links degraded.`,
      meta: `update_hazard({ id: "${raise[1]}", severity: ${updated.severity.toFixed(2)} })`,
    };
  }

  const kind = findKind(lower);
  if (kind && /(inject|create|add|simulate|start|what if|throw|put|spawn)/.test(lower)) {
    const place = findPlace(lower);
    const severity = findSeverity(lower);
    const before = tools.network_summary();
    const hazard = tools.inject_hazard({
      kind,
      lat: place?.lat,
      lon: place?.lon,
      severity: severity ?? undefined,
    });
    const after = tools.network_summary();
    const delta = after.degraded - before.degraded;
    return {
      reply: `Injected ${hazard.spec.name.toLowerCase()} ${place ? `over ${place.name}` : "at a random footprint"} at ${hazard.spec.unit} ${hazard.severity.toFixed(2)} — ${hazard.id}. ${delta > 0 ? `${delta} more links degraded` : "no links degraded yet"}; mean quality now ${Math.round(after.capacity * 100)}%.`,
      meta: `inject_hazard({ kind: "${kind}"${place ? `, lat: ${place.lat}, lon: ${place.lon}` : ""}, severity: ${hazard.severity.toFixed(2)} })`,
      hazard,
    };
  }

  if (kind) {
    return {
      reply: `I can inject a ${HAZARD_KINDS[kind].name.toLowerCase()} — say “inject” and a region, e.g. “inject a ${kind} over the Pacific”.`,
      meta: "no tool call",
    };
  }

  const satMatch = text.match(/\b((?:gnss|mesh|geo)-\d{4})\b/i);
  if (satMatch) {
    const record = tools.query_satellite({ id: satMatch[1].toLowerCase() });
    if (record) {
      tools.focus_satellite({ id: record.id });
      return {
        reply: `${record.id}: ${record.status}, ${record.altitudeKm.toLocaleString()} km, ${record.deltaVRemaining.toFixed(1)} m/s delta-v left, ${record.links} active links.`,
        meta: `query_satellite({ id: "${record.id}" })`,
      };
    }
  }

  return {
    reply: "Not something I can act on yet. This is the local stub — it only routes to the simulation tools. Say “help” for what works.",
    meta: "no tool call",
  };
}
