import { World, HAZARD_KINDS } from "./world.js";
import { Globe } from "./globe.js";
import { Chat, HazardStrip, Inspector, Layers } from "./ui.js";
import { interpret } from "./agent.js";
import { createTools } from "./tools.js";
import { Instance } from "./instance.js";
import { renderBoard } from "../ui/board.js";
import { Sybil } from "./sybil.js";
import { closeAperture, openAperture } from "../aperture.js";
import { pushUpdate } from "../updates.js";
import { ambient, markHandoff } from "../ambient.js";
import { HandTracker } from "./hands.js";
import { Bearings } from "./bearings.js";
import { fetchFleet, propagator } from "./catalogue.js";
import { current as currentWeather } from "./spaceweather.js";
import { forecast, loadModel } from "./forecast.js";
import { applyLive, describeConditions } from "./live.js";
import { mark, record, whoami } from "../session.js";
import { capture, create, list, remove, rename, restore, saver } from "./instances.js";
import { Library, create as addDocument, remove as dropDocument } from "./documents.js";
import * as code from "../core/client.js";
import { CAVEAT } from "./conjunctions.js";
import { Screening, byCraft } from "./screening.js";
import { Operator } from "./operator.js";
import { ROUTES } from "../routes.js";
import { Loader } from "../ui/loader.js";

const $ = (selector) => document.querySelector(selector);

const world = new World();

whoami().then((status) => mark(document.body, status));

const addHazard = world.addHazard.bind(world);
world.addHazard = (spec) => {
  const hazard = addHazard(spec);
  if (hazard.origin === "injected") {
    record(
      "hazard",
      `${hazard.label} — ${hazard.spec.unit} ${hazard.severity.toFixed(2)} at ${hazard.lat.toFixed(0)}°, ${hazard.lon.toFixed(0)}°`,
      { kind: hazard.kind, lat: hazard.lat, lon: hazard.lon, severity: hazard.severity, radiusKm: Math.round(hazard.radius * 6371) },
    );
  }
  return hazard;
};

world.addHazard({ kind: "jam", lat: 16, lon: 44, severity: 0.42, origin: "observed", label: "Uplink interference" });

const globe = new Globe($("[data-globe]"), world, {
  onPick: (satellite) => {
    if (screen.on) {
      return;
    }
    strip.active = null;
    strip.render();
    inspector.showSatellite(satellite, world);
  },
});

const inspector = new Inspector($("[data-panel]"));

const live = { weather: null, forecast: null, model: null };

const library = new Library();
const operator = new Operator({
  onChange: () => saveSoon(),
  readings: (name) => {
    const weather = live.weather;
    const predicted = live.model && weather ? forecast(weather.days, live.model) : null;
    return {
      kp: weather?.days?.at(-1)?.kp,
      kp_tomorrow: predicted?.kp,
      kp_storm_chance: predicted?.stormChance,
      satellites: world.satellites.length,
      hazards: world.hazards.length,
      links: world.links.length,
    }[name];
  },
});

const instance = new Instance({
  onBoard: (entries) => paintBoard(entries),
  onLog: (line) => console.log(`[aos] ${line}`),
  onAsk: (ask) => obey(ask),
});

const boardMount = $("[data-board]");

function paintBoard(entries) {
  const any = entries.length > 0;
  boardMount.hidden = !any;
  if (any) {
    renderBoard(boardMount, { entries, state: "ready" });
  }
  requestAnimationFrame(() => {
    const height = any ? Math.ceil(boardMount.getBoundingClientRect().height) : 0;
    document.documentElement.style.setProperty("--board-h", `${height ? height + 12 : 0}px`);
  });
}

function obey(ask) {
  if (ask.do === "focus" && ask.subject?.kind === "satellite") {
    const craft = world.satellites.find((row) => row.id === ask.subject.id);
    if (craft) {
      globe.select(craft);
      globe.lookAt?.(craft);
    }
    return;
  }
  if (ask.do === "layer") {
    const { constellations, links } = world.filters;
    const set = constellations.has(ask.name) || !links.has(ask.name) ? constellations : links;
    if (ask.on) {
      set.add(ask.name);
    } else {
      set.delete(ask.name);
    }
    world.setFilter({});
    return;
  }
  if (ask.do === "screen" && !screen.on) {
    runScreen({ show: false });
  }
}

