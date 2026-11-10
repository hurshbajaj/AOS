
import {
  CONFIRM,
  LIMITS,
  SESSION_MAX_AGE,
  VERIFY_MINUTES_VALUE as VERIFY_MINUTES,
  THROTTLE,
  check,
  checkEmail,
  code,
  fingerprint,
  hash,
  mint,
  orgKey,
  publicUser,
  sessionExpiry,
  throttleUntil,
  throttled,
  userId,
  verify,
  verifyExpiry,
} from "./accounts.mjs";
import { open, queries } from "./db.mjs";
import { BUNDLES, Forge, LIMITS as FORGE, dependenciesFrom, sandboxed } from "./forge.mjs";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { deliver, deliverable, config as mailConfig } from "./mail.mjs";
import { html as htmlLetter, plain as plainLetter, subjectFor } from "./letter.mjs";
import { authUrl, claims, configured as googleConfigured, exchange, settings as googleSettings } from "./oauth.mjs";

const safeParse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
};

const COOKIE = "aos_session";
const STATE_COOKIE = "aos_oauth";
const BODY_LIMIT = 160 * 1024;

const KEEP = { chat: 60, hazard: 120 };
const SHOW = 12;

const INSTANCE = { name: 60, note: 500, state: 32 * 1024, max: 24 };

const SCRIPT = { name: 64, source: FORGE.sourceBytes, manifest: 8 * 1024, max: FORGE.scripts };

const dependencyNames = (manifest) => dependenciesFrom(manifest).deps.map((d) => d.name);

const DOCUMENT = { name: 80, body: 48 * 1024, max: 16, total: 192 * 1024 };

const KINDS = new Set(["text", "markdown", "csv", "json", "tle"]);

const kindOf = (name) => {
  const extension = String(name).toLowerCase().split(".").pop();
  return { md: "markdown", markdown: "markdown", csv: "csv", tsv: "csv", json: "json", tle: "tle", txt: "text" }[extension] ?? "text";
};

const json = (response, status, body, headers = {}) =>
  response
    .writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers })
    .end(JSON.stringify(body));

const redirect = (response, location, headers = {}) =>
  response.writeHead(302, { Location: location, "Cache-Control": "no-store", ...headers }).end();

export function parseCookies(header = "") {
  const out = {};
  for (const part of String(header).split(";")) {
    const at = part.indexOf("=");
    if (at > 0) {
      out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
    }
  }
  return out;
}

export function cookie(name, value, { maxAge, secure }) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

const isSecure = (request) =>
  request.socket?.encrypted === true || request.headers["x-forwarded-proto"] === "https";

export const origin = (request) => {
  const host = request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost";
  return `${isSecure(request) ? "https" : "http"}://${host}`;
};

const sameOrigin = (request) => {
  const stated = request.headers.origin;
  return !stated || stated === origin(request);
};

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > BODY_LIMIT) {
      throw new Error("too large");
    }
  }
  if (!body) {
    return {};
  }
  return JSON.parse(body);
}

export class Accounts {
  constructor({ path, env = process.env, mailer = deliver, reachable = deliverable, forge = new Forge() } = {}) {
    this.db = open(path);
    this.q = queries(this.db);
    this.env = env;
    this.mailer = mailer;
    this.forge = forge;
    this.reachable = reachable;
  }

