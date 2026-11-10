
const CONTRACT = 1;
const WASM = "assets/core/aos_core.wasm";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class EngineError extends Error {}

const BEFORE_THE_CLOCK = Date.UTC(2001, 0, 1);

function stampLoadTime(board, openedAt) {
  for (const entry of board) {
    if (!(entry.at >= BEFORE_THE_CLOCK)) {
      entry.at = openedAt;
    }
  }
  return board;
}

export class Engine {
  #wasm = null;
  #memory = null;
  #openedAt = null;

  static async load(source = WASM) {
    const imports = {
      env: {
        aos_now_ms: () => performance.now(),
      },
    };
    const bytes = typeof source === "string" ? await fetch(source) : source;
    const { instance } = typeof source === "string"
      ? await WebAssembly.instantiateStreaming(bytes, imports).catch(async () => {
          const buffer = await (await fetch(source)).arrayBuffer();
          return WebAssembly.instantiate(buffer, imports);
        })
      : await WebAssembly.instantiate(bytes, imports);

    const engine = new Engine();
    engine.#wasm = instance.exports;
    engine.#memory = instance.exports.memory;
    const built = engine.#wasm.aos_contract();
    if (built !== CONTRACT) {
      throw new EngineError(
        `The engine was built against contract ${built} and this page expects ${CONTRACT}. Run npm run core.`,
      );
    }
    return engine;
  }

  #send(text) {
    const payload = encoder.encode(text);
    const into = this.#wasm.aos_alloc(payload.length);
    new Uint8Array(this.#memory.buffer, into, payload.length).set(payload);
    const at = this.#wasm.aos_command(into, payload.length);
    this.#wasm.aos_free(into, payload.length);
    const length = new DataView(this.#memory.buffer).getUint32(at, true);
    return new Uint8Array(this.#memory.buffer, at + 4, length).slice();
  }

  #json(text) {
    const bytes = this.#send(text);
    if (!bytes.length) {
      return {};
    }
    const parsed = JSON.parse(decoder.decode(bytes));
    if (parsed.error) {
      throw new EngineError(parsed.error);
    }
    return parsed;
  }

  open({ id = "local", name = "Console", note = "", epoch = Date.now(), rate = 60 } = {}) {
    this.#openedAt = Date.now();
    const payload = encoder.encode(`${id}\n${name}\n${note}`);
    const into = this.#wasm.aos_alloc(payload.length);
    new Uint8Array(this.#memory.buffer, into, payload.length).set(payload);
    const ok = this.#wasm.aos_open(into, payload.length);
    this.#wasm.aos_free(into, payload.length);
    if (!ok) {
      throw new EngineError("The engine refused the instance details.");
    }
    this.#json(`epoch ${epoch} ${rate}`);
  }

  epoch(simMs, rate) {
    const n = (value) => (Number.isFinite(value) ? value : "nan");
    return this.#json(`epoch ${n(simMs)} ${n(rate)}`);
  }

  step(dt, wall = Date.now()) {
    const frame = this.#json(`step ${dt} ${wall}`);
    if (frame.board?.length) {
      stampLoadTime(frame.board, this.#openedAt ?? wall);
    }
    return frame;
  }

  fleet(rows) {
    const body = rows
      .map(
        (row) =>
          `${row.id}|${row.name ?? row.id}|${row.constellation ?? "fleet"}|${row.plane ?? 0}|${
            row.slot ?? 0
          }|${row.class ?? "communications"}\n${row.line1}\n${row.line2}`,
      )
      .join("\n");
    return this.#json(`fleet\n${body}`);
  }

  catalogue(text, group = "cat") {
    return this.#json(`catalogue ${group}\n${text}`);
  }

  weather({ kp, ap, f107, f107Mean, sunspots, c = 0, m = 0, x = 0, measuredAt, live = false }) {
    return this.#json(
      `weather ${kp} ${ap} ${f107} ${f107Mean ?? f107} ${sunspots} ${c} ${m} ${x} ${
        measuredAt ?? Date.now()
      } ${live ? "live" : "baked"}`,
    );
  }

  forecast({ forDay, kp, stormProbability, rmse = 1.124, brierSkill = 0.22, live = false }) {
    return this.#json(
      `forecast ${forDay} ${kp} ${stormProbability} ${rmse} ${brierSkill} ${live ? "live" : "baked"}`,
    );
  }

  operator(figures) {
    const body = figures
      .map((f) => `${f.name}|${f.value}|${f.unit ?? ""}|${f.source ?? ""}|${f.note ?? ""}|${f.derived ? "derived" : "read"}`)
      .join("\n");
    return this.#json(`operator\n${body}`);
  }

  config({ altitudeScale, elevationMaskDeg, linkDensity, rate } = {}) {
    const n = (value) => (Number.isFinite(value) ? value : "nan");
    return this.#json(`config ${n(altitudeScale)} ${n(elevationMaskDeg)} ${n(linkDensity)} ${n(rate)}`);
  }

  inject({ kind, severity = 0.6, lat, lon, radiusKm, durationMin, provenance = "injected", confidence, params = {} }) {
    const n = (value) => (Number.isFinite(value) ? value : "nan");
    const extra = Object.entries(params)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n");
    return this.#json(
      `inject ${kind} ${severity} ${n(lat)} ${n(lon)} ${n(radiusKm)} ${n(durationMin)} ${provenance} ${n(
        confidence,
      )}\n${extra}`,
    );
  }

  clear(id) {
    return this.#json(`clear ${id}`);
  }

  state() {
    const bytes = this.#send("state");
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  }

  links() {
    const bytes = this.#send("links");
    return {
      ends: new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4),
      floats: new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4),
      count: bytes.length / 20,
    };
  }

  screen({ hours = 24, alertKm = 10, from, until } = {}) {
    const n = (value) => (Number.isFinite(value) ? value : "nan");
    return this.#json(`screen ${hours} ${alertKm} ${n(from)} ${n(until)}`);
  }

  manifest() {
    return this.#json("manifest");
  }

  report() {
    return this.#json("report");
  }

  ask(question, who = "") {
    return this.#json(`ask ${who}\n${question}`);
  }

  select(kind, id) {
    return this.#json(`select ${kind} ${id}`);
  }
}

export const FIELDS = {
  stride: 9,
  lat: 0,
  lon: 1,
  altitudeKm: 2,
  radiusKm: 3,
  speedKms: 4,
  health: 5,
  status: 6,
  eclipsed: 7,
  betaDeg: 8,
};

export const STATUS = ["nominal", "degraded", "at risk", "offline", "manoeuvring"];
export const LINK_KINDS = ["in-plane", "cross-plane", "feeder", "navigation", "user", "ttc", "custom"];
export const STATION_BIT = 0x8000_0000;
