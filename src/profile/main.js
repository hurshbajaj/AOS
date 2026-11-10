
import { Sky } from "./sky.js";
import { complain, gate, inscribe, sheet } from "./ui.js";
import { forget, mark, whoami } from "../session.js";
import { closeAperture, openAperture } from "../aperture.js";
import { ambient, markHandoff } from "../ambient.js";
import { ROUTES } from "../routes.js";

const $ = (selector) => document.querySelector(selector);
const sheetRoot = $("[data-sheet]");

new Sky($("[data-sky]")).start();
ambient();

const entry = sessionStorage.getItem("profile:enter");
if (entry !== null) {
  sessionStorage.removeItem("profile:enter");
  let from = null;
  try {
    from = JSON.parse(entry);
  } catch {
    from = null;
  }
  openAperture(from);
}

$("[data-back]").addEventListener("click", async () => {
  markHandoff();
  await closeAperture();
  window.location.href = ROUTES.deck;
});

const LEAVE_MS = 200;
const SIZE_MS = 540;

function swap(card) {
  const leaving = sheetRoot.querySelector(".card");
  if (!leaving) {
    sheetRoot.replaceChildren(card);
    return;
  }
  const from = leaving.offsetHeight;
  leaving.style.height = `${from}px`;
  leaving.classList.add("is-leaving");
  setTimeout(() => {
    sheetRoot.replaceChildren(card);
    const to = card.offsetHeight;
    card.classList.add("is-sizing");
    card.style.height = `${from}px`;
    void card.offsetHeight;
    card.style.height = `${to}px`;
    setTimeout(() => {
      card.style.height = "";
      card.classList.remove("is-sizing");
    }, SIZE_MS);
  }, LEAVE_MS);
}

async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, ...payload };
}

function say(notice, text, tone = "bad") {
  inscribe(notice, text, text ? tone : null);
}

const busy = (button, on, label) => {
  button.disabled = on;
  button.classList.toggle("is-busy", on);
  if (label === undefined) {
    return;
  }
  button.dataset.label ??= button.textContent;
  button.textContent = on ? label : button.dataset.label;
};

let state = { user: null, google: false, mail: false, consoles: [], pending: null };
let mode = "in";

function arrival() {
  const params = new URLSearchParams(window.location.search);
  const messages = {
    "google=linked": ["Google account linked.", "good"],
    "google=state": ["That Google sign-in could not be matched to this browser. Try it again from here.", "bad"],
    "google=denied": ["Google sign-in was cancelled.", "bad"],
    "google=exchange": ["Google would not complete the sign-in. The server log has the reason.", "bad"],
    "google=nocode": ["Google sent us back without an authorisation code.", "bad"],
    "google=unset": ["Google sign-in is not configured on this server.", "bad"],
  };
  for (const [key, [text, tone]] of Object.entries(messages)) {
    const [name, value] = key.split("=");
    if (params.get(name) === value) {
      const banner = document.createElement("p");
      banner.className = `flash flash--${tone}`;
      banner.textContent = text;
      sheetRoot.before(banner);
      window.history.replaceState({}, "", window.location.pathname);
      setTimeout(() => banner.classList.add("is-going"), 6000);
      setTimeout(() => banner.remove(), 6800);
      return;
    }
  }
}

function showGate() {
  const view = gate({
    mode,
    google: state.google,
    onMode: (next) => {
      mode = next;
      view.become(next);
    },
    onSubmit: async (values) => {
      complain(view.fields, {});
      say(view.notice, null);
      busy(view.submit, true, mode === "in" ? "Signing in…" : "Creating…");
      const result = await post(mode === "in" ? "/api/auth/login" : "/api/auth/signup", values);
      busy(view.submit, false);

      if (result.errors) {
        complain(view.fields, result.errors);
        return;
      }
      if (!result.ok) {
        say(view.notice, result.error ?? "That did not work");
        return;
      }
      state = { ...state, user: result.user, consoles: [], pending: result.pending ?? null };
      if (result.mail && !result.mail.sent) {
        state.mail = false;
      }
      render();
    },
  });
  swap(view.card);
}

