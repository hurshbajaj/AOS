
export const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
};

const GOOGLE_G = `<svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
  <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92a8.78 8.78 0 0 0 2.68-6.62z"/>
  <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.02-3.7H.96v2.34A9 9 0 0 0 9 18z"/>
  <path fill="#FBBC05" d="M3.98 10.72a5.4 5.4 0 0 1 0-3.44V4.96H.96a9 9 0 0 0 0 8.08l3.02-2.32z"/>
  <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.59A8.98 8.98 0 0 0 .96 4.96l3.02 2.32C4.68 5.16 6.66 3.58 9 3.58z"/>
</svg>`;

const FIELDS = {
  email: { label: "Email", type: "email", autocomplete: "email" },
  name: { label: "Name", type: "text", autocomplete: "name" },
  org: { label: "Organisation", type: "text", autocomplete: "organization" },
  password: { label: "Password", type: "password", autocomplete: "new-password" },
  phone: { label: "Phone", type: "tel", autocomplete: "tel", optional: true },
  notes: { label: "Notes", type: "textarea", optional: true, placeholder: "\u2014" },
};

const EYE = `<svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
  <path d="M1.5 9S4.3 4.2 9 4.2 16.5 9 16.5 9 13.7 13.8 9 13.8 1.5 9 1.5 9z"/>
  <circle cx="9" cy="9" r="2.1"/>
</svg>`;
const EYE_OFF = `<svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
  <path d="M7.1 4.5A7.4 7.4 0 0 1 9 4.2C13.7 4.2 16.5 9 16.5 9a13 13 0 0 1-2.4 2.9M4.3 5.6A12.9 12.9 0 0 0 1.5 9S4.3 13.8 9 13.8c.9 0 1.7-.2 2.4-.4"/>
  <path d="M2.6 2.6l12.8 12.8"/>
</svg>`;

function field(key, { value = "", autocomplete, label, rows, reveal, grow, quiet } = {}) {
  const spec = FIELDS[key];
  const wrap = el("label", "field");
  const head = el("span", "field__head");
  head.append(el("span", "field__label", label ?? spec.label));
  if (spec.optional && !quiet) {
    head.append(el("span", "field__optional", "optional"));
  }
  const input = el(spec.type === "textarea" ? "textarea" : "input", "field__input");
  if (spec.type !== "textarea") {
    input.type = spec.type;
  } else {
    input.rows = rows ?? 3;
  }
  input.name = key;
  input.value = value;
  input.autocomplete = autocomplete ?? spec.autocomplete ?? "off";
  if (spec.placeholder) {
    input.placeholder = spec.placeholder;
  }
  if (grow && spec.type === "textarea") {
    wrap.classList.add("field--grow");
    input.addEventListener("focus", () => wrap.classList.add("is-writing"));
    input.addEventListener("blur", () => wrap.classList.remove("is-writing"));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        input.blur();
      }
    });
  }

  const error = el("span", "field__error");
  error.hidden = true;

  const shell = el("span", "field__shell");
  shell.append(input);
  wrap.append(head, shell, error);

  if (reveal) {
    shell.classList.add("field__shell--reveal");
    const eye = el("button", "field__reveal");
    eye.type = "button";
    eye.innerHTML = EYE;
    eye.setAttribute("aria-label", "Show password");
    eye.addEventListener("click", () => {
      const shown = input.type === "text";
      input.type = shown ? "password" : "text";
      eye.innerHTML = shown ? EYE : EYE_OFF;
      eye.setAttribute("aria-label", shown ? "Show password" : "Hide password");
      input.focus();
    });
    shell.append(eye);
  }

  if (spec.hint && !reveal) {
    wrap.append(el("span", "field__hint", spec.hint));
  }
  return { wrap, input, error, key };
}

export function complain(fields, errors = {}) {
  let first = null;
  for (const entry of Object.values(fields)) {
    const message = errors[entry.key];
    if (entry.error) {
      entry.error.textContent = message ?? "";
      entry.error.hidden = !message;
    }
    entry.line?.classList.toggle("is-wrong", Boolean(message));
    if (entry.input) {
      entry.input.classList.toggle("is-wrong", Boolean(message));
      entry.input.setAttribute("aria-invalid", message ? "true" : "false");
    }
    if (message && !first) {
      first = entry.input ?? entry.line;
    }
  }
  first?.focus?.();
}

