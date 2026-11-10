
import { Engine } from "./core.js";
import { HAZARD_KINDS, geodetic } from "./world.js";

const FRAME_BUDGET_MS = 6;

export class Instance {
  #engine = null;
  #id = null;
  #lastStep = 0;
  #slow = 0;

  constructor({
    onBoard = () => {},
    onCards = () => {},
    onLog = () => {},
    onAsk = () => {},
    load = (id) => Engine.load(`/api/instances/${id}/bundle`),
  } = {}) {
    this.load = load;
    this.onBoard = onBoard;
    this.onCards = onCards;
    this.onLog = onLog;
    this.onAsk = onAsk;

    this.manifest = null;
    this.board = [];
    this.cards = [];
    this.metrics = {};
    this.trouble = null;
    this.running = false;
  }

  get id() {
    return this.#id;
  }

  get scripts() {
    return this.manifest?.scripts ?? [];
  }

  async attach(instance, { world, weather, forecast, operator } = {}) {
    this.detach();
    this.#id = instance?.id ?? null;
    if (!this.#id) {
      return false;
    }

    try {
      const engine = await this.load(this.#id);
      engine.open({
        id: this.#id,
        name: instance.name ?? "Console",
        note: instance.note ?? "",
        epoch: world ? world.at().getTime() : Date.now(),
        rate: world?.rate != null ? world.rate * 60 : 60,
      });

      this.#engine = engine;
      this.#feed({ world, weather, forecast, operator });
      this.manifest = engine.manifest();

      for (const kind of this.manifest.hazardKinds.filter((k) => !k.stock)) {
        HAZARD_KINDS[kind.id] ??= {
          id: kind.id,
          name: kind.name,
          glyph: kind.glyph,
          colour: kind.colour,
          affects: kind.actsOn[0] ?? "link",
          unit: kind.unit,
          defaults: { severity: 0.6, radius: 0.9, durationMin: 120 },
          blurb: kind.blurb,
          scripted: true,
        };
      }

      this.running = true;
      this.trouble = null;
      this.step(0, world);
      return true;
    } catch (error) {
      this.#engine = null;
      this.running = false;
      this.trouble = /404|no bundle/i.test(String(error?.message))
        ? null
        : `This console's scripts would not load: ${error.message}`;
      return false;
    }
  }

  detach() {
    this.#engine = null;
    this.#id = null;
    this.manifest = null;
    this.board = [];
    this.cards = [];
    this.metrics = {};
    this.running = false;
    this.trouble = null;
  }

  #feed({ world, weather, forecast, operator }) {
    const engine = this.#engine;
    if (!engine) {
      return;
    }

    const last = weather?.days?.at(-1);
    if (last) {
      engine.weather({
        kp: weather.now?.kp ?? last.kpMax,
        ap: last.ap,
        f107: last.f107 ?? 140,
        f107Mean: last.f107 ?? 140,
        sunspots: last.sunspots ?? 0,
        c: last.flares?.c ?? 0,
        m: last.flares?.m ?? 0,
        x: last.flares?.x ?? 0,
        measuredAt: Date.parse(`${last.date}T00:00:00Z`),
        live: Boolean(weather.live),
      });
    }
    if (forecast) {
      engine.forecast({
        forDay: Date.parse(`${forecast.date}T00:00:00Z`),
        kp: forecast.kp,
        stormProbability: forecast.storm ?? forecast.stormProbability ?? 0,
        live: Boolean(weather?.live),
      });
    }
    if (world) {
      engine.config({
        elevationMaskDeg: 10,
        linkDensity: world.filters.density,
        rate: world.rate * 60,
      });
      const rows = world.satellites
        .filter((craft) => craft.tle?.length === 2)
        .map((craft) => ({
          id: craft.id,
          name: craft.name ?? craft.id,
          constellation: craft.constellation,
          plane: craft.plane ?? 0,
          slot: craft.slot ?? 0,
          class: craft.constellation === "gnss" ? "navigation" : "communications",
          line1: craft.tle[0],
          line2: craft.tle[1],
        }));
      if (rows.length) {
        engine.fleet(rows);
      }
    }
    if (operator) {
      const { facts, models } = operator.list();
      engine.operator([
        ...facts.map((f) => ({ ...f, derived: false })),
        ...models
          .filter((m) => Number.isFinite(m.value))
          .map((m) => ({ name: m.name, value: m.value, unit: m.unit, source: m.source, note: m.formula, derived: true })),
      ]);
    }
  }

  refresh(context) {
    this.#feed(context);
  }

