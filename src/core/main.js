
import { ROUTES } from "../routes.js";
import { ambient, markHandoff } from "../ambient.js";
import { openAperture } from "../aperture.js";
import { Sky } from "../profile/sky.js";
import { mark, whoami } from "../session.js";
import { Engine } from "../orbital/core.js";
import { current as liveWeather } from "../orbital/spaceweather.js";
import * as api from "./client.js";
import { renderBoard, renderBrief, renderConsoles, renderScripts, renderViewer } from "./ui.js";
import { el } from "../ui/board.js";

const $ = (selector) => document.querySelector(selector);
const where = {
  board: $("[data-board]"),
  consoles: $("[data-consoles]"),
  scripts: $("[data-scripts]"),
  viewer: $("[data-viewer]"),
  brief: $("[data-brief]"),
  file: $("[data-file]"),
  sky: $("[data-sky]"),
};

new Sky(where.sky).start();
ambient();

const LAST = "aos:core:open";

const state = {
  signedIn: false,
  consoles: [],
  current: sessionStorage.getItem(LAST) || null,
  scripts: [],
  bundle: { status: "none", bytes: 0, log: [] },
  forge: null,
  open: null,
  edited: null,
  building: false,
  steps: null,
  saving: false,
  diagnostics: [],
  preview: { state: "idle", detail: "", board: [], manifest: null, reports: [] },
};

let shown = null;

const dirty = () =>
  Boolean(
    state.edited &&
      state.open &&
      (state.edited.source !== state.open.source || state.edited.manifest !== state.open.manifest),
  );

function paint() {
  renderConsoles(where.consoles, {
    rows: state.consoles,
    current: state.current,
    signedIn: state.signedIn,
    onOpen: (row) => openConsole(row.id),
    onRename: renameConsole,
    onDrop: dropConsole,
  });

  renderScripts(where.scripts, {
    rows: state.scripts,
    bundle: state.bundle,
    forge: state.forge,
    selected: state.open?.id ?? null,
    current: state.current,
    busy: state.building,
    steps: state.steps,
    onPick: (row) => openScript(row.id),
    onAdd: () => where.file.click(),
    onBuild: buildNow,
    onEnable: async (row, on) => {
      await guard(() => api.enable(state.current, row.id, on), refreshScripts);
    },
    onMove: async (from, to) => {
      const order = state.scripts.map((row) => row.id);
      const [moved] = order.splice(from, 1);
      order.splice(to, 0, moved);
      await guard(() => api.reorder(state.current, order), refreshScripts);
    },
    onDrop: async (row) => {
      await guard(() => api.remove(state.current, row.id), () => {
        if (state.open?.id === row.id) {
          state.open = null;
          state.edited = null;
        }
        return refreshScripts();
      });
    },
  });

  const open = state.open?.id ?? null;
  renderViewer(where.viewer, {
    script: state.edited ?? state.open,
    fresh: open !== shown,
    diagnostics: state.diagnostics.filter(
      (d) => !d.script || !state.open || d.script === state.open.name,
    ),
    dirty: dirty(),
    saving: state.saving,
    onSave: saveOpen,
    onRevert: () => {
      state.edited = null;
      paint();
    },
    onBuild: async () => {
      if (dirty()) {
        await saveOpen();
      }
      await buildNow();
    },
  });
  shown = open;

  renderBoard(where.board, {
    entries: state.preview.board,
    state:
      state.preview.state === "ready"
        ? "ready"
        : state.preview.state === "running"
          ? "running"
          : state.preview.state === "error"
            ? "error"
            : "none",
    detail: state.preview.detail,
  });

  renderBrief(where.brief, {
    manifest: state.preview.manifest,
    reports: state.preview.reports,
    state: state.preview.state,
    detail: state.preview.detail,
  });
}

async function guard(work, after) {
  try {
    const result = await work();
    if (after) {
      await after(result);
    }
    return result;
  } catch (error) {
    say(error.message);
    paint();
    return null;
  }
}

function say(message) {
  state.preview.board = [
    {
      level: "alarm",
      title: "Core",
      detail: message,
      from: "page",
      at: Date.now(),
      sticky: true,
      glyph: "!",
    },
    ...state.preview.board.filter((entry) => entry.from !== "page"),
  ];
  if (state.preview.state === "idle" || state.preview.state === "none") {
    state.preview.state = "ready";
  }
}

async function loadConsoles() {
  state.consoles = (await api.consoles().catch(() => [])) ?? [];
  if (!state.consoles.some((row) => row.id === state.current)) {
    state.current = state.consoles[0]?.id ?? null;
  }
}

async function openConsole(id) {
  state.current = id;
  sessionStorage.setItem(LAST, id);
  state.open = null;
  state.edited = null;
  state.diagnostics = [];
  state.preview = { state: "idle", detail: "", board: [], manifest: null, reports: [] };
  await refreshScripts();
}