function showSheet() {
  const view = sheet({
    user: state.user,
    consoles: state.consoles,
    mail: state.mail,
    pending: state.pending,
    onSave: async (values) => {
      complain(view.fields, {});
      say(view.notice, null);
      busy(view.save, true, "Saving…");
      const result = await post("/api/profile", values);
      busy(view.save, false);
      if (result.errors) {
        complain(view.fields, result.errors);
        return;
      }
      if (!result.ok) {
        say(view.notice, result.error ?? "Could not save that");
        return;
      }
      state.user = result.user;
      view.onSaved(result.user);
      say(view.notice, "Saved", "good");
      mark(document.body, state);
      $("[data-who]").textContent = result.user.org;
    },
    onPassword: async (values, ui) => {
      complain(ui.fields, {});
      say(ui.notice, null);
      busy(ui.button, true, "Changing…");
      const result = await post("/api/profile/password", values);
      busy(ui.button, false);
      if (result.errors) {
        complain(ui.fields, result.errors);
        return;
      }
      if (!result.ok) {
        say(ui.notice, result.error ?? "Could not change it");
        return;
      }
      ui.back();
      say(view.notice, "Password changed — every other session signed out", "good");
    },
    onResend: async (button, kind = "verify") => {
      busy(button, true);
      const result = await post("/api/auth/resend", { kind });
      busy(button, false);
      if (result.pending) {
        view.until(result.pending);
      }
      say(
        view.notice,
        result.ok
          ? result.mail?.sent
            ? "Verification mail sent"
            : "Code printed on the server terminal"
          : result.error ?? "Could not send it",
        result.ok && result.mail?.sent ? "good" : "bad",
      );
    },
    onConfirm: async (code, kind, ui) => {
      ui.clear();
      ui.busy(true);
      const result = await post("/api/auth/confirm", { code, kind });
      ui.busy(false);
      if (!result.ok) {
        ui.wrong(result.errors?.code ?? result.error ?? "That did not work");
        return;
      }
      state.user = result.user;
      mark(document.body, state);
      ui.right();
      setTimeout(() => {
        view.later(kind === "alt" ? "Second address confirmed" : "Address confirmed", "good");
        view.onEmail(result.user);
      }, 760);
    },
    onAddEmail: async (email, ui) => {
      busy(ui.button, true);
      const result = await post("/api/profile/email", { email });
      busy(ui.button, false);
      if (result.errors?.altEmail) {
        say(ui.notice, result.errors.altEmail);
        ui.input.focus();
        return;
      }
      if (!result.ok) {
        say(ui.notice, result.error ?? "Could not add that address");
        return;
      }
      state.user = result.user;
      state.pending = result.pending ?? state.pending;
      view.later(result.mail?.sent ? "Verification mail sent" : "Code printed on the server terminal", result.mail?.sent ? "good" : "bad");
      view.onEmail(result.user, result.pending);
    },
    onDropEmail: async (button) => {
      button.disabled = true;
      const result = await post("/api/profile/email/remove");
      if (!result.ok) {
        button.disabled = false;
        return;
      }
      state.user = result.user;
      view.onEmail(result.user);
    },
    onOpenConsole: () => {
      markHandoff();
      window.location.href = ROUTES.orbital;
    },
    onLogout: async () => {
      await post("/api/auth/logout");
      forget();
      state = { ...state, user: null, consoles: [] };
      render();
    },
  });
  swap(view.card);
}

function render() {
  mark(document.body, state);
  const who = $("[data-who]");
  who.textContent = state.user ? state.user.org : "";
  if (state.user) {
    showSheet();
  } else {
    mode = mode === "up" ? "up" : "in";
    showGate();
  }
}

whoami({ fresh: true }).then(async (status) => {
  state = {
    user: status.user,
    google: Boolean(status.google),
    mail: Boolean(status.mail),
    consoles: [],
    pending: status.pending ?? null,
  };
  if (status.user) {
    state.consoles = await fetch("/api/instances")
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => body?.instances ?? [])
      .catch(() => []);
  }
  arrival();
  render();
});