const authoring = {
  console: () => consoles.current,
  consoles: () => consoles.rows,
  unsaved: () => consoles.saver.pending,

  scripts: (id) => code.scripts(id),
  script: (id, script) => code.script(id, script),
  upload: (id, file) => code.upload(id, file),
  save: (id, script, file) => code.save(id, script, file),
  enable: (id, script, on) => code.enable(id, script, on),
  reorder: (id, order) => code.reorder(id, order),
  remove: (id, script) => code.remove(id, script),

  build: async (id) => {
    const result = await code.build(id);
    const row = consoles.rows.find((item) => item.id === id);
    if (row) {
      await attachScripts(row);
    }
    return result;
  },

  reference: async () => {
    const response = await fetch("/api/scripting/reference");
    if (!response.ok) {
      throw new Error("The scripting reference is not available on this server.");
    }
    return response.json();
  },

  referenceFile: async (file, from, lines) => {
    const where = new URLSearchParams();
    if (Number.isFinite(Number(from))) {
      where.set("from", String(Math.max(1, Math.round(Number(from)))));
    }
    if (Number.isFinite(Number(lines))) {
      where.set("lines", String(Math.max(1, Math.round(Number(lines)))));
    }
    const response = await fetch(`/api/scripting/reference/${file}?${where}`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error ?? "No such reference file.");
    }
    return body;
  },

  find: (which) => {
    const wanted = String(which ?? "").trim().toLowerCase();
    if (!wanted) {
      return null;
    }
    return (
      consoles.rows.find((row) => row.id === wanted) ??
      consoles.rows.find((row) => row.name.toLowerCase() === wanted) ??
      consoles.rows.find((row) => row.name.toLowerCase().includes(wanted)) ??
      null
    );
  },

  open: (which) => {
    const row = authoring.find(which);
    if (!row) {
      return { opened: false, error: `No console called "${which}". list_consoles has the names.` };
    }
    if (row.id === consoles.current) {
      return { opened: true, already: true, console: { id: row.id, name: row.name } };
    }
    return openConsole(row, { ask: false });
  },

  save_console: async () => {
    if (!consoles.current) {
      return { saved: false, error: "No console is open." };
    }
    await consoles.saver.save(consoles.current, capture(world, operator, parts.chat));
    showConsoles();
    return { saved: true, console: consoles.current };
  },

  create: async (name, note) => {
    if (consoles.saver.pending) {
      const leaving = consoles.rows.find((row) => row.id === consoles.saver.pending);
      return {
        created: false,
        error: `"${leaving?.name ?? "The open console"}" has unsaved changes, and a new one replaces what is on screen. Save it first or tell the operator what they would lose.`,
      };
    }
    const { instance: made, instances } = await create(name || `Console ${consoles.rows.length + 1}`, note || "");
    consoles.rows = instances;
    consoles.current = made.id;
    rememberOpen(made.id);
    restore(world, { hazards: [] }, operator, parts.chat, sybil);
    instance.detach();
    paintBoard([]);
    strip.restage();
    pushUpdate("system", `Console "${made.name}" created`);
    showConsoles();
    return { created: true, console: { id: made.id, name: made.name, note: made.note ?? "" } };
  },

  rename: async (which, name, note) => {
    const row = which ? authoring.find(which) : consoles.rows.find((item) => item.id === consoles.current);
    if (!row) {
      return { error: which ? `No console called "${which}".` : "No console is open." };
    }
    const fresh = (await rename(row.id, name ?? row.name, note ?? row.note ?? "")).instances;
    consoles.rows = inOldOrder(consoles.rows, fresh);
    showConsoles();
    const now = consoles.rows.find((item) => item.id === row.id);
    return { renamed: true, console: { id: row.id, name: now?.name, note: now?.note ?? "" } };
  },

  drop: async (which, confirmed) => {
    const row = authoring.find(which);
    if (!row) {
      return { deleted: false, error: `No console called "${which}".` };
    }
    if (!confirmed) {
      const count = (row.state?.hazards ?? []).length;
      return {
        deleted: false,
        error: `This would permanently delete "${row.name}" -- ${count} hazard${count === 1 ? "" : "s"}, its figures, its conversation and its scripts -- with no undo. Tell the operator that, and call again with confirm true only if they say so.`,
      };
    }
    consoles.rows = (await remove(row.id)).instances;
    if (consoles.current === row.id) {
      consoles.current = null;
      rememberOpen(null);
      restore(world, { hazards: [] }, operator, parts.chat, sybil);
      instance.detach();
      paintBoard([]);
      strip.restage();
    }
    pushUpdate("system", `Console "${row.name}" deleted`);
    showConsoles();
    return { deleted: row.name };
  },

  screen: async () => {
    await runScreen({ show: screen.on });
    return authoring.screening();
  },

  screening: () => {
    if (screen.state?.error) {
      return { available: false, error: screen.state.error };
    }
    const result = screen.state?.result;
    if (!result) {
      return { available: false, note: "No screen has been run on this console yet. run_screening does one." };
    }
    return {
      available: true,
      hours: result.hours,
      alertKm: result.alertKm,
      alerts: result.alerts,
      screened: result.screened ?? null,
      caveat: CAVEAT,
      encounters: result.encounters.slice(0, 40),
    };
  },
};