async function renameConsole(row) {
  const name = prompt("Name", row.name);
  if (!name) {
    return;
  }
  const note = prompt("What is this console for?", row.note ?? "") ?? "";
  await guard(() => api.renameConsole(row.id, name.trim(), note.trim()), (body) => {
    state.consoles = body.instances;
    paint();
  });
}

async function dropConsole(row) {
  const count = row.id === state.current ? state.scripts.length : null;
  const carries = count ? ` and the ${count} script${count === 1 ? "" : "s"} in it` : "";
  if (!confirm(`Delete "${row.name}"${carries}? This cannot be undone.`)) {
    return;
  }
  await guard(() => api.dropConsole(row.id), async (body) => {
    state.consoles = body.instances;
    if (state.current === row.id) {
      state.current = state.consoles[0]?.id ?? null;
      await openConsole(state.current);
      return;
    }
    paint();
  });
}

async function refreshScripts() {
  if (!state.current) {
    state.scripts = [];
    state.bundle = { status: "none", bytes: 0, log: [] };
    paint();
    return;
  }
  const body = await api.scripts(state.current).catch((error) => {
    say(error.message);
    return null;
  });
  if (body) {
    state.scripts = body.scripts;
    state.bundle = body.bundle;
    state.forge = body.forge ?? state.forge;
    state.diagnostics = body.bundle.log ?? [];
  }
  paint();
  await preview();
}

async function openScript(id) {
  const file = await guard(() => api.script(state.current, id));
  if (file) {
    state.open = file;
    state.edited = { ...file };
    paint();
  }
}

async function saveOpen() {
  if (!state.open || !dirty()) {
    return;
  }
  state.saving = true;
  paint();
  const body = await guard(() =>
    api.save(state.current, state.open.id, {
      name: state.edited.name,
      source: state.edited.source,
      manifest: state.edited.manifest,
    }),
  );
  state.saving = false;
  if (body) {
    state.open = { ...state.open, source: state.edited.source, manifest: state.edited.manifest };
    state.edited = { ...state.open };
    state.scripts = body.scripts;
    state.bundle = body.bundle;
  }
  paint();
}

async function takeFiles(files) {
  const sources = [];
  const manifests = new Map();
  for (const file of files) {
    const text = await file.text();
    if (/\.toml$/i.test(file.name)) {
      manifests.set(file.name.replace(/\.toml$/i, "").toLowerCase(), text);
    } else {
      sources.push({ name: file.name, source: text });
    }
  }
  if (!sources.length) {
    say("No .rs file in that selection. A script is Rust source; the Cargo.toml is optional.");
    paint();
    return;
  }
  const lone = manifests.size === 1 && sources.length === 1 ? [...manifests.values()][0] : null;
  for (const file of sources) {
    const key = file.name.replace(/\.rs$/i, "").toLowerCase();
    await guard(() =>
      api.upload(state.current, {
        name: file.name,
        source: file.source,
        manifest: manifests.get(key) ?? lone ?? "",
      }),
    );
  }
  await refreshScripts();
}

function buildSteps(current, done = {}) {
  const crates = state.scripts.filter((row) => row.enabled).flatMap((row) => row.dependencies);
  const order = [
    ["send", "Sourcing"],
    [
      "compile",
      crates.length
        ? `Compiling, with ${crates.length} crate${crates.length === 1 ? "" : "s"} to fetch`
        : "Compiling",
    ],
    ["load", "Loading the bundle"],
    ["run", "Injecting the scripts"],
  ];
  const at = order.findIndex(([key]) => key === current);
  return order.map(([key, label], index) => {
    if (done[key]) {
      return { label, state: done[key], word: done[key] === "failed" ? "failed" : "done" };
    }
    if (index === at) {
      return { label, state: "running", word: "" };
    }
    return { label, state: index < at ? "done" : "waiting", word: index < at ? "done" : "" };
  });
}

function phase(current, done) {
  state.steps = buildSteps(current, done);
  paint();
}

async function buildNow() {
  state.building = true;
  state.preview = { state: "running", detail: "", board: [], manifest: null, reports: [] };
  const done = {};
  phase("send", done);

  let ok = false;
  try {
    phase("compile", done);
    const body = await api.build(state.current);
    state.scripts = body.scripts;
    state.bundle = body.bundle;
    state.diagnostics = body.bundle.log ?? [];
    if (body.built === false && body.reason) {
      done.compile = body.cleaned ? "done" : "failed";
      say(body.reason);
    } else {
      done.compile = "done";
      ok = true;
    }
  } catch (error) {
    const body = error.body ?? {};
    state.scripts = body.scripts ?? state.scripts;
    state.bundle = body.bundle ?? { ...state.bundle, status: "failed" };
    state.diagnostics = state.bundle.log ?? [];
    done.compile = "failed";
    say(
      state.diagnostics.find((d) => d.level === "error")?.message ??
        error.message ??
        "The build failed.",
    );
  }

  if (!ok) {
    phase(null, done);
    setTimeout(() => {
      state.building = false;
      state.steps = null;
      paint();
    }, 1100);
    await preview();
    return;
  }

  await preview({ phase, done });
  state.building = false;
  state.steps = null;
  paint();
}

