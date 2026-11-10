
import { fetchScreeningSet } from "./catalogue.js";
import { histogram } from "./conjunctions.js";
import { sampleResult } from "./screening-sample.js";

export class Screening {
  #lanes = [];
  #catalogue = null;
  #sources = [];

  constructor({ onProgress = () => {}, live = false } = {}) {
    this.onProgress = onProgress;
    this.live = live;
    this.result = null;
    this.running = false;
    this.error = null;
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
    this.stop();
  }

  get sources() {
    return this.#sources;
  }

  async catalogue() {
    if (!this.#catalogue) {
      const { objects, sources } = await fetchScreeningSet((step) => this.onProgress(step));
      this.#catalogue = objects;
      this.#sources = sources;
    }
    return this.#catalogue;
  }

  async run(fleet, options = {}) {
    if (this.running) {
      return this.result;
    }
    this.running = true;
    this.error = null;
    this.cancelled = false;

    if (!this.live) {
      this.onProgress({ stage: "screening", fraction: 0.25, sample: true });
      await new Promise((go) => setTimeout(go, 240));
      if (this.cancelled) {
        this.running = false;
        return null;
      }
      this.onProgress({ stage: "screening", fraction: 0.8, sample: true });
      await new Promise((go) => setTimeout(go, 200));
      this.running = false;
      if (this.cancelled) {
        return null;
      }
      const made = sampleResult(fleet, options);
      this.result = {
        sample: true,
        from: made.from.toISOString(),
        hours: made.hours,
        alertKm: made.alertKm,
        catalogue: 18556,
        pool: 2601,
        pairs: 258341,
        fleet: made.craft,
        encounters: made.encounters,
        total: made.total,
        alerts: made.encounters.filter((row) => row.alert).length,
        histogram: histogram(made.encounters),
        lanes: 1,
        ms: 440,
      };
      return this.result;
    }

    try {
      this.onProgress({ stage: "catalogue" });
      const catalogue = await this.catalogue();
      if (!catalogue.length) {
        throw new Error("The catalogue could not be reached. CelesTrak may be rate limiting; try again shortly.");
      }

      const payload = fleet
        .filter((craft) => Array.isArray(craft.tle))
        .map((craft) => ({ id: craft.id, name: craft.name, tle: craft.tle }));
      if (!payload.length) {
        throw new Error(
          "The fleet on screen is modelled rather than tracked, so it has no elements to screen against. " +
            "The catalogue was unreachable when the console started; reload to try it again.",
        );
      }

      const hours = options.hours ?? 24;
      const coarseS = options.coarseS ?? 90;
      const alertKm = options.alertKm ?? 10;
      const from = new Date();
      const lanes = Math.max(1, Math.min(6, navigator.hardwareConcurrency || 2));
      const span = (hours * 3600 * 1000) / lanes;
      const slices = Array.from({ length: lanes }, (_, index) => ({
        index,
        from: from.getTime() + index * span - (index ? coarseS * 2000 : 0),
        until: from.getTime() + (index + 1) * span,
      }));

      this.onProgress({ stage: "preparing", lanes });
      const progress = new Array(lanes).fill(0);
      const parts = await Promise.all(
        slices.map((slice) =>
          this.#lane(
            { fleet: payload, catalogue, options: { hours, coarseS, alertKm, padKm: options.padKm, keepKm: options.keepKm }, slice },
            (done, total) => {
              progress[slice.index] = total ? done / total : 0;
              this.onProgress({
                stage: "screening",
                fraction: progress.reduce((sum, value) => sum + value, 0) / lanes,
                lanes,
              });
            },
          ),
        ),
      );

      if (this.cancelled) {
        return null;
      }
      const broken = parts.find((part) => part.error);
      if (broken) {
        throw new Error(broken.error);
      }

      const seen = new Set();
      const encounters = [];
      for (const part of parts) {
        for (const row of part.encounters ?? []) {
          const key = `${row.mine}|${row.other}|${Math.round(new Date(row.at).getTime() / 1000)}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          encounters.push({ ...row, inHours: (new Date(row.at) - from) / 3600000 });
        }
      }
      encounters.sort((a, b) => a.km - b.km);

      this.result = {
        from: from.toISOString(),
        hours,
        alertKm,
        catalogue: parts[0]?.catalogue ?? catalogue.length,
        pool: Math.max(0, ...parts.map((part) => part.pool ?? 0)),
        pairs: Math.max(0, ...parts.map((part) => part.pairs ?? 0)),
        fleet: payload.map((craft) => ({ id: craft.id, name: craft.name })),
        encounters: encounters.slice(0, 400),
        total: encounters.length,
        alerts: encounters.filter((row) => row.alert).length,
        histogram: histogram(encounters),
        lanes,
        ms: Math.max(0, ...parts.map((part) => part.ms ?? 0)),
      };
      return this.result;
    } catch (error) {
      this.error = String(error?.message ?? error);
      throw error;
    } finally {
      this.stop();
      this.running = false;
    }
  }

  #lane(message, onProgress) {
    return new Promise((resolve) => {
      const worker = new Worker(new URL("./screen.worker.js", import.meta.url), { type: "module" });
      this.#lanes.push(worker);
      worker.addEventListener("message", (event) => {
        if (event.data?.stage === "progress") {
          onProgress(event.data.done, event.data.total);
          return;
        }
        resolve(event.data);
        worker.terminate();
      });
      worker.addEventListener("error", (event) => {
        resolve({ error: event.message || "A screening worker failed to start." });
      });
      worker.postMessage(message);
    });
  }

  stop() {
    for (const worker of this.#lanes) {
      worker.terminate();
    }
    this.#lanes = [];
  }
}

export function byCraft(result) {
  const out = new Map();
  for (const row of result?.encounters ?? []) {
    const held = out.get(row.mine);
    if (!held || row.km < held.km) {
      out.set(row.mine, row);
    }
  }
  return out;
}

export function risk(km, alertKm = 10) {
  if (km <= 1) return "critical";
  if (km <= alertKm / 2) return "high";
  if (km <= alertKm) return "watch";
  return "clear";
}
