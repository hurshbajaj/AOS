
const KEY = "aos:updates";
const LIMIT = 12;
const CYCLE_MS = 6000;

export const KINDS = {
  flare: { glyph: "✸", colour: "#ffb067" },
  storm: { glyph: "≋", colour: "#7fd4ff" },
  debris: { glyph: "✦", colour: "#ff7a7a" },
  outage: { glyph: "▣", colour: "#c9a6ff" },
  jam: { glyph: "⌁", colour: "#9dff8f" },
  route: { glyph: "⤳", colour: "#ffffff" },
  system: { glyph: "◆", colour: "#ffffff" },
};

const SEED = [
  { kind: "storm", text: "Auroral oval unrest over the Norwegian Sea" },
  { kind: "route", text: "Mesh plane 4 rerouted around Hartebeesthoek" },
  { kind: "jam", text: "Uplink interference logged at 16°N 44°E" },
];

const read = () => {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(KEY));
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch {
    return null;
  }
};

export function pushUpdate(kind, text) {
  const entries = read() ?? [];
  entries.unshift({ kind, text, at: Date.now() });
  try {
    sessionStorage.setItem(KEY, JSON.stringify(entries.slice(0, LIMIT)));
  } catch {
  }
  window.dispatchEvent(new CustomEvent("aos:update"));
}

function ago(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m ago`;
  }
  return `${Math.round(seconds / 3600)}h ago`;
}

export class UpdatePanel {
  #timer = 0;
  #index = 0;

  constructor(root) {
    this.root = root;
    this.root.classList.add("updates");
    this.root.innerHTML = `
      <span class="updates__glyph" aria-hidden="true"></span>
      <span class="updates__body">
        <span class="updates__label">Latest</span>
        <span class="updates__text"></span>
      </span>
      <span class="updates__age"></span>`;
    this.glyph = this.root.querySelector(".updates__glyph");
    this.text = this.root.querySelector(".updates__text");
    this.age = this.root.querySelector(".updates__age");

    window.addEventListener("aos:update", () => {
      this.#index = 0;
      this.paint();
    });
    this.start();
  }

  get entries() {
    return read() ?? SEED.map((entry, offset) => ({ ...entry, at: Date.now() - (offset + 1) * 90_000 }));
  }

  paint() {
    const entries = this.entries;
    if (!entries.length) {
      return;
    }
    const entry = entries[this.#index % entries.length];
    const spec = KINDS[entry.kind] ?? KINDS.system;
    this.root.style.setProperty("--tint", spec.colour);
    this.glyph.textContent = spec.glyph;
    this.text.textContent = entry.text;
    this.age.textContent = ago(entry.at);
    this.root.classList.remove("is-fresh");
    void this.root.offsetWidth;
    this.root.classList.add("is-fresh");
  }

  start() {
    this.paint();
    clearInterval(this.#timer);
    this.#timer = setInterval(() => {
      this.#index += 1;
      this.paint();
    }, CYCLE_MS);
  }
}
