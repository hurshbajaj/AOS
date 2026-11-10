
import { HAZARD_KINDS } from "./world.js";
import { CONSTELLATIONS, EARTH_RADIUS_KM, SUN_DIRECTION as SUN } from "./data.js";

import { lines as linesOf, search as searchText } from "./documents.js";
import { FUNCTIONS } from "./formula.js";
import { LIMITS as OPERATOR_LIMITS } from "./operator.js";
import { PLANETS, alignedSky, subPoint } from "./ephemeris.js";
import { describeKp } from "./forecast.js";

const DEG = Math.PI / 180;
const POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const round = (value, places = 2) => (Number.isFinite(value) ? Number(value.toFixed(places)) : null);

const object = (properties, required = []) => ({ type: "object", properties, required });
const string = (description, extra = {}) => ({ type: "string", description, ...extra });
const number = (description, extra = {}) => ({ type: "number", description, ...extra });

const brief = (craft, world) => ({
  id: craft.id,
  name: craft.name ?? craft.id,
  noradId: craft.noradId ?? null,
  constellation: craft.constellation,
  status: craft.status,
  health: round(craft.health),
  altitudeKm: round(craft.altitudeKm, 0),
  subPoint: Number.isFinite(craft.latitude)
    ? { lat: round(craft.latitude, 2), lon: round(craft.longitude, 2) }
    : null,
  speedKms: round(craft.speedKms),
  links: world.links.filter((link) => link.a === craft || link.b === craft).length,
  source: craft.source ?? "modelled",
});

const hazardBrief = (hazard) => ({
  id: hazard.id,
  kind: hazard.kind,
  label: hazard.label,
  severity: round(hazard.severity),
  radiusKm: round(hazard.radius * EARTH_RADIUS_KM, 0),
  lat: round(hazard.lat, 1),
  lon: round(hazard.lon, 1),
  origin: hazard.origin,
  confidence: hazard.confidence === null ? null : round(hazard.confidence),
  affects: hazard.spec.affects,
});

function sunFrom(position) {
  const length = Math.hypot(position.x, position.y, position.z) || 1;
  const up = { x: position.x / length, y: position.y / length, z: position.z / length };
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

  const elevation = Math.asin(Math.max(-1, Math.min(1, dot(up, SUN)))) / DEG;

  const polar = { x: 0, y: 1, z: 0 };
  const lean = dot(polar, up);
  let north = { x: -lean * up.x, y: 1 - lean * up.y, z: -lean * up.z };
  const span = Math.hypot(north.x, north.y, north.z);
  north = span > 1e-6 ? { x: north.x / span, y: north.y / span, z: north.z / span } : { x: 1, y: 0, z: 0 };
  const east = {
    x: north.y * up.z - north.z * up.y,
    y: north.z * up.x - north.x * up.z,
    z: north.x * up.y - north.y * up.x,
  };

  const azimuth = (Math.atan2(dot(SUN, east), dot(SUN, north)) / DEG + 360) % 360;

  const along = -dot(position, SUN);
  const off = Math.sqrt(Math.max(length * length - along * along, 0));
  const eclipsed = along > 0 && off < 1;

  return {
    elevationDeg: round(elevation, 1),
    azimuthDeg: round(azimuth, 1),
    bearing: POINTS[Math.round(azimuth / 45) % 8],
    sunlit: !eclipsed,
    eclipsed,
    note: eclipsed
      ? "In Earth's shadow: no solar power, and the batteries are carrying the load."
      : elevation > 0
        ? "Sunlit, with the Sun above the local horizon."
        : "Sunlit from orbit, though the ground below is in darkness.",
  };
}