async function preview(watch = null) {
  if (!state.current || (state.bundle.status !== "built" && state.bundle.status !== "stale")) {
    state.preview = {
      state: "none",
      detail:
        state.bundle.status === "failed"
          ? "The last build failed, so there is no bundle to run."
          : "No bundle yet. Build the scripts and this fills in from what they actually do.",
      board: [],
      manifest: null,
      reports: [],
    };
    paint();
    return;
  }

  state.preview = { state: "running", detail: "", board: [], manifest: null, reports: [] };
  paint();

  try {
    watch?.phase("load", watch.done);
    const engine = await Engine.load(api.bundleUrl(state.current));
    const row = state.consoles.find((c) => c.id === state.current);
    engine.open({
      id: state.current,
      name: row?.name ?? "Console",
      note: row?.note ?? "",
      epoch: Date.now(),
    });

    let against = "the engine's defaults";
    try {
      const weather = await liveWeather();
      const last = weather.days.at(-1);
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
          live: weather.live,
        });
        against = weather.live ? "today's measured weather" : "the baked history";
      }
    } catch {
    }

    watch?.phase("run", { ...watch.done, load: "done" });
    const manifest = engine.manifest();

    const wall = Date.now();
    for (let step = 0; step < 120; step += 1) {
      engine.step(1, wall + step * 1000);
    }
    const last = engine.step(0, wall + 120_000);

    const marks = new Map(manifest.scripts.map((s) => [s.id, { glyph: s.glyph, tint: s.tint }]));
    state.preview = {
      state: "ready",
      detail: against,
      board: last.board.map((entry) => ({ ...entry, ...(marks.get(entry.from) ?? {}) })),
      manifest,
      reports: engine.report().reports,
    };
    if (last.stopped.length) {
      state.preview.board.unshift(
        ...last.stopped.map((row) => ({
          level: "alarm",
          title: `${row.script} was stopped`,
          detail: row.why,
          from: "host",
          at: Date.now(),
          sticky: true,
          glyph: "!",
        })),
      );
    }
  } catch (error) {
    state.preview = {
      state: "error",
      detail: `${error.message}`,
      board: [],
      manifest: null,
      reports: [],
    };
  }
  paint();
}

where.viewer.addEventListener("edited", (event) => {
  if (!state.edited) {
    return;
  }
  Object.assign(state.edited, event.detail);
  const save = where.viewer.querySelector(".viewer__tool--go");
  if (save) {
    save.disabled = !dirty();
  }
});

where.file.addEventListener("change", async () => {
  const files = [...(where.file.files ?? [])];
  where.file.value = "";
  if (files.length) {
    await takeFiles(files);
  }
});

$("[data-back]").addEventListener("click", () => {
  sessionStorage.setItem("aos:return", "deck");
  markHandoff();
  window.location.href = ROUTES.deck;
});

document.addEventListener("dragover", (event) => {
  if (state.current) {
    event.preventDefault();
    document.body.classList.add("is-dropping");
  }
});
document.addEventListener("dragleave", (event) => {
  if (event.relatedTarget === null) {
    document.body.classList.remove("is-dropping");
  }
});
document.addEventListener("drop", async (event) => {
  event.preventDefault();
  document.body.classList.remove("is-dropping");
  const files = [...(event.dataTransfer?.files ?? [])];
  if (state.current && files.length) {
    await takeFiles(files);
  }
});

const arrived = sessionStorage.getItem("core:enter");
if (arrived !== null) {
  sessionStorage.removeItem("core:enter");
  let origin = null;
  try {
    origin = JSON.parse(arrived);
  } catch {
    origin = null;
  }
  openAperture(origin);
}

async function start() {
  const status = await whoami();
  const user = mark(document.body, status);
  state.signedIn = Boolean(user);

  const who = $("[data-who]");
  if (user) {
    who.replaceChildren();
    if (user.org) {
      who.append(el("span", "bar__org", user.org));
    }
    const open = document.createElement("button");
    open.type = "button";
    open.className = "bar__open";
    open.textContent = "Open in console";
    open.addEventListener("click", () => {
      if (!state.current) {
        return;
      }
      sessionStorage.setItem("aos:console:open", state.current);
      sessionStorage.setItem("aos:return", "deck");
      markHandoff();
      window.location.href = `${ROUTES.orbital}?from=core`;
    });
    who.append(open);
  } else {
    who.textContent = "Not signed in";
  }

  if (!state.signedIn) {
    paint();
    return;
  }

  await loadConsoles();
  await refreshScripts();
}

start();
