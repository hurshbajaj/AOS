
export class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this._style = {};
    this.dataset = {};
    this.style = { setProperty: (k, v) => { this._style[k] = v; } };
    this._cls = new Set();
    this.classList = {
      add: (...c) => c.forEach((x) => this._cls.add(x)),
      remove: (...c) => c.forEach((x) => this._cls.delete(x)),
      toggle: (c, on) => ((on ?? !this._cls.has(c)) ? this._cls.add(c) : this._cls.delete(c)),
      contains: (c) => this._cls.has(c),
    };
  }

  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this._cls].join(" "); }
  set innerHTML(v) {
    this._html = v;
    this.children = [];
    for (const m of String(v).matchAll(/class="([^"]+)"/g)) {
      const c = new El("span");
      c.className = m[1];
      c.parentNode = this;
      this.children.push(c);
    }
  }
  set textContent(v) { this._text = v; }
  get textContent() { return this._text ?? this.children.map((c) => c.textContent).join(" "); }

  get offsetWidth() { return 10; }
  get offsetHeight() { return 44; }
  get scrollHeight() { return this._scrollHeight ?? 62; }
  set scrollHeight(value) { this._scrollHeight = value; }
  get clientHeight() { return this._clientHeight ?? 180; }
  set clientHeight(value) { this._clientHeight = value; }
  get firstChild() { return this.children[0] ?? null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    return this.parentNode.children[this.parentNode.children.indexOf(this) + 1] ?? null;
  }
  get lastElementChild() { return this.children[this.children.length - 1] ?? null; }
  getBoundingClientRect() {
    const i = this.parentNode ? this.parentNode.children.indexOf(this) : 0;
    const top = i * 52;
    return { top, left: 0, width: 272, height: 44, bottom: top + 44, right: 272 };
  }

  append(...kids) {
    for (const k of kids) {
      if (k.parentNode) k.parentNode.children = k.parentNode.children.filter((c) => c !== k);
      k.parentNode = this;
      this.children.push(k);
    }
  }
  prepend(...kids) {
    for (const k of kids.reverse()) {
      if (k.parentNode) k.parentNode.children = k.parentNode.children.filter((c) => c !== k);
      k.parentNode = this;
      this.children.unshift(k);
    }
  }
  insertBefore(node, ref) {
    const i = this.children.indexOf(ref);
    if (i < 0) throw new Error("NotFoundError: insertBefore reference is not a child");
    if (node.parentNode) node.parentNode.children = node.parentNode.children.filter((c) => c !== node);
    node.parentNode = this;
    this.children.splice(i, 0, node);
  }
  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
      this.parentNode = null;
    }
  }
  replaceWith(node) {
    if (!this.parentNode) return;
    this.parentNode.insertBefore(node, this);
    this.remove();
  }
  replaceChildren(...kids) {
    this.children.forEach((c) => { c.parentNode = null; });
    this.children = [];
    this.append(...kids);
  }
  querySelector(sel) {
    const want = sel.replace(".", "");
    const walk = (n) => {
      for (const c of n.children) {
        if (c._cls.has(want)) return c;
        const d = walk(c);
        if (d) return d;
      }
      return null;
    };
    return walk(this);
  }
  setAttribute(key, value) {
    (this._attr ??= {})[key] = value;
    if (key === "class") {
      this.className = value;
    }
  }
  getAttribute(key) { return this._attr?.[key] ?? null; }
  addEventListener(type, fn) { ((this._on ??= {})[type] ??= []).push(fn); }
  dispatch(type, event = {}) {
    for (const fn of this._on?.[type] ?? []) fn({ preventDefault() {}, ...event });
  }
  dispatchEvent(event) {
    this.dispatch(event?.type ?? String(event), event ?? {});
    return true;
  }
  focus() {}
  select() { this._caret = [0, String(this.value ?? "").length]; }
  setSelectionRange(start, end) { this._caret = [start, end]; }
}

export const textOf = (node) => {
  const out = [];
  const walk = (n) => {
    if (n._text) out.push(n._text);
    n.children.forEach(walk);
  };
  walk(node);
  return out.filter(Boolean);
};

const pending = new Map();
let timer = 0;
export const flush = () => {
  const due = [...pending.values()];
  pending.clear();
  due.forEach((fn) => fn());
};

export function install() {
  globalThis.document = {
    createElement: (t) => new El(t),
    createElementNS: (_ns, t) => new El(t),
    body: new El("body"),
  };
  globalThis.Event = class {
    constructor(type, options = {}) {
      this.type = type;
      Object.assign(this, options);
    }
    preventDefault() {}
  };
  globalThis.CustomEvent ??= class extends globalThis.Event {
    constructor(type, options = {}) {
      super(type, options);
      this.detail = options.detail ?? null;
    }
  };
  globalThis.requestAnimationFrame = (fn) => { pending.set(++timer, () => fn(0)); return timer; };
  globalThis.setTimeout = (fn) => { pending.set(++timer, fn); return timer; };
  globalThis.setInterval = () => 0;
  globalThis.clearTimeout = (id) => { pending.delete(id); };
  globalThis.flush = flush;
}