const tools = createTools(world, globe, {
  library,
  operator,
  instance,
  weather: () => live.weather,
  forecast: () => live.forecast,
  model: () => live.model,
  predict: () => (live.model && live.weather ? forecast(live.weather.days, live.model) : null),
  authoring,
});

const legacyTools = Object.fromEntries(
  Object.entries(tools).map(([name, tool]) => [name, (args) => tool.run(args ?? {})]),
);

function openHazard(hazard) {
  if (screen.on) {
    return;
  }
  globe.select(null);
  inspector.showHazard(hazard, world, {
    onChange: (patch) => {
      world.updateHazard(hazard.id, patch);
      strip.render();
      if (patch.severity !== undefined) {
        pushUpdate(hazard.kind, `${hazard.label} revised to ${hazard.spec.unit} ${patch.severity.toFixed(2)}`);
      }
      if (patch.label !== undefined) {
        pushUpdate("system", `Renamed to ${hazard.label}`);
      }
    },
    onRemove: () => {
      world.removeHazard(hazard.id);
      pushUpdate("system", `${hazard.label} cleared`);
      strip.active = null;
      strip.render();
      inspector.clear();
    },
  });
}

const strip = new HazardStrip($("[data-stack]"), world, {
  onSelect: openHazard,
  onAdd: () => {
    strip.active = null;
    strip.render();
    globe.select(null);
    inspector.showPicker(Object.values(HAZARD_KINDS), (kind) => {
      const hazard = world.addHazard({ kind });
      pushUpdate(kind, `${hazard.spec.name} injected at ${hazard.lat.toFixed(0)}°, ${hazard.lon.toFixed(0)}°`);
      strip.active = hazard.id;
      strip.render();
      openHazard(hazard);
    },
    () => {
      if (consoles.current) {
        sessionStorage.setItem("aos:core:open", consoles.current);
      }
      enterCore();
    });
  },
});

const controls = $("[data-controls]");
new Layers(controls, world);

const savedPip = $("[data-saved]");
let pipTimer = 0;
const flashSaved = () => {
  clearTimeout(pipTimer);
  savedPip.classList.add("is-on");
  pipTimer = setTimeout(() => savedPip.classList.remove("is-on"), 1600);
};

const parts = { chat: null };

const LAST_OPEN = "aos:console:chosen";

const lastOpen = () => {
  try {
    return localStorage.getItem(LAST_OPEN);
  } catch {
    return null;
  }
};

const rememberOpen = (id) => {
  try {
    if (id) {
      localStorage.setItem(LAST_OPEN, id);
    } else {
      localStorage.removeItem(LAST_OPEN);
    }
  } catch {
  }
};

const consoles = {
  rows: [],
  current: null,
  signedIn: false,
  saver: saver({
    onWrite: flashSaved,
    onDirty: () => {
      if (inspector.showing === "consoles") {
        showConsoles();
      }
    },
  }),
};

function inOldOrder(current, fresh) {
  const byId = new Map(fresh.map((row) => [row.id, row]));
  const kept = current.map((row) => byId.get(row.id)).filter(Boolean);
  const seen = new Set(kept.map((row) => row.id));
  return [...kept, ...fresh.filter((row) => !seen.has(row.id))];
}

function saveSoon() {
  if (consoles.current) {
    consoles.saver.touch(consoles.current, capture(world, operator, parts.chat));
  }
}

async function openConsole(row, { ask = true } = {}) {
  if (consoles.saver.pending && consoles.saver.pending !== row.id) {
    const leaving = consoles.rows.find((item) => item.id === consoles.saver.pending);
    if (ask && !confirm(`"${leaving?.name ?? "That console"}" has unsaved changes. Open "${row.name}" and lose them?`)) {
      return { opened: false, reason: "The operator kept the console they were in." };
    }
    if (!ask) {
      return {
        opened: false,
        unsaved: leaving?.name ?? consoles.saver.pending,
        error: `"${leaving?.name ?? "The open console"}" has unsaved changes that opening "${row.name}" would lose. Save it first, or tell the operator what they are about to lose and let them decide.`,
      };
    }
  }
  consoles.current = row.id;
  rememberOpen(row.id);
  restore(world, row.state, operator, parts.chat, sybil);
  strip.restage();
  pushUpdate("system", `Console "${row.name}" opened`);
  showConsoles();
  await attachScripts(row);
  return { opened: true, console: { id: row.id, name: row.name, note: row.note ?? "" } };
}

