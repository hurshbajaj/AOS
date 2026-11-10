
export const EARTH_RADIUS_KM = 6371;

export const SUN_DIRECTION = (() => {
  const raw = { x: -0.55, y: 0.3, z: 0.78 };
  const length = Math.hypot(raw.x, raw.y, raw.z);
  return { x: raw.x / length, y: raw.y / length, z: raw.z / length };
})();

export const ALTITUDE_SCALE = 0.55;

export const sceneRadius = (altitudeKm) => 1 + (altitudeKm / EARTH_RADIUS_KM) * ALTITUDE_SCALE;

export const CONSTELLATIONS = {
  gnss: {
    id: "gnss",
    name: "GNSS",
    role: "Positioning, navigation and timing",
    colour: "#7fd4ff",
    altitudeKm: 20200,
    inclination: 55,
    planes: 6,
    perPlane: 4,
    kind: "nav",
  },
  mesh: {
    id: "mesh",
    name: "LEO Mesh",
    role: "Broadband relay",
    colour: "#ffffff",
    altitudeKm: 550,
    inclination: 53,
    planes: 8,
    perPlane: 9,
    kind: "comms",
  },
  geo: {
    id: "geo",
    name: "GEO Belt",
    role: "Wide-area backhaul",
    colour: "#ffb067",
    altitudeKm: 35786,
    inclination: 0,
    planes: 1,
    perPlane: 6,
    kind: "comms",
  },
};

export const GROUND_STATIONS = [
  { id: "gs-svalbard", name: "Svalbard", lat: 78.23, lon: 15.41 },
  { id: "gs-punta", name: "Punta Arenas", lat: -53.16, lon: -70.91 },
  { id: "gs-hartebeesthoek", name: "Hartebeesthoek", lat: -25.89, lon: 27.69 },
  { id: "gs-goldstone", name: "Goldstone", lat: 35.43, lon: -116.89 },
  { id: "gs-kourou", name: "Kourou", lat: 5.25, lon: -52.8 },
  { id: "gs-perth", name: "Perth", lat: -31.8, lon: 115.89 },
  { id: "gs-bengaluru", name: "Bengaluru", lat: 13.03, lon: 77.51 },
  { id: "gs-fairbanks", name: "Fairbanks", lat: 64.86, lon: -147.85 },
];

export const PLATFORMS = {
  nav: { label: "Navigation payload", dryMassKg: 1630, thruster: "Hydrazine monoprop" },
  comms: { label: "Phased-array relay", dryMassKg: 290, thruster: "Krypton Hall-effect" },
};

function seeded(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

export function buildFleet() {
  const random = seeded(20261103);
  const satellites = [];

  for (const group of Object.values(CONSTELLATIONS)) {
    for (let plane = 0; plane < group.planes; plane += 1) {
      const raan = (360 / group.planes) * plane;
      for (let slot = 0; slot < group.perPlane; slot += 1) {
        const phase = (360 / group.perPlane) * slot + (plane * 360) / (group.planes * group.perPlane);
        const budget = group.kind === "nav" ? 48 + random() * 34 : 12 + random() * 20;
        const spent = budget * random() * 0.55;
        satellites.push({
          id: `${group.id}-${String(plane + 1).padStart(2, "0")}${String(slot + 1).padStart(2, "0")}`,
          constellation: group.id,
          plane,
          slot,
          raan,
          phase,
          inclination: group.inclination,
          altitudeKm: group.altitudeKm,
          radius: sceneRadius(group.altitudeKm),
          period: Math.sqrt((group.altitudeKm + EARTH_RADIUS_KM) ** 3 / 398600.4418) * 2 * Math.PI,
          platform: PLATFORMS[group.kind],
          deltaVBudget: budget,
          deltaVSpent: spent,
          powerMargin: 0.38 + random() * 0.5,
          status: "nominal",
          health: 1,
        });
      }
    }
  }

  return satellites;
}

export function planeKey(satellite) {
  return `${satellite.constellation}-${satellite.plane}`;
}

export function orbitPlanes() {
  return Object.values(CONSTELLATIONS).flatMap((group) =>
    Array.from({ length: group.planes }, (_, plane) => ({
      id: `${group.id}-${plane}`,
      constellation: group.id,
      radius: sceneRadius(group.altitudeKm),
      inclination: group.inclination,
      raan: (360 / group.planes) * plane,
      colour: group.colour,
    })),
  );
}
