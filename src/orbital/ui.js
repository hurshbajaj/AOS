import { CONSTELLATIONS } from "./data.js";
import { WORKING } from "./instances.js";

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
};

const pct = (value) => `${Math.round(value * 100)}%`;

const CLOSE_MS = 240;

const BOOT_OUT_MS = 420;

const BOOT_WAIT_MS = 15000;

const CNS_FADE_MS = 150;
const CNS_OUT_MS = 240;

const CHART = { w: 600, h: 150 };

const CLEAR_MARK = `<svg viewBox="0 0 120 60" aria-hidden="true" focusable="false">
  <line class="screen__none-floor" x1="4" y1="42" x2="116" y2="42"/>
  <circle class="screen__none-dot" cx="18" cy="17" r="1.8"/>
  <circle class="screen__none-dot" cx="39" cy="9" r="1.4"/>
  <circle class="screen__none-dot" cx="57" cy="22" r="1.9"/>
  <circle class="screen__none-dot" cx="74" cy="13" r="1.4"/>
  <circle class="screen__none-dot" cx="92" cy="26" r="1.7"/>
  <circle class="screen__none-dot" cx="106" cy="15" r="1.3"/>
</svg>`;

const IDLE_ORBIT = `<svg viewBox="0 0 200 150" aria-hidden="true" focusable="false">
  <defs>
    <clipPath id="idle-upper"><rect x="0" y="0" width="200" height="75"/></clipPath>
    <clipPath id="idle-lower"><rect x="0" y="75" width="200" height="75"/></clipPath>
  </defs>
  <ellipse class="idle__ring" cx="100" cy="75" rx="64" ry="20" transform="rotate(-16 100 75)" clip-path="url(#idle-upper)"/>
  <circle class="idle__planet" cx="100" cy="75" r="30"/>
  <circle class="idle__shade" cx="112" cy="68" r="30"/>
  <ellipse class="idle__ring" cx="100" cy="75" rx="64" ry="20" transform="rotate(-16 100 75)" clip-path="url(#idle-lower)"/>
  <g transform="rotate(-16 100 75)">
    <!-- Along the ring itself, not around a circle that merely touches it.
         The same ellipse written as a path: two half arcs, because an SVG
         arc cannot close a full one in a single command. Walked with
         animateMotion rather than a rotation, since rotating a dot about
         the centre traces a circle and the ring is an ellipse seen at an
         angle -- which is why it kept drifting off the wire. -->
    <circle class="idle__moon" r="3">
      <animateMotion dur="16s" repeatCount="indefinite"
        path="M164,75 A64,20 0 1 1 36,75 A64,20 0 1 1 164,75"/>
    </circle>
  </g>
</svg>`;

const ORBIT_MARK = `<svg viewBox="0 0 34 34" aria-hidden="true" focusable="false">
  <ellipse class="screenbtn__ring" cx="17" cy="17" rx="15" ry="6.5" transform="rotate(-22 17 17)"/>
  <ellipse class="screenbtn__ring screenbtn__ring--two" cx="17" cy="17" rx="15" ry="6.5" transform="rotate(46 17 17)"/>
  <circle class="screenbtn__spot" cx="17" cy="17" r="2.4"/>
</svg>`;

const BACK = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  <path d="M9.6 3.4L5 8l4.6 4.6"/>
</svg>`;

const PEN = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  <path d="M11.4 2.6l2 2-7.5 7.5-2.6.6.6-2.6z"/>
  <path d="M9.9 4.1l2 2"/>
</svg>`;

const BIN = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  <path d="M3.4 4.6h9.2"/>
  <path d="M6.4 4.6V3.2h3.2v1.4"/>
  <path d="M4.6 4.6l.6 8.2h5.6l.6-8.2"/>
