
import { Accounts } from "../scripts/api.mjs";
import { fingerprint } from "../scripts/accounts.mjs";
import { Readable } from "node:stream";

let failures = 0;
const ok = (label, pass, detail = "") => {
  console.log(`  ${pass ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!pass) failures += 1;
};

function request(method, path, { body, cookie, origin, address = "10.0.0.1" } = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const stream = Readable.from(payload ? [payload] : []);
  stream.method = method;
  stream.url = path;
  stream.headers = {
    host: "localhost:5173",
    ...(cookie ? { cookie } : {}),
    ...(origin ? { origin } : {}),
  };
  stream.socket = { remoteAddress: address };
  return stream;
}

function response() {
  const out = {
    status: 0,
    headers: {},
    body: null,
    writeHead(status, headers) {
      out.status = status;
      out.headers = { ...out.headers, ...headers };
      return out;
    },
    end(text) {
      out.body = text ? JSON.parse(text) : null;
      return out;
    },
  };
  return out;
}

const cookieFrom = (res) => {
  const set = [res.headers["Set-Cookie"]].flat().filter(Boolean);
  const session = set.find((line) => line.startsWith("aos_session=") && !line.startsWith("aos_session=;"));
  return session ? session.split(";")[0] : null;
};

const mails = [];
const env = {
  PUBLIC_URL: "http://localhost:5173",
};

const accounts = new Accounts({
  path: ":memory:",
  env,
  mailer: async (letter) => {
    mails.push(letter);
    return { sent: true, via: "test" };
  },
  reachable: async () => ({ ok: true }),
});

const call = async (method, path, options) => {
  const res = response();
  const handled = await accounts.handle(request(method, path, options), res, path.split("?")[0]);
  return { handled, ...res };
};

const signup = {
  email: "mira@example.com",
  name: "Mira Vance",
  org: "Orbital Ltd",
  password: "a long enough password",
  phone: "+44 20 7946 0958",
  notes: "Shift lead, nights.",
};

{
  const me = await call("GET", "/api/me");
  ok("an unknown visitor is nobody", me.status === 200 && me.body.user === null);
  ok("and is told what the server can do", me.body.google === false && me.body.mail === false);
  ok("the limits come with it, so the page need not duplicate them", me.body.limits.password[0] === 10);
  ok("no history for nobody", me.body.activity === null);

  const unknown = await call("GET", "/api/nope");
  ok("an unknown endpoint is not claimed", unknown.handled === false);

  const guarded = await call("POST", "/api/profile", { body: { name: "x" } });
  ok("editing a profile without a session is refused", guarded.status === 401);
  ok("so is reading history", (await call("GET", "/api/activity")).status === 401);
}

let session = null;
{
  const bad = await call("POST", "/api/auth/signup", { body: { ...signup, email: "nope", password: "short" } });
  ok("a bad sign-up is refused field by field", bad.status === 422 && bad.body.errors.email && bad.body.errors.password);
  ok("and sets no session", cookieFrom(bad) === null);

  const made = await call("POST", "/api/auth/signup", { body: signup });
  ok("a good sign-up creates the account", made.status === 201 && made.body.user.email === "mira@example.com");
  ok("it starts unverified", made.body.user.verified === false);
  ok("the optional fields are kept", made.body.user.phone === "+44 20 7946 0958" && made.body.user.notes === "Shift lead, nights.");
  ok("no password comes back", !JSON.stringify(made.body).includes("password"));
  session = cookieFrom(made);
  ok("and the session cookie is set", Boolean(session), session?.slice(0, 20));
  ok("httpOnly, Lax and rooted", [made.headers["Set-Cookie"]].flat().join().includes("HttpOnly; SameSite=Lax"));

  const again = await call("POST", "/api/auth/signup", { body: signup });
  ok("the same address cannot sign up twice", again.status === 409 && Boolean(again.body.errors.email));

  const me = await call("GET", "/api/me", { cookie: session });
  ok("the session identifies the account", me.body.user?.name === "Mira Vance");
  ok("and comes with empty history", me.body.activity.counts.chat === 0);

  const forged = await call("GET", "/api/me", { cookie: "aos_session=not-a-real-token" });
  ok("a made-up token is nobody", forged.body.user === null);
}

{
  ok("signing up mints a code", Boolean(accounts.db.prepare("select token_hash from tokens where kind = 'verify'").get()));
  ok("and sends exactly one letter", mails.length === 1, `${mails.length} sent`);
  ok("to the address that signed up", mails[0].to === "mira@example.com");
  ok("carrying a six-digit code", /^\d{6}$/.test(mails[0].code ?? ""), mails[0].code);
  ok("which appears in the body the recipient reads", mails[0].text.includes(mails[0].code));
  ok("and there is no link to follow", !/https?:\/\//.test(mails[0].text));
  ok("the code is not stored in the clear", accounts.db.prepare("select token_hash from tokens where kind = 'verify'").get().token_hash !== mails[0].code);
  ok("but its hash is what is filed", accounts.db.prepare("select token_hash from tokens where kind = 'verify'").get().token_hash === fingerprint(mails[0].code));

  ok("confirming needs a session", (await call("POST", "/api/auth/confirm", { body: { code: mails[0].code } })).status === 401);

  const wrong = await call("POST", "/api/auth/confirm", { cookie: session, body: { code: "000000" } });
  ok("a wrong code is refused", wrong.status === 422, wrong.body.errors?.code);
  ok("and says how many tries are left", /tries left/.test(wrong.body.errors.code), wrong.body.errors.code);
  ok("while the account stays unconfirmed", accounts.db.prepare("select verified from users").get().verified === 0);

  for (let i = 0; i < 9; i += 1) {
    await call("POST", "/api/auth/confirm", { cookie: session, body: { code: "000001" } });
  }
  const locked = await call("POST", "/api/auth/confirm", { cookie: session, body: { code: "000002" } });
  ok("ten wrong tries kills the code", locked.status === 429, locked.body.errors?.code);
  ok("and the right one no longer works either", (await call("POST", "/api/auth/confirm", { cookie: session, body: { code: mails[0].code } })).status === 429);

  const again = await call("POST", "/api/auth/resend", { cookie: session });
  ok("a new code can be asked for", again.status === 200 && mails.length === 2);
  ok("and it replaces the old one", accounts.db.prepare("select count(*) as n from tokens where kind = 'verify'").get().n === 1);
  ok("so the tries start again", (await call("POST", "/api/auth/confirm", { cookie: session, body: { code: "000000" } })).body.errors.code.includes("9 tries"));
  ok("and the first code is dead", (await call("POST", "/api/auth/confirm", { cookie: session, body: { code: mails[0].code } })).status === 422);

  const good = await call("POST", "/api/auth/confirm", { cookie: session, body: { code: mails[1].code } });
  ok("the right code confirms the account", good.status === 200 && good.body.user.verified === true);
  ok("the database agrees", accounts.db.prepare("select verified from users").get().verified === 1);
  ok("and it cannot be used twice", (await call("POST", "/api/auth/confirm", { cookie: session, body: { code: mails[1].code } })).status === 410);

  ok("a confirmed account is told there is nothing to resend", (await call("POST", "/api/auth/resend", { cookie: session })).body.mail.via === "already verified");
  ok("and no code is left lying in the table", accounts.db.prepare("select count(*) as n from tokens where kind = 'verify'").get().n === 0);

  const stale = await call("POST", "/api/auth/signup", { body: { email: "slow@example.com", name: "Slow", org: "Elsewhere", password: "a long enough password" } });
  const slowCookie = cookieFrom(stale);
  accounts.db.prepare("update tokens set expires_at = ? where kind = 'verify'").run(new Date(Date.now() - 1000).toISOString());
  const expired = await call("POST", "/api/auth/confirm", { cookie: slowCookie, body: { code: mails.at(-1).code } });
  ok("an expired code is refused", expired.status === 410, expired.body.errors?.code);
}

{
  const wrong = await call("POST", "/api/auth/login", { body: { email: signup.email, password: "not it" } });
  ok("a wrong password is refused", wrong.status === 401);
  const nobody = await call("POST", "/api/auth/login", { body: { email: "ghost@example.com", password: "not it" } });
  ok("an unknown address says exactly the same thing", nobody.status === 401 && nobody.body.error === wrong.body.error);

  const good = await call("POST", "/api/auth/login", { body: { email: "MIRA@example.com ", password: signup.password } });
  ok("the right password signs in", good.status === 200 && good.body.user.email === "mira@example.com");
  ok("and the address is not case sensitive", Boolean(cookieFrom(good)));

  for (let i = 0; i < 8; i += 1) {
    await call("POST", "/api/auth/login", { body: { email: "target@example.com", password: `guess ${i}` }, address: "10.0.0.9" });
  }
  const locked = await call("POST", "/api/auth/login", { body: { email: "target@example.com", password: "guess" }, address: "10.0.0.9" });
  ok("guessing gets locked out", locked.status === 429, locked.body.error);
  const elsewhere = await call("POST", "/api/auth/login", { body: { email: "target@example.com", password: "guess" }, address: "10.0.0.8" });
  ok("but only for that address, not the account", elsewhere.status === 401);
  await call("POST", "/api/auth/login", { body: { email: signup.email, password: signup.password }, address: "10.0.0.9" });
  const after = await call("POST", "/api/auth/login", { body: { email: signup.email, password: "wrong" }, address: "10.0.0.9" });
  ok("a success resets the count", after.status === 401);
}

{
  const foreign = await call("POST", "/api/profile", { cookie: session, body: { name: "Taken over" }, origin: "https://evil.test" });
  ok("a post from another origin is refused", foreign.status === 403);
  const same = await call("POST", "/api/profile", {
    cookie: session,
    body: { name: "Mira Vance", org: "Orbital Ltd" },
    origin: "http://localhost:5173",
  });
  ok("and one from this origin is not", same.status === 200);
}

{
  const saved = await call("POST", "/api/profile", {
    cookie: session,
    body: { name: "M. Vance", org: "Orbital Logistics", phone: "", notes: "Days now." },
  });
  ok("a profile edit saves", saved.status === 200 && saved.body.user.name === "M. Vance");
  ok("clearing an optional field clears it", saved.body.user.phone === "");
  ok("the address is not editable here", saved.body.user.email === "mira@example.com");

  const refused = await call("POST", "/api/profile", { cookie: session, body: { name: "", org: "x" } });
  ok("an empty name is refused", refused.status === 422 && Boolean(refused.body.errors.name));

  const other = await call("POST", "/api/auth/login", { body: { email: signup.email, password: signup.password } });
  const otherCookie = cookieFrom(other);
  const changed = await call("POST", "/api/profile/password", {
    cookie: session,
    body: { current: signup.password, password: "an even longer password" },
  });
  ok("the password changes", changed.status === 200);
  ok("the session that changed it survives", (await call("GET", "/api/me", { cookie: cookieFrom(changed) })).body.user !== null);
  ok("every other session is cut", (await call("GET", "/api/me", { cookie: otherCookie })).body.user === null);
  session = cookieFrom(changed);

  ok("the old password stops working", (await call("POST", "/api/auth/login", { body: { email: signup.email, password: signup.password } })).status === 401);
  ok("and the new one works", (await call("POST", "/api/auth/login", { body: { email: signup.email, password: "an even longer password" } })).status === 200);

  const noCurrent = await call("POST", "/api/profile/password", { cookie: session, body: { current: "wrong", password: "yet another long one" } });
  ok("changing it needs the current one", noCurrent.status === 403 && Boolean(noCurrent.body.errors.current));
  const tooShort = await call("POST", "/api/profile/password", { cookie: session, body: { current: "an even longer password", password: "short" } });
  ok("a short new password is refused", tooShort.status === 422);
}

{
  ok("recording without a session is quietly nothing", (await call("POST", "/api/activity", { body: { kind: "chat", summary: "x" } })).body.stored === false);

  await call("POST", "/api/activity", { cookie: session, body: { kind: "chat", summary: "where is GPS BIIR-2", detail: { reply: "Over the Pacific." } } });
  await call("POST", "/api/activity", { cookie: session, body: { kind: "hazard", summary: "Solar flare at 34°, -135°", detail: { kind: "flare" } } });
  const history = await call("GET", "/api/activity", { cookie: session });
  ok("a chat is filed", history.body.chats[0].summary === "where is GPS BIIR-2");
  ok("with its detail parsed back", history.body.chats[0].detail.reply === "Over the Pacific.");
  ok("a hazard is filed separately", history.body.hazards[0].summary.startsWith("Solar flare"));
  ok("and the counts are kept", history.body.counts.chat === 1 && history.body.counts.hazard === 1);

  ok("an unknown kind is refused", (await call("POST", "/api/activity", { cookie: session, body: { kind: "secrets", summary: "x" } })).status === 422);
  ok("so is an empty summary", (await call("POST", "/api/activity", { cookie: session, body: { kind: "chat", summary: "  " } })).status === 422);

  for (let i = 0; i < 61; i += 1) {
    await call("POST", "/api/activity", { cookie: session, body: { kind: "chat", summary: `question ${i}` } });
  }
  const capped = accounts.db.prepare("select count(*) as n from activity where kind = 'chat'").get();
  ok("history is capped per kind", capped.n === 60, `${capped.n} chats`);
  ok("and the first one is gone", accounts.db.prepare("select count(*) as n from activity where summary = 'where is GPS BIIR-2'").get().n === 0);
  ok("while the hazard is untouched", accounts.db.prepare("select count(*) as n from activity where kind = 'hazard'").get().n === 1);
}

{
  ok("adding one needs a session", (await call("POST", "/api/profile/email", { body: { email: "x@y.zz" } })).status === 401);

  const bad = await call("POST", "/api/profile/email", { cookie: session, body: { email: "not an address" } });
  ok("a malformed address is refused", bad.status === 422 && Boolean(bad.body.errors.altEmail));
  const same = await call("POST", "/api/profile/email", { cookie: session, body: { email: "mira@example.com" } });
  ok("so is the one already on the account", same.status === 422, same.body.errors?.altEmail);

  const before = mails.length;
  const added = await call("POST", "/api/profile/email", { cookie: session, body: { email: "  Mira.Vance@Work.example  " } });
  ok("a good one is added", added.status === 200 && added.body.user.altEmail === "mira.vance@work.example", added.body.user?.altEmail);
  ok("unconfirmed until the code is typed", added.body.user.altVerified === false);
  ok("and a confirmation goes to the new address", mails.length === before + 1 && mails.at(-1).to === "mira.vance@work.example");
  ok("the primary address is untouched", added.body.user.email === "mira@example.com");

  const altAgain = await call("POST", "/api/auth/resend", { cookie: session, body: { kind: "alt" } });
  ok("a second address can ask for a fresh code", altAgain.status === 200 && mails.length === before + 2);
  ok("which goes to the second address, not the primary", mails.at(-1).to === "mira.vance@work.example");
  ok("and replaces the one it supersedes", accounts.db.prepare("select count(*) as n from tokens where kind = 'alt'").get().n === 1);
  ok("the primary's own code is left alone", altAgain.body.pending.alt !== undefined);

  const digits = mails.at(-1).code;
  const crossed = await call("POST", "/api/auth/confirm", { cookie: session, body: { code: digits, kind: "verify" } });
  ok("the second address's code is not the primary's", crossed.status === 410 || crossed.status === 422, String(crossed.status));
  const done = await call("POST", "/api/auth/confirm", { cookie: session, body: { code: digits, kind: "alt" } });
  ok("its own code confirms it", done.status === 200 && done.body.user.altVerified === true);
  ok("without touching the primary one's state", (await call("GET", "/api/me", { cookie: session })).body.user.verified === true);

  ok("it cannot be signed in with", (await call("POST", "/api/auth/login", { body: { email: "mira.vance@work.example", password: "an even longer password" } })).status === 401);

  await call("POST", "/api/auth/signup", { body: { email: "rival@example.com", name: "Rival", org: "Elsewhere", password: "yet another password" } });
  const theirs = cookieFrom(await call("POST", "/api/auth/login", { body: { email: "rival@example.com", password: "yet another password" } }));
  const clash = await call("POST", "/api/profile/email", { cookie: theirs, body: { email: "mira.vance@work.example" } });
  ok("another account cannot claim it", clash.status === 409, clash.body.errors?.altEmail);
  const clashPrimary = await call("POST", "/api/profile/email", { cookie: theirs, body: { email: "mira@example.com" } });
  ok("nor claim someone's primary as its second", clashPrimary.status === 409);

  ok(
    "a confirmed second address has nothing to resend either",
    (await call("POST", "/api/auth/resend", { cookie: session, body: { kind: "alt" } })).body.mail.via === "already verified",
  );

  const picky = new Accounts({
    path: ":memory:",
    env,
    mailer: async (letter) => ({ sent: true, via: "test", letter }),
    reachable: async (address) =>
      address.endsWith("gmail.om")
        ? { ok: false, reason: "Nothing at gmail.om can receive mail. Check the spelling." }
        : { ok: true },
  });
  const pickyCall = async (method, path, options) => {
    const res = response();
    await picky.handle(request(method, path, options), res, path.split("?")[0]);
    return { status: res.status, body: res.body ?? {}, headers: res.headers };
  };
  const typo = await pickyCall("POST", "/api/auth/signup", {
    body: { email: "someone@gmail.om", name: "Typo", org: "Elsewhere", password: "a long enough password" },
  });
  ok("a domain that cannot take mail is refused at sign-up", typo.status === 422, typo.body.errors?.email);
  ok("and says which domain", /gmail\.om/.test(typo.body.errors.email), typo.body.errors.email);
  ok("with no account left behind", picky.db.prepare("select count(*) as n from users").get().n === 0);

  const fine = await pickyCall("POST", "/api/auth/signup", {
    body: { email: "someone@gmail.com", name: "Fine", org: "Elsewhere", password: "a long enough password" },
  });
  const fineCookie = cookieFrom({ headers: fine.headers });
  ok("while a domain that can is let through", fine.status === 201 || fine.status === 200, String(fine.status));
  const altTypo = await pickyCall("POST", "/api/profile/email", { cookie: fineCookie, body: { email: "hb.alt@gmail.om" } });
  ok("a second address is held to the same test", altTypo.status === 422, altTypo.body.errors?.altEmail);
  ok("and is not written to the account", picky.db.prepare("select alt_email from users where email = ?").get("someone@gmail.com").alt_email === null);

  const dropped = await call("POST", "/api/profile/email/remove", { cookie: session });
  ok("it can be removed", dropped.status === 200 && dropped.body.user.altEmail === "");
  ok("and its pending link dies with it", accounts.db.prepare("select count(*) as n from tokens where kind = 'alt'").get().n === 0);
  ok("after which the address is free again", (await call("POST", "/api/profile/email", { cookie: theirs, body: { email: "mira.vance@work.example" } })).status === 200);
}

{
  ok("listing them needs a session", (await call("GET", "/api/documents")).status === 401);

  const empty = await call("GET", "/api/documents", { cookie: session });
  ok("a new team has none", empty.status === 200 && empty.body.documents.length === 0);
  ok("and is told what the limits are, so the page need not guess", empty.body.limits.max > 0);

  const nameless = await call("POST", "/api/documents", { cookie: session, body: { body: "x" } });
  ok("one with no name is refused", nameless.status === 422, nameless.body.errors?.name);
  const hollow = await call("POST", "/api/documents", { cookie: session, body: { name: "fleet-spec.csv", body: "   " } });
  ok("and so is one with nothing in it", hollow.status === 422, hollow.body.errors?.body);

  const csv = "name,dry_kg,prop_kg,isp_s\nAOS-04,1200,310,230\nAOS-05,1180,298,230";
  const made = await call("POST", "/api/documents", { cookie: session, body: { name: "  fleet  spec.csv ", body: csv } });
  ok("a good one is kept", made.status === 201 && made.body.document.name === "fleet spec.csv", made.body.document?.name);
  ok("with its kind read off the name", made.body.document.kind === "csv", made.body.document?.kind);
  ok("and its size in bytes, not characters", made.body.document.bytes === Buffer.byteLength(csv, "utf8"));
  ok("attributed to whoever added it", made.body.document.author === "M. Vance", made.body.document?.author);
  const paper = made.body.document.id;
  ok("the id looks like one", /^doc_[0-9a-f]{16}$/.test(paper), paper);

  const listed = await call("GET", "/api/documents", { cookie: session });
  ok("the listing carries no bodies", listed.body.documents[0].body === undefined);
  ok("reading one does", (await call("GET", `/api/documents/${paper}`, { cookie: session })).body.document.body === csv);

  const clash = await call("POST", "/api/documents", { cookie: session, body: { name: "fleet spec.csv", body: "other" } });
  ok("two by the same name is refused", clash.status === 409, clash.body.errors?.name);

  const edited = await call("POST", `/api/documents/${paper}`, { cookie: session, body: { name: "fleet spec.csv", body: `${csv}\nAOS-06,1205,301,230` } });
  ok("one can be rewritten", edited.status === 200 && edited.body.document.body.includes("AOS-06"));
  ok("without the name counting as a clash with itself", edited.body.document.name === "fleet spec.csv");

  const huge = await call("POST", "/api/documents", { cookie: session, body: { name: "huge.txt", body: "x".repeat(49 * 1024) } });
  ok("one too big is refused with its size said plainly", huge.status === 422 && /KB/.test(huge.body.errors.body), huge.body.errors?.body);

  await call("POST", "/api/auth/signup", { body: { email: "teammate@example.com", name: "Teammate", org: "Orbital Logistics", password: "a long enough password" } });
  const theirs = cookieFrom(await call("POST", "/api/auth/login", { body: { email: "teammate@example.com", password: "a long enough password" } }));
  ok("a teammate sees it", (await call("GET", "/api/documents", { cookie: theirs })).body.documents.length === 1);

  await call("POST", "/api/auth/signup", { body: { email: "outsider@example.com", name: "Outsider", org: "Somewhere Else", password: "a long enough password" } });
  const outside = cookieFrom(await call("POST", "/api/auth/login", { body: { email: "outsider@example.com", password: "a long enough password" } }));
  ok("someone outside the team does not", (await call("GET", "/api/documents", { cookie: outside })).body.documents.length === 0);
  ok("and cannot read it by its id either", (await call("GET", `/api/documents/${paper}`, { cookie: outside })).status === 404);
  ok("nor overwrite it", (await call("POST", `/api/documents/${paper}`, { cookie: outside, body: { name: "mine.txt", body: "theirs now" } })).status === 404);
  ok("and deleting it does nothing", (await call("POST", `/api/documents/${paper}/delete`, { cookie: outside })).body.documents.length === 0);
  ok("so it is still there", (await call("GET", "/api/documents", { cookie: session })).body.documents.length === 1);

  const gone = await call("POST", `/api/documents/${paper}/delete`, { cookie: session });
  ok("the team can remove it", gone.status === 200 && gone.body.documents.length === 0);
}

{
  ok("listing consoles needs a session", (await call("GET", "/api/instances")).status === 401);
  const seeded = await call("GET", "/api/instances", { cookie: session });
  ok("a new account starts with one", seeded.status === 200 && seeded.body.instances.length === 1, String(seeded.body.instances.length));
  ok("and it says who made it", seeded.body.instances[0].author === "M. Vance", seeded.body.instances[0].author);

  const made = await call("POST", "/api/instances", { cookie: session, body: { name: "Pacific flare", note: "GPS outage drill" } });
  ok("one can be created", made.status === 201 && made.body.instance.name === "Pacific flare");
  ok("with its note", made.body.instance.note === "GPS outage drill");
  ok("and the list comes back with it", made.body.instances.length === 2);
  const id = made.body.instance.id;
  ok("the id looks like one", /^cns_[0-9a-f]{16}$/.test(id), id);

  ok("a nameless console is refused", (await call("POST", "/api/instances", { cookie: session, body: { name: "  " } })).status === 422);

  const state = { v: 1, hazards: [{ kind: "flare", label: "Solar flare", lat: 34, lon: -135, severity: 0.6, radius: 0.9, durationMin: 180 }], filters: { density: 0.5 } };
  const saved = await call("POST", `/api/instances/${id}`, { cookie: session, body: { state } });
  ok("state saves", saved.status === 200 && saved.body.instance.state.hazards.length === 1);
  ok("and comes back parsed, not as a string", saved.body.instance.state.hazards[0].lat === 34);
  const renamed = await call("POST", `/api/instances/${id}`, { cookie: session, body: { name: "Pacific flare v2", note: "" } });
  ok("renaming works", renamed.body.instance.name === "Pacific flare v2");
  ok("and does not blank the state", renamed.body.instance.state.hazards.length === 1);
  ok("an emptied note comes back empty, not null", renamed.body.instance.note === "");

  const fetched = await call("GET", `/api/instances/${id}`, { cookie: session });
  ok("one can be read back on its own", fetched.body.instance.id === id);

  await call("POST", "/api/auth/signup", { body: { email: "other@example.com", name: "Other", org: "Elsewhere", password: "another long password" } });
  const theirs = cookieFrom(await call("POST", "/api/auth/login", { body: { email: "other@example.com", password: "another long password" } }));
  const elsewhere = await call("GET", "/api/instances", { cookie: theirs });
  ok("another organisation sees only its own", elsewhere.body.instances.length === 1 && elsewhere.body.instances[0].name === "Main console");
  ok("cannot read one by id", (await call("GET", `/api/instances/${id}`, { cookie: theirs })).status === 404);
  ok("cannot rename one", (await call("POST", `/api/instances/${id}`, { cookie: theirs, body: { name: "Mine now" } })).status === 404);
  const stolen = await call("POST", `/api/instances/${id}/delete`, { cookie: theirs });
  ok("deleting someone else's does nothing", stolen.status === 200 && stolen.body.instances.length === 1);
  ok("and it is still there for its owner", (await call("GET", `/api/instances/${id}`, { cookie: session })).status === 200);

  await call("POST", "/api/auth/signup", { body: { email: "colleague@example.com", name: "Colleague", org: "  orbital LOGISTICS  ", password: "a third long password" } });
  const mate = cookieFrom(await call("POST", "/api/auth/login", { body: { email: "colleague@example.com", password: "a third long password" } }));
  const shared = await call("GET", "/api/instances", { cookie: mate });
  ok("a colleague sees the team's consoles", shared.body.instances.some((row) => row.id === id), shared.body.instances.map((r) => r.name).join(", "));
  ok("matched on the name folded and trimmed", shared.body.instances.length >= 2);
  ok("and no second default was seeded for them", shared.body.instances.filter((row) => row.name === "Main console").length === 1);
  const byMate = await call("POST", `/api/instances/${id}`, { cookie: mate, body: { name: "Pacific flare, revised" } });
  ok("and can work on them", byMate.status === 200 && byMate.body.instance.name === "Pacific flare, revised");
  ok("the author stays whoever made it", byMate.body.instance.author === "M. Vance", byMate.body.instance.author);
  await call("POST", `/api/instances/${id}`, { cookie: session, body: { name: "Pacific flare v2" } });

  ok("an unknown id is a 404, not a 500", (await call("POST", "/api/instances/cns_nope", { cookie: session, body: { name: "x" } })).status === 404);

  const big = { hazards: Array.from({ length: 400 }, () => ({ kind: "flare", label: "x".repeat(40), lat: 1, lon: 2, severity: 0.5, radius: 0.5, durationMin: 60 })) };
  const refused = await call("POST", `/api/instances/${id}`, { cookie: session, body: { state: big } });
  ok("an oversized state is refused with a reason", refused.status === 413, refused.body.error);
  ok("and the saved state is untouched", (await call("GET", `/api/instances/${id}`, { cookie: session })).body.instance.state.hazards.length === 1);
  const absurd = { hazards: Array.from({ length: 4000 }, () => ({ kind: "flare", label: "x".repeat(40) })) };
  ok("one too big to even read is refused too", (await call("POST", `/api/instances/${id}`, { cookie: session, body: { state: absurd } })).status === 400);
  for (let i = 0; i < 22; i += 1) {
    await call("POST", "/api/instances", { cookie: session, body: { name: `Console ${i}` } });
  }
  const over = await call("POST", "/api/instances", { cookie: session, body: { name: "One too many" } });
  ok("there is a ceiling on how many", over.status === 409, over.body.error);

  const gone = await call("POST", `/api/instances/${id}/delete`, { cookie: session });
  ok("deleting removes it", !gone.body.instances.some((row) => row.id === id));

  const mine = (await call("POST", "/api/instances", { cookie: mate, body: { name: "Colleague's drill" } })).body.instance;
  const before = (await call("GET", "/api/instances", { cookie: session })).body.instances.length;
  await call("POST", "/api/profile", { cookie: mate, body: { name: "Colleague", org: "Orbital Logistics Ltd" } });

  const after = (await call("GET", "/api/instances", { cookie: mate })).body.instances;
  ok("their own console follows them", after.some((row) => row.id === mine.id));
  const left = (await call("GET", "/api/instances", { cookie: session })).body.instances;
  ok("and the team keeps the rest", left.length === before - 1, `${left.length} left of ${before}`);
  ok("which they can no longer see", !after.some((row) => left.some((other) => other.id === row.id)));
  ok("nor read by id", (await call("GET", `/api/instances/${left[0].id}`, { cookie: mate })).status === 404);

  const owner = accounts.db.prepare("select id from users where email = 'mira@example.com'").get();
  accounts.db.prepare("delete from users where id = ?").run(owner.id);
  ok("consoles go with the account", accounts.db.prepare("select count(*) as n from instances where user_id = ?").get(owner.id).n === 0);
}

{
  const out = await call("POST", "/api/auth/logout", { cookie: session });
  ok("signing out clears the cookie", [out.headers["Set-Cookie"]].flat().join().includes("aos_session=; Path=/"));
  ok("and the token stops working", (await call("GET", "/api/me", { cookie: session })).body.user === null);
  ok("the row is gone, not just the cookie", accounts.db.prepare("select count(*) as n from sessions where token_hash = ?").get(fingerprint(session.split("=")[1])).n === 0);
  ok("signing out twice is harmless", (await call("POST", "/api/auth/logout", { cookie: session })).status === 200);
}

{
  const start = await call("GET", "/api/auth/google");
  ok("with no credentials the Google route says so", start.headers.Location === "/profile?google=unset");

  const configured = new Accounts({
    path: ":memory:",
    env: { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec", PORT: "5173" },
  });
  const res = response();
  await configured.handle(request("GET", "/api/auth/google"), res, "/api/auth/google");
  ok("with them it redirects to Google", res.headers.Location.startsWith("https://accounts.google.com/"));
  const stateCookie = [res.headers["Set-Cookie"]].flat().join();
  ok("and plants the state cookie", stateCookie.includes("aos_oauth="));
  const state = new URL(res.headers.Location).searchParams.get("state");
  ok("which matches the state in the URL", stateCookie.includes(encodeURIComponent(state)));

  const mismatched = response();
  await configured.handle(
    request("GET", "/api/auth/google/callback?code=abc&state=somebody-elses", { cookie: "aos_oauth=ours" }),
    mismatched,
    "/api/auth/google/callback",
  );
  ok("a mismatched state is refused", mismatched.headers.Location === "/profile?google=state");
  const noCookie = response();
  await configured.handle(
    request("GET", "/api/auth/google/callback?code=abc&state=anything"),
    noCookie,
    "/api/auth/google/callback",
  );
  ok("and so is a callback with no state cookie at all", noCookie.headers.Location === "/profile?google=state");
}

console.log(failures ? `\n${failures} failing` : "\nall green");
process.exit(failures ? 1 : 0);