const googleButton = (label) => {
  const link = el("a", "oauth");
  link.href = "/api/auth/google";
  link.innerHTML = `${GOOGLE_G}<span>${label}</span>`;
  return link;
};

export function gate({ mode = "in", google, onMode, onSubmit }) {
  const card = el("section", "card card--gate");
  card.append(el("p", "card__kicker", "Autonomous Orbital Sentinel"));

  const toggle = el("div", "toggle");
  toggle.setAttribute("role", "tablist");
  const tabs = {};
  for (const [key, label] of [["in", "Sign in"], ["up", "Create account"]]) {
    const tab = el("button", "toggle__tab", label);
    tab.type = "button";
    tab.setAttribute("role", "tab");
    tab.addEventListener("click", () => key !== mode && onMode(key));
    tabs[key] = tab;
    toggle.append(tab);
  }
  const markTabs = () => {
    for (const [key, tab] of Object.entries(tabs)) {
      tab.setAttribute("aria-selected", String(key === mode));
      tab.classList.toggle("is-on", key === mode);
    }
  };
  markTabs();

  const stage = el("div", "gate__body");
  let current = null;
  let crossing = 0;
  let fields = {};
  let form = null;
  let notice = null;
  let submit = null;

  const build = () => {
    fields = {};
    const make = (key, options) => (fields[key] = field(key, options));

    const layer = el("div", "gate__layer");
    const head = el("div", "gate__head");
    head.append(
      el("h1", "card__title", mode === "in" ? "Sign in" : "Create an account"),
      el(
        "p",
        "card__blurb",
        mode === "in"
          ? "Your hazards and your conversations with Sybil follow you between sessions."
          : "An account keeps the hazards you inject and what you ask Sybil, and nothing else.",
      ),
    );

    form = el("form", "form");
    if (mode === "in") {
      form.append(
        make("email").wrap,
        make("password", { autocomplete: "current-password", reveal: true }).wrap,
      );
    } else {
      const pair = el("div", "form__pair");
      pair.append(make("name").wrap, make("org").wrap);
      const required = el("div", "gate__main");
      const inside = el("div", "gate__fields");
      inside.append(make("email").wrap, make("password", { reveal: true }).wrap);
      required.append(inside);
      const stack = el("div", "gate__stack");
      stack.append(required, extras(make, stack));
      form.append(pair, stack);
    }

    notice = el("p", "form__notice");
    notice.hidden = true;
    submit = el("button", "button button--go", mode === "in" ? "Sign in" : "Create account");
    submit.type = "submit";
    form.append(notice, submit);

    if (google) {
      const or = el("div", "or");
      or.append(el("span", null, "or"));
      form.append(or, googleButton(mode === "in" ? "Continue with Google" : "Sign up with Google"));
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      onSubmit(Object.fromEntries(Object.entries(fields).map(([key, entry]) => [key, entry.input.value])));
    });

    layer.append(head, form);
    current = layer;
    stage.replaceChildren(layer);
  };

  build();
  card.append(toggle, stage);

  return {
    card,
    get fields() {
      return fields;
    },
    get form() {
      return form;
    },
    get notice() {
      return notice;
    },
    get submit() {
      return submit;
    },
    become(next) {
      if (next === mode) {
        return;
      }
      clearTimeout(crossing);
      const ghost = current;
      const from = stage.offsetHeight;

      mode = next;
      markTabs();
      build();

      if (ghost) {
        ghost.classList.add("gate__layer--ghost");
        stage.append(ghost);
      }
      current.classList.add("is-entering");

      const to = stage.offsetHeight;
      stage.style.height = `${from}px`;
      void stage.offsetHeight;
      stage.style.height = `${to}px`;

      const soon = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => fn();
      soon(() => {
        current?.classList.remove("is-entering");
        ghost?.classList.add("is-gone");
      });

      crossing = setTimeout(() => {
        ghost?.remove();
        stage.style.height = "";
      }, GATE_CROSS_MS);
    },
  };
}