async function attachScripts(row) {
  paintBoard([]);
  const started = await instance.attach(row, {
    world,
    weather: live.weather,
    forecast: live.forecast,
    operator,
  });
  if (instance.trouble) {
    pushUpdate("system", instance.trouble);
  }
  if (started && instance.scripts.length) {
    pushUpdate(
      "system",
      `${instance.scripts.length} script${instance.scripts.length === 1 ? "" : "s"} running: ` +
        instance.scripts.map((script) => script.name).join(", "),
    );
  }
  strip.render();
}

async function showConsoles(message) {
  strip.active = null;
  strip.render();
  globe.select(null);
  const panel = inspector.showConsoles(consoles.rows, {
    current: consoles.current,
    unsaved: consoles.saver.pending,
    signedIn: consoles.signedIn,
    onSave: async (button) => {
      button.disabled = true;
      try {
        await consoles.saver.save(consoles.current, capture(world, operator, parts.chat));
      } catch (error) {
        pushUpdate("system", `Could not save: ${error.message}`);
      }
      showConsoles();
    },
    documents: library.documents,
    onAddDoc: async (name, text) => {
      await addDocument(name, text);
      await library.refresh();
      library.load();
      pushUpdate("system", `"${name}" added to your data`);
      showConsoles();
    },
    onScreen: () => enterScreening(),
    onDropDoc: async (row, button) => {
      button.disabled = true;
      try {
        await dropDocument(row.id);
        await library.refresh();
        pushUpdate("system", `"${row.name}" removed from your data`);
        showConsoles();
      } catch (error) {
        button.disabled = false;
        showConsoles(error.message);
      }
    },
    onOpen: (row) => openConsole(row),
    onCreate: async (button) => {
      button.disabled = true;
      try {
        const { instance: made, instances } = await create(`Console ${consoles.rows.length + 1}`, "");
        consoles.rows = instances;
        consoles.current = made.id;
        rememberOpen(made.id);
        restore(world, { hazards: [] }, operator, parts.chat, sybil);
        instance.detach();
        paintBoard([]);
        strip.restage();
        pushUpdate("system", `Console "${made.name}" created`);
        showConsoles();
      } catch (error) {
        button.disabled = false;
        showConsoles(error.message);
      }
    },
    onRename: async (row, name, note) => {
      try {
        const fresh = (await rename(row.id, name, note)).instances;
        consoles.rows = inOldOrder(consoles.rows, fresh);
        showConsoles();
      } catch (error) {
        showConsoles(error.message);
      }
    },
    onDelete: async (row) => {
      try {
        consoles.rows = (await remove(row.id)).instances;
        if (consoles.current === row.id) {
          consoles.current = null;
          rememberOpen(null);
          restore(world, { hazards: [] }, operator, parts.chat, sybil);
          instance.detach();
          paintBoard([]);
          strip.restage();
        }
        pushUpdate("system", `Console "${row.name}" deleted`);
        showConsoles();
      } catch (error) {
        showConsoles(error.message);
      }
    },
  });
  if (message) {
    const line = document.createElement("p");
    line.className = "detail__note";
    line.textContent = message;
    panel.append(line);
  }
}

const screening = new Screening({
  onProgress: (step) => paintScreen(step),
  live: new URLSearchParams(window.location.search).get("screen") !== "sample",
});
const screen = { on: false, state: null, running: false };

const MODE_MS = 900;

let cameraWas = null;