</svg>`;

const LINK_LABELS = {
  isl: "Inter-satellite",
  feeder: "Feeder",
  nav: "Navigation",
};

export class Layers {
  constructor(root, world) {
    this.world = world;
    this.root = root;

    const fleets = el("div", "control");
    fleets.append(el("span", "control__label", "Fleets"));
    const fleetRow = el("div", "control__row");
    for (const group of Object.values(CONSTELLATIONS)) {
      fleetRow.append(this.#chip(group.name, group.colour, world.filters.constellations.has(group.id), (on) => {
        const next = new Set(world.filters.constellations);
        if (on) {
          next.add(group.id);
        } else {
          next.delete(group.id);
        }
        world.setFilter({ constellations: next });
      }));
    }
    fleets.append(fleetRow);

    const links = el("div", "control");
    links.append(el("span", "control__label", "Links"));
    const linkRow = el("div", "control__row");
    for (const [kind, label] of Object.entries(LINK_LABELS)) {
      linkRow.append(this.#chip(label, null, world.filters.links.has(kind), (on) => {
        const next = new Set(world.filters.links);
        if (on) {
          next.add(kind);
        } else {
          next.delete(kind);
        }
        world.setFilter({ links: next });
      }));
    }
    links.append(linkRow);

    const overlays = el("div", "control");
    overlays.append(el("span", "control__label", "Overlays"));
    const overlayRow = el("div", "control__row");
    overlayRow.append(this.#chip("Orbits", null, world.filters.orbits, (on) => world.setFilter({ orbits: on })));
    overlayRow.append(this.#chip("Ground", null, world.filters.stations, (on) => world.setFilter({ stations: on })));
    overlays.append(overlayRow);

    const density = el("div", "control control--wide");
    density.append(el("span", "control__label", "Link density"));
    const slider = el("input", "slider");
    slider.type = "range";
    slider.min = "0.1";
    slider.max = "1";
    slider.step = "0.05";
    slider.value = String(world.filters.density);
    const readout = el("span", "control__value", pct(world.filters.density));
    slider.addEventListener("input", () => {
      world.setFilter({ density: Number(slider.value) });
      readout.textContent = pct(Number(slider.value));
    });
    const sliderRow = el("div", "control__row");
    sliderRow.append(slider, readout);
    density.append(sliderRow);

    root.append(fleets, links, overlays, density);
  }

  #chip(label, colour, active, onToggle) {
    const button = el("button", "chip");
    button.type = "button";
    button.classList.toggle("is-on", active);
    if (colour) {
      const dot = el("span", "chip__dot");
      dot.style.background = colour;
      button.append(dot);
    }
    button.append(el("span", null, label));
    button.addEventListener("click", () => {
      const next = !button.classList.contains("is-on");
      button.classList.toggle("is-on", next);
      onToggle(next);
    });
    return button;
  }
}

const BEAT_MS = 1100;
const BEAT_GAP_MS = 0;
const ENTER_MS = 560;
const LEAVE_MS = 420;
const SHIFT_MS = LEAVE_MS;
const ROUND_GAP_MS = 900;

export class HazardStrip {
  #cards = new Map();

  #beatTimer = 0;
  #beatId = null;

  #primed = false;

  constructor(root, world, { onSelect, onAdd }) {
    this.root = root;
    this.world = world;
    this.onSelect = onSelect;
    this.onAdd = onAdd;
    this.active = null;

    this.add = el("button", "haz haz--add");
    this.add.type = "button";
    this.add.innerHTML = '<span class="haz__glyph" aria-hidden="true">+</span><span class="haz__text"><span class="haz__name">Inject</span></span>';
    this.add.addEventListener("click", () => this.onAdd());

    this.empty = el("p", "haz__empty", "No hazards in play");
    this.render();
    this.#beat();
  }

  #schedule(delay) {
    clearTimeout(this.#beatTimer);
    this.#beatTimer = setTimeout(() => this.#beat(), delay);
  }

  #beat() {
    const ids = this.world.hazards.map((hazard) => hazard.id);
    for (const card of this.#cards.values()) {
      card.button.classList.remove("is-beating");
    }
    if (!ids.length) {
      this.#beatId = null;
      this.#schedule(BEAT_MS + BEAT_GAP_MS);
      return;
    }

    let next = this.#beatId === null ? -1 : ids.indexOf(this.#beatId);
    let card = null;
    for (let step = 0; step < ids.length; step += 1) {
      next = (next + 1) % ids.length;
      const candidate = this.#cards.get(ids[next]);
      if (candidate && !candidate.leaving && !candidate.button.classList.contains("is-moving")) {
        card = candidate;
        break;
      }
    }
    this.#beatId = ids[next];

    if (card) {
      void card.button.offsetWidth;
      card.button.classList.add("is-beating");
    }

    const closesRound = next === ids.length - 1;
    this.#schedule(BEAT_MS + BEAT_GAP_MS + (closesRound ? ROUND_GAP_MS : 0));
  }

  #create(hazard) {
    const button = el("button", "haz is-arriving");
    button.type = "button";
    button.innerHTML = `
      <span class="haz__glyph" aria-hidden="true"></span>
      <span class="haz__text">
        <span class="haz__name"></span>
        <span class="haz__meta"></span>
      </span>
      <span class="haz__flag" aria-hidden="true"></span>`;
    button.addEventListener("click", () => {
      this.active = hazard.id;
      this.render();
      this.onSelect(hazard);
    });
    return {
      button,
      glyph: button.querySelector(".haz__glyph"),
      name: button.querySelector(".haz__name"),
      meta: button.querySelector(".haz__meta"),
      flag: button.querySelector(".haz__flag"),
    };
  }

  restage() {
    for (const card of this.#cards.values()) {
      card.button.remove();
    }
    this.#cards.clear();
    this.active = null;
    this.render();
  }

  render() {
    const live = new Set();
    const fresh = [];

    this.world.hazards.forEach((hazard) => {
      live.add(hazard.id);
      let card = this.#cards.get(hazard.id);
      if (!card) {
        card = this.#create(hazard);
        this.#cards.set(hazard.id, card);
        fresh.push(card);
      }
      const { button, glyph, name, meta, flag } = card;
      const injected = hazard.origin === "injected";
      const forecast = hazard.origin === "forecast";

      button.classList.toggle("is-injected", injected);
      button.classList.toggle("is-forecast", forecast);
      button.classList.toggle("is-active", hazard.id === this.active);
      button.style.setProperty("--haz", hazard.spec.colour);

      glyph.textContent = hazard.spec.glyph;
      name.textContent = hazard.label;
      meta.textContent = `${hazard.spec.unit} ${hazard.severity.toFixed(2)} · ${hazard.lat.toFixed(0)}°, ${hazard.lon.toFixed(0)}°`;
      flag.textContent = forecast ? "FCT" : injected ? "INJ" : "OBS";
      flag.title = forecast
        ? `Forecast${hazard.confidence ? ` — ${Math.round(hazard.confidence * 100)}% confidence` : ""}`
        : injected
          ? "Injected by you"
          : "Observed now";
      button.setAttribute("aria-label", `${hazard.label}, ${hazard.origin}`);
    });

    for (const [id, card] of this.#cards) {
      if (!live.has(id) && !card.leaving) {
        card.leaving = true;
        card.button.disabled = true;
        this.#close(card.button);
        setTimeout(() => {
          card.button.remove();
          this.#cards.delete(id);
        }, LEAVE_MS);
      }
    }

    const order = this.world.hazards.map((hazard) => this.#cards.get(hazard.id).button);

    if (this.add.parentNode !== this.root) {
      this.root.append(this.add);
    }

    const before = new Map();
    if (fresh.length && this.#primed) {
      for (const node of this.root.children) {
        before.set(node, node.getBoundingClientRect().top);
      }
    }

    if (!order.length) {
      if (this.empty.parentNode !== this.root) {
        this.root.insertBefore(this.empty, this.add);
      }
    } else {
      this.empty.remove();
    }

    const passing = (node) => node === this.empty || node.classList?.contains("is-leaving");
    let cursor = this.root.firstChild;
    for (const button of order) {
      while (cursor && cursor !== button && passing(cursor)) {
        cursor = cursor.nextSibling;
      }
      if (cursor === button) {
        cursor = cursor.nextSibling;
        continue;
      }
      this.root.insertBefore(button, cursor ?? this.add);
    }
    if (this.root.lastElementChild !== this.add) {
      this.root.append(this.add);
    }

    if (fresh.length) {
      if (this.#primed) {
        this.#open(fresh.map((card) => card.button), before);
      } else {
        for (const card of fresh) {
          card.button.classList.remove("is-arriving");
        }
      }
    }
    this.#primed = true;
  }

  #open(buttons, before) {
    const shifted = [];
    for (const [node, top] of before) {
      if (node.classList?.contains("is-leaving")) {
        continue;
      }
      const delta = top - node.getBoundingClientRect().top;
      if (Math.abs(delta) < 0.5) {
        continue;
      }
      node.style.transition = "none";
      node.style.transform = `translateY(${delta}px)`;
      shifted.push(node);
    }

    for (const button of buttons) {
      button.classList.add("is-moving");
    }

    void this.root.offsetHeight;
    requestAnimationFrame(() => {
      for (const node of shifted) {
        node.style.transition = `transform ${SHIFT_MS}ms var(--soft)`;
        node.style.transform = "translateY(0px)";
      }
      for (const button of buttons) {
        button.classList.remove("is-arriving");
      }
      setTimeout(() => {
        for (const node of shifted) {
          node.style.transition = "";
          node.style.transform = "";
        }
      }, SHIFT_MS);
      setTimeout(() => {
        for (const button of buttons) {
          button.classList.remove("is-moving");
        }
      }, ENTER_MS);
    });
  }

  #close(button) {
    const { style } = button;
    style.height = `${button.offsetHeight}px`;
    style.overflow = "hidden";
    void button.offsetHeight;
    button.classList.add("is-leaving");
    style.height = "0px";
    style.marginBottom = "0px";
    style.paddingTop = "0px";
    style.paddingBottom = "0px";
  }
}

export class Inspector {
  constructor(root) {
    this.root = root;
    this.clear();
  }

  clear() {
    this.showing = null;
    this.root.replaceChildren(
      (() => {
        const empty = el("div", "panel__empty");
        empty.append(
          el("p", "panel__empty-title", "Nothing selected"),
          el("p", "panel__empty-body", "Pick a satellite on the globe, or open a hazard from the stack above."),
        );
        return empty;
      })(),
    );
  }

  #shell(kind, title, subtitle, accent) {
    this.showing = kind;
    const panel = el("article", `detail detail--${kind}`);
    if (accent) {
      panel.style.setProperty("--accent", accent);
    }
    const head = el("header", "detail__head");
    head.append(el("p", "detail__kicker", subtitle), el("h2", "detail__title", title));
    panel.append(head);
    this.root.replaceChildren(panel);
    return panel;
  }

  #renameable(panel, hazard, onChange) {
    const title = panel.querySelector(".detail__title");
    const kicker = panel.querySelector(".detail__kicker");
    const subtitle = kicker.textContent;

    const row = el("div", "detail__name");
    title.replaceWith(row);
    row.append(title);
    title.title = hazard.label;

    const pen = el("button", "detail__rename");
    pen.type = "button";
    pen.innerHTML = PEN;
    row.append(pen);

    const input = el("input", "detail__title-edit");
    input.type = "text";
    input.maxLength = 48;
    input.spellcheck = false;
    input.setAttribute("aria-label", "Hazard name");
    input.hidden = true;
    row.append(input);

    let editing = false;
    let closing = 0;

    const label = () => {
      title.textContent = hazard.label;
      title.title = hazard.label;
      pen.setAttribute("aria-label", `Rename ${hazard.label}`);
    };

    const stop = (commit) => {
      if (!editing) {
        return;
      }
      editing = false;
      const value = input.value.trim();
      if (commit && value && value !== hazard.label) {
        onChange({ label: value });
      }
      label();
      kicker.textContent = subtitle;
      row.classList.remove("is-editing");
      row.classList.add("is-closing");
      closing = setTimeout(() => {
        row.classList.remove("is-closing");
        input.hidden = true;
      }, CLOSE_MS);
    };

    pen.addEventListener("click", () => {
      if (editing) {
        return;
      }
      clearTimeout(closing);
      row.classList.remove("is-closing");
      editing = true;
      input.value = hazard.label;
      input.hidden = false;
      row.classList.add("is-editing");
      kicker.textContent = "Enter to save · Esc to cancel";
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });

    input.addEventListener("blur", () => stop(true));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        stop(event.key === "Enter");
      }
    });

    label();
  }

  #facts(panel, rows) {
    const list = el("dl", "detail__facts");
    for (const [key, value] of rows) {
      list.append(el("dt", null, key), el("dd", null, value));
    }
    panel.append(list);
    return list;
  }

  #meter(panel, label, value, caption) {
    const wrap = el("div", "meter");
    const head = el("div", "meter__head");
    head.append(el("span", null, label), el("span", "meter__value", caption));
    const track = el("span", "meter__track");
    const fill = el("span", "meter__fill");
    fill.style.transform = `scaleX(${Math.max(0, Math.min(value, 1))})`;
    track.append(fill);
    wrap.append(head, track);
    panel.append(wrap);
  }

  showConsoles(rows, { current, unsaved, onOpen, onCreate, onSave, onRename, onDelete, signedIn, documents, onAddDoc, onDropDoc, onScreen }) {
    const panel = this.#shell("consoles", "Consoles", signedIn ? "Pick one, or start another" : "Sign in to keep these");
    panel.append(
      el(
        "p",
        "detail__blurb",
        signedIn
          ? "Each console keeps its own hazards and layers. The fleet is live in all of them."
          : "The console works signed out, but nothing you build in it is kept. Sign in from the deck to save scenarios.",
      ),
    );

    if (signedIn) {
      const list = el("div", "consoles");
      if (!rows.length) {
        list.append(el("p", "log__empty", "Nothing saved yet."));
      }
      for (const row of rows) {
        list.append(
          this.#console(row, { current, unsaved: unsaved === row.id, onOpen, onRename, onDelete }),
        );
      }
      panel.append(list);

      const make = el("button", "detail__new", "New console");
      make.type = "button";
      make.addEventListener("click", () => onCreate(make));
      panel.append(make);

      if (onSave && current) {
        const save = el("button", "detail__new detail__new--quiet", "Save Current");
        save.type = "button";
        save.title = unsaved
          ? "Write this console to the server"
          : "Everything in this console is already on the server";
        save.addEventListener("click", () => onSave(save));
        panel.append(save);
      }

      if (onAddDoc) {
        panel.append(this.#papers(documents ?? [], { onAddDoc, onDropDoc }));
      }

      if (onScreen) {
        const screen = el("button", "screenbtn");
        screen.type = "button";
        const art = el("span", "screenbtn__art");
        art.setAttribute("aria-hidden", "true");
        art.innerHTML = ORBIT_MARK;
        const words = el("span", "screenbtn__words");
        words.append(
          el("span", "screenbtn__name", "Conjunction screening"),
          el("span", "screenbtn__note", "Every craft against the tracked catalogue, 24 hours ahead"),
        );
        screen.append(art, words, el("span", "screenbtn__go", "\u2192"));
        screen.addEventListener("click", () => onScreen());
        panel.append(screen);
      }
    }
    return panel;
  }

  #papers(rows, { onAddDoc, onDropDoc }) {
    const box = el("section", "papers");
    box.append(el("h3", "papers__title", "Your data"));
    box.append(
      el(
        "p",
        "papers__blurb",
        "Fleet specs, ops manuals, link budgets — anything your team has that this console does not. Sybil reads them, and what she finds in them outranks her own modelled figures.",
      ),
    );

    const list = el("div", "papers__list");
    if (!rows.length) {
      list.append(el("p", "log__empty", "Nothing added yet."));
    }
    for (const row of rows) {
      const line = el("div", "paper");
      const text = el("span", "paper__stack");
      text.append(el("span", "paper__name", row.name));
      text.append(
        el(
          "span",
          "paper__meta",
          `${row.kind} · ${row.bytes < 1024 ? `${row.bytes} B` : `${Math.round(row.bytes / 1024)} KB`}${row.author ? ` · ${row.author}` : ""}`,
        ),
      );
      const bin = el("button", "cns__act cns__act--bin");
      bin.type = "button";
      bin.title = "Remove";
      bin.setAttribute("aria-label", `Remove ${row.name}`);
      bin.innerHTML = BIN;
      bin.addEventListener("click", () => onDropDoc(row, bin));
      line.append(text, bin);
      list.append(line);
    }
    box.append(list);

    const form = el("form", "papers__add");
    const name = el("input", "cns__field cns__field--name");
    name.type = "text";
    name.maxLength = 80;
    name.placeholder = "Name it — fleet-spec.csv";
    name.setAttribute("aria-label", "Document name");

    const body = el("textarea", "cns__field cns__field--note");
    body.rows = 3;
    body.placeholder = "Paste it here, or choose a file.";
    body.setAttribute("aria-label", "Contents");

    const pick = el("input", "papers__file");
    pick.type = "file";
    pick.accept = ".txt,.md,.markdown,.csv,.tsv,.json,.tle,text/plain,text/csv,text/markdown,application/json";
    pick.id = `paper-file-${Math.random().toString(36).slice(2, 8)}`;
    const choose = el("label", "papers__choose", "Choose a file");
    choose.setAttribute("for", pick.id);
    pick.addEventListener("change", async () => {
      const file = pick.files?.[0];
      if (!file) {
        return;
      }
      body.value = await file.text();
      if (!name.value.trim()) {
        name.value = file.name;
      }
      pick.value = "";
    });

    const save = el("button", "cns__save", "Add");
    save.type = "submit";
    const row = el("div", "papers__row");
    row.append(choose, save);

    const say = el("p", "papers__note");
    say.hidden = true;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      say.hidden = true;
      if (!body.value.trim()) {
        say.textContent = "There is nothing in it yet.";
        say.hidden = false;
        return;
      }
      save.disabled = true;
      try {
        await onAddDoc(name.value.trim() || "Untitled", body.value);
        name.value = "";
        body.value = "";
      } catch (error) {
        say.textContent = error.message;
        say.hidden = false;
      } finally {
        save.disabled = false;
      }
    });

    form.append(name, body, pick, row, say);
    box.append(form);
    return box;
  }

  showScreening(state, { onBack, onFocus, onRun, onCancel }) {
    const panel = this.#shell("screening", "Conjunction screening", "");
    panel.classList.add("detail--wide");
    panel.querySelector(".detail__kicker")?.remove();

    const back = el("button", "backlink backlink--screen");
    back.type = "button";
    back.innerHTML = `${BACK}<span>Console</span>`;
    back.addEventListener("click", () => onBack());
    panel.querySelector(".detail__head").prepend(back);

    const hold = el("div", "screen__hold");
    panel.append(hold);

    if (state.error) {
      hold.append(this.#screenFailed(state.error, onRun));
      return panel;
    }

    if (!state.result) {
      hold.append(this.#screenProgress(state, onCancel));
      return panel;
    }

    const r = state.result;
    if (r.sample) {
      const flag = el("p", "screen__sample");
      flag.append(el("span", "screen__pill", "Sample data"), el("span", null, "Representative figures for development. Drop ?screen=sample from the address to screen against the real catalogue."));
      hold.append(flag);
    }
    if (!r.encounters.length) {
      hold.append(this.#screenNothing(r));
      return panel;
    }
    hold.append(this.#screenSummary(r));
    const body = el("div", "screen__body");
    body.append(this.#screenChart(r), this.#screenList(r, onFocus));
    hold.append(body);
    hold.append(el("p", "screen__caveat", state.caveat ?? ""));
    return panel;
  }

  #screenProgress(state, onCancel) {
    const box = el("div", "screen__wait screen__wait--middle");
    box.append(el("p", "screen__waitline", state.message ?? "Starting\u2026"));
    const track = el("span", "screen__track");
    const fill = el("span", "screen__fill");
    if (state.fraction != null) {
      fill.style.transform = `scaleX(${Math.max(0.02, Math.min(1, state.fraction))})`;
    } else {
      fill.classList.add("is-sliding");
    }
    track.append(fill);
    box.append(track);
    const foot = el("div", "screen__waitfoot");
    if (state.detail) {
      foot.append(el("p", "screen__waitnote", state.detail));
    }
    if (onCancel) {
      const stop = el("button", "screen__cancel", "Cancel");
      stop.type = "button";
      stop.addEventListener("click", () => onCancel());
      foot.append(stop);
    }
    box.append(foot);
    return box;
  }

  #screenNothing(r) {
    const box = el("div", "screen__none");
    const art = el("span", "screen__none-art");
    art.setAttribute("aria-hidden", "true");
    art.innerHTML = CLEAR_MARK;
    const nothingNear = r.pairs === 0;
    const words = el("div", "screen__none-words");
    words.append(
      el("h3", "screen__none-title", nothingNear ? "Nothing to screen against" : "No close approaches"),
      el(
        "p",
        "screen__none-note",
        nothingNear
          ? `None of the ${r.fleet.length} craft share an altitude band with any of the ${r.catalogue.toLocaleString()} objects screened, so no pair was close enough at any point to be worth propagating.`
          : `Nothing came within ${r.alertKm} km of the fleet in the next ${r.hours} hours, screened against ${r.catalogue.toLocaleString()} tracked objects.`,
      ),
    );
    box.append(art, words);
    return box;
  }

  #screenFailed(detail, onRun) {
    const said = String(detail ?? "");
    const reason = /modelled rather than tracked|no elements/i.test(said)
      ? {
          title: "The fleet is not tracked",
          note: "The catalogue was unreachable when the console started, so what is on screen is modelled rather than real orbits. Reload to try it again.",
          again: false,
        }
      : /celestrak|catalogue|403|network|fetch/i.test(said)
        ? {
            title: "The catalogue did not answer",
            note: "Fresh elements are published every couple of hours. Worth another go in a moment.",
            again: true,
          }
        : {
            title: "The screen did not finish",
            note: "Nothing was changed by it, so running it again is safe.",
            again: true,
          };

    const box = el("div", "screen__none");
    const art = el("span", "screen__none-art");
    art.setAttribute("aria-hidden", "true");
    art.innerHTML = CLEAR_MARK;
    const words = el("div", "screen__none-words");
    words.append(el("h3", "screen__none-title", reason.title), el("p", "screen__none-note", reason.note));
    if (reason.again) {
      const retry = el("button", "screen__retry", "Try again");
      retry.type = "button";
      retry.addEventListener("click", () => onRun());
      words.append(retry);
    }
    box.append(art, words);
    return box;
  }

  #screenSummary(r) {
    const list = el("dl", "screen__facts");
    const closest = r.encounters[0];
    const rows = [
      ["Screened against", `${r.catalogue.toLocaleString()} objects`],
      ["Fleet", `${r.fleet.length} craft`],
      ["Horizon", `${r.hours} h`],
      ["Encounters", r.total.toLocaleString()],
      ["Under " + r.alertKm + " km", String(r.alerts)],
      ["Closest", closest ? `${closest.km.toFixed(2)} km` : "\u2014"],
    ];
    for (const [key, value] of rows) {
      const cell = el("div", "screen__fact");
      cell.append(el("dt", null, key), el("dd", null, value));
      list.append(cell);
    }
    if (r.alerts) {
      list.classList.add("is-alert");
    }
    return list;
  }

  #screenChart(r) {
    const wrap = el("div", "screen__chart");
    const top = Math.max(r.alertKm * 4, 40);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${CHART.w} ${CHART.h}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.classList.add("screen__svg");

    const node = (name, attrs) => {
      const made = document.createElementNS("http://www.w3.org/2000/svg", name);
      for (const [key, value] of Object.entries(attrs)) {
        made.setAttribute(key, String(value));
      }
      return made;
    };
    const y = (km) => CHART.h - (Math.min(km, top) / top) * (CHART.h - 6) - 3;
    const x = (hours) => (Math.max(0, Math.min(hours, r.hours)) / r.hours) * CHART.w;

    svg.append(node("line", { x1: 0, y1: y(r.alertKm), x2: CHART.w, y2: y(r.alertKm), class: "screen__floor" }));
    for (let h = 0; h <= r.hours; h += 6) {
      svg.append(node("line", { x1: x(h), y1: 0, x2: x(h), y2: CHART.h, class: "screen__grid" }));
    }
    for (const row of r.encounters) {
      svg.append(
        node("circle", {
          cx: x(row.inHours),
          cy: y(row.km),
          r: row.alert ? 2.6 : 1.5,
          class: `screen__dot${row.alert ? " is-alert" : ""}`,
        }),
      );
    }
    wrap.append(svg);

    const axis = el("div", "screen__axis");
    axis.append(el("span", null, "now"), el("span", null, `+${Math.round(r.hours / 2)} h`), el("span", null, `+${r.hours} h`));
    wrap.append(axis);
    wrap.append(el("span", "screen__ymark", `${r.alertKm} km`));
    wrap.style.setProperty("--floor", `${(y(r.alertKm) / CHART.h) * 100}%`);
    return wrap;
  }

  #screenList(r, onFocus) {
    const box = el("div", "screen__list");
    if (!r.encounters.length) {
      box.append(el("p", "log__empty", "Nothing came close. A quiet day."));
      return box;
    }
    for (const row of r.encounters.slice(0, 40)) {
      const line = el("button", `screen__row${row.alert ? " is-alert" : ""}`);
      line.type = "button";
      const left = el("span", "screen__rowstack");
      left.append(el("span", "screen__pair", `${row.mineName} \u2194 ${row.name}`));
      left.append(el("span", "screen__when", `T+${row.inHours.toFixed(2)} h`));
      line.append(left, el("span", "screen__km", `${row.km.toFixed(2)} km`));
      line.addEventListener("click", () => onFocus(row));
      box.append(line);
    }
    if (r.total > r.encounters.length) {
      box.append(el("p", "screen__more", `${(r.total - r.encounters.length).toLocaleString()} further encounters beyond the closest ${r.encounters.length}.`));
    }
    return box;
  }

  #console(row, { current, unsaved, onOpen, onRename, onDelete }) {
    const card = el("article", "cns");
    card.classList.toggle("is-current", row.id === current);

    const open = el("button", "cns__open");
    open.type = "button";
    const heading = el("span", "cns__heading");
    const title = el("span", "cns__name", row.name);
    heading.append(title);
    if (unsaved) {
      const mark = el("span", "cns__unsaved", "!");
      mark.setAttribute("aria-label", "Unsaved changes");
      heading.append(mark);
      const tip = el("span", "cns__tip", "Not saved");
      tip.setAttribute("aria-hidden", "true");
      mark.append(tip);
    }
    const count = (row.state?.hazards ?? []).length;
    open.append(
      heading,
      el("span", "cns__meta", `${count} hazard${count === 1 ? "" : "s"} · ${new Date(row.updated).toLocaleDateString([], { day: "numeric", month: "short" })}`),
    );
    if (row.note) {
      open.append(el("span", "cns__note", row.note));
    }
    open.addEventListener("click", () => onOpen(row));

    const tools = el("div", "cns__tools");
    const pen = el("button", "cns__act");
    pen.type = "button";
    pen.title = "Rename";
    pen.setAttribute("aria-label", `Rename ${row.name}`);
    pen.innerHTML = PEN;

    const bin = el("button", "cns__act cns__act--bin");
    bin.type = "button";
    bin.title = "Delete";
    bin.setAttribute("aria-label", `Delete ${row.name}`);
    bin.innerHTML = BIN;
    tools.append(pen, bin);

    const form = el("form", "cns__edit");
    form.hidden = true;
    const name = el("input", "cns__field cns__field--name");
    name.type = "text";
    name.maxLength = 60;
    name.value = row.name;
    name.setAttribute("aria-label", "Name");
    const note = el("textarea", "cns__field cns__field--note");
    note.rows = 2;
    note.maxLength = 500;
    note.value = row.note ?? "";
    note.placeholder = "What is this one for?";
    note.setAttribute("aria-label", "Note");
    const save = el("button", "cns__save", "Save");
    save.type = "submit";
    const cancel = el("button", "cns__cancel", "Cancel");
    cancel.type = "button";
    const buttons = el("div", "cns__buttons");
    buttons.append(save, cancel);
    form.append(name, note, buttons);

    let phase = 0;
    const still = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const beat = (ms, then) => {
      clearTimeout(phase);
      if (still) {
        then();
        return;
      }
      phase = setTimeout(then, ms);
    };

    const close = () => {
      card.classList.remove("is-editing");
      card.classList.add("is-closing");
      beat(CNS_OUT_MS, () => {
        card.classList.remove("is-closing");
        card.classList.add("is-settling");
        form.hidden = true;
        open.hidden = false;
        tools.hidden = false;
        name.value = row.name;
        note.value = row.note ?? "";
        beat(CNS_FADE_MS * 2, () => card.classList.remove("is-settling"));
      });
    };
    cancel.addEventListener("click", () => close());
    pen.addEventListener("click", () => {
      card.classList.remove("is-closing", "is-settling");
      card.classList.add("is-opening");
      beat(CNS_FADE_MS, () => {
        card.classList.remove("is-opening");
        card.classList.add("is-editing");
        form.hidden = false;
        open.hidden = true;
        tools.hidden = true;
        name.focus();
        name.setSelectionRange(name.value.length, name.value.length);
      });
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = name.value.trim();
      if (!value) {
        name.focus();
        return;
      }
      close();
      onRename(row, value, note.value.trim());
    });
    form.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    });

    let armed = false;
    bin.addEventListener("click", () => {
      if (!armed) {
        armed = true;
        card.classList.add("is-arming");
        bin.textContent = "Delete?";
        setTimeout(() => {
          if (armed) {
            armed = false;
            card.classList.remove("is-arming");
            bin.innerHTML = BIN;
          }
        }, 3200);
        return;
      }
      onDelete(row);
    });

    card.append(open, tools, form);
    return card;
  }

  showPicker(kinds, onPick, onElsewhere) {
    const panel = this.#shell("pick", "New hazard", "Choose what to introduce");
    const list = el("div", "picker");
    for (const spec of kinds) {
      const option = el("button", "picker__option");
      option.type = "button";
      option.style.setProperty("--haz", spec.colour);
      const glyph = el("span", "picker__glyph", spec.glyph);
      const text = el("span", "picker__text");
      text.append(el("span", "picker__name", spec.name), el("span", "picker__blurb", spec.blurb));
      if (spec.scripted) {
        text.append(el("span", "picker__from", "from this console's scripts"));
      }
      option.append(glyph, text);
      option.addEventListener("click", () => onPick(spec.id));
      list.append(option);
    }
    panel.append(list);
    panel.append(
      el(
        "p",
        "detail__blurb",
        "It lands with the kind's own defaults. Place it and tune it afterwards — nothing here " +
          "has to be right before it exists.",
      ),
    );

    if (onElsewhere) {
      const away = el("div", "picker__away");
      away.append(el("p", "picker__away-ask", "Looking for something else?"));
      const go = el("button", "picker__away-go", "Write your own in Core");
      go.type = "button";
      go.addEventListener("click", () => onElsewhere());
      away.append(go);
      panel.append(away);
    }
  }

  showSatellite(satellite, world) {
    const group = CONSTELLATIONS[satellite.constellation];
    const tracked = satellite.source === "catalogue";
    const panel = this.#shell(
      "sat",
      satellite.name ?? satellite.id,
      `${group.name} · ${group.role}`,
      group.colour,
    );
    const links = world.links.filter((link) => link.a === satellite || link.b === satellite);

    if (Number.isFinite(satellite.deltaVBudget) && Number.isFinite(satellite.deltaVSpent)) {
      const remaining = satellite.deltaVBudget - satellite.deltaVSpent;
      this.#meter(
        panel,
        "Delta-v remaining",
        remaining / satellite.deltaVBudget,
        `${remaining.toFixed(1)} m/s of ${satellite.deltaVBudget.toFixed(0)}`,
      );
    }
    if (Number.isFinite(satellite.powerMargin)) {
      this.#meter(panel, "Power margin", satellite.powerMargin, pct(satellite.powerMargin));
    }
    this.#meter(panel, "Link health", satellite.health ?? 1, satellite.status ?? "nominal");

    const degrees = (value) => `${(((value % 360) + 360) % 360).toFixed(1)}°`;
    const facts = [
      satellite.noradId && ["Catalogue no.", satellite.noradId],
      ["Altitude", `${Math.round(satellite.altitudeKm).toLocaleString()} km`],
      Number.isFinite(satellite.latitude) && [
        "Sub-point",
        `${Math.abs(satellite.latitude).toFixed(1)}°${satellite.latitude >= 0 ? "N" : "S"} ` +
          `${Math.abs(satellite.longitude).toFixed(1)}°${satellite.longitude >= 0 ? "E" : "W"}`,
      ],
      Number.isFinite(satellite.speedKms) && ["Speed", `${satellite.speedKms.toFixed(2)} km/s`],
      ["Inclination", `${satellite.inclination.toFixed(1)}°`],
      Number.isFinite(satellite.eccentricity) && ["Eccentricity", satellite.eccentricity.toFixed(5)],
      Number.isFinite(satellite.raan) && ["RAAN", degrees(satellite.raan)],
      Number.isFinite(satellite.u) && ["Arg. latitude", degrees(satellite.u)],
      ["Period", `${(satellite.period / 60).toFixed(1)} min`],
      Number.isFinite(satellite.plane) && ["Plane / slot", `${satellite.plane + 1} / ${satellite.slot + 1}`],
      ["Platform", satellite.platform.label],
      ["Propulsion", satellite.platform.thruster],
      ["Dry mass", `${satellite.platform.dryMassKg} kg`],
      ["Active links", String(links.length)],
    ].filter(Boolean);
    this.#facts(panel, facts);

    const provenance = el(
      "p",
      "detail__note",
      tracked
        ? "Position propagated with SGP4 from current catalogue elements. Propellant and power are modelled — no public feed carries them."
        : "Modelled constellation. Catalogue elements were unavailable when the console opened.",
    );
    panel.append(provenance);

    if (links.length) {
      const list = el("ul", "detail__links");
      for (const link of links.slice(0, 8)) {
        const other = link.a === satellite ? link.b : link.a;
        const item = el("li", "detail__link");
        item.classList.toggle("is-degraded", link.degraded);
        item.append(
          el("span", "detail__link-kind", LINK_LABELS[link.kind]),
          el("span", "detail__link-peer", other.name ?? other.id),
          el("span", "detail__link-q", pct(link.quality)),
        );
        list.append(item);
      }
      panel.append(el("p", "detail__section", "Carrying"), list);
    }
  }

  showHazard(hazard, world, { onChange, onRemove }) {
    const panel = this.#shell("haz", hazard.label, `${hazard.origin === "injected" ? "Injected by operator" : "Observed"} · ${hazard.id}`, hazard.spec.colour);
    this.#renameable(panel, hazard, onChange);
    panel.append(el("p", "detail__blurb", hazard.spec.blurb));

    const control = (label, key, min, max, step, format) => {
      const wrap = el("div", "field");
      const head = el("div", "field__head");
      const readout = el("span", "field__value", format(hazard[key]));
      head.append(el("label", null, label), readout);
      const input = el("input", "slider");
      input.type = "range";
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(hazard[key]);
      input.addEventListener("input", () => {
        const value = Number(input.value);
        readout.textContent = format(value);
        onChange({ [key]: value });
      });
      wrap.append(head, input);
      panel.append(wrap);
    };

    control("Severity", "severity", 0.05, 1, 0.05, (value) => `${hazard.spec.unit} ${Number(value).toFixed(2)}`);
    control("Footprint", "radius", 0.1, 2, 0.05, (value) => `${(Number(value) * 6371).toFixed(0)} km`);
    control("Latitude", "lat", -85, 85, 1, (value) => `${Number(value).toFixed(0)}°`);
    control("Longitude", "lon", -180, 180, 1, (value) => `${Number(value).toFixed(0)}°`);
    control("Duration", "durationMin", 15, 1440, 15, (value) => `${(Number(value) / 60).toFixed(1)} h`);

    const affectedLinks = world.links.filter((link) => link.degraded).length;
    const affectedSats = world.satellites.filter((satellite) => satellite.status !== "nominal").length;
    const offline = world.stations.filter((station) => !station.online).length;

    this.#facts(panel, [
      ["Acts on", hazard.spec.affects],
      ["Degraded links", String(affectedLinks)],
      ["Affected craft", String(affectedSats)],
      ["Gateways down", String(offline)],
    ]);

    const remove = el("button", "detail__remove", "Clear hazard");
    remove.type = "button";
    remove.addEventListener("click", () => onRemove(hazard));
    panel.append(remove);
  }
}

export class Chat {
  #offset = 0;
  #said = [];
  #waiting = null;
  #booting = false;
  #rescue = null;
  #lines = [];

  constructor(root, { onSend }) {
    this.log = root.querySelector("[data-chat-log]");
    this.form = root.querySelector("[data-chat-form]");
    this.input = root.querySelector("[data-chat-input]");

    this.log.addEventListener("scroll", () => {
      const max = Math.max(0, this.log.scrollHeight - this.log.clientHeight);
      this.#offset = Math.max(0, max - this.log.scrollTop);
    });
    if (typeof ResizeObserver === "function") {
      this.watcher = new ResizeObserver(() => this.reflow());
      this.watcher.observe(this.log);
    }

    this.idle = el("li", "chat__idle");
    this.idle.setAttribute("aria-hidden", "true");
    this.idle.innerHTML = `<span class="chat__idle-art">${IDLE_ORBIT}</span>`;
    if (globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      this.idle.querySelector("animateMotion")?.remove();
    }
    this.log.append(this.idle);

    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = this.input.value.trim();
      if (!text) {
        return;
      }
      this.input.value = "";
      this.push("you", text);
      onSend(text);
    });
  }

  transcript() {
    return this.#said;
  }

  replay(said) {
    const kept = (said ?? []).map((entry) => ({ ...entry }));
    if (this.#booting) {
      this.#waiting = kept;
      clearTimeout(this.#rescue);
      this.#rescue = setTimeout(() => {
        if (this.#waiting) {
          const waiting = this.#waiting;
          this.#waiting = null;
          this.#draw(waiting);
        }
      }, BOOT_WAIT_MS);
      return;
    }
    this.#draw(kept, { clear: true });
  }

  #draw(said, { clear = false } = {}) {
    if (clear) {
      for (const line of this.#lines) {
        line.remove();
      }
      this.#lines = [];
    }
    this.#said = said;
    for (const entry of said) {
      this.push(entry.who, entry.text, entry.meta, { at: entry.at, quiet: true });
    }
    this.reflow();
  }

  working() {
    const line = el("li", "msg msg--aos msg--working");
    const body = el("p", "msg__body", WORKING);
    line.append(body);
    this.log.append(line);
    if (this.idle) {
      this.log.append(this.idle);
    }
    this.#offset = 0;
    this.reflow();
    return {
      say: (text) => {
        body.textContent = text;
      },
      done: () => line.remove(),
    };
  }

  push(who, text, meta, { at: when, quiet = false, transient = false } = {}) {
    if (!quiet && !transient) {
      this.#said.push({ who, text, meta: meta ?? null, at: Date.now() });
    }
    const line = el("li", `msg msg--${who}`);
    const name = el("span", "msg__who");
    if (who === "you") {
      name.textContent = "Operator";
    } else {
      name.append(el("span", "msg__system", "AOS"), el("span", "msg__sep", "|"), el("span", "msg__agent", "Sybil"));
    }
    const clock = el("time", "msg__time");
    const at = when ? new Date(when) : new Date();
    clock.dateTime = at.toISOString();
    clock.textContent = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    name.append(clock);
    line.append(name, el("p", "msg__body", text));
    if (meta) {
      line.append(el("p", "msg__meta", meta));
    }
    this.log.append(line);
    if (!transient) {
      this.#lines.push(line);
    }
    if (this.idle) {
      this.log.append(this.idle);
    }
    this.#offset = 0;
    this.reflow();
    return line;
  }

  reflow() {
    const max = Math.max(0, this.log.scrollHeight - this.log.clientHeight);
    this.log.scrollTop = Math.max(0, Math.min(max, max - this.#offset));
  }

  boot(steps) {
    const block = el("li", "boot");
    block.append(el("p", "boot__title", "Bringing the console up"));
    const list = el("ul", "boot__list");
    const rows = new Map();
    for (const [key, label, state = "is-waiting"] of steps) {
      const row = el("li", `boot__step ${state}`);
      row.append(el("span", "boot__dot"), el("span", "boot__label", label), el("span", "boot__state"));
      rows.set(key, row);
      list.append(row);
    }
    block.append(list);
    this.log.prepend(block);
    this.reflow();
    this.#booting = true;

    let left = rows.size;
    const settle = (key, state, word) => {
      const row = rows.get(key);
      if (!row || row.classList.contains("is-done") || row.classList.contains("is-failed")) {
        return;
      }
      row.classList.remove("is-waiting", "is-running");
      row.classList.add(state);
      row.querySelector(".boot__state").textContent = word;
      left -= 1;
      if (left === 0) {
        setTimeout(() => {
          block.style.flex = `0 0 ${block.offsetHeight}px`;
          void block.offsetHeight;
          block.classList.add("is-going");
          block.style.flex = "0 0 0px";
          setTimeout(() => {
            block.remove();
            this.#booting = false;
            clearTimeout(this.#rescue);
            if (this.#waiting) {
              const waiting = this.#waiting;
              this.#waiting = null;
              this.#draw(waiting);
            }
            this.reflow();
          }, BOOT_OUT_MS);
        }, 900);
      }
    };

    return {
      start: (key) => {
        const row = rows.get(key);
        if (row?.classList.contains("is-waiting")) {
          row.classList.remove("is-waiting");
          row.classList.add("is-running");
        }
      },
      done: (key, word = "ok") => settle(key, "is-done", word),
      fail: (key, word = "failed") => settle(key, "is-failed", word),
    };
  }

  naturalHeight() {
    const items = [...this.log.children].filter((node) => node !== this.idle);
    if (!items.length || typeof getComputedStyle !== "function") {
      return 0;
    }
    const span = items[items.length - 1].getBoundingClientRect().bottom - items[0].getBoundingClientRect().top;
    const box = getComputedStyle(this.log);
    const padding = parseFloat(box.paddingTop) + parseFloat(box.paddingBottom);
    return span + padding + this.form.offsetHeight + 2;
  }
}