function extras(make, stack) {
  const more = el("div", "more");
  const head = el("button", "more__head");
  head.type = "button";
  head.setAttribute("aria-expanded", "false");
  head.append(el("span", "more__word", "Phone and notes"), el("span", "more__hint", "optional"));

  const fold = el("div", "more__fold");
  const body = el("div", "more__body");
  const phone = make("phone", { quiet: true });
  const notes = make("notes", { rows: 1, grow: true, quiet: true });
  const first = el("div", "more__first");
  first.append(phone.wrap);

  let unfold = 0;
  const foldPhone = (away) => {
    clearTimeout(unfold);
    const from = first.offsetHeight;
    let to = 0;
    if (!away) {
      first.style.height = "auto";
      to = first.offsetHeight;
    }
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      first.style.height = "";
      return;
    }
    first.style.height = `${from}px`;
    void first.offsetHeight;
    first.style.height = `${to}px`;
    if (!away) {
      unfold = setTimeout(() => {
        first.style.height = "";
      }, FOLD_MS + 60);
    }
  };
  body.append(first, notes.wrap);
  fold.append(body);

  const grow = () => {
    const box = notes.input;
    const chrome = notes.wrap.offsetHeight - box.offsetHeight;
    const room = Math.max(box.offsetHeight, body.clientHeight - chrome);
    if (Number.isFinite(room) && room > 0) {
      box.style.height = `${room}px`;
    }
    foldPhone(true);
    body.classList.add("is-writing");
  };

  const settle = () => {
    if (!body.classList.contains("is-writing")) {
      return;
    }
    body.classList.remove("is-writing");
    notes.input.style.height = "";
    foldPhone(false);
  };

  notes.input.addEventListener("focus", grow);
  notes.input.addEventListener("blur", settle);

  let unpin = 0;
  head.addEventListener("click", () => {
    const open = !more.classList.contains("is-open");
    more.classList.toggle("is-open", open);
    head.setAttribute("aria-expanded", String(open));
    clearTimeout(unpin);

    if (open) {
      stack.style.height = `${stack.offsetHeight}px`;
      stack.classList.add("is-expanded");
      return;
    }

    settle();
    notes.wrap.classList.remove("is-writing");
    notes.input.blur?.();
    stack.classList.add("is-folding");
    stack.classList.remove("is-expanded");
    unpin = setTimeout(() => {
      stack.classList.remove("is-folding");
      const from = stack.offsetHeight;
      stack.style.height = "auto";
      const to = stack.offsetHeight;
      stack.style.height = `${from}px`;
      void stack.offsetHeight;
      stack.style.height = `${to}px`;
      unpin = setTimeout(() => {
        stack.style.height = "";
      }, STAGE_MS);
    }, FOLD_MS);
  });

  more.append(head, fold);
  return more;
}

const POWER = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  <path d="M8 2.2v5.2"/>
  <path d="M11.8 4.2a5 5 0 1 1-7.6 0"/>
</svg>`;

const monogram = (name) =>
  String(name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join("");

const FOLD_MS = 480;

const GATE_CROSS_MS = 540;

const STAGE_MS = 420;

const CLOSE_MS = 240;

const PEN = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  <path d="M11.4 2.6l2 2-7.5 7.5-2.6.6.6-2.6z"/>
  <path d="M9.9 4.1l2 2"/>
</svg>`;

const BACK = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  <path d="M9.6 3.4L5 8l4.6 4.6"/>
</svg>`;

const when = (iso, opts = { day: "numeric", month: "short", year: "numeric" }) =>
  new Date(iso).toLocaleDateString([], opts);

const MAIL = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  <rect x="1.8" y="3.4" width="12.4" height="9.2" rx="1.6"/>
  <path d="M2.4 4.4L8 8.6l5.6-4.2"/>
</svg>`;

const CLOCK = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  <circle cx="8" cy="8" r="5.9"/>
  <path d="M8 4.6V8l2.4 1.5"/>
</svg>`;

const PLUS = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  <path d="M8 3.4v9.2M3.4 8h9.2"/>
</svg>`;

