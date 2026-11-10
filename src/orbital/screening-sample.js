
const seeded = (seed) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};

const FRAGMENTS = [
  "COSMOS 2251 DEB", "FENGYUN 1C DEB", "IRIDIUM 33 DEB", "COSMOS 1408 DEB",
  "SL-16 R/B", "CZ-6A DEB", "THORAD AGENA D DEB", "ARIANE 5 DEB",
];

export function sampleResult(fleet, { hours = 24, alertKm = 10, seed = 20260207 } = {}) {
  const roll = seeded(seed);
  const craft = (fleet.length ? fleet : [{ id: "mesh-00000", name: "AOS-MESH-01" }]).map((row) => ({
    id: row.id,
    name: row.name,
  }));
  const from = new Date();
  const encounters = [];
  const count = 400;

  for (let i = 0; i < count; i += 1) {
    const mine = craft[Math.floor(roll() * craft.length)];
    const km = 1.4 + 36 * Math.sqrt(roll());
    const at = new Date(from.getTime() + roll() * hours * 3600 * 1000);
    encounters.push({
      mine: mine.id,
      mineName: mine.name,
      other: `sample-${i}`,
      name: FRAGMENTS[Math.floor(roll() * FRAGMENTS.length)],
      group: "sample",
      km,
      at: at.toISOString(),
      inHours: (at - from) / 3600000,
      alert: km <= alertKm,
    });
  }
  encounters.sort((a, b) => a.km - b.km);
  return { from, hours, alertKm, craft, encounters, total: 10704 };
}