function glidePanel(into) {
  const panel = $("[data-panel]");
  const chat = $(".chat");
  const before = panel.getBoundingClientRect();
  const chatWas = chat?.getBoundingClientRect().height ?? 0;
  document.body.classList.toggle("is-screening", into);
  const after = panel.getBoundingClientRect();
  growChat(chat, chatWas);

  panel.classList.add("is-travelling");
  const box = (rect) => {
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.width = `${rect.width}px`;
    panel.style.height = `${rect.height}px`;
  };
  panel.style.transition = "none";
  panel.style.position = "fixed";
  panel.style.right = "auto";
  panel.style.bottom = "auto";
  panel.style.margin = "0";
  box(before);
  void panel.offsetWidth;
  panel.style.transition = [
    `left ${MODE_MS}ms var(--ease-out)`,
    `top ${MODE_MS}ms var(--ease-out)`,
    `width ${MODE_MS}ms var(--ease-out)`,
    `height ${MODE_MS}ms var(--ease-out)`,
  ].join(", ");
  box(after);

  clearTimeout(glidePanel.settle);
  glidePanel.settle = setTimeout(() => {
    for (const name of ["transition", "position", "left", "top", "right", "bottom", "width", "height", "margin"]) {
      panel.style.removeProperty(name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
    }
    panel.classList.remove("is-travelling");
  }, MODE_MS + 60);
}

function growChat(chat, from) {
  if (!chat) {
    return;
  }
  const to = chat.getBoundingClientRect().height;
  if (!from || Math.abs(to - from) < 1) {
    return;
  }
  chat.style.transition = "none";
  chat.style.alignSelf = "end";
  chat.style.height = `${from}px`;
  void chat.offsetHeight;
  chat.style.transition = `height ${MODE_MS}ms var(--ease-out)`;
  chat.style.height = `${to}px`;
  clearTimeout(growChat.settle);
  growChat.settle = setTimeout(() => {
    chat.style.transition = "";
    chat.style.height = "";
    chat.style.alignSelf = "";
  }, MODE_MS + 60);
}

function reframeGlobe(into) {
  if (!into) {
    globe.frame(0, 0, { duration: MODE_MS });
    if (cameraWas !== null) {
      globe.dollyTo(cameraWas, { duration: MODE_MS });
      cameraWas = null;
    }
    return;
  }
  const panel = $("[data-panel]").getBoundingClientRect();
  const rail = $(".chat")?.getBoundingClientRect().width ?? 0;
  globe.frame(Math.round(rail * 0.78), Math.round(panel.height * 0.72), { duration: MODE_MS });
  cameraWas = globe.distance();
  globe.dollyTo(globe.controls.maxDistance, { duration: MODE_MS });
}

function paintScreen(progress) {
  if (!screen.on) {
    return;
  }
  if (progress) {
    const map = {
      catalogue: "Fetching the tracked catalogue\u2026",
      fetch: `Fetching ${progress.group}\u2026`,
      preparing: `Reading elements across ${progress.lanes ?? 1} cores\u2026`,
      screening: progress.sample ? "Building a sample screen\u2026" : "Sweeping the next 24 hours\u2026",
    };
    screen.state = {
      ...screen.state,
      message: map[progress.stage] ?? screen.state?.message,
      fraction: progress.fraction ?? (progress.stage === "screening" ? 0 : null),
      detail: progress.sample
        ? "Sample data \u00b7 drop ?screen=sample for the real catalogue"
        : progress.stage === "screening"
          ? `${Math.round((progress.fraction ?? 0) * 100)}% \u00b7 ${progress.lanes ?? 1} workers, one per slice of the day`
          : "Public elements from CelesTrak. One download a session.",
    };
  }
  inspector.showScreening(
    { ...screen.state, caveat: CAVEAT },
    {
      onBack: () => leaveScreening(),
      onRun: () => runScreen(),
      onCancel: () => {
        screening.cancel();
        leaveScreening();
      },
      onFocus: (row) => {
        const craft = world.satellites.find((sat) => sat.id === row.mine);
        if (craft) {
          globe.select(craft);
          globe.lookAtGeo(craft.latitude, craft.longitude);
        }
      },
    },
  );
}

async function runScreen({ show = true } = {}) {
  if (screen.running) {
    if (show) {
      paintScreen();
    }
    return;
  }
  if (show) {
    screen.state = { message: "Fetching the tracked catalogue\u2026", fraction: null };
  }
  screen.running = true;
  paintScreen();
  try {
    const result = await screening.run(world.satellites, { hours: 24 });
    if (!result) {
      return;
    }
    screen.state = { result };
    if (screen.on) {
      globe.markRisk(byCraft(result));
    }
    const alerts = result.alerts;
    pushUpdate(
      alerts ? "debris" : "system",
      alerts
        ? `${alerts} close approach${alerts === 1 ? "" : "es"} under ${result.alertKm} km in the next ${result.hours} h`
        : `No approach under ${result.alertKm} km in the next ${result.hours} h`,
    );
  } catch (error) {
    screen.state = { error: String(error.message ?? error) };
  } finally {
    screen.running = false;
  }
  paintScreen();
}

function enterScreening() {
  if (screen.on) {
    return;
  }
  screen.on = true;
  strip.active = null;
  globe.select(null);
  glidePanel(true);
  globe.focusConjunctions(true);
  reframeGlobe(true);
  if (screen.state?.result) {
    globe.markRisk(byCraft(screen.state.result));
    paintScreen();
  } else {
    runScreen();
  }
}

function leaveScreening() {
  if (!screen.on) {
    return;
  }
  screen.on = false;
  screening.stop();
  globe.markRisk(new Map());
  globe.focusConjunctions(false);
  reframeGlobe(false);
  glidePanel(false);
  showConsoles();
}

$("[data-home]").addEventListener("click", () => {
  if (screen.on) {
    leaveScreening();
    return;
  }
  showConsoles();
});

world.addEventListener("change", () => saveSoon());

whoami().then(async (status) => {
  consoles.signedIn = Boolean(status?.user);
  if (consoles.signedIn) {
    try {
      consoles.rows = await list();
    } catch {
      consoles.rows = [];
    }
    await library.refresh();
    library.load();

    const handed = sessionStorage.getItem("aos:console:open");
    sessionStorage.removeItem("aos:console:open");
    const remembered = lastOpen();
    const oldest = [...consoles.rows].sort((a, b) => String(a.created).localeCompare(String(b.created)))[0];
    const arriving =
      (handed ? consoles.rows.find((row) => row.id === handed) : null) ??
      (remembered ? consoles.rows.find((row) => row.id === remembered) : null) ??
      oldest ??
      null;
    if (arriving) {
      consoles.current = arriving.id;
      if (handed) {
        rememberOpen(arriving.id);
      }
      restore(world, arriving.state, operator, parts.chat, sybil);
      strip.restage();
      pushUpdate("system", `Console "${arriving.name}" opened`);
      await attachScripts(arriving);
      showConsoles();
      return;
    }
  }
  showConsoles();
});

new Bearings(document.body, globe);

(() => {
  const dock = $("[data-motion]");
  const GAP = 12;
  const publish = () => {
    const panel = Math.ceil(controls.getBoundingClientRect().height);
    const row = Math.ceil(dock.getBoundingClientRect().height);
    const root = document.documentElement.style;
    root.setProperty("--controls-h", `${panel}px`);
    root.setProperty("--lower-left-h", `${panel + GAP + row}px`);
  };
  publish();
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(publish);
    observer.observe(controls);
    observer.observe(dock);
  } else {
    window.addEventListener("resize", publish, { passive: true });
  }
})();