  #pending(user) {
    const out = {};
    for (const kind of ["verify", "alt"]) {
      const row = this.q.liveToken.get(user.id, kind);
      if (row && new Date(row.expires_at).getTime() > Date.now()) {
        out[kind] = row.expires_at;
      }
    }
    return out;
  }

  #seedConsole(user) {
    const team = orgKey(user.org);
    if (this.q.countInstances.get(team).n > 0) {
      return;
    }
    const now = new Date().toISOString();
    this.q.insertInstance.run(
      `cns_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      user.id,
      team,
      "Main console",
      "Everything in play right now.",
      "{}",
      now,
      now,
    );
  }

  session(request) {
    const token = parseCookies(request.headers.cookie)[COOKIE];
    if (!token) {
      return null;
    }
    const row = this.q.session.get(fingerprint(token));
    if (!row) {
      return null;
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      this.q.dropSession.run(row.token_hash);
      return null;
    }
    return this.q.byId.get(row.user_id) ?? null;
  }

  #start(user, request) {
    const { token, token_hash } = mint();
    const now = new Date().toISOString();
    this.q.insertSession.run(token_hash, user.id, now, sessionExpiry());
    this.q.expireSessions.run(now);
    return cookie(COOKIE, token, { maxAge: SESSION_MAX_AGE, secure: isSecure(request) });
  }

  async #sendVerification(user, request, kind = "verify") {
    const to = kind === "alt" ? user.alt_email : user.email;
    this.q.dropTokens.run(user.id, kind);
    const { code: digits, token_hash } = code();
    this.q.insertToken.run(token_hash, user.id, kind, verifyExpiry());
    const letter = { name: user.name, code: digits, kind, minutes: VERIFY_MINUTES, to };
    return this.mailer(
      {
        to,
        subject: subjectFor(digits),
        text: plainLetter(letter),
        html: htmlLetter(letter),
        code: digits,
      },
      this.env,
    );
  }

  async handle(request, response, pathname) {
    const route = pathname.replace(/^\/api\//, "");
    const post = request.method === "POST";

    if (post && !sameOrigin(request)) {
      json(response, 403, { error: "Cross-site request refused." });
      return true;
    }

    const coded =
      /^instances\/([A-Za-z0-9_-]{1,40})\/(scripts|build|bundle)(?:\/([A-Za-z0-9_-]{1,40}))?(?:\/(delete))?$/.exec(
        route,
      );
    if (coded) {
      try {
        return await this.#code(request, response, {
          instance: coded[1],
          what: coded[2],
          id: coded[3],
          verb: coded[4],
        });
      } catch (error) {
        if (error instanceof SyntaxError || error.message === "too large") {
          json(response, 400, { error: "Could not read that request." });
          return true;
        }
        console.error("[aos] script error:", error.message);
        json(response, 500, { error: "Something went wrong on the server." });
        return true;
      }
    }

    const owned = /^instances(?:\/([A-Za-z0-9_-]{1,40}))?(?:\/(delete))?$/.exec(route);
    if (owned) {
      try {
        return await this.#instances(request, response, { id: owned[1], verb: owned[2] });
      } catch (error) {
        if (error instanceof SyntaxError || error.message === "too large") {
          json(response, 400, { error: "Could not read that request." });
          return true;
        }
        console.error("[aos] instance error:", error.message);
        json(response, 500, { error: "Something went wrong on the server." });
        return true;
      }
    }

    const papers = /^documents(?:\/([A-Za-z0-9_-]{1,40}))?(?:\/(delete))?$/.exec(route);
    if (papers) {
      try {
        return await this.#documents(request, response, { id: papers[1], verb: papers[2] });
      } catch (error) {
        if (error instanceof SyntaxError || error.message === "too large") {
          json(response, 400, { error: "Could not read that request." });
          return true;
        }
        console.error("[aos] document error:", error.message);
        json(response, 500, { error: "Something went wrong on the server." });
        return true;
      }
    }

    try {
      switch (`${request.method} ${route}`) {
        case "GET me":
          return this.#me(request, response);
        case "POST auth/signup":
          return await this.#signup(request, response);
        case "POST auth/login":
          return await this.#login(request, response);
        case "POST auth/logout":
          return this.#logout(request, response);
        case "POST auth/resend":
          return await this.#resend(request, response);
        case "POST auth/confirm":
          return await this.#confirm(request, response);
        case "GET auth/google":
          return this.#googleStart(request, response);
        case "GET auth/google/callback":
          return await this.#googleBack(request, response);
        case "POST profile":
          return await this.#saveProfile(request, response);
        case "POST profile/password":
          return await this.#changePassword(request, response);
        case "POST profile/email":
          return await this.#addEmail(request, response);
        case "POST profile/email/remove":
          return this.#dropEmail(request, response);
        case "POST activity":
          return await this.#record(request, response);
        case "GET activity":
          return this.#history(request, response);
        default:
          return false;
      }
    } catch (error) {
      if (error instanceof SyntaxError || error.message === "too large") {
        json(response, 400, { error: "Could not read that request." });
        return true;
      }
      console.error("[aos] account error:", error.message);
      json(response, 500, { error: "Something went wrong on the server." });
      return true;
    }
  }

  #me(request, response) {
    const user = this.session(request);
    json(response, 200, {
      user: publicUser(user),
      google: googleConfigured(this.env),
      mail: Boolean(mailConfig(this.env)),
      limits: LIMITS,
      activity: user ? this.#recent(user.id) : null,
      consoles: user ? this.q.countInstances.get(orgKey(user.org)).n : 0,
      pending: user ? this.#pending(user) : null,
    });
    return true;
  }

  async #signup(request, response) {
    const body = await readJson(request);
    const { fields, errors, ok } = check(body);
    if (!ok) {
      json(response, 422, { errors });
      return true;
    }
    if (this.q.byEmail.get(fields.email)) {
      json(response, 409, { errors: { email: "There is already an account on that address." } });
      return true;
    }

    const reach = await this.reachable(fields.email);
    if (!reach.ok) {
      json(response, 422, { errors: { email: reach.reason } });
      return true;
    }

    const now = new Date().toISOString();
    const id = userId();
    this.q.insertUser.run(
      id,
      fields.email,
      fields.name,
      fields.org,
      fields.phone || null,
      fields.notes || null,
      await hash(body.password),
      null,
      0,
      now,
      now,
    );
    const user = this.q.byId.get(id);
    this.#seedConsole(user);
    const setCookie = this.#start(user, request);

    let mail;
    try {
      mail = await this.#sendVerification(user, request);
    } catch (error) {
      console.error("[aos] verification mail failed:", error.message);
      mail = { sent: false, via: "failed", error: error.message };
    }
    json(response, 201, { user: publicUser(user), mail, pending: this.#pending(user), activity: this.#recent(id) }, { "Set-Cookie": setCookie });
    return true;
  }

  async #login(request, response) {
    const body = await readJson(request);
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const key = `${email}|${request.socket.remoteAddress ?? "?"}`;

    if (throttled(this.q.attempts.get(key))) {
      json(response, 429, {
        error: `Too many attempts. Wait ${Math.round(THROTTLE.windowMs / 60000)} minutes and try again.`,
      });
      return true;
    }

    const user = this.q.byEmail.get(email);
    const good = await verify(password, user?.password ?? "scrypt$1$1$1$AA$AA");
    if (!user || !good) {
      this.q.bumpAttempts.run(key, throttleUntil());
      json(response, 401, { error: "That email and password do not match." });
      return true;
    }

    this.q.clearAttempts.run(key);
    const setCookie = this.#start(user, request);
    json(response, 200, { user: publicUser(user), activity: this.#recent(user.id) }, { "Set-Cookie": setCookie });
    return true;
  }

  #logout(request, response) {
    const token = parseCookies(request.headers.cookie)[COOKIE];
    if (token) {
      this.q.dropSession.run(fingerprint(token));
    }
    json(response, 200, { user: null }, {
      "Set-Cookie": cookie(COOKIE, "", { maxAge: 0, secure: isSecure(request) }),
    });
    return true;
  }

  async #resend(request, response) {
    const user = this.session(request);
    if (!user) {
      json(response, 401, { error: "Sign in first." });
      return true;
    }
    const body = await readJson(request);
    const kind = body.kind === "alt" ? "alt" : "verify";

    const settled = kind === "alt" ? !user.alt_email || user.alt_verified : user.verified;
    if (settled) {
      this.q.dropTokens.run(user.id, kind);
      json(response, 200, { mail: { sent: false, via: "already verified" } });
      return true;
    }
    try {
      const mail = await this.#sendVerification(user, request, kind);
      json(response, 200, { mail, pending: this.#pending(user) });
    } catch (error) {
      json(response, 502, { error: `The mail server refused it: ${error.message}` });
    }
    return true;
  }

  async #confirm(request, response) {
    const user = this.session(request);
    if (!user) {
      json(response, 401, { error: "Sign in first." });
      return true;
    }
    const body = await readJson(request);
    const kind = body.kind === "alt" ? "alt" : "verify";
    const digits = String(body.code ?? "").replace(/\s+/g, "");

    const row = this.q.liveToken.get(user.id, kind);
    if (!row || new Date(row.expires_at).getTime() < Date.now()) {
      json(response, 410, { errors: { code: "That code has expired. Ask for a new one." } });
      return true;
    }
    if (row.tries >= CONFIRM.attempts) {
      json(response, 429, { errors: { code: "Too many wrong tries. Ask for a new code." } });
      return true;
    }
    if (fingerprint(digits) !== row.token_hash) {
      this.q.missedToken.run(row.token_hash);
      const left = CONFIRM.attempts - row.tries - 1;
      json(response, 422, {
        errors: { code: left > 0 ? `That is not the code. ${left} ${left === 1 ? "try" : "tries"} left.` : "That is not the code. Ask for a new one." },
      });
      return true;
    }

    this.q.useToken.run(row.token_hash);
    this.q.dropTokens.run(user.id, kind);
    const now = new Date().toISOString();
    if (kind === "alt") {
      this.q.markAltVerified.run(now, user.id);
    } else {
      this.q.markVerified.run(now, user.id);
    }
    json(response, 200, { user: publicUser(this.q.byId.get(user.id)) });
    return true;
  }

  #googleStart(request, response) {
    if (!googleConfigured(this.env)) {
      redirect(response, "/profile?google=unset");
      return true;
    }
    const { token } = mint();
    redirect(response, authUrl(googleSettings(this.env), token), {
      "Set-Cookie": cookie(STATE_COOKIE, token, { maxAge: 600, secure: isSecure(request) }),
    });
    return true;
  }

  async #googleBack(request, response) {
    const url = new URL(request.url, "http://localhost");
    const clear = cookie(STATE_COOKIE, "", { maxAge: 0, secure: isSecure(request) });
    const fail = (why) => redirect(response, `/profile?google=${why}`, { "Set-Cookie": clear });

    const state = parseCookies(request.headers.cookie)[STATE_COOKIE];
    if (!state || state !== url.searchParams.get("state")) {
      return fail("state") || true;
    }
    if (url.searchParams.get("error")) {
      return fail("denied") || true;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      return fail("nocode") || true;
    }

    const config = googleSettings(this.env);
    let identity;
    try {
      const tokens = await exchange(code, config);
      identity = claims(tokens.id_token, config);
    } catch (error) {
      console.error("[aos] Google sign-in failed:", error.message);
      return fail("exchange") || true;
    }

    const now = new Date().toISOString();
    let user = this.q.byGoogle.get(identity.sub) ?? this.q.byEmail.get(identity.email);
    if (!user) {
      const id = userId();
      this.q.insertUser.run(
        id,
        identity.email,
        identity.name,
        identity.domain ?? "—",
        null,
        null,
        null,
        identity.sub,
        1,
        now,
        now,
      );
      user = this.q.byId.get(id);
      this.#seedConsole(user);
    } else if (!user.google_sub) {
      this.q.linkGoogle.run(identity.sub, now, user.id);
      user = this.q.byId.get(user.id);
    }

    redirect(response, "/profile?google=done", {
      "Set-Cookie": [clear, this.#start(user, request)],
    });
    return true;
  }

  async #saveProfile(request, response) {
    const user = this.session(request);
    if (!user) {
      json(response, 401, { error: "Sign in first." });
      return true;
    }
    const body = await readJson(request);
    const { fields, errors, ok } = check({ ...body, email: user.email }, { password: false });
    if (!ok) {
      json(response, 422, { errors });
      return true;
    }
    this.q.updateProfile.run(
      fields.name,
      fields.org,
      fields.phone || null,
      fields.notes || null,
      new Date().toISOString(),
      user.id,
    );
    if (orgKey(fields.org) !== orgKey(user.org)) {
      this.q.reKeyInstances.run(orgKey(fields.org), user.id);
      this.q.reKeyDocuments.run(orgKey(fields.org), user.id);
    }
    const fresh = this.q.byId.get(user.id);
    this.#seedConsole(fresh);
    json(response, 200, { user: publicUser(fresh) });
    return true;
  }

  async #changePassword(request, response) {
    const user = this.session(request);
    if (!user) {
      json(response, 401, { error: "Sign in first." });
      return true;
    }
    const body = await readJson(request);
    const next = String(body.password ?? "");
    const [min, max] = LIMITS.password;
    if (next.length < min || next.length > max) {
      json(response, 422, { errors: { password: `Between ${min} and ${max} characters.` } });
      return true;
    }
    if (user.password && !(await verify(String(body.current ?? ""), user.password))) {
      json(response, 403, { errors: { current: "That is not the current password." } });
      return true;
    }
    this.q.updatePassword.run(await hash(next), new Date().toISOString(), user.id);
    this.q.dropUserSessions.run(user.id);
    json(response, 200, { user: publicUser(this.q.byId.get(user.id)) }, { "Set-Cookie": this.#start(user, request) });
    return true;
  }

  async #record(request, response) {
    const user = this.session(request);
    if (!user) {
      json(response, 200, { stored: false });
      return true;
    }
    const body = await readJson(request);
    const kind = body.kind === "hazard" ? "hazard" : body.kind === "chat" ? "chat" : null;
    if (!kind) {
      json(response, 422, { error: "kind must be chat or hazard." });
      return true;
    }
    const summary = String(body.summary ?? "").trim().slice(0, 400);
    if (!summary) {
      json(response, 422, { error: "summary is needed." });
      return true;
    }
    const detail = body.detail === undefined ? null : JSON.stringify(body.detail).slice(0, 2000);
    this.q.insertActivity.run(user.id, kind, summary, detail, new Date().toISOString());
    this.q.trimActivity.run(user.id, kind, user.id, kind, KEEP[kind]);
    json(response, 200, { stored: true });
    return true;
  }

  async #addEmail(request, response) {
    const user = this.session(request);
    if (!user) {
      json(response, 401, { error: "Sign in first." });
      return true;
    }
    const body = await readJson(request);
    const { email, error } = checkEmail(body.email);
    if (error) {
      json(response, 422, { errors: { altEmail: error } });
      return true;
    }
    if (email === user.email) {
      json(response, 422, { errors: { altEmail: "That is already the address on the account." } });
      return true;
    }
    const taken = this.q.byAnyEmail.get(email, email);
    if (taken && taken.id !== user.id) {
      json(response, 409, { errors: { altEmail: "That address is on another account." } });
      return true;
    }

    const reach = await this.reachable(email);
    if (!reach.ok) {
      json(response, 422, { errors: { altEmail: reach.reason } });
      return true;
    }

    this.q.setAlt.run(email, new Date().toISOString(), user.id);
    const fresh = this.q.byId.get(user.id);
    let mail;
    try {
      mail = await this.#sendVerification(fresh, request, "alt");
    } catch (error_) {
      console.error("[aos] second-address mail failed:", error_.message);
      mail = { sent: false, via: "failed", error: error_.message };
    }
    json(response, 200, { user: publicUser(fresh), mail, pending: this.#pending(fresh) });
    return true;
  }

  #dropEmail(request, response) {
    const user = this.session(request);
    if (!user) {
      json(response, 401, { error: "Sign in first." });
      return true;
    }
    this.q.dropTokens.run(user.id, "alt");
    this.q.clearAlt.run(new Date().toISOString(), user.id);
    json(response, 200, { user: publicUser(this.q.byId.get(user.id)) });
    return true;
  }

  async #documents(request, response, { id, verb }) {
    const user = this.session(request);
    if (!user) {
      json(response, 401, { error: "Sign in first." });
      return true;
    }
    const team = orgKey(user.org);
    const shape = (row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      bytes: row.bytes,
      author: row.author ?? null,
      created: row.created_at,
      updated: row.updated_at,
      ...(row.body === undefined ? {} : { body: row.body }),
    });
    const list = () => this.q.documents.all(team).map(shape);

    if (request.method === "GET") {
      if (id) {
        const row = this.q.document.get(id, team);
        if (!row) {
          json(response, 404, { error: "No such document." });
          return true;
        }
        json(response, 200, { document: shape(row) });
        return true;
      }
      json(response, 200, { documents: list(), limits: DOCUMENT });
      return true;
    }

    if (request.method !== "POST") {
      json(response, 405, { error: "Use GET or POST." });
      return true;
    }

    if (verb === "delete") {
      this.q.dropDocument.run(id, team);
      json(response, 200, { documents: list() });
      return true;
    }

    const body = await readJson(request);
    const name = String(body.name ?? "").trim().replace(/\s+/g, " ").slice(0, DOCUMENT.name);
    const text = String(body.body ?? "");
    if (!name) {
      json(response, 422, { errors: { name: "Give it a name you will recognise in a month." } });
      return true;
    }
    if (!text.trim()) {
      json(response, 422, { errors: { body: "There is nothing in it." } });
      return true;
    }
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > DOCUMENT.body) {
      json(response, 422, {
        errors: { body: `That is ${Math.round(bytes / 1024)}KB. One document can be ${Math.round(DOCUMENT.body / 1024)}KB — paste the part that matters.` },
      });
      return true;
    }
    const kind = KINDS.has(body.kind) ? body.kind : kindOf(name);

    const clash = this.q.documentByName.get(team, name);
    if (clash && clash.id !== id) {
      json(response, 409, { errors: { name: "Your team already has one by that name." } });
      return true;
    }

    const now = new Date().toISOString();
    if (id) {
      if (!this.q.document.get(id, team)) {
        json(response, 404, { error: "No such document." });
        return true;
      }
      this.q.updateDocument.run(name, kind, text, bytes, now, id, team);
      json(response, 200, { document: shape(this.q.document.get(id, team)), documents: list() });
      return true;
    }

    const tally = this.q.countDocuments.get(team);
    if (tally.n >= DOCUMENT.max) {
      json(response, 409, { error: `That is ${DOCUMENT.max} documents, which is the limit. Remove one first.` });
      return true;
    }
    if (tally.total + bytes > DOCUMENT.total) {
      json(response, 409, {
        error: `Your team is at ${Math.round(DOCUMENT.total / 1024)}KB of documents, which is the limit. Remove something first.`,
      });
      return true;
    }

    const fresh = `doc_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    this.q.insertDocument.run(fresh, user.id, team, name, kind, text, bytes, now, now);
    json(response, 201, { document: shape(this.q.document.get(fresh, team)), documents: list() });
    return true;
  }

  async #instances(request, response, { id, verb }) {
    const user = this.session(request);
    if (!user) {
      json(response, 401, { error: "Sign in first." });
      return true;
    }
    const team = orgKey(user.org);
    const shape = (row) => ({
      id: row.id,
      name: row.name,
      note: row.note ?? "",
      state: safeParse(row.state),
      author: row.author ?? null,
      created: row.created_at,
      updated: row.updated_at,
    });
    const list = () => this.q.instances.all(team).map(shape);

    if (request.method === "GET") {
      if (id) {
        const row = this.q.instance.get(id, team);
        if (!row) {
          json(response, 404, { error: "No such console." });
          return true;
        }
        json(response, 200, { instance: shape(row) });
        return true;
      }
      json(response, 200, { instances: list() });
      return true;
    }

    if (request.method !== "POST") {
      json(response, 405, { error: "Not a thing you can do to a console." });
      return true;
    }

    const now = new Date().toISOString();

    if (verb === "delete") {
      this.q.dropInstance.run(id, team);
      json(response, 200, { instances: list() });
      return true;
    }

    const body = await readJson(request);
    const name = String(body.name ?? "").trim().slice(0, INSTANCE.name);
    const note = String(body.note ?? "").trim().slice(0, INSTANCE.note);

    let state;
    if (body.state !== undefined) {
      state = JSON.stringify(body.state);
      if (state.length > INSTANCE.state) {
        json(response, 413, { error: "That console has too much in it to save." });
        return true;
      }
    }

    if (!id) {
      if (this.q.countInstances.get(team).n >= INSTANCE.max) {
        json(response, 409, { error: `That is ${INSTANCE.max} consoles. Delete one first.` });
        return true;
      }
      if (!name) {
        json(response, 422, { errors: { name: "A name is needed." } });
        return true;
      }
      const made = `cns_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      this.q.insertInstance.run(made, user.id, team, name, note || null, state ?? "{}", now, now);
      json(response, 201, { instance: shape(this.q.instance.get(made, team)), instances: list() });
      return true;
    }

    if (!this.q.instance.get(id, team)) {
      json(response, 404, { error: "No such console." });
      return true;
    }
    if (body.name !== undefined || body.note !== undefined) {
      if (!name) {
        json(response, 422, { errors: { name: "A name is needed." } });
        return true;
      }
      this.q.renameInstance.run(name, note || null, now, id, team);
    }
    if (state !== undefined) {
      this.q.saveInstance.run(state, now, id, team);
    }
    json(response, 200, { instance: shape(this.q.instance.get(id, team)), instances: list() });
    return true;
  }

  async #code(request, response, { instance, what, id, verb }) {
    const user = this.session(request);
    if (!user) {
      json(response, 401, { error: "Sign in first." });
      return true;
    }
    const team = orgKey(user.org);
    const owner = this.q.instance.get(instance, team);
    if (!owner) {
      json(response, 404, { error: "No such console." });
      return true;
    }

    const shape = (row) => ({
      id: row.id,
      name: row.name,
      bytes: row.bytes,
      enabled: Boolean(row.enabled),
      position: row.position,
      dependencies: dependencyNames(row.manifest ?? ""),
      author: row.author ?? null,
      created: row.created_at,
      updated: row.updated_at,
    });
    const list = () => this.q.scripts.all(instance).map(shape);
    const bundle = () => {
      const row = this.q.bundle.get(instance, team);
      return {
        status: row?.bundle_status ?? "none",
        bytes: row?.bundle_bytes ?? 0,
        at: row?.bundle_at ?? null,
        log: safeParse(row?.bundle_log || "[]") ?? [],
      };
    };

    if (what === "bundle") {
      if (request.method !== "GET") {
        json(response, 405, { error: "Not a thing you can do to a bundle." });
        return true;
      }
      const state = bundle();
      if (state.status !== "built" && state.status !== "stale") {
        json(response, 404, { error: "This console has no bundle. Build it first." });
        return true;
      }
      const path = join(BUNDLES, `${instance}.wasm`);
      const bytes = await readFile(path).catch(() => null);
      if (!bytes) {
        this.q.setBundle.run("none", 0, null, "[]", instance, team);
        json(response, 409, { error: "The bundle is gone from disk. Build it again." });
        return true;
      }
      response
        .writeHead(200, {
          "Content-Type": "application/wasm",
          "Content-Length": bytes.length,
          "Cache-Control": "no-store",
          "X-Bundle-Status": state.status,
        })
        .end(bytes);
      return true;
    }

    if (what === "build") {
      if (request.method !== "POST") {
        json(response, 405, { error: "A build is a POST." });
        return true;
      }
      const scripts = this.q.buildableScripts.all(instance);
      if (!scripts.length) {
        const had = bundle().status !== "none";
        this.q.setBundle.run("none", 0, null, "[]", instance, team);
        await unlink(join(BUNDLES, `${instance}.wasm`)).catch(() => {});
        json(response, 200, {
          bundle: bundle(),
          scripts: list(),
          built: false,
          cleaned: had,
          reason: had ? "Bundle cleared. The console is back on its own physics." : "Nothing to build.",
        });
        return true;
      }
      const now = new Date().toISOString();
      this.q.setBundle.run("building", 0, now, "[]", instance, team);
      const result = await this.forge.build({ id: instance }, scripts);
      const log = JSON.stringify(result.diagnostics ?? []).slice(0, 64 * 1024);
      this.q.setBundle.run(
        result.ok ? "built" : "failed",
        result.bytes ?? 0,
        new Date().toISOString(),
        log,
        instance,
        team,
      );
      json(response, result.ok ? 200 : 422, {
        bundle: bundle(),
        scripts: list(),
        built: result.ok,
        ms: result.ms,
        dependencies: result.dependencies ?? [],
      });
      return true;
    }

    if (request.method === "GET") {
      if (id) {
        const row = this.q.script.get(id, instance);
        if (!row) {
          json(response, 404, { error: "No such script." });
          return true;
        }
        json(response, 200, { script: { ...shape(row), source: row.source, manifest: row.manifest } });
        return true;
      }
      json(response, 200, {
        scripts: list(),
        bundle: bundle(),
        forge: { sandboxed: sandboxed(), dependencies: sandboxed() ? FORGE.dependencies : 0, limits: FORGE },
      });
      return true;
    }

    if (request.method !== "POST") {
      json(response, 405, { error: "Not a thing you can do to a script." });
      return true;
    }

    const now = new Date().toISOString();

    if (verb === "delete") {
      this.q.dropScript.run(id, instance);
      this.q.staleBundle.run(instance);
      json(response, 200, { scripts: list(), bundle: bundle() });
      return true;
    }

    const body = await readJson(request);

    if (!id && Array.isArray(body.order)) {
      const known = new Set(this.q.scripts.all(instance).map((row) => row.id));
      if (body.order.length !== known.size || body.order.some((row) => !known.has(row))) {
        json(response, 422, { error: "An order has to name every script in the console, once each." });
        return true;
      }
      body.order.forEach((row, at) => this.q.orderScript.run(at, now, row, instance));
      this.q.staleBundle.run(instance);
      json(response, 200, { scripts: list(), bundle: bundle() });
      return true;
    }

    if (id && body.enabled !== undefined && body.source === undefined) {
      if (!this.q.script.get(id, instance)) {
        json(response, 404, { error: "No such script." });
        return true;
      }
      this.q.enableScript.run(body.enabled ? 1 : 0, now, id, instance);
      this.q.staleBundle.run(instance);
      json(response, 200, { scripts: list(), bundle: bundle() });
      return true;
    }

    const name = String(body.name ?? "").trim().slice(0, SCRIPT.name);
    const source = String(body.source ?? "");
    const manifest = String(body.manifest ?? "").slice(0, SCRIPT.manifest);

    if (!name) {
      json(response, 422, { errors: { name: "A name is needed." } });
      return true;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name)) {
      json(response, 422, {
        errors: { name: "Letters, digits, spaces, dots, dashes and underscores, starting with a letter or digit." },
      });
      return true;
    }
    const bytes = Buffer.byteLength(source);
    if (!bytes) {
      json(response, 422, { errors: { source: "That file is empty." } });
      return true;
    }
    if (bytes > SCRIPT.source) {
      json(response, 413, {
        errors: { source: `${(SCRIPT.source / 1024) | 0}KB is the most one script may be.` },
      });
      return true;
    }
    if (!sandboxed() && dependencyNames(manifest).length) {
      json(response, 422, {
        errors: {
          manifest:
            "This server cannot sandbox a build, so dependencies are refused. Write the script against aos-sim alone.",
        },
      });
      return true;
    }

    if (id) {
      if (!this.q.script.get(id, instance)) {
        json(response, 404, { error: "No such script." });
        return true;
      }
      this.q.updateScript.run(name, source, manifest, bytes, now, id, instance);
      this.q.staleBundle.run(instance);
      json(response, 200, { script: shape(this.q.script.get(id, instance)), scripts: list(), bundle: bundle() });
      return true;
    }

    if (this.q.countScripts.get(instance).n >= SCRIPT.max) {
      json(response, 409, { error: `That is ${SCRIPT.max} scripts. Delete one first.` });
      return true;
    }
    const made = `scr_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const slot = this.q.nextScriptSlot.get(instance).at;
    this.q.insertScript.run(made, instance, user.id, name, source, manifest, bytes, slot, now, now);
    this.q.staleBundle.run(instance);
    json(response, 201, { script: shape(this.q.script.get(made, instance)), scripts: list(), bundle: bundle() });
    return true;
  }

  #recent(id) {
    const counts = Object.fromEntries(this.q.countActivity.all(id).map((row) => [row.kind, row.n]));
    const shape = (row) => ({ ...row, detail: row.detail ? JSON.parse(row.detail) : null });
    return {
      chats: this.q.recentOfKind.all(id, "chat", SHOW).map(shape),
      hazards: this.q.recentOfKind.all(id, "hazard", SHOW).map(shape),
      counts: { chat: counts.chat ?? 0, hazard: counts.hazard ?? 0 },
    };
  }

  #history(request, response) {
    const user = this.session(request);
    if (!user) {
      json(response, 401, { error: "Sign in first." });
      return true;
    }
    json(response, 200, this.#recent(user.id));
    return true;
  }
}