export function createTools(world, globe, extras = {}) {
  const findCraft = (query) => {
    if (!query) {
      return null;
    }
    const needle = String(query).toLowerCase();
    return (
      world.satellites.find((craft) => craft.id.toLowerCase() === needle) ??
      world.satellites.find((craft) => craft.noradId === needle) ??
      world.satellites.find((craft) => (craft.name ?? "").toLowerCase() === needle) ??
      world.satellites.find((craft) => (craft.name ?? "").toLowerCase().includes(needle)) ??
      null
    );
  };

  const tools = {
    network_summary: {
      description:
        "Overall state of the network: how many links are up, how many degraded, mean link quality, navigation fix coverage, craft off nominal, gateways offline. Start here for anything like 'how are we doing' or 'status'.",
      schema: object({}),
      run: () => world.summary(),
    },

    list_satellites: {
      description:
        "List satellites, optionally filtered by constellation or by whether they are degraded. Use limit to keep the answer short; there are up to a few hundred.",
      schema: object({
        constellation: string("gnss, mesh or geo", { enum: Object.keys(CONSTELLATIONS) }),
        degradedOnly: { type: "boolean", description: "Only craft that are not nominal" },
        limit: number("How many to return, default 20"),
      }),
      run: ({ constellation, degradedOnly = false, limit = 20 } = {}) =>
        world.satellites
          .filter((craft) => !constellation || craft.constellation === constellation)
          .filter((craft) => !degradedOnly || craft.status !== "nominal")
          .slice(0, Math.min(limit, 100))
          .map((craft) => brief(craft, world)),
    },

    find_satellite: {
      description:
        "Find one satellite by id, catalogue (NORAD) number, or part of its name. Returns everything known about it including its live sub-point and its links.",
      schema: object({ query: string("Id, NORAD number, or part of the name") }, ["query"]),
      run: ({ query }) => {
        const craft = findCraft(query);
        if (!craft) {
          return { found: false, query };
        }
        const links = world.links.filter((link) => link.a === craft || link.b === craft);
        return {
          found: true,
          ...brief(craft, world),
          inclinationDeg: round(craft.inclination, 2),
          eccentricity: round(craft.eccentricity, 5),
          periodMin: round(craft.period / 60, 1),
          platform: craft.platform.label,
          thruster: craft.platform.thruster,
          dryMassKg: craft.platform.dryMassKg,
          deltaVRemaining: round(craft.deltaVBudget - craft.deltaVSpent, 1),
          powerMargin: round(craft.powerMargin),
          modelledFields: craft.modelled ?? null,
          carrying: links.map((link) => ({
            kind: link.kind,
            peer: (link.a === craft ? link.b : link.a).name ?? (link.a === craft ? link.b : link.a).id,
            quality: round(link.quality),
            degraded: link.degraded,
          })),
        };
      },
    },

    worst_affected: {
      description: "The satellites currently in the worst state, ranked by link health. Empty when everything is nominal.",
      schema: object({ limit: number("How many, default 5") }),
      run: ({ limit = 5 } = {}) =>
        world.satellites
          .filter((craft) => craft.status !== "nominal")
          .sort((a, b) => a.health - b.health)
          .slice(0, limit)
          .map((craft) => brief(craft, world)),
    },

    list_ground_stations: {
      description: "The ground stations, where they are, whether they are online, and how many satellites each can currently see.",
      schema: object({}),
      run: () =>
        world.stations.map((station) => ({
          id: station.id,
          name: station.name,
          lat: station.lat,
          lon: station.lon,
          online: station.online,
          visible: world.links.filter((link) => link.kind !== "isl" && (link.a === station || link.b === station)).length,
        })),
    },

    sun_from: {
      description:
        "Where the Sun is from a satellite or from a point on the ground: its elevation above the local horizon, which way it lies, and whether the place is in Earth's shadow. Use this for anything about sunlight, eclipse, solar power, or day and night.",
      schema: object({
        satellite: string("A satellite id, NORAD number or name"),
        lat: number("Latitude, if asking about a ground point instead"),
        lon: number("Longitude, if asking about a ground point instead"),
      }),
      run: ({ satellite, lat, lon }) => {
        if (satellite) {
          const craft = findCraft(satellite);
          if (!craft?.position) {
            return { found: false, satellite };
          }
          return { found: true, from: craft.name ?? craft.id, ...sunFrom(craft.position) };
        }
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          return { error: "Give either a satellite, or a lat and lon." };
        }
        const phi = lat * DEG;
        const lambda = lon * DEG;
        return {
          found: true,
          from: `${lat}, ${lon}`,
          ...sunFrom({ x: Math.cos(phi) * Math.cos(lambda), y: Math.sin(phi), z: -Math.cos(phi) * Math.sin(lambda) }),
        };
      },
    },

    sky_bearings: {
      description:
        "Where the Sun and the planets are right now, as seen from Earth: distance in astronomical units, angle from the Sun, and the sub-point -- the spot on Earth each one is directly above. Use the sub-point to place something on the side of the planet facing a given body: ask for Venus, then inject at its sub-point.",
      schema: object({ body: string("One body, or leave empty for all", { enum: ["sun", ...PLANETS] }) }),
      run: ({ body } = {}) => {
        const sky = alignedSky(SUN, new Date());
        const pick = body ? { [body]: sky[body] } : sky;
        return Object.fromEntries(
          Object.entries(pick)
            .filter(([, value]) => value)
            .map(([name, value]) => {
              const under = subPoint(value.scene);
              return [
                name,
                {
                  distanceAu: round(value.distance, 3),
                  elongationFromSunDeg: round(value.elongation, 1),
                  subPoint: { lat: round(under.lat, 1), lon: round(under.lon, 1) },
                },
              ];
            }),
        );
      },
    },

    list_hazard_kinds: {
      description: "The kinds of hazard that exist, what each one degrades, and the units its severity is measured in.",
      schema: object({}),
      run: () =>
        Object.values(HAZARD_KINDS).map(({ id, name, unit, affects, defaults }) => ({
          id,
          name,
          unit,
          affects,
          defaultSeverity: defaults.severity,
          defaultRadiusKm: Math.round(defaults.radius * EARTH_RADIUS_KM),
        })),
    },

    list_hazards: {
      description:
        "Everything currently in play, with where it came from: observed means NOAA is measuring it now, forecast means the trained model expects it, injected means the operator asked for it.",
      schema: object({}),
      run: () => world.hazards.map(hazardBrief),
    },

    inject_hazard: {
      description:
        "Create a hazard. Only kind is required; anything left out takes that kind's default. Severity runs 0 to 1. Latitude and longitude place it; leave them out for a random position. This is a real change to the simulation and the operator will see it appear.",
      schema: object(
        {
          kind: string("Which kind", { enum: Object.keys(HAZARD_KINDS) }),
          lat: number("Latitude, -90 to 90"),
          lon: number("Longitude, -180 to 180"),
          severity: number("0 to 1, where 1 is the worst the scale goes"),
          radiusKm: number("Footprint radius on the ground in kilometres, 640 to 12700. A typical auroral disturbance is around 2000-5000."),
          durationMin: number("How long it lasts, in minutes, up to a week"),
          label: string("A short name for it, as the operator would say it"),
        },
        ["kind"],
      ),
      run: ({ radiusKm, ...args }) => {
        const hazard = world.addHazard({
          ...args,
          ...(Number.isFinite(radiusKm) ? { radius: radiusKm / EARTH_RADIUS_KM } : {}),
          origin: "injected",
        });
        globe.lookAtGeo?.(hazard.lat, hazard.lon);
        return hazardBrief(hazard);
      },
      mutates: true,
    },

    update_hazard: {
      description: "Change a hazard that already exists: rename it, or change its severity, radius, position or duration.",
      schema: object(
        {
          id: string("The hazard id, like hz-003"),
          label: string("Rename it to this"),
          severity: number("0 to 1"),
          radiusKm: number("Footprint radius on the ground in kilometres, 640 to 12700"),
          lat: number("Latitude"),
          lon: number("Longitude"),
          durationMin: number("Minutes"),
        },
        ["id"],
      ),
      run: ({ id, radiusKm, ...patch }) => {
        const hazard = world.updateHazard(id, {
          ...patch,
          ...(Number.isFinite(radiusKm) ? { radius: radiusKm / EARTH_RADIUS_KM } : {}),
        });
        if (hazard && (patch.lat !== undefined || patch.lon !== undefined)) {
          globe.lookAtGeo?.(hazard.lat, hazard.lon);
        }
        return hazard ? hazardBrief(hazard) : { found: false, id };
      },
      mutates: true,
    },

    clear_hazard: {
      description: "Remove one hazard, or every hazard if `all` is set.",
      schema: object({ id: string("The hazard id"), all: { type: "boolean", description: "Clear everything in play" } }),
      run: ({ id, all = false }) => {
        if (all) {
          const ids = world.hazards.map((hazard) => hazard.id);
          ids.forEach((each) => world.removeHazard(each));
          return { cleared: ids };
        }
        if (!id) {
          return { error: "Give an id, or set all." };
        }
        world.removeHazard(id);
        return { cleared: [id] };
      },
      mutates: true,
    },

    space_weather_now: {
      description:
        "What the Sun and Earth's magnetic field are actually doing right now, from NOAA: the planetary Kp index, how many flares were observed today by class, and how fresh the data is. Real measurements, not simulation.",
      schema: object({}),
      run: () => {
        const weather = extras.weather?.();
        if (!weather) {
          return { available: false, note: "The live feed was not reachable when the console opened." };
        }
        return {
          available: true,
          kp: weather.now ? round(weather.now.kp, 2) : null,
          kpDescription: weather.now ? describeKp(weather.now.kp) : null,
          measuredAt: weather.now?.at ?? null,
          flaresToday: weather.flares ?? null,
          dataThrough: weather.through,
          live: weather.live,
          notes: weather.notes,
        };
      },
    },

    storm_forecast: {
      description:
        "Tomorrow's geomagnetic forecast from the trained network: expected maximum Kp and the probability it reaches storm level. Includes what plain persistence would have said, for comparison.",
      schema: object({}),
      run: () => {
        const prediction = extras.predict?.() ?? extras.forecast?.();
        if (!prediction) {
          return { available: false, note: "No forecast: the model or the history was unavailable." };
        }
        return {
          available: true,
          forDate: prediction.date,
          basedOn: prediction.basis,
          expectedMaxKp: round(prediction.kp, 2),
          description: describeKp(prediction.kp),
          stormProbability: round(prediction.probability, 3),
          persistenceWouldSay: round(prediction.persistence, 2),
        };
      },
    },

    recent_activity: {
      description:
        "The last few weeks of geomagnetic activity, day by day: the daily maximum Kp, the solar radio flux and the sunspot number. Use this for anything about trends -- whether it has been stormy lately, whether activity is rising, what led up to today.",
      schema: object({ days: number("How many days back, up to 60. Default 14.") }),
      run: ({ days = 14 } = {}) => {
        const history = extras.weather?.()?.days ?? [];
        if (!history.length) {
          return { available: false, note: "No geomagnetic history loaded." };
        }
        const window = history.slice(-Math.min(Math.max(days, 1), 60));
        const peaks = window.map((day) => day.kpMax);
        return {
          available: true,
          days: window.map((day) => ({
            date: day.date,
            maxKp: round(day.kpMax, 2),
            f107: round(day.f107, 1),
            sunspots: day.sunspots ?? null,
          })),
          quietestKp: round(Math.min(...peaks), 2),
          stormiestKp: round(Math.max(...peaks), 2),
          stormDays: peaks.filter((kp) => kp >= 5).length,
        };
      },
    },

    forecast_model_card: {
      description:
        "How the forecaster was built and how well it scores on held-out years. Use this whenever asked how accurate the prediction is, how it was trained, or whether it can be trusted.",
      schema: object({}),
      run: () => {
        const model = extras.model?.();
        if (!model) {
          return { available: false };
        }
        return {
          available: true,
          trainedOn: model.span,
          source: model.source,
          trainingDays: model.rows.train,
          testDays: model.rows.test,
          testPeriodStartsAt: model.split.validEnd,
          architecture: model.architecture,
          features: model.features,
          testRmseKp: round(model.metrics.test.rmse, 3),
          testBrier: round(model.metrics.test.brier, 4),
          persistenceRmse: round(model.metrics.baselines.persistence.rmse, 3),
          climatologyRmse: round(model.metrics.baselines.climatology.rmse, 3),
          ridgeRmse: round(model.metrics.ridge.rmse, 3),
          skillOverPersistence: round(model.metrics.skill.rmseOverPersistence, 3),
          detection: model.metrics.detection,
          caveat:
            "A linear model on the same features scores within about one per cent, so most of the signal here is linear. Storm detection at one day's lead is genuinely hard: what decides it is the interplanetary field's north-south component, which is only measurable about an hour ahead.",
        };
      },
    },

    focus_satellite: {
      description: "Select a satellite on the globe and open its panel, as though the operator had clicked it.",
      schema: object({ query: string("Id, NORAD number, or name") }, ["query"]),
      run: ({ query }) => {
        const craft = findCraft(query);
        if (!craft) {
          return { found: false, query };
        }
        globe.select(craft);
        return { focused: craft.name ?? craft.id };
      },
      mutates: true,
    },

    adjust_view: {
      description:
        "Move the camera: zoom in or out, turn around the globe, or swing round to face a place. Use it to show the operator what you are talking about -- a satellite over the Pacific means nothing if they are looking at Europe. Every move is eased, never a cut.",
      schema: object({
        zoom: string("in, out, or a plain number as a multiplier of the current distance -- 0.5 halves it", {}),
        turn: string("Which way to turn the globe", { enum: ["left", "right", "up", "down"] }),
        degrees: number("How far to turn, default 45"),
        faceLat: number("Swing round to put this latitude in view"),
        faceLon: number("Swing round to put this longitude in view"),
      }),
      run: ({ zoom, turn, degrees = 45, faceLat, faceLon }) => {
        if (Number.isFinite(faceLat) && Number.isFinite(faceLon)) {
          globe.lookAtGeo?.(faceLat, faceLon);
          return { facing: { lat: faceLat, lon: faceLon } };
        }
        const scale = zoom === "in" ? 0.55 : zoom === "out" ? 1.8 : Number(zoom);
        const step = Math.max(-180, Math.min(180, degrees));
        const moved = globe.moveView?.({
          zoom: Number.isFinite(scale) && scale > 0 ? scale : 1,
          azimuthDeg: turn === "left" ? -step : turn === "right" ? step : 0,
          polarDeg: turn === "up" ? step : turn === "down" ? -step : 0,
        });
        return { zoomed: Number.isFinite(scale) ? scale : 1, turned: turn ?? null, degrees: turn ? step : 0, ...moved };
      },
      mutates: true,
    },

    set_layers: {
      description:
        "Show or hide what is drawn: a whole constellation, a kind of link, the ground stations, or the orbit rings. Use when the view is too busy to read, or to isolate one thing the operator is asking about.",
      schema: object({
        constellation: string("Which constellation", { enum: Object.keys(CONSTELLATIONS) }),
        links: string("Which link layer: isl is satellite-to-satellite, feeder is satellite-to-gateway, nav is positioning", {
          enum: ["isl", "feeder", "nav"],
        }),
        stations: { type: "boolean", description: "Show ground stations" },
        orbits: { type: "boolean", description: "Show orbit rings" },
        visible: { type: "boolean", description: "Whether the chosen constellation or link layer is shown. Default true." },
      }),
      run: ({ constellation, links, stations, orbits, visible = true }) => {
        const patch = {};
        if (constellation) {
          const next = new Set(world.filters.constellations);
          next[visible ? "add" : "delete"](constellation);
          patch.constellations = next;
        }
        if (links) {
          const next = new Set(world.filters.links);
          next[visible ? "add" : "delete"](links);
          patch.links = next;
        }
        if (stations !== undefined) {
          patch.stations = stations;
        }
        if (orbits !== undefined) {
          patch.orbits = orbits;
        }
        world.setFilter(patch);
        return {
          constellations: [...world.filters.constellations],
          links: [...world.filters.links],
          stations: world.filters.stations,
          orbits: world.filters.orbits,
        };
      },
      mutates: true,
    },
  };

  const library = extras.library;
  const operator = extras.operator;
  const instance = extras.instance;

  if (instance) {
    tools.list_scripts = {
      description:
        "The operator's own scripts running on this console: what each one does, the hazard kinds they added, and which of the console's algorithms they have replaced. Call this when asked what this console is set up to do, or before saying something is not possible -- the operator may have written it.",
      schema: object({}),
      run: () => {
        const described = instance.describe();
        if (!described) {
          return {
            scripts: [],
            note: "This console carries no scripts, or its bundle has not been built. The console's own five hazard kinds and its own physics are what is running.",
          };
        }
        return {
          ...described,
          reports: instance.report(),
        };
      },
    };

    tools.ask_script = {
      description:
        "Put a question to one of the operator's scripts by its id, from list_scripts. The script answers with its own figures, which are the operator's numbers rather than the console's. Leave script out to ask all of them. A script with nothing to say returns no answer -- report that it did not answer rather than guessing what it would have said.",
      schema: object({
        question: string("What to ask. Pass the operator's own words where you can."),
        script: string("Which script, by id. Omit to ask every script."),
      }),
      run: ({ question, script } = {}) => {
        if (!question) {
          return { error: "A question is needed." };
        }
        const { answers } = instance.ask(String(question), script ? String(script) : "");
        if (!answers.length) {
          return {
            answers: [],
            note: script
              ? `${script} had nothing to say about that, or there is no script by that id.`
              : "No script answered that.",
          };
        }
        return { answers };
      },
    };
  }

  if (library) {
    tools.list_operator_data = {
      description:
        "The documents the operator has put into this workspace: fleet specs, ops manuals, anomaly logs, whatever their team already has that the console does not. Names, kinds and sizes only. Read one to see inside. Reach for this whenever a question touches their actual fleet rather than the simulation, and before saying a figure is unavailable.",
      schema: object({}),
      run: () =>
        library.documents.length
          ? {
              documents: library.documents.map((row) => ({
                name: row.name,
                kind: row.kind,
                lines: (library.cached(row.id) ?? "").split("\n").length || null,
                bytes: row.bytes,
                author: row.author,
                updated: row.updated,
              })),
            }
          : { documents: [], note: "The operator has not put any documents in yet." },
    };

    tools.read_operator_data = {
      description:
        "Read a document the operator supplied, by name. Returns numbered lines, so you can cite exactly where a figure came from. Long documents come back a slice at a time -- use `from` to continue rather than asking for the whole thing.",
      schema: object(
        {
          name: string("The document's name, as list_operator_data gave it."),
          from: number("Line to start at, counting from 1. Default 1.", { minimum: 1 }),
          count: number("How many lines. Default 120, maximum 400.", { minimum: 1, maximum: 400 }),
        },
        ["name"],
      ),
      run: ({ name, from = 1, count = 120 }) => {
        const row = library.find(name);
        if (!row) {
          return { error: `No document called "${name}". Call list_operator_data to see what there is.` };
        }
        const text = library.cached(row.id);
        if (text === null) {
          return { error: `"${row.name}" has not finished loading. Try again in a moment.` };
        }
        const all = linesOf(text);
        const start = Math.max(1, Math.floor(from));
        const take = Math.max(1, Math.min(400, Math.floor(count)));
        const slice = all.slice(start - 1, start - 1 + take);
        return {
          name: row.name,
          kind: row.kind,
          totalLines: all.length,
          from: start,
          to: Math.min(all.length, start + slice.length - 1),
          more: start + slice.length - 1 < all.length,
          lines: slice.map((text_, index) => `${start + index}: ${text_}`),
        };
      },
    };

    tools.search_operator_data = {
      description:
        "Find a phrase across every document the operator supplied, with the line number and a line of context either side. Faster than reading a long document end to end when you know roughly what you are looking for -- a satellite's name, a column heading, a unit.",
      schema: object(
        {
          query: string("The text to look for. Case does not matter."),
          name: string("Only this document, if you want to narrow it."),
        },
        ["query"],
      ),
      run: ({ query, name }) => {
        const rows = name ? [library.find(name)].filter(Boolean) : library.documents;
        if (!rows.length) {
          return { error: name ? `No document called "${name}".` : "The operator has not put any documents in yet." };
        }
        const found = [];
        for (const row of rows) {
          const text = library.cached(row.id);
          if (text === null) {
            continue;
          }
          for (const hit of searchText(text, query)) {
            found.push({ document: row.name, ...hit });
          }
        }
        return found.length ? { hits: found.slice(0, 24) } : { hits: [], note: `Nothing matching "${query}".` };
      },
    };
  }

  if (operator) {
    tools.record_operator_fact = {
      description:
        "Record a figure you read out of the operator's documents, so the console uses it instead of its own modelled value. Use this for anything measured that we only model -- propellant, dry mass, transmit power, a ground station's real coordinates. Always say which document and which line it came from: a figure nobody can trace is one nobody should act on. Tell the operator plainly what you recorded and what it replaced.",
      schema: object(
        {
          name: string("A short name a formula can use: lower case, underscores, no spaces. Like dry_mass_kg."),
          value: number("The number itself."),
          unit: string("Its unit, as the operator writes it. kg, m/s, dBW."),
          source: string("Which document and which line. Like 'fleet-spec.csv line 41'."),
          note: string("Anything else worth remembering about it."),
        },
        ["name", "value", "source"],
      ),
      run: (args) => operator.setFact(args),
    };

    tools.define_operator_model = {
      description:
        `Define a formula the console evaluates whenever it needs the answer, rather than a number that is right today and wrong tomorrow. Write it over recorded facts, live readings and other models by name -- "isp_s * 9.80665 * ln((dry_mass_kg + propellant_kg) / dry_mass_kg)". Use this whenever a figure the operator needs can be derived from things in their documents, even if their documents never state it outright. Arithmetic only: + - * / % ^, comparisons, && ||, and ${Object.keys(FUNCTIONS).join(", ")}. if(test, then, otherwise) is the only branch.`,
      schema: object(
        {
          name: string("A short name: lower case, underscores. Like delta_v_ms."),
          formula: string(`The expression, at most ${OPERATOR_LIMITS.formula} characters.`),
          unit: string("The unit of what it works out to."),
          source: string("Which documents the inputs came from, and how you derived it."),
          note: string("What it means, in one line, for the operator reading the list."),
        },
        ["name", "formula"],
      ),
      run: (args) => operator.setModel(args),
    };

    tools.operator_values = {
      description:
        "Everything recorded for this console: the facts read out of the operator's documents and the models derived from them, each with its current value worked out. Check here before recording something, so you do not record the same figure twice under two names.",
      schema: object({}),
      run: () => {
        const { facts, models } = operator.list();
        return facts.length || models.length
          ? { facts, models, note: "These outrank the console's own modelled figures." }
          : { facts: [], models: [], note: "Nothing recorded yet for this console." };
      },
    };

    tools.evaluate_operator_model = {
      description:
        "What a recorded model works out to right now, with the inputs it used. Use it to check a model you have just written, and to show the operator the working rather than only the answer.",
      schema: object({ name: string("The model's name.") }, ["name"]),
      run: ({ name }) => {
        const entry = operator.entry(name);
        if (!entry) {
          return { error: `Nothing recorded called "${name}".` };
        }
        const worth = operator.tryValue(name);
        return {
          name: entry.name,
          formula: entry.formula ?? null,
          unit: entry.unit,
          source: entry.source,
          ...worth,
          inputs: (entry.needs ?? []).map((need) => ({ name: need, ...operator.tryValue(need) })),
        };
      },
    };

    tools.forget_operator_value = {
      description:
        "Remove a recorded fact or model. Use it when the operator corrects something, or when a figure you recorded turns out to have come from the wrong line.",
      schema: object({ name: string("What to remove.") }, ["name"]),
      run: ({ name }) =>
        operator.forget(name) ? { forgot: name } : { error: `Nothing recorded called "${name}".` },
      mutates: true,
    };
  }

  const authoring = extras.authoring;

  if (authoring) {
    const open = () => {
      const id = authoring.console();
      if (!id) {
        throw new Error("No console is open. Open one first -- scripts belong to a console.");
      }
      return id;
    };

    const findFile = async (which) => {
      const wanted = String(which ?? "").trim().toLowerCase();
      if (!wanted) {
        throw new Error("Which script? Pass its id or its filename, from list_script_files.");
      }
      const { scripts } = await authoring.scripts(open());
      const hit =
        scripts.find((row) => row.id === wanted) ??
        scripts.find((row) => row.name.toLowerCase() === wanted) ??
        scripts.find((row) => row.name.toLowerCase().replace(/\.rs$/, "") === wanted.replace(/\.rs$/, ""));
      if (!hit) {
        throw new Error(`No script called "${which}". list_script_files has the names.`);
      }
      return hit;
    };

    tools.list_script_files = {
      description:
        "The Rust files on the open console and the state of its compiled bundle: names, ids, sizes, which are switched on, what order they run in, and whether the bundle is built, stale or failed. This is the file listing; list_scripts is what those files are doing once they run.",
      schema: object({}),
      run: () => authoring.scripts(open()),
    };

    tools.read_script = {
      description:
        "The full source of one script, by id or filename. Read before editing -- a write replaces the whole file, so editing without reading first silently discards everything you did not retype.",
      schema: object({ script: string("Its id or its filename, from list_script_files.") }, ["script"]),
      run: async ({ script }) => {
        const row = await findFile(script);
        return authoring.script(open(), row.id);
      },
    };

    tools.write_script = {
      description:
        "Write a Rust file to the open console: a new one when no script is given, a complete replacement of an existing one when there is. The source is the whole file every time. Read the contract with read_scripting_reference before writing your first one -- aos-sim is on no registry and guessing at its API produces a file that cannot compile. Writing marks the bundle stale; nothing runs until build_scripts.",
      schema: object(
        {
          source: string("The complete Rust file."),
          name: string("Filename, like storm_watch.rs. Required for a new script; renames an existing one if given."),
          script: string("An existing script's id or filename, to replace it. Omit to add a new one."),
          manifest: string("Cargo dependency lines, one per line, like `serde = \"1\"`. Most scripts need none, and a server that cannot sandbox a build refuses them."),
        },
        ["source"],
      ),
      run: async ({ source, name, script, manifest = "" }) => {
        const instance = open();
        const text = String(source ?? "");
        if (!text.trim()) {
          return { error: "That file is empty." };
        }
        if (script) {
          const row = await findFile(script);
          const written = await authoring.save(instance, row.id, {
            name: String(name ?? row.name),
            source: text,
            manifest: String(manifest ?? ""),
          });
          return { ...written, note: "Written. The bundle is stale until build_scripts runs." };
        }
        if (!name) {
          return { error: "A new script needs a name, like storm_watch.rs." };
        }
        const made = await authoring.upload(instance, { name: String(name), source: text, manifest: String(manifest ?? "") });
        return { ...made, note: "Added. The bundle is stale until build_scripts runs." };
      },
    };

    tools.enable_script = {
      description:
        "Switch one script on or off without deleting it. A disabled script stays in the console and is left out of the next build -- the way to find out whether one of them is responsible for something.",
      schema: object(
        { script: string("Its id or filename."), enabled: { type: "boolean", description: "On or off." } },
        ["script", "enabled"],
      ),
      run: async ({ script, enabled }) => {
        const row = await findFile(script);
        return authoring.enable(open(), row.id, Boolean(enabled));
      },
    };

    tools.reorder_scripts = {
      description:
        "Set the order every script runs in, first to last. Order decides which override wins when two scripts replace the same algorithm, which hazard kind wins a name collision, and the sequence hooks fire in. Name every script in the console exactly once.",
      schema: object(
        { order: { type: "array", items: { type: "string" }, description: "Every script's id, in the order they should run." } },
        ["order"],
      ),
      run: async ({ order }) => {
        const instance = open();
        const rows = await Promise.all((order ?? []).map((which) => findFile(which)));
        return authoring.reorder(instance, rows.map((row) => row.id));
      },
    };

    tools.delete_script = {
      description:
        "Remove a script from the open console for good. There is no undo and the source is not kept anywhere else, so read it first if there is any chance it is wanted. Pass confirm true to go ahead.",
      schema: object(
        {
          script: string("Its id or filename."),
          confirm: { type: "boolean", description: "Must be true. Nothing is deleted without it." },
        },
        ["script"],
      ),
      run: async ({ script, confirm }) => {
        const row = await findFile(script);
        if (!confirm) {
          return {
            deleted: false,
            error: `This would delete ${row.name} permanently, with no undo. Say so to the operator and call again with confirm true if they want it.`,
          };
        }
        return { ...(await authoring.remove(open(), row.id)), deleted: row.name };
      },
    };

    tools.build_scripts = {
      description:
        "Compile the open console's scripts into its bundle and, if it builds, load it so it is running. Takes up to a minute. A failed build is not an error here -- it comes back with the compiler's own diagnostics, which are the thing to read and fix. Nothing a script does takes effect until this has run.",
      schema: object({}),
      run: async () => {
        const result = await authoring.build(open());
        return {
          ...result,
          note:
            result?.bundle?.status === "built"
              ? "Built and now running on this console."
              : "Not built. The log carries the compiler's own diagnostics.",
        };
      },
    };

    tools.list_scripting_reference = {
      description:
        "What there is to read before writing a script: every module of the aos-sim contract, and every worked example, each with a one-line summary of what it covers. Start here rather than guessing -- aos-sim is not on crates.io and is in no model's training data.",
      schema: object({}),
      run: () => authoring.reference(),
    };

    tools.read_scripting_reference = {
      description:
        "A window of one contract module or example, as text. Files run to hundreds of lines, so take 200 at a time and page with from. emit.rs is everything a script may do, env.rs is everything it can see, script.rs is the trait and its hooks, and the examples show all of it in use.",
      schema: object(
        {
          file: string("Its path from list_scripting_reference, like aos-sim/emit.rs or examples/storm_watch.rs."),
          from: { type: "number", description: "First line, 1-based. Default 1." },
          lines: { type: "number", description: "How many lines. Default 400, most 600." },
        },
        ["file"],
      ),
      run: ({ file, from, lines }) => authoring.referenceFile(String(file), from, lines),
    };

    tools.list_consoles = {
      description:
        "Every saved console in this workspace, and which one is open. A console is a scenario: its own hazards, layers, figures and scripts. The fleet is live in all of them.",
      schema: object({}),
      run: () => ({
        open: authoring.console(),
        consoles: authoring.consoles().map((row) => ({
          id: row.id,
          name: row.name,
          note: row.note ?? "",
          hazards: (row.state?.hazards ?? []).length,
          updated: row.updated,
        })),
        unsaved: authoring.unsaved(),
      }),
    };

    tools.open_console = {
      description:
        "Switch to another saved console, by id or name. Everything changes with it: the hazards on the stack, the layers, the operator's figures, the conversation and the scripts. Save first if the open one has unsaved changes -- list_consoles says whether it does.",
      schema: object({ console: string("Its id or its name.") }, ["console"]),
      run: ({ console: which }) => authoring.open(String(which ?? "")),
    };

    tools.save_console = {
      description:
        "Write the open console to the server: its hazards, layers, the operator's figures and this conversation. Nothing is saved on a timer, so this is the only way work here is kept.",
      schema: object({}),
      run: () => authoring.save_console(),
    };

    tools.create_console = {
      description:
        "Start a new, empty console and switch to it. It carries no hazards and no scripts, so whatever the last one was running stops. Save the open one first if it has unsaved changes.",
      schema: object({
        name: string("What to call it."),
        note: string("What it is for. Worth writing -- a console called \"test 3\" with no note is the one nobody can tell from \"test 4\" a week later."),
      }),
      run: ({ name, note }) => authoring.create(String(name ?? "").trim(), String(note ?? "").trim()),
    };

    tools.rename_console = {
      description: "Change a console's name, its note, or both.",
      schema: object(
        { console: string("Which one, by id or name. Omit for the open one."), name: string("The new name."), note: string("The new note.") },
        [],
      ),
      run: ({ console: which, name, note }) => authoring.rename(which ? String(which) : null, name, note),
    };

    tools.delete_console = {
      description:
        "Delete a saved console and everything in it -- its hazards, its figures, its conversation and its scripts. Permanent, with no undo. Pass confirm true to go ahead; say what will be lost before you do.",
      schema: object(
        {
          console: string("Which one, by id or name."),
          confirm: { type: "boolean", description: "Must be true. Nothing is deleted without it." },
        },
        ["console"],
      ),
      run: ({ console: which, confirm }) => authoring.drop(String(which ?? ""), Boolean(confirm)),
      mutates: true,
    };

    tools.run_screening = {
      description:
        "Sweep every craft in the fleet against the tracked public catalogue for the next 24 hours and return the close approaches. Tens of seconds. Miss distances, not probabilities, unless this console's scripts have replaced the screening algorithm with one that has covariance. Runs without moving the operator off what they are looking at.",
      schema: object({}),
      run: () => authoring.screen(),
    };

    tools.screening_result = {
      description:
        "The last screening result without running another one. Returns nothing if none has been run on this console yet.",
      schema: object({}),
      run: () => authoring.screening(),
    };
  }

  return tools;
}

export const describeTools = (tools) =>
  Object.entries(tools).map(([name, tool]) => ({
    name,
    description: tool.description,
    schema: tool.schema,
  }));

export function callTool(tools, name, args) {
  const tool = tools[name];
  if (!tool) {
    return { error: `No tool called ${name}.` };
  }
  const settle = (result) => (result === undefined ? { ok: true } : result);
  const failed = (error) => ({ error: String(error?.message ?? error) });
  try {
    const result = tool.run(args ?? {});
    return result && typeof result.then === "function"
      ? result.then(settle, failed)
      : settle(result);
  } catch (error) {
    return failed(error);
  }
}