const sybil = new Sybil({
  tools,
  context: () => instance.describe(),
  onActivity: (name) => {
    if (thinking) {
      thinking.say(`${name}…`);
    }
  },
});

let thinking = null;
let busy = false;

const chat = new Chat($("[data-chat]"), {
  onSend: async (text) => {
    if (busy) {
      return;
    }
    if (sybil.available === false) {
      const { reply, meta, hazard } = interpret(text, legacyTools);
      chat.push("aos", reply, meta);
      strip.render();
      if (hazard) {
        pushUpdate(hazard.kind, `${hazard.spec.name} injected at ${hazard.lat.toFixed(0)}°, ${hazard.lon.toFixed(0)}°`);
        strip.active = hazard.id;
        strip.render();
        openHazard(hazard);
      }
      return;
    }

    busy = true;
    thinking = chat.working();
    try {
      const { reply, meta } = await sybil.send(text);
      thinking.done();
      chat.push("aos", reply, meta);
      record("chat", text, { reply: reply.slice(0, 600), tools: meta || null });
    } catch (error) {
      thinking.done();
      chat.push("aos", `I could not reach the model: ${error.message ?? error}`, "relay error");
    } finally {
      thinking = null;
      busy = false;
      strip.render();
      paintStats();
    }
  },
});

const opening = (() => {
  const loader = new Loader($("[data-loader]"), "Opening the console");
  const total = 5;
  const landed = new Set();
  let lifted = false;

  const lift = () => {
    if (lifted) {
      return;
    }
    lifted = true;
    loader.progress(1);
    loader.done();
  };

  const giveUp = setTimeout(lift, 8000);

  return {
    reached(step) {
      if (landed.has(step)) {
        return;
      }
      landed.add(step);
      loader.progress(landed.size / total);
      if (landed.has("catalogue") && landed.has("frame")) {
        clearTimeout(giveUp);
        lift();
      }
    },
    fail(message) {
      loader.fail(message);
      clearTimeout(giveUp);
    },
  };
})();

parts.chat = chat;

const boot = chat.boot([
  ["relay", "Handing Sybil the console", "is-running"],
  ["catalogue", "Fetching the orbital catalogue", "is-running"],
  ["weather", "Reading space weather"],
  ["forecast", "Loading the forecast model"],
]);

sybil.probe().then((status) => {
  boot[status.ready ? "done" : "fail"]("relay", status.ready ? "ready" : "no model");
  opening.reached("relay");
  if (status.ready) {
    chat.push(
      "aos",
      "Console live. Ask me anything about the network, the weather it is flying through, or what is forecast — and tell me to change it if you want to see what happens.",
      `${status.provider} · ${status.model} · ${Object.keys(tools).length} tools`,
      { transient: true },
    );
  } else {
    chat.push(
      "aos",
      "Console live, running without a model. I understand a handful of phrasings: “status”, “worst affected”, “inject a solar flare over the Pacific”, “clear hz-001”. Set an API key on the server for the rest.",
      "keyword parser · no model",
      { transient: true },
    );
  }
});

