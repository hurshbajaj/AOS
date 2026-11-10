
import { badge, bytes, button, el } from "../ui/board.js";
import { paint } from "./highlight.js";

export { renderBoard } from "../ui/board.js";

export function titleOf(name) {
  const stem = String(name ?? "").replace(/\.rs$/i, "");
  if (!/^[a-z0-9]+([_-][a-z0-9]+)*$/.test(stem)) {
    return name;
  }
  return stem
    .split(/[_-]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function head(root, title, action) {
  const bar = el("div", "panel__head");
  bar.append(el("h2", "panel__title", title));
  if (action) {
    bar.append(action);
  }
  root.append(bar);
}

export function renderConsoles(root, { rows = [], current, signedIn, onOpen, onRename, onDrop }) {
  root.replaceChildren();
  head(root, "Consoles");

  if (!signedIn) {
    root.append(
      el(
        "p",
        "panel__empty",
        "Sign in on the profile page to keep consoles and scripts. Without an account there is " +
          "nowhere to file them.",
      ),
    );
    return;
  }

  if (!rows.length) {
    root.append(el("p", "panel__empty", "No consoles yet."));
    return;
  }

  const list = el("ul", "rows");
  for (const row of rows) {
    const item = el("li", `row${row.id === current ? " is-current" : ""}`);
    const open = button("row__open", "", () => onOpen(row));
    open.append(el("span", "row__name", row.name));
    const meta = el("span", "row__meta");
    meta.append(el("span", "", row.note || "No note"));
    open.append(meta);
    item.append(open);

    const tools = el("div", "row__tools");
    tools.append(
      button("row__tool", "Rename", () => onRename(row)),
      button("row__tool row__tool--bad", "×", () => onDrop(row), { title: "Delete this console" }),
    );
    item.append(tools);
    list.append(item);
  }
  root.append(list);
}

const STATUS = {
  none: { label: "No bundle", tone: "quiet" },
  building: { label: "Building…", tone: "busy" },
  built: { label: "Built", tone: "good" },
  stale: { label: "Stale — rebuild", tone: "warn" },
  failed: { label: "Failed", tone: "bad" },
};

export function renderScripts(
  root,
  { rows = [], bundle, forge, selected, current, busy, steps, onPick, onAdd, onBuild, onEnable, onMove, onDrop },
) {
  root.replaceChildren();
  head(root, "Scripts", current ? button("panel__act", "Add", () => onAdd(), { title: "Upload a .rs file" }) : null);

  if (!current) {
    root.append(el("p", "panel__empty", "Open a console to see its scripts."));
    return;
  }

  if (!rows.length) {
    root.append(
      el("p", "panel__empty", "No scripts yet. Upload a .rs file written against aos-sim."),
      el(
        "p",
        "panel__hint",
        forge?.sandboxed
          ? "Any crate on crates.io is allowed. Send a Cargo.toml alongside and its dependency table is read."
          : "This server cannot sandbox a build, so dependencies are refused. Write against aos-sim alone.",
      ),
    );
    const get = el("a", "panel__get", "Download aos-sim for your editor");
    get.href = "/api/scripting/aos-sim.tar.gz";
    get.download = "aos-sim.tar.gz";
    get.title = "Unpack it beside your crate and point a path dependency at it";
    root.append(get);
  } else {
    const list = el("ol", "rows");
    rows.forEach((row, at) => {
      const item = el("li", `row${row.id === selected ? " is-open" : ""}${row.enabled ? "" : " is-off"}`);
      const open = button("row__open", "", () => onPick(row));
      open.append(el("span", "row__name", row.name));
      const meta = el("span", "row__meta");
      meta.append(el("span", "", bytes(row.bytes)));
      if (!row.enabled) {
        meta.append(el("span", "row__off", "off"));
      }
      if (row.dependencies.length) {
        meta.append(el("span", "row__deps", row.dependencies.join(" · ")));
      }
      open.append(meta);
      item.append(open);

      const tools = el("div", "row__tools");
      tools.append(
        button("row__tool", row.enabled ? "On" : "Off", () => onEnable(row, !row.enabled), {
          title: row.enabled ? "Leave it out of the next build" : "Put it back in the next build",
        }),
      );
      if (rows.length > 1) {
        const up = button("row__tool", "↑", () => onMove(at, at - 1), { title: "Earlier" });
        up.disabled = at === 0;
        const down = button("row__tool", "↓", () => onMove(at, at + 1), { title: "Later" });
        down.disabled = at === rows.length - 1;
        tools.append(up, down);
      }
      tools.append(button("row__tool row__tool--bad", "×", () => onDrop(row), { title: "Delete" }));
      item.append(tools);
      list.append(item);
    });
    root.append(list);
  }

  if (busy && steps?.length) {
    root.append(renderBoot(steps));
    return;
  }

  const state = STATUS[bundle?.status ?? "none"] ?? STATUS.none;
  const foot = el("div", "build");
  const label = el("p", `build__state build__state--${state.tone}`, state.label);
  if (bundle?.status === "built" && bundle.bytes) {
    label.append(el("span", "build__size", bytes(bundle.bytes)));
  }
  foot.append(label);
  const buildable = rows.some((row) => row.enabled);
  const cleanable = !buildable && (bundle?.status ?? "none") !== "none";
  const go = button("build__go", buildable ? "Build" : "Clean", () => onBuild());
  go.disabled = !buildable && !cleanable;
  if (cleanable) {
    go.title = "No scripts to build. Clears the compiled bundle so the console runs its own physics.";
  }
  foot.append(go);
  if (forge && !forge.sandboxed) {
    foot.append(
      el(
        "p",
        "build__hint",
        "No sandbox on this host, so dependencies are refused rather than compiled unprotected.",
      ),
    );
  }
  root.append(foot);
}

export function renderBoot(steps) {
  const block = el("div", "boot");
  block.append(el("p", "boot__title", "Building"));
  const list = el("ul", "boot__list");
  for (const { label, state, word } of steps) {
    const row = el("li", `boot__step is-${state}`);
    row.append(
      el("span", "boot__dot"),
      el("span", "boot__label", label),
      el("span", "boot__state", word ?? ""),
    );
    list.append(row);
  }
  block.append(list);
  return block;
}

export function renderViewer(root, { script, diagnostics = [], dirty, saving, fresh, onSave, onRevert, onBuild }) {
  root.replaceChildren();
  root.classList.toggle("is-fresh", Boolean(fresh));

  if (!script) {
    const idle = el("div", "viewer__idle");
    const mark = el("span", "viewer__idle-mark", "◇");
    mark.setAttribute("aria-hidden", "true");
    idle.append(
      mark,
      el("h2", "viewer__idle-title", "Nothing open"),
      el(
        "p",
        "viewer__idle-note",
        "Pick a script to read it, or drop a .rs file anywhere on this page. A script is a crate " +
          "with one exported register function — the whole contract is in docs/SCRIPTING.md, and " +
          "examples/ has seven that compile as written.",
      ),
    );
    root.append(idle);
    return;
  }

  const bar = el("div", "viewer__head");
  const naming = el("div", "viewer__naming");
  naming.append(
    el("p", "viewer__kicker", dirty ? `${script.name} · unsaved` : script.name),
    el("h2", "viewer__name", titleOf(script.name)),
  );
  bar.append(naming);

  const tools = el("div", "viewer__tools");
  if (dirty) {
    tools.append(button("viewer__tool", "Revert", () => onRevert()));
  }
  const save = button("viewer__tool viewer__tool--go", saving ? "Saving…" : "Save", () => onSave());
  save.disabled = !dirty || Boolean(saving);
  tools.append(save, button("viewer__tool", "Save and build", () => onBuild()));
  bar.append(tools);
  root.append(bar);

  const errors = diagnostics.filter((d) => d.level === "error");
  const warnings = diagnostics.filter((d) => d.level === "warning");

  const flagged = new Map();
  for (const d of diagnostics) {
    if (d.line) {
      flagged.set(d.line, d.level === "error" ? "error" : (flagged.get(d.line) ?? "warning"));
    }
  }

  const frame = el("div", "code");
  const gutter = el("div", "code__gutter");
  gutter.setAttribute("aria-hidden", "true");

  const stack = el("div", "code__stack");
  const painted = el("pre", "code__paint");
  painted.setAttribute("aria-hidden", "true");
  const area = el("textarea", "code__text");
  area.value = script.source ?? "";
  area.spellcheck = false;
  area.setAttribute("aria-label", `${script.name} source`);

  const paintGutter = () => {
    gutter.replaceChildren();
    const lines = (area.value.match(/\n/g)?.length ?? 0) + 1;
    for (let line = 1; line <= lines; line += 1) {
      const mark = flagged.get(line);
      gutter.append(el("span", `code__line${mark ? ` is-${mark}` : ""}`, String(line)));
    }
  };
  const repaint = () => {
    painted.innerHTML = paint(area.value);
  };
  paintGutter();
  repaint();

  area.addEventListener("scroll", () => {
    gutter.scrollTop = area.scrollTop;
    painted.scrollTop = area.scrollTop;
    painted.scrollLeft = area.scrollLeft;
  });
  area.addEventListener("input", () => {
    paintGutter();
    repaint();
    root.dispatchEvent(new CustomEvent("edited", { detail: { source: area.value }, bubbles: true }));
  });
  stack.append(painted, area);
  frame.append(gutter, stack);
  root.append(frame);

  const manifest = el("details", "manifest");
  if (script.manifest) {
    manifest.open = true;
  }
  manifest.append(el("summary", "manifest__summary", script.manifest ? "Cargo.toml" : "Cargo.toml — none"));
  const deps = el("textarea", "manifest__text");
  deps.value = script.manifest ?? "";
  deps.spellcheck = false;
  deps.placeholder = '[dependencies]\nnalgebra = { version = "0.33", default-features = false, features = ["libm"] }';
  deps.setAttribute("aria-label", "Cargo.toml");
  deps.addEventListener("input", () =>
    root.dispatchEvent(new CustomEvent("edited", { detail: { manifest: deps.value }, bubbles: true })),
  );
  manifest.append(deps);
  manifest.append(
    el(
      "p",
      "manifest__note",
      "Only the dependency table is used. Everything else is discarded and a fresh manifest " +
        "generated around it — a patch section or a build script here would apply to the whole " +
        "workspace. An aos-sim path entry is dropped too, so the line that gives you autocomplete " +
        "locally uploads unchanged.",
    ),
  );
  root.append(manifest);

  if (diagnostics.length) {
    const said = el("div", "said");
    said.append(
      el(
        "h3",
        "said__title",
        errors.length
          ? `${errors.length} error${errors.length === 1 ? "" : "s"}`
          : `${warnings.length} warning${warnings.length === 1 ? "" : "s"}`,
      ),
    );
    for (const d of diagnostics) {
      const row = el("div", `said__row said__row--${d.level}`);
      const where = el("p", "said__where");
      where.append(el("span", "said__file", d.script ?? "the engine"));
      if (d.line) {
        where.append(el("span", "said__line", `line ${d.line}`));
      }
      row.append(where);
      row.append(el("p", "said__message", d.message));
      if (d.rendered) {
        const pre = el("pre", "said__rendered");
        pre.textContent = d.rendered;
        row.append(pre);
      }
      said.append(row);
    }
    root.append(said);
  }
}

const SLOT_NAMES = {
  propagator: "Propagator",
  screening: "Screening",
  "link-budget": "Link budget",
  atmosphere: "Atmosphere",
  visibility: "Visibility",
};

export function renderBrief(root, { manifest, reports = [], state = "idle", detail = "" } = {}) {
  root.replaceChildren();
  head(root, "What this does");

  if (state !== "ready" || !manifest) {
    root.append(
      el(
        "p",
        "brief__idle",
        state === "running"
          ? "Reading the bundle…"
          : state === "error"
            ? detail || "The bundle would not run, so there is nothing to read out of it."
            : detail || "Build the console's scripts and this fills in from the bundle itself.",
      ),
    );
    return;
  }

  const section = (title) => {
    const node = el("section", "brief__block");
    node.append(el("h3", "brief__heading", title));
    return node;
  };

  if (manifest.scripts.length) {
    const block = section(`${manifest.scripts.length} script${manifest.scripts.length === 1 ? "" : "s"}`);
    for (const script of manifest.scripts) {
      const row = el("article", "card");
      const top = el("div", "card__head");
      top.append(badge(script.glyph, script.tint));
      const naming = el("div", "card__naming");
      naming.append(el("h4", "card__name", script.name));
      const by = [script.version, script.author].filter(Boolean).join(" · ");
      naming.append(el("p", "card__by", by || script.id));
      top.append(naming);
      row.append(top);
      row.append(el("p", "card__summary", script.summary));

      const facts = el("ul", "card__facts");
      facts.append(
        el(
          "li",
          "",
          script.tickEverySeconds
            ? `Ticks every ${simSpan(script.tickEverySeconds)} of simulated time`
            : "Runs on events and timers only",
        ),
      );
      const said = reports.find((r) => r.script === script.id);
      for (const line of said?.lines ?? []) {
        facts.append(el("li", "card__reading", `${line.label}: ${line.value}${line.unit ? ` ${line.unit}` : ""}`));
      }
      row.append(facts);

      if (script.notes.length) {
        const notes = el("ul", "card__notes");
        for (const note of script.notes) {
          notes.append(el("li", "", note));
        }
        row.append(notes);
      }
      block.append(row);
    }
    root.append(block);
  }

  const added = manifest.hazardKinds.filter((kind) => !kind.stock);
  if (added.length) {
    const block = section(`${added.length} hazard kind${added.length === 1 ? "" : "s"} added`);
    for (const kind of added) {
      const row = el("article", "kind");
      const top = el("div", "kind__head");
      top.append(badge(kind.glyph, kind.colour, { size: 26 }));
      const naming = el("div");
      naming.append(el("h4", "kind__name", kind.name));
      naming.append(el("p", "kind__unit", `measured in ${kind.unit}`));
      top.append(naming);
      row.append(top);
      row.append(el("p", "kind__blurb", kind.blurb));
      const acts = el("p", "kind__acts");
      for (const what of kind.actsOn) {
        acts.append(el("span", "tag", what));
      }
      if (!kind.actsOn.length) {
        acts.append(el("span", "tag tag--quiet", "nothing"));
      }
      row.append(acts);
      row.append(
        el(
          "p",
          "kind__limits",
          `Footprint ${Math.round(kind.limits.radiusLowKm)}–${Math.round(kind.limits.radiusHighKm)} km, ` +
            `up to ${Math.round(kind.limits.durationHighMin / 60)} h`,
        ),
      );
      block.append(row);
    }
    root.append(block);
  }

  if (manifest.overrides.length) {
    const block = section("Algorithms replaced");
    for (const override of manifest.overrides) {
      const row = el("article", "swap");
      row.append(el("h4", "swap__slot", SLOT_NAMES[override.slot] ?? override.slot));
      row.append(el("p", "swap__name", override.name));
      row.append(el("p", "swap__cost", override.consequence));
      block.append(row);
    }
    root.append(block);
  }

  if (manifest.clashes.length) {
    const block = section("Ignored");
    for (const clash of manifest.clashes) {
      block.append(
        el(
          "p",
          "brief__clash",
          `A second ${SLOT_NAMES[clash.slot] ?? clash.slot} override, "${clash.ignored}", was not loaded. ` +
            "One per console.",
        ),
      );
    }
    root.append(block);
  }

  if (manifest.craftAdded) {
    const block = section("Fleet");
    block.append(
      el("p", "brief__plain", `${manifest.craftAdded} craft added by these scripts, on top of the catalogue.`),
    );
    root.append(block);
  }

  if (!manifest.scripts.length && !added.length && !manifest.overrides.length && !manifest.craftAdded) {
    root.append(
      el(
        "p",
        "brief__idle",
        "The bundle built and registered nothing. A crate whose register function is empty compiles " +
          "perfectly well and does not do anything.",
      ),
    );
  }
}

function simSpan(seconds) {
  if (seconds < 90) {
    return `${Math.round(seconds)} s`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)} min`;
  }
  if (seconds < 172_800) {
    return `${(seconds / 3600).toFixed(seconds % 3600 ? 1 : 0)} h`;
  }
  return `${(seconds / 86_400).toFixed(1)} days`;
}

export { badge, bytes, el };