const CROSS = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  <path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2"/>
</svg>`;

function cell(key, label, value, { onEdit, wide, onOpen, onClose } = {}) {
  const line = el("div", `cell${wide ? " cell--wide" : ""}`);
  const head = el("span", "cell__label", label);

  const pen = el("button", "cell__pen");
  pen.type = "button";
  pen.innerHTML = PEN;
  pen.setAttribute("aria-label", `Edit ${label.toLowerCase()}`);

  const slot = el("span", "cell__slot");
  const text = el("span", "cell__value", value || "—");
  text.classList.toggle("is-empty", !value);
  const error = el("span", "cell__error");
  error.hidden = true;
  slot.append(text, error);
  line.append(head, pen, slot);

  const multiline = key === "notes";
  const input = el(multiline ? "textarea" : "input", "cell__input");
  if (multiline) {
    input.rows = 2;
  } else {
    input.type = key === "phone" ? "tel" : "text";
  }
  input.maxLength = multiline ? 500 : 80;
  input.hidden = true;
  input.setAttribute("aria-label", label);
  slot.append(input);

  let editing = false;
  let closing = 0;

  const stop = (commit) => {
    if (!editing) {
      return;
    }
    editing = false;
    const next = input.value.trim();
    text.hidden = false;
    pen.hidden = false;
    if (commit) {
      onEdit(key, next);
    }
    line.classList.remove("is-editing");
    line.classList.add("is-closing");
    onClose?.();
    closing = setTimeout(() => {
      line.classList.remove("is-closing");
      input.hidden = true;
    }, CLOSE_MS);
  };

  pen.addEventListener("click", () => {
    if (editing) {
      return;
    }
    clearTimeout(closing);
    line.classList.remove("is-closing");
    editing = true;
    input.value = text.classList.contains("is-empty") ? "" : text.textContent;
    input.hidden = false;
    text.hidden = true;
    pen.hidden = true;
    line.classList.add("is-editing");
    onOpen?.();
    input.focus();
    if (multiline) {
      input.setSelectionRange(input.value.length, input.value.length);
    } else {
      input.select();
    }
  });

  if (key === "phone") {
    input.addEventListener("input", () => {
      const cleaned = input.value.replace(/[^0-9+()\-. \/]/g, "");
      if (cleaned !== input.value) {
        const at = input.selectionStart;
        input.value = cleaned;
        input.setSelectionRange(at - 1, at - 1);
      }
    });
  }

  input.addEventListener("blur", () => stop(true));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      stop(false);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      stop(true);
    }
  });

  return { line, text, input, error, key };
}

const TICK = `<svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
  <circle class="tick__ring" cx="9" cy="9" r="7.1"/>
  <path class="tick__mark" d="M5.4 9.3l2.6 2.6 4.8-5.6"/>
</svg>`;

const CLOCK_FACE = `<svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
  <circle class="clock__face" cx="9" cy="9" r="6.6"/>
  <path class="clock__hands" d="M9 5.2V9h3.2"/>