const statsRoot = $("[data-stats]");
const stats = [
  { id: "links", label: "Links", warn: () => false },
  { id: "degraded", label: "Degraded", warn: (summary) => summary.degraded > 0 },
  { id: "quality", label: "Quality", warn: (summary) => summary.capacity < 0.85 },
  { id: "nav", label: "Nav fix", warn: (summary) => summary.navCoverage < 1 },
].map((stat) => {
  const node = document.createElement("div");
  node.className = "stat";
  node.innerHTML = '<span class="stat__label"></span><span class="stat__value"></span>';
  node.querySelector(".stat__label").textContent = stat.label;
  statsRoot.append(node);
  return { ...stat, node, value: node.querySelector(".stat__value") };
});

function paintStats() {
  const summary = world.summary();
  const text = {
    links: String(summary.total),
    degraded: String(summary.degraded),
    quality: `${Math.round(summary.capacity * 100)}%`,
    nav: `${Math.round(summary.navCoverage * 100)}%`,
  };
  for (const stat of stats) {
    stat.value.textContent = text[stat.id];
    stat.node.classList.toggle("is-warn", stat.warn(summary));
  }
}

setInterval(paintStats, 500);
paintStats();

world.addEventListener("change", ({ detail }) => {
  if (detail.what === "hazards") {
    strip.render();
  }
});

(() => {
  const side = document.querySelector(".side");
  const grip = $("[data-grip]");
  const MIN = 112;

  const clamp = (height) => {
    const room = side.clientHeight - 200;
    const natural = chat.naturalHeight();
    const ceiling = natural ? Math.min(room, Math.max(MIN, natural)) : room;
    return Math.max(MIN, Math.min(height, ceiling));
  };

  const apply = (height) => {
    side.style.setProperty("--chat-h", `${clamp(height)}px`);
    chat.reflow();
  };

  grip.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    grip.classList.add("is-dragging");
    document.body.classList.add("is-resizing");

    const move = (move_) => apply(side.getBoundingClientRect().bottom - move_.clientY - 18);
    const up = () => {
      grip.classList.remove("is-dragging");
      document.body.classList.remove("is-resizing");
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  });

  grip.addEventListener("keydown", (event) => {
    const step = { ArrowUp: 28, ArrowDown: -28 }[event.key];
    if (!step) {
      return;
    }
    event.preventDefault();
    const chat = document.querySelector(".chat");
    apply(chat.getBoundingClientRect().height + step);
  });
})();

const motion = (() => {
  const root = $("[data-motion]");
  const toggle = $("[data-motion-toggle]");
  const body = $("[data-motion-body]");
  const status = $("[data-motion-status]");

  const tracker = new HandTracker({
    view: $("[data-motion-view]"),
    onStatus: ({ state, text }) => {
      status.textContent = text;
      for (const name of ["is-live", "is-loading", "is-error"]) {
        root.classList.remove(name);
      }
      if (state !== "off") {
        root.classList.add(`is-${state}`);
      }
    },
  });

  const help = $("[data-motion-help]");
  const legend = $("#motion-legend");
  help.addEventListener("click", () => {
    const open = help.getAttribute("aria-expanded") !== "true";
    help.setAttribute("aria-expanded", String(open));
    legend.hidden = !open;
  });

  toggle.addEventListener("click", async () => {
    const starting = !tracker.active;
    if (starting) {
      body.hidden = false;
    }
    const live = await tracker.toggle();
    pump();
    toggle.setAttribute("aria-pressed", String(live));
    body.hidden = !live && !root.classList.contains("is-error");
  });

  let previous = performance.now();
  let driving = 0;
  const drive = (now) => {
    if (!tracker.active) {
      driving = 0;
      return;
    }
    driving = requestAnimationFrame(drive);
    const dt = (now - previous) / 1000;
    previous = now;
    const { dx, dy, scale } = tracker.reader.sample(dt);
    const gain = globe.canvas.clientHeight || 800;
    if (dx || dy) {
      globe.orbit(dx * gain, dy * gain);
    }
    globe.zoom(scale);
  };
  const pump = () => {
    if (tracker.active && !driving) {
      previous = performance.now();
      driving = requestAnimationFrame(drive);
    }
  };

  window.addEventListener("pagehide", () => tracker.stop());

  return tracker;
})();

