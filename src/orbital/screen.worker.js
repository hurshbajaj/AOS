
import { screenMany, shell } from "./conjunctions.js";

const SATELLITE = "https://esm.sh/satellite.js@5.0.0";
let sgp4 = null;

const load = async () => {
  if (!sgp4) {
    sgp4 = await import(SATELLITE);
  }
  return sgp4;
};

function prepare(twoline2satrec, { name, tle, group, id }) {
  const satrec = twoline2satrec(tle[0], tle[1]);
  if (!satrec || satrec.error) {
    return null;
  }
  return {
    id: id ?? `${group ?? "cat"}-${satrec.satnum}`,
    name: name || `NORAD ${satrec.satnum}`,
    group,
    satrec,
    ...shell(satrec),
  };
}

self.addEventListener("message", async (event) => {
  const { fleet = [], catalogue = [], options = {}, slice } = event.data ?? {};
  try {
    const { twoline2satrec, propagate } = await load();
    const mine = fleet.map((row) => prepare(twoline2satrec, row)).filter(Boolean);
    const targets = catalogue.map((row) => prepare(twoline2satrec, row)).filter(Boolean);
    if (!mine.length) {
      self.postMessage({ stage: "slice", error: "None of the fleet's elements could be read." });
      return;
    }

    const step = (object, when) => propagate(object.satrec, when)?.position ?? null;

    const started = performance.now();
    const result = screenMany(mine, targets, step, {
      ...options,
      from: new Date(slice.from),
      until: new Date(slice.until),
      onStep: ({ done, total }) => self.postMessage({ stage: "progress", slice: slice.index, done, total }),
    });

    self.postMessage({
      stage: "slice",
      index: slice.index,
      encounters: result.encounters,
      pool: result.pool,
      pairs: result.pairs,
      catalogue: targets.length,
      ms: performance.now() - started,
    });
  } catch (error) {
    self.postMessage({ stage: "slice", error: String(error?.message ?? error) });
  }
});
