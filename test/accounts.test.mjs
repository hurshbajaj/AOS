
import {
  LIMITS,
  THROTTLE,
  check,
  fingerprint,
  hash,
  mint,
  publicUser,
  sessionExpiry,
  throttleUntil,
  throttled,
  userId,
  verify,
} from "../scripts/accounts.mjs";
import { open, queries } from "../scripts/db.mjs";
import { complete, conversation, deliverable, message, statusOf, config as mailConfig } from "../scripts/mail.mjs";
import { authUrl, claims, configured, settings } from "../scripts/oauth.mjs";
import { cookie, parseCookies } from "../scripts/api.mjs";

let failures = 0;
const ok = (label, pass, detail = "") => {
  console.log(`  ${pass ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!pass) failures += 1;
};
const threw = async (fn, match) => {
  try {
    await fn();
    return false;
  } catch (error) {
    return match ? String(error.message).includes(match) : true;
  }
};

{
  const good = check({ email: " Ops@Example.COM ", name: " Mira ", org: "Orbital Ltd", password: "correct horse staple" });
  ok("a complete sign-up passes", good.ok);
  ok("the address is trimmed and folded to lower case", good.fields.email === "ops@example.com", good.fields.email);
  ok("and so is the name", good.fields.name === "Mira");

  const bare = check({});
  ok("an empty form complains about every required field", ["email", "name", "org", "password"].every((key) => bare.errors[key]), Object.keys(bare.errors).join(", "));
  ok("but not about the optional ones", !bare.errors.phone && !bare.errors.notes);

  for (const bad of ["nope", "a@b", "a b@c.com", "@example.com", "two@@example.com", "trailing@example."]) {
    ok(`"${bad}" is refused`, Boolean(check({ ...good.fields, email: bad, password: "x".repeat(12) }).errors.email));
  }
  for (const fine of ["a+tag@example.co.uk", "first.last@sub.domain.org", "x@y.zz"]) {
    ok(`"${fine}" is accepted`, !check({ ...good.fields, email: fine, password: "x".repeat(12) }).errors.email);
  }

  const [min, max] = LIMITS.password;
  ok("a short password is refused", Boolean(check({ ...good.fields, password: "x".repeat(min - 1) }).errors.password));
  ok("one at the floor is not", !check({ ...good.fields, password: "x".repeat(min) }).errors.password);
  ok("an enormous one is refused", Boolean(check({ ...good.fields, password: "x".repeat(max + 1) }).errors.password));

  ok("a phone number may be blank", !check({ ...good.fields, password: "x".repeat(12), phone: "" }).errors.phone);
  ok("+44 20 7946 0958 is fine", !check({ ...good.fields, password: "x".repeat(12), phone: "+44 20 7946 0958" }).errors.phone);
  ok("letters in a phone number are not", Boolean(check({ ...good.fields, password: "x".repeat(12), phone: "call me" }).errors.phone));
  ok("over-long notes are refused", Boolean(check({ ...good.fields, password: "x".repeat(12), notes: "n".repeat(LIMITS.notes + 1) }).errors.notes));
  ok("a profile edit does not demand a password", check({ ...good.fields }, { password: false }).ok);
}

{
  const stored = await hash("correct horse battery staple");
  ok("a hash records its own parameters", stored.startsWith("scrypt$65536$8$1$"), stored.slice(0, 20));
  ok("and is not the password", !stored.includes("correct"));
  ok("the right password verifies", await verify("correct horse battery staple", stored));
  ok("a wrong one does not", !(await verify("correct horse battery stapl", stored)));
  ok("nor does the empty string", !(await verify("", stored)));

  const again = await hash("correct horse battery staple");
  ok("the same password hashes differently each time", again !== stored);
  ok("and both still verify", await verify("correct horse battery staple", again));

  for (const junk of [null, undefined, "", "not-a-hash", "scrypt$1$2$3", "bcrypt$a$b$c$d$e"]) {
    ok(`a stored value of ${JSON.stringify(junk)} simply fails`, (await verify("anything", junk)) === false);
  }
}

{
  const { token, token_hash } = mint();
  ok("a token is url-safe", /^[\w-]+$/.test(token), token.slice(0, 12));
  ok("and has 256 bits in it", Buffer.from(token, "base64url").length === 32);
  ok("the stored hash is not the token", token_hash !== token);
  ok("and the token hashes to it", fingerprint(token) === token_hash);
  ok("two tokens differ", mint().token !== mint().token);
  ok("an id looks like an id", /^usr_[0-9a-f]{20}$/.test(userId()), userId());
}

{
  const now = Date.UTC(2026, 0, 1);
  ok("nothing recorded is not throttled", !throttled(null, now));
  ok("under the limit is not throttled", !throttled({ count: THROTTLE.limit - 1, until: throttleUntil(now) }, now));
  ok("at the limit is", throttled({ count: THROTTLE.limit, until: throttleUntil(now) }, now));
  ok("and stops being, once the window has gone by", !throttled({ count: 99, until: throttleUntil(now) }, now + THROTTLE.windowMs + 1));
}

{
  const db = open(":memory:");
  const q = queries(db);
  const now = new Date().toISOString();
  const id = userId();
  q.insertUser.run(id, "mira@example.com", "Mira", "Orbital Ltd", null, null, await hash("a long enough password"), null, 0, now, now);

  ok("a user comes back by address", q.byEmail.get("mira@example.com")?.id === id);
  ok("and by id", q.byId.get(id)?.email === "mira@example.com");
  ok("a second account on the same address is refused", await threw(() =>
    q.insertUser.run(userId(), "mira@example.com", "Other", "Org", null, null, "x", null, 0, now, now)));

  const shown = publicUser(q.byId.get(id));
  ok("the public shape has no password in it", !("password" in shown) && !JSON.stringify(shown).includes("scrypt"));
  ok("nor the Google subject", !("google_sub" in shown));
  ok("and it does carry the org", shown.org === "Orbital Ltd");
  ok("verified is a boolean, not a 0", shown.verified === false);

  const { token, token_hash } = mint();
  q.insertSession.run(token_hash, id, now, sessionExpiry());
  ok("a session resolves to its user", q.session.get(fingerprint(token))?.user_id === id);
  ok("an unknown token resolves to nothing", q.session.get(fingerprint("made up")) === undefined);
  q.dropSession.run(token_hash);
  ok("and a dropped one stops resolving", q.session.get(token_hash) === undefined);

  const stale = mint();
  q.insertSession.run(stale.token_hash, id, now, new Date(Date.now() - 1000).toISOString());
  const fresh = mint();
  q.insertSession.run(fresh.token_hash, id, now, sessionExpiry());
  q.expireSessions.run(new Date().toISOString());
  ok("an expired session is swept", q.session.get(stale.token_hash) === undefined);
  ok("a live one is not", q.session.get(fresh.token_hash)?.user_id === id);

  for (let i = 1; i <= 8; i += 1) {
    q.insertActivity.run(id, "chat", `question ${i}`, null, new Date(Date.UTC(2026, 0, i)).toISOString());
  }
  q.insertActivity.run(id, "hazard", "Solar flare", JSON.stringify({ kind: "flare" }), now);
  ok("history comes back newest first", q.recentOfKind.all(id, "chat", 3).map((r) => r.summary).join(",") === "question 8,question 7,question 6");
  ok("and only of the kind asked for", q.recentOfKind.all(id, "hazard", 9).length === 1);
  q.trimActivity.run(id, "chat", id, "chat", 5);
  ok("trimming keeps the newest n", q.recentOfKind.all(id, "chat", 99).length === 5);
  ok("and keeps the right ones", q.recentOfKind.all(id, "chat", 1)[0].summary === "question 8");
  ok("while leaving other kinds alone", q.recentOfKind.all(id, "hazard", 9).length === 1);

  db.prepare("delete from users where id = ?").run(id);
  ok("history goes with the account", q.recentActivity.all(id, 99).length === 0);
}

{
  const { migrate } = await import("../scripts/db.mjs");
  const old = new (await import("node:sqlite")).DatabaseSync(":memory:");
  old.exec(`create table users (
    id text primary key, email text not null unique, name text not null, org text not null,
    phone text, notes text, password text, google_sub text unique,
    verified integer not null default 0, created_at text not null, updated_at text not null
  )`);
  const added = migrate(old);
  ok("a missing column is added", added.includes("users.alt_email"), added.join(", "));
  ok("and a table that is not there is skipped, not an error", !added.some((name) => name.startsWith("tokens.")));
  const columns = old.prepare("pragma table_info(users)").all().map((row) => row.name);
  ok("and the table has it afterwards", columns.includes("alt_email") && columns.includes("alt_verified"));
  ok("running it again adds nothing", migrate(old).length === 0);

  const legacy = new (await import("node:sqlite")).DatabaseSync(":memory:");
  legacy.exec(`create table users (
    id text primary key, email text not null unique, name text not null, org text not null,
    phone text, notes text, password text, google_sub text unique,
    verified integer not null default 0, created_at text not null, updated_at text not null
  )`);
  legacy.exec(`create table instances (
    id text primary key, user_id text not null, name text not null, note text,
    state text not null default '{}', created_at text not null, updated_at text not null
  )`);
  legacy.prepare("insert into users values ('u1','a@b.c','Mira','  Orbital LTD ',null,null,null,null,1,'x','x')").run();
  legacy.prepare("insert into instances values ('c1','u1','Old drill',null,'{}','x','x')").run();
  migrate(legacy);
  const keyed = legacy.prepare("select org_key from instances where id = 'c1'").get();
  ok("an older console is filed under its creator's team", keyed.org_key === "orbital ltd", keyed.org_key);
  ok("and a fresh database needs none of it", migrate(open(":memory:")).length === 0);
}

{
  const parsed = parseCookies("aos_session=abc%3Ddef; other=1; spaced = 2 ");
  ok("a cookie header parses", parsed.aos_session === "abc=def", JSON.stringify(parsed));
  ok("and so do the rest of them", parsed.other === "1" && parsed.spaced === "2");
  ok("nothing is invented from an empty header", Object.keys(parseCookies("")).length === 0);
  ok("a malformed pair is skipped, not thrown on", Object.keys(parseCookies("=x; ;y")).length === 0);

  const set = cookie("aos_session", "tok en", { maxAge: 60, secure: false });
  ok("the value is encoded", set.includes("aos_session=tok%20en"));
  ok("HttpOnly is set", set.includes("HttpOnly"));
  ok("SameSite is Lax", set.includes("SameSite=Lax"));
  ok("Path covers the site", set.includes("Path=/"));
  ok("Secure is left off for plain http", !set.includes("Secure"));
  ok("and set when there is TLS", cookie("a", "b", { maxAge: 1, secure: true }).includes("Secure"));
}

{
  const body = message({ from: "aos@example.com", to: "mira@example.com", subject: "Confirm", text: "line one\n.hidden\nline three" });
  ok("a message ends the way SMTP expects", body.endsWith("\r\n.\r\n"));
  ok("every line break is a CRLF", !/[^\r]\n/.test(body));
  ok("a leading dot is stuffed", body.includes("\r\n..hidden\r\n"));
  ok("the headers are there", /^From: AOS <aos@example\.com>\r\nTo: <mira@example\.com>\r\nSubject: Confirm\r\n/.test(body));

  const nasty = message({ from: "a@b.c", to: "victim@x.y\r\nBcc: attacker@evil.test", subject: "x\r\nX-Evil: 1", text: "hi" });
  ok("a newline in an address cannot add a header", !/\r\nBcc:/i.test(nasty));
  ok("nor can one in a subject", !/\r\nX-Evil:/.test(nasty) && nasty.includes("Subject: x X-Evil: 1"));
  const { html: htmlLetter, plain: plainLetter, subjectFor } = await import("../scripts/letter.mjs");
  const letter = { name: "Mira Vance", code: "482913", kind: "verify", minutes: 5, to: "mira@example.com" };
  ok("the code leads the subject", subjectFor("482913") === "482913 is your AOS confirmation code");
  const two = message({ from: "a@b.c", to: "d@e.f", subject: "x", text: plainLetter(letter), html: htmlLetter(letter) });
  ok("a letter with both is multipart/alternative", /Content-Type: multipart\/alternative; boundary="aos-/.test(two));
  ok("with the plain part first", two.indexOf("text/plain") < two.indexOf("text/html"));
  ok("and a closing boundary", /\r\n--aos-[0-9a-f-]+--\r\n\.\r\n$/.test(two));
  ok("still CRLF throughout", !/[^\r]\n/.test(two));
  ok("the code is in both parts", plainLetter(letter).includes("482913") && htmlLetter(letter).includes("482913"));
  ok("every style is inline", !/<style/i.test(htmlLetter(letter)));
  ok("a name cannot carry markup into it", htmlLetter({ ...letter, name: "<img src=x onerror=1>" }).includes("&lt;img"));
  ok("nor can the address", htmlLetter({ ...letter, to: '"><b>x' }).includes("&quot;&gt;&lt;b&gt;"));
  ok("the monogram is the initials, as on the page", htmlLetter(letter).includes(">MV<"));
  ok("the address it went to is on it", htmlLetter(letter).includes("mira@example.com"));
  ok("and the expiry is stated, not implied", htmlLetter(letter).includes("in 5 minutes") && plainLetter(letter).includes("in 5 minutes"));
  ok("and the plain part is unchanged by having an HTML one", two.includes(plainLetter(letter).split("\n")[0]));

  ok("a non-ASCII subject is encoded", message({ from: "a@b.c", to: "c@d.e", subject: "Confirmación", text: "x" }).includes("=?UTF-8?B?"));

  ok("a reply code is read off the front", statusOf("250 OK\r\n") === 250 && statusOf("354 go\r\n") === 354);
  ok("a multi-line reply is not complete until its last line", !complete("250-first\r\n") && complete("250-first\r\n250 last\r\n"));

  const steps = [...conversation({ host: "aos", from: "a@b.c", to: "d@e.f", user: "u", pass: "p", starttls: true, body: "BODY" })];
  const sent = steps.filter((step) => step.send !== undefined).map((step) => step.send);
  ok("it greets, upgrades, then greets again", sent[0] === "EHLO aos" && sent[1] === "STARTTLS" && sent[2] === "EHLO aos", sent.slice(0, 3).join(" | "));
  const upgradeAt = steps.findIndex((step) => step.upgrade);
  const passAt = steps.findIndex((step) => step.send === Buffer.from("p").toString("base64"));
  ok("the password is only sent after the upgrade", upgradeAt > 0 && passAt > upgradeAt, `upgrade at ${upgradeAt}, password at ${passAt}`);
  ok("credentials are flagged as secret", steps.filter((s) => s.secret).length === 2);
  ok("the envelope is in order", sent.join(" ").includes("MAIL FROM:<a@b.c> RCPT TO:<d@e.f> DATA BODY QUIT"));
  ok("the body is sent raw, without a trailing CRLF added", steps.find((s) => s.send === "BODY").raw === true);

  ok("a domain with mail exchangers is deliverable", (await deliverable("a@gmail.com", { lookup: async () => [{ exchange: "mx.gmail.com", priority: 10 }] })).ok);
  const nowhere = await deliverable("a@gmail.om", { lookup: async () => { const e = new Error("nope"); e.code = "ENOTFOUND"; throw e; } });
  ok("a domain that is not there is refused", nowhere.ok === false, nowhere.reason);
  ok("and the message names it, since it is usually a typo", /gmail\.om/.test(nowhere.reason), nowhere.reason);
  const empty = await deliverable("a@no-mail.test", { lookup: async () => [] });
  ok("a domain that exists and takes no mail is refused too", empty.ok === false, empty.reason);
  const offline = await deliverable("a@gmail.com", { lookup: async () => { const e = new Error("down"); e.code = "EAI_AGAIN"; throw e; } });
  ok("but a resolver that failed is not an answer, so it passes", offline.ok === true && offline.unverified === true);
  ok("and nor is an address with no domain in it", (await deliverable("nodomain", { lookup: async () => [] })).ok === false);

  const plain = [...conversation({ host: "aos", from: "a@b.c", to: "d@e.f", starttls: false, body: "B" })];
  ok("with no credentials there is no AUTH", !plain.some((step) => String(step.send).startsWith("AUTH")));
  ok("and with implicit TLS there is no STARTTLS", !plain.some((step) => step.send === "STARTTLS"));

  ok("no SMTP_HOST means no mail configuration", mailConfig({}) === null);
  const smtp = mailConfig({ SMTP_HOST: "smtp.example.com", SMTP_USER: "u", SMTP_PASS: "p" });
  ok("port 465 is implicit TLS", smtp.implicit === true && smtp.port === 465);
  ok("and 587 is not", mailConfig({ SMTP_HOST: "h", SMTP_PORT: "587" }).implicit === false);
  ok("the from address falls back to the user", smtp.from === "u");
}

{
  ok("unconfigured without both halves", !configured({}) && !configured({ GOOGLE_CLIENT_ID: "x" }));
  ok("configured with both", configured({ GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "y" }));

  const config = settings({ GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec", PORT: "5173" });
  ok("the redirect defaults to this server", config.redirectUri === "http://localhost:5173/api/auth/google/callback", config.redirectUri);
  const url = new URL(authUrl(config, "st4te"));
  ok("the consent screen is Google's", url.origin === "https://accounts.google.com");
  ok("the state travels with it", url.searchParams.get("state") === "st4te");
  ok("only identity is asked for", url.searchParams.get("scope") === "openid email profile");
  ok("the flow is the code flow", url.searchParams.get("response_type") === "code");
  ok("no offline access is requested", !url.searchParams.has("access_type"));
  ok("the secret is not in the URL", !url.search.includes("sec"));

  const token = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;
  const future = Math.floor(Date.now() / 1000) + 600;
  const base = { iss: "https://accounts.google.com", aud: "cid", exp: future, sub: "1234", email: "Mira@Example.com", email_verified: true, name: "Mira" };

  const identity = claims(token(base), config);
  ok("a good id_token yields an identity", identity.sub === "1234" && identity.name === "Mira");
  ok("the address is folded to lower case", identity.email === "mira@example.com");
  ok("a Workspace domain comes through as the org", claims(token({ ...base, hd: "orbital.ltd" }), config).domain === "orbital.ltd");
  ok("and is null without one", identity.domain === null);
  ok("a missing name falls back to the local part", claims(token({ ...base, name: "" }), config).name === "mira");

  ok("a token for another application is refused", await threw(() => claims(token({ ...base, aud: "someone-else" }), config), "different application"));
  ok("a token from another issuer is refused", await threw(() => claims(token({ ...base, iss: "https://evil.test" }), config), "unexpected issuer"));
  ok("an expired token is refused", await threw(() => claims(token({ ...base, exp: 1 }), config), "expired"));
  ok("one with no subject is refused", await threw(() => claims(token({ ...base, sub: undefined }), config), "no subject"));
  ok("one with no address is refused", await threw(() => claims(token({ ...base, email: undefined }), config), "email"));
  ok("an unverified address is refused", await threw(() => claims(token({ ...base, email_verified: false }), config), "not verified"));
  ok("nonsense is refused rather than thrown through", await threw(() => claims("not a jwt", config)));
}

console.log(failures ? `\n${failures} failing` : "\nall green");
process.exit(failures ? 1 : 0);