const cameFrom = new URLSearchParams(window.location.search).get("from");
const back = cameFrom === "core" ? { route: ROUTES.core, name: "Meta Console" } : { route: ROUTES.deck, name: "Deck" };

{
  const button = $("[data-back]");
  button.lastChild.textContent = ` ${back.name}`;
  button.setAttribute("aria-label", `Back to the ${back.name.toLowerCase()}`);
  button.addEventListener("click", async () => {
    motion.stop();
    markHandoff();
    if (cameFrom === "core") {
      const origin = { x: 24, y: 26 };
      sessionStorage.setItem("core:enter", JSON.stringify(origin));
      await closeAperture(origin);
    }
    window.location.href = back.route;
  });
}

async function enterCore() {
  motion.stop();
  markHandoff();
  const panel = $("[data-panel]")?.getBoundingClientRect();
  const origin = panel
    ? { x: panel.left + panel.width / 2, y: panel.top + panel.height / 2 }
    : null;
  sessionStorage.setItem("core:enter", JSON.stringify(origin));
  await closeAperture(origin);
  window.location.href = ROUTES.core;
}

const entry = sessionStorage.getItem("orbital:enter");
if (entry !== null) {
  sessionStorage.removeItem("orbital:enter");
  let origin = null;
  try {
    origin = JSON.parse(entry);
  } catch {
    origin = null;
  }
  openAperture(origin);
}

ambient({ mount: $("[data-ambient-mount]") });

(async () => {
  const report = (text, meta) => chat.push("aos", text, meta, { transient: true });

  try {
    const [{ fleet, counts, fetched }, engine] = await Promise.all([fetchFleet(), propagator()]);
    if (world.adopt({ fleet, propagator: engine })) {
      globe.rebuild();
      strip.render();
      const breakdown = Object.entries(counts)
        .map(([name, count]) => `${count} ${name}`)
        .join(", ");
      report(
        `Catalogue loaded: ${fleet.length} tracked objects (${breakdown}), propagated with SGP4 from elements issued ${fetched.slice(0, 10)}.`,
        "celestrak · sgp4",
      );
      pushUpdate("system", `${fleet.length} catalogue objects under SGP4`);
      boot.done("catalogue", `${fleet.length} objects`);
      opening.reached("catalogue");
    } else {
      boot.fail("catalogue", "rejected");
      opening.reached("catalogue");
    }
  } catch (error) {
    console.warn("[aos] catalogue unavailable, staying on the modelled fleet", error);
    report("Catalogue unreachable — the fleet on screen is modelled, not tracked.", "offline");
    boot.fail("catalogue", "offline");
    opening.reached("catalogue");
  }

  boot.start("weather");
  try {
    const weather = await currentWeather();
    live.weather = weather;
    boot.done("weather", weather.live ? "live" : "cached");
    opening.reached("weather");
    let prediction = null;
    boot.start("forecast");
    try {
      live.model = await loadModel();
      prediction = forecast(weather.days, live.model);
      live.forecast = prediction;
      boot.done("forecast", `Kp ${prediction.kp.toFixed(1)}`);
      opening.reached("forecast");
    } catch (error) {
      console.warn("[aos] forecast model unavailable", error);
      boot.fail("forecast", "unavailable");
      opening.reached("forecast");
    }

    const made = applyLive(world, { weather, prediction }, new Date());
    strip.render();
    report(`Conditions: ${describeConditions({ weather, prediction })}.`, weather.live ? "noaa swpc" : "cached");

    if (prediction) {
      const skill = (await loadModel()).metrics.skill.rmseOverPersistence;
      report(
        `Forecast for ${prediction.date}: Kp ${prediction.kp.toFixed(1)}, ` +
          `${(prediction.probability * 100).toFixed(0)}% chance of storm level. ` +
          `Persistence would say ${prediction.persistence.toFixed(1)}; on held-out years this network removes ` +
          `${(skill * 100).toFixed(0)}% of persistence's error.`,
        "kp-net · 20 features",
      );
      pushUpdate("storm", `Kp ${prediction.kp.toFixed(1)} forecast for ${prediction.date}`);
    }
    for (const hazard of made) {
      pushUpdate(hazard.kind, `${hazard.label} (${hazard.origin})`);
    }
  } catch (error) {
    console.warn("[aos] space weather unavailable", error);
    report("Space weather feed unreachable — hazards on the stack are modelled.", "offline");
    boot.fail("weather", "offline");
    opening.reached("weather");
    boot.fail("forecast", "no input");
    opening.reached("forecast");
  }
})();

globe.onTick = (dt) => {
  opening.reached("frame");
  instance.step(dt, world);
};

globe.start();