</svg>`;

export function inscribe(node, text, tone) {
  node.className = `form__notice${tone ? ` form__notice--${tone}` : ""}`;
  node.hidden = !text;
  node.replaceChildren();
  if (!text) {
    return;
  }
  let index = 0;
  for (const word of String(text).split(" ")) {
    const run = el("span", "ink__word");
    for (const letter of word) {
      const glyph = el("span", "ink", letter);
      glyph.style.setProperty("--i", String(index));
      index += 1;
      run.append(glyph);
    }
    node.append(run);
    const space = el("span", "ink", " ");
    space.style.setProperty("--i", String(index));
    index += 1;
    node.append(space);
  }
}

function dots() {
  const wrap = el("span", "dots");
  wrap.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i += 1) {
    wrap.append(el("span"));
  }
  return wrap;
}

function codeEntry(onSubmit, expires, onResend) {
  const form = el("form", "code");
  const input = el("input", "code__input");
  input.type = "text";
  input.inputMode = "numeric";
  input.autocomplete = "one-time-code";
  input.pattern = "[0-9]*";
  input.maxLength = 6;
  input.placeholder = "000000";
  input.setAttribute("aria-label", "Confirmation code");

  const clock = el("span", "clock");
  clock.innerHTML = CLOCK_FACE;
  clock.tabIndex = 0;
  clock.setAttribute("role", "img");

  const tip = el("span", "clock__tip");
  tip.setAttribute("aria-hidden", "true");
  let words = "";
  let dismissing = 0;

  const show = () => {
    clearTimeout(dismissing);
    if (!document.body) {
      return;
    }
    tip.textContent = words;
    document.body.append(tip);
    const box = clock.getBoundingClientRect?.() ?? { right: 0, bottom: 0 };
    tip.style.left = `${Math.round(box.right - 6)}px`;
    tip.style.top = `${Math.round(box.bottom + 9)}px`;
    void tip.offsetWidth;
    tip.classList.add("is-up");
  };

  const hide = () => {
    tip.classList.remove("is-up");
    dismissing = setTimeout(() => tip.remove(), 260);
  };

  clock.addEventListener("pointerenter", show);
  clock.addEventListener("focus", show);
  clock.addEventListener("pointerleave", hide);
  clock.addEventListener("blur", hide);

  let ticking = 0;
  let deadline = 0;

  const countdown = () => {
    const remaining = Math.max(0, deadline - Date.now());
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    words = remaining
      ? `${mins}:${String(secs).padStart(2, "0")} left on this code`
      : "This code has expired — send another";
    tip.textContent = words;
    clock.setAttribute("aria-label", words);
    clock.classList.toggle("is-low", remaining > 0 && remaining < 60000);
    clock.classList.toggle("is-dead", remaining === 0);
    if (!remaining) {
      clearInterval(ticking);
      input.disabled = true;
      say("Expired", "bad");
    }
  };

  const status = el("span", "code__status");
  status.setAttribute("role", "status");
  const spin = el("span", "spinner");
  spin.setAttribute("aria-hidden", "true");
  const tick = el("span", "code__tick");
  tick.innerHTML = TICK;
  const word = el("span", "code__word");
  status.append(spin, tick, word);
  let again = null;
  if (onResend) {
    again = el("button", "fact__go code__again");
    again.type = "button";
    again.append(el("span", "sends__label", "Send another"), dots());
    again.addEventListener("click", () => onResend(again));
  }
  form.append(input, clock, status, ...(again ? [again] : []));

  const say = (text, tone) => {
    word.textContent = text ?? "";
    status.classList.toggle("code__status--bad", tone === "bad");
    status.classList.toggle("code__status--good", tone === "good");
  };

  const ui = {
    input,
    busy(on) {
      input.disabled = on;
      if (on) {
        say("Checking", null);
      }
      status.classList.toggle("is-busy", on);
    },
    wrong(text) {
      say(text, "bad");
      input.classList.add("is-wrong");
      input.select();
    },
    clear() {
      say(null);
      input.classList.remove("is-wrong");
    },
    until(iso) {
      clearInterval(ticking);
      ticking = 0;
      deadline = iso ? new Date(iso).getTime() : 0;
      clock.hidden = false;
      if (!deadline) {
        countdown();
        return;
      }
      say(null);
      input.classList.remove("is-wrong");
      input.disabled = false;
      countdown();
      ticking = setInterval(countdown, 1000);
    },
    right() {
      clearInterval(ticking);
      clock.hidden = true;
      input.disabled = true;
      input.classList.remove("is-wrong");
      input.classList.add("is-right");
      say("Confirmed", "good");
      status.classList.remove("is-busy");
    },
  };

  input.addEventListener("input", () => {
    const cleaned = input.value.replace(/\D/g, "").slice(0, 6);
    if (cleaned !== input.value) {
      input.value = cleaned;
    }
    ui.clear();
    if (cleaned.length === 6) {
      form.dispatchEvent(new Event("submit", { cancelable: true }));
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (input.value.length === 6 && !input.disabled) {
      onSubmit(input.value, ui);
    }
  });
  ui.until(expires);
  return { form, input, ui };
}

function fact(glyph, value, trailing) {
  const line = el("div", "fact");
  const mark = el("span", "fact__glyph");
  mark.innerHTML = glyph;
  line.append(mark, el("span", "fact__value", value));
  if (trailing) {
    line.append(trailing);
  }
  return line;
}

function morph(host, render, { done, settle = 340, hold = 150 } = {}) {
  const from = host.offsetHeight;
  host.style.height = `${from}px`;
  host.classList.add("is-fading");
  setTimeout(() => {
    render();
    host.style.height = "auto";
    const to = host.offsetHeight;
    host.style.height = `${from}px`;
    void host.offsetHeight;
    host.style.height = `${to}px`;
    host.classList.remove("is-fading");
    setTimeout(() => {
      host.style.height = "";
      done?.();
    }, settle);
  }, hold);
}

export function sheet({ user, consoles, mail, pending, onSave, onPassword, onResend, onLogout, onOpenConsole, onAddEmail, onDropEmail, onConfirm }) {
  const card = el("section", "card card--sheet");
  const draft = { name: user.name, org: user.org, phone: user.phone, notes: user.notes };
  const codes = {};
  const clocks = { ...(pending ?? {}) };

  const rail = el("nav", "rail");
  const brand = el("div", "rail__who");
  const mark = el("span", "monogram", monogram(user.name));
  mark.setAttribute("aria-hidden", "true");
  const naming = el("div", "rail__naming");
  const heading = el("p", "rail__name", user.name);
  naming.append(heading, el("p", "rail__org", user.org));
  brand.append(mark, naming);

  const pills = el("div", "rail__state");
  const badge = el("span", `pill ${user.verified ? "pill--ok" : "pill--warn"}`, user.verified ? "Verified" : "Unverified");
  pills.append(badge);

  const tabs = el("div", "tabs");
  const panes = {};
  const buttons = {};
  let settle = 0;
  const show = (key, animate = true) => {
    const from = animate ? stage.offsetHeight : 0;
    for (const [name, node] of Object.entries(panes)) {
      node.hidden = name !== key;
      buttons[name].classList.toggle("is-on", name === key);
      buttons[name].setAttribute("aria-selected", String(name === key));
    }
    if (!animate) {
      return;
    }
    clearTimeout(settle);
    const to = stage.scrollHeight;
    stage.classList.add("is-sliding");
    stage.style.height = `${from}px`;
    void stage.offsetHeight;
    stage.style.height = `${to}px`;
    settle = setTimeout(() => {
      stage.style.height = "";
      stage.classList.remove("is-sliding");
    }, STAGE_MS);
  };
  for (const [key, label] of [["profile", "Profile"], ["consoles", "Consoles"]]) {
    const tab = el("button", "tabs__tab", label);
    tab.type = "button";
    tab.setAttribute("role", "tab");
    if (key === "consoles" && consoles?.length) {
      tab.append(el("span", "tabs__count", String(consoles.length)));
    }
    tab.addEventListener("click", () => show(key));
    buttons[key] = tab;
    tabs.append(tab);
  }

  const out = el("button", "signout");
  out.type = "button";
  const outLabel = el("span", "signout__label");
  outLabel.append(el("span", null, "Sign out"));
  out.innerHTML = `<span class="signout__glyph">${POWER}</span>`;
  out.append(outLabel);
  out.addEventListener("click", onLogout);

  const foot = el("div", "rail__foot");
  foot.append(out);
  rail.append(brand, pills, tabs, foot);
  const stage = el("div", "stage");
  card.append(rail, stage);

  const profile = el("section", "pane");
  panes.profile = profile;
  const title = el("h2", "pane__title", "Profile");
  const body = el("div", "pane__body");
  profile.append(title, body);

  let banner = null;
  if (!user.verified) {
    banner = el("div", "banner");
    banner.append(
      el(
        "p",
        "banner__text",
        mail
          ? `We sent a six-digit code to ${user.email}. Type it here to confirm the address.`
          : "This server has no mail configured, so the confirmation code was printed on the terminal running AOS. Type it here.",
      ),
    );
    const entry = codeEntry(
      (digits, ui) => onConfirm(digits, "verify", ui),
      clocks.verify,
      (button) => onResend(button, "verify"),
    );
    codes.verify = entry.ui;
    banner.append(entry.form);
    profile.insertBefore(banner, body);
  }

  let rows = {};
  let notice = el("p", "form__notice");
  let save = null;
  let pendingWord = null;
  let unpin = 0;

  const dirty = () =>
    ["name", "org", "phone", "notes"].some((key) => (draft[key] ?? "") !== (user[key] ?? ""));
  const refresh = () => {
    if (save) {
      save.disabled = !dirty();
    }
  };

  function record() {
    title.textContent = "Profile";
    rows = {};
    notice = el("p", "form__notice");
    notice.hidden = true;

    const edit = (key, value) => {
      draft[key] = value;
      rows[key].text.textContent = value || "—";
      rows[key].text.classList.toggle("is-empty", !value);
      refresh();
    };

    const grid = el("div", "cells");
    const short = el("div", "fold");
    const shortRow = el("div", "short");
    for (const [key, label] of [["name", "Name"], ["org", "Organisation"], ["phone", "Phone"]]) {
      rows[key] = cell(key, label, draft[key], { onEdit: edit });
      shortRow.append(rows[key].line);
    }
    short.append(shortRow);
    grid.append(short);
    rows.notes = cell("notes", "Notes", draft.notes, {
      onEdit: edit,
      wide: true,
      onOpen: () => {
        clearTimeout(unpin);
        body.style.height = `${body.offsetHeight}px`;
        body.classList.add("is-expanded");
      },
      onClose: () => {
        body.classList.add("is-folding");
        body.classList.remove("is-expanded");
        unpin = setTimeout(() => {
          body.classList.remove("is-folding");
          const from = body.offsetHeight;
          body.style.height = "auto";
          const to = body.offsetHeight;
          body.style.height = `${from}px`;
          void body.offsetHeight;
          body.style.height = `${to}px`;
          unpin = setTimeout(() => {
            body.style.height = "";
          }, STAGE_MS);
        }, FOLD_MS);
      },
    });
    grid.append(rows.notes.line);

    const factsFold = el("div", "fold");
    const facts = el("div", "facts");
    factsFold.append(facts);
    facts.append(fact(MAIL, user.email, el("span", "fact__tag", "Primary")));

    if (user.altEmail) {
      const drop = el("button", "fact__drop");
      drop.type = "button";
      drop.innerHTML = CROSS;
      drop.setAttribute("aria-label", `Remove ${user.altEmail}`);
      drop.addEventListener("click", () => onDropEmail(drop));
      const tag = el("span", `fact__tag ${user.altVerified ? "" : "fact__tag--wait"}`.trim(), user.altVerified ? "Secondary" : "Unconfirmed");
      const line = fact(MAIL, user.altEmail, tag);
      line.append(drop);
      facts.append(line);
      if (!user.altVerified) {
        const entry = codeEntry(
          (digits, ui) => onConfirm(digits, "alt", ui),
          clocks.alt,
          (button) => onResend(button, "alt"),
        );
        codes.alt = entry.ui;
        entry.form.classList.add("code--inset");
        facts.append(entry.form);
      }
    } else {
      facts.append(emailSlot());
    }

    facts.append(fact(CLOCK, `Joined ${when(user.joined, { day: "numeric", month: "long", year: "numeric" })}`));

    save = el("button", "button button--go", "Save changes");
    save.type = "button";
    save.disabled = true;
    save.addEventListener("click", () => onSave({ ...draft }));

    const change = el("button", "button button--quiet", "Change password");
    change.type = "button";
    change.addEventListener("click", () => morph(body, password));

    const bar = el("div", "form__foot");
    bar.append(notice, change, save);
    body.replaceChildren(grid, factsFold, bar);
    refresh();
    if (pendingWord) {
      inscribe(notice, pendingWord.text, pendingWord.tone);
      pendingWord = null;
    }
  }

  function emailSlot() {
    const swap = el("div", "swap");

    const add = el("button", "fact fact--add");
    add.type = "button";
    const plus = el("span", "fact__glyph");
    plus.innerHTML = PLUS;
    add.append(plus, el("span", "fact__value", "Add another address"));

    const form = el("form", "fact fact--form");
    const mark = el("span", "fact__glyph");
    mark.innerHTML = MAIL;
    const shell = el("span", "fact__shell");
    const input = el("input", "fact__input");
    input.type = "email";
    input.maxLength = 254;
    input.placeholder = "another@example.com";
    input.setAttribute("aria-label", "Another email address");
    shell.append(input);
    const go = el("button", "fact__go");
    go.type = "submit";
    go.append(el("span", "sends__label", "Add"), dots());
    const cancel = el("button", "fact__drop");
    cancel.type = "button";
    cancel.innerHTML = CROSS;
    cancel.setAttribute("aria-label", "Cancel");
    form.append(mark, shell, go, cancel);

    const show = (which) => {
      add.classList.toggle("is-away", which !== add);
      form.classList.toggle("is-away", which !== form);
    };
    add.addEventListener("click", () => {
      show(form);
      input.focus();
    });
    cancel.addEventListener("click", () => {
      input.value = "";
      show(add);
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      onAddEmail(input.value, { input, button: go, notice });
    });

    show(add);
    swap.append(add, form);
    return swap;
  }

  function password() {
    title.textContent = "Change password";
    const passFields = {};
    notice = el("p", "form__notice");
    notice.hidden = true;

    const form = el("form", "form");
    const back = el("button", "backlink");
    back.type = "button";
    back.innerHTML = BACK;
    back.append(el("span", null, "Profile"));
    back.addEventListener("click", () => morph(body, record));
    form.append(back);

    const grid = el("div", "form__row");
    if (user.hasPassword !== false) {
      passFields.current = field("password", { label: "Current", autocomplete: "current-password", reveal: true });
      passFields.current.key = "current";
      grid.append(passFields.current.wrap);
    }
    passFields.password = field("password", { label: "New password", reveal: true });
    grid.append(passFields.password.wrap);
    form.append(grid);

    const confirm = el("button", "button button--go", "Change password");
    confirm.type = "submit";
    const foot = el("div", "form__foot");
    foot.append(notice, confirm);
    form.append(foot);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      onPassword(
        { current: passFields.current?.input.value ?? "", password: passFields.password.input.value },
        { fields: passFields, notice, button: confirm, back: () => morph(body, record) },
      );
    });

    body.replaceChildren(form);
    save = null;
  }

  record();

  const cns = el("section", "pane");
  panes.consoles = cns;
  cns.append(el("h2", "pane__title", "Consoles"));
  cns.append(
    el(
      "p",
      "pane__blurb",
      "Each one keeps its own hazards and layers. Open the console to start, rename or clear them.",
    ),
  );

  if (!consoles?.length) {
    cns.append(el("p", "log__empty", "None saved yet."));
  } else {
    const list = el("div", "rows");
    for (const saved of consoles) {
      const line = el("button", "row row--go");
      line.type = "button";
      const count = (saved.state?.hazards ?? []).length;
      const text = el("span", "row__stack");
      text.append(el("span", "row__value", saved.name));
      if (saved.note) {
        text.append(el("span", "row__note", saved.note));
      }
      line.append(
        text,
        el("span", "row__tail", `${count} hazard${count === 1 ? "" : "s"}`),
        el("span", "row__tail row__tail--dim", when(saved.updated, { day: "numeric", month: "short" })),
      );
      line.addEventListener("click", () => onOpenConsole(saved));
      list.append(line);
    }
    cns.append(list);
  }

  stage.append(profile, cns);
  show("profile", false);

  return {
    card,
    get fields() {
      return rows;
    },
    get notice() {
      return notice;
    },
    get save() {
      return save;
    },
    heading,
    later(text, tone) {
      pendingWord = { text, tone };
    },
    get codes() {
      return codes;
    },
    until(fresh) {
      Object.assign(clocks, fresh ?? {});
      for (const kind of Object.keys(fresh ?? {})) {
        codes[kind]?.until(fresh[kind]);
      }
    },
    onSaved(next) {
      Object.assign(user, next);
      Object.assign(draft, { name: next.name, org: next.org, phone: next.phone, notes: next.notes });
      heading.textContent = next.name;
      mark.textContent = monogram(next.name);
      naming.children[1].textContent = next.org;
      refresh();
    },
    onEmail(next, fresh) {
      Object.assign(user, next);
      Object.assign(clocks, fresh ?? {});
      if (next.verified && banner) {
        const going = banner;
        banner = null;
        going.style.height = `${going.offsetHeight}px`;
        void going.offsetHeight;
        going.classList.add("is-going");
        going.style.height = "0px";
        setTimeout(() => going.remove(), STAGE_MS);
      }
      badge.className = `pill ${next.verified ? "pill--ok" : "pill--warn"}`;
      badge.textContent = next.verified ? "Verified" : "Unverified";
      morph(body, record);
    },
  };
}