  step(dt, world) {
    if (!this.#engine || !this.running) {
      return null;
    }
    const started = performance.now();
    let frame;
    try {
      frame = this.#engine.step(dt, Date.now());
    } catch (error) {
      this.running = false;
      this.trouble = `The scripts stopped: ${error.message}`;
      return null;
    }
    const spent = performance.now() - started;
    if (spent > FRAME_BUDGET_MS) {
      this.#slow += 1;
      if (this.#slow > 120) {
        this.running = false;
        this.trouble = `This console's scripts were costing ${spent.toFixed(0)}ms a frame and have been stopped.`;
      }
    } else {
      this.#slow = Math.max(0, this.#slow - 1);
    }

    this.#lastStep = started;
    this.#drain(frame, world);
    return frame;
  }

  #drain(frame, world) {
    if (!frame) {
      return;
    }

    const board = frame.board.map((entry) => ({
      ...entry,
      ...(this.#markOf(entry.from) ?? {}),
    }));
    if (!same(board, this.board)) {
      this.board = board;
      this.onBoard(board);
    }

    if (!same(frame.cards, this.cards)) {
      this.cards = frame.cards;
      this.onCards(frame.cards);
    }
    this.metrics = frame.metrics;

    for (const line of frame.logs) {
      this.onLog(line);
    }

    if (world) {
      this.#mirror(frame.hazards, world);
    }

    for (const ask of frame.asks) {
      this.onAsk(ask);
    }

    if (frame.stopped.length) {
      for (const row of frame.stopped) {
        if (!this.board.some((entry) => entry.title?.includes(row.script))) {
          this.onLog(`[${row.script}] stopped: ${row.why}`);
        }
      }
    }
  }

  #markOf(id) {
    const script = this.manifest?.scripts.find((s) => s.id === id);
    return script ? { glyph: script.glyph, tint: script.tint } : null;
  }

  #mirror(hazards, world) {
    const theirs = hazards.filter((h) => h.flag === "SCR");
    const mine = world.hazards.filter((h) => h.origin === "scripted");

    for (const hazard of theirs) {
      const known = mine.find((h) => h.engineId === hazard.id);
      if (known) {
        if (Number.isFinite(hazard.lat) && Number.isFinite(hazard.lon)) {
          world.updateHazard(known.id, {
            lat: hazard.lat,
            lon: hazard.lon,
            severity: hazard.intensity,
          });
          place(known, hazard);
        }
        continue;
      }
      if (!HAZARD_KINDS[hazard.kind]) {
        continue;
      }
      try {
        const made = world.addHazard({
          kind: hazard.kind,
          label: hazard.label,
          lat: hazard.lat ?? 0,
          lon: hazard.lon ?? 0,
          severity: hazard.intensity,
          radius: hazard.radiusKm ? hazard.radiusKm / 6371 : undefined,
          durationMin: 10_080,
          origin: "scripted",
        });
        made.engineId = hazard.id;
        made.script = hazard.script;
        place(made, hazard);
      } catch {
      }
    }

    for (const hazard of mine) {
      if (!theirs.some((h) => h.id === hazard.engineId)) {
        world.removeHazard(hazard.id);
      }
    }
  }

  describe() {
    if (!this.manifest || !this.running) {
      return null;
    }
    const added = this.manifest.hazardKinds.filter((k) => !k.stock);
    return {
      scripts: this.manifest.scripts.map((s) => ({
        id: s.id,
        name: s.name,
        summary: s.summary,
        notes: s.notes,
      })),
      hazardKinds: added.map((k) => ({ id: k.id, name: k.name, unit: k.unit, blurb: k.blurb })),
      overrides: this.manifest.overrides.map((o) => ({ slot: o.slot, name: o.name })),
      craftAdded: this.manifest.craftAdded,
    };
  }

  report() {
    return this.#engine && this.running ? this.#engine.report().reports : [];
  }

  ask(question, who = "") {
    if (!this.#engine || !this.running) {
      return { answers: [] };
    }
    return this.#engine.ask(question, who);
  }
}

function place(hazard, theirs) {
  if (Number.isFinite(theirs.radiusKm) && theirs.radiusKm > 0) {
    hazard.radius = theirs.radiusKm / 6371;
  }
  if (Number.isFinite(theirs.lat) && Number.isFinite(theirs.lon)) {
    hazard.lat = theirs.lat;
    hazard.lon = theirs.lon;
    hazard.centre = geodetic(theirs.lat, theirs.lon, 1);
  }
}

function same(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}
