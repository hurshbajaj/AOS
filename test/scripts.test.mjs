
import { Accounts } from "../scripts/api.mjs";
import { Readable } from "node:stream";

let failures = 0;
const ok = (label, pass, detail = "") => {
  console.log(`  ${pass ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!pass) failures += 1;
};

function request(method, path, { body, cookie, origin } = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const stream = Readable.from(payload ? [payload] : []);
  stream.method = method;
  stream.url = path;
  stream.headers = { host: "localhost:5173", ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) };
  stream.socket = { remoteAddress: "10.0.0.1" };
  return stream;
}

function response() {
  const out = {
    status: 0,
    headers: {},
    body: null,
    raw: null,
    writeHead(status, headers) {
      out.status = status;
      out.headers = { ...out.headers, ...headers };
      return out;
    },
    end(payload) {
      out.raw = payload;
      try {
        out.body = payload ? JSON.parse(payload) : null;
      } catch {
        out.body = null;
      }
      return out;
    },
  };
  return out;
}

const asked = [];
const forge = {
  busy: false,
  capabilities: { sandboxed: true, dependencies: 24, limits: {} },
  outcome: { ok: true, ms: 10, bytes: 1234, diagnostics: [] },
  async build(instance, scripts) {
    asked.push({ instance: instance.id, names: scripts.map((s) => s.name) });
    return forge.outcome;
  },
};

const accounts = new Accounts({
  path: ":memory:",
  env: { PUBLIC_URL: "http://localhost:5173" },
  mailer: async () => ({ sent: true, via: "test" }),
  reachable: async () => ({ ok: true }),
  forge,
});

const call = async (method, path, options) => {
  const res = response();
  const handled = await accounts.handle(request(method, path, options), res, path.split("?")[0]);
  return { handled, ...res };
};

const made = await call("POST", "/api/auth/signup", {
  origin: "http://localhost:5173",
  body: {
    email: "ida@example.com",
    name: "Ida Peric",
    org: "Orbital Ltd",
    password: "a long enough password",
  },
});
const cookie = [made.headers["Set-Cookie"]]
  .flat()
  .filter(Boolean)
  .find((line) => line.startsWith("aos_session="))
  ?.split(";")[0];
ok("an operator can sign up", Boolean(cookie), `status ${made.status}`);

const consoles = await call("GET", "/api/instances", { cookie });
const instance = consoles.body.instances[0].id;
ok("and arrives with a console already there", Boolean(instance));

const SOURCE = `use aos_sim::prelude::*;
struct Watch;
impl Script for Watch {
    fn manifest(&self) -> Manifest { Manifest::new("watch", "Watch", "Watches.") }
}
pub fn register(r: &mut Registry) { r.script(Watch); }
`;

{
  const out = await call("GET", `/api/instances/${instance}/scripts`);
  ok("signed out, there is nothing to see", out.status === 401);
}

{
  const missing = await call("GET", "/api/instances/cns_nope/scripts", { cookie });
  ok("another team's console is a 404, not a 403", missing.status === 404);
}

{
  const out = await call("GET", `/api/instances/${instance}/scripts`, { cookie });
  ok("an empty console has no scripts", out.body.scripts.length === 0);
  ok("and no bundle", out.body.bundle.status === "none");
  ok("and says what this host can build", out.body.forge.sandboxed === true || out.body.forge.dependencies === 0);
}

{
  const out = await call("POST", `/api/instances/${instance}/scripts`, {
    cookie,
    origin: "http://localhost:5173",
    body: { name: "watch.rs", source: SOURCE },
  });
  ok("a script can be uploaded", out.status === 201, `status ${out.status}`);
  ok("and comes back with its size", out.body.script.bytes === Buffer.byteLength(SOURCE));
  ok("enabled by default, because uploading one is asking to run it", out.body.script.enabled === true);
}

{
  const empty = await call("POST", `/api/instances/${instance}/scripts`, {
    cookie,
    origin: "http://localhost:5173",
    body: { name: "empty.rs", source: "" },
  });
  ok("an empty file is refused", empty.status === 422 && Boolean(empty.body.errors.source));

  const nameless = await call("POST", `/api/instances/${instance}/scripts`, {
    cookie,
    origin: "http://localhost:5173",
    body: { name: "", source: SOURCE },
  });
  ok("and so is a nameless one", nameless.status === 422);

  const odd = await call("POST", `/api/instances/${instance}/scripts`, {
    cookie,
    origin: "http://localhost:5173",
    body: { name: "../../etc/passwd", source: SOURCE },
  });
  ok("a name that is a path is refused", odd.status === 422, `status ${odd.status}`);

  const huge = await call("POST", `/api/instances/${instance}/scripts`, {
    cookie,
    origin: "http://localhost:5173",
    body: { name: "huge.rs", source: "x".repeat(70 * 1024) },
  });
  ok("and one that is too big, before any build is queued", huge.status === 413);
}

{
  const cross = await call("POST", `/api/instances/${instance}/scripts`, {
    cookie,
    origin: "http://evil.example",
    body: { name: "cross.rs", source: SOURCE },
  });
  ok("a cross-site write is refused", cross.status === 403);
}

const listed = await call("GET", `/api/instances/${instance}/scripts`, { cookie });
const first = listed.body.scripts[0];
ok("the listing names the scripts", listed.body.scripts.length === 1);
ok("and does not carry their source", first.source === undefined);

const one = await call("GET", `/api/instances/${instance}/scripts/${first.id}`, { cookie });
ok("asking for one by id does", one.body.script.source === SOURCE);

{
  const built = await call("POST", `/api/instances/${instance}/build`, {
    cookie,
    origin: "http://localhost:5173",
  });
  ok("a build succeeds", built.status === 200 && built.body.built === true, `status ${built.status}`);
  ok("and the bundle is recorded", built.body.bundle.status === "built" && built.body.bundle.bytes === 1234);
  ok("it compiled the one script there is", asked.at(-1).names.join() === "watch.rs");
}

{
  await call("POST", `/api/instances/${instance}/scripts/${first.id}`, {
    cookie,
    origin: "http://localhost:5173",
    body: { name: "watch.rs", source: `${SOURCE}// edited\n` },
  });
  const after = await call("GET", `/api/instances/${instance}/scripts`, { cookie });
  ok("editing a script makes the bundle stale", after.body.bundle.status === "stale");
}

{
  await call("POST", `/api/instances/${instance}/build`, { cookie, origin: "http://localhost:5173" });
  await call("POST", `/api/instances/${instance}/scripts/${first.id}`, {
    cookie,
    origin: "http://localhost:5173",
    body: { enabled: false },
  });
  const after = await call("GET", `/api/instances/${instance}/scripts`, { cookie });
  ok("so does turning one off", after.body.bundle.status === "stale");
  ok("and the script says it is off rather than broken", after.body.scripts[0].enabled === false);

  const nothing = await call("POST", `/api/instances/${instance}/build`, {
    cookie,
    origin: "http://localhost:5173",
  });
  ok("building with everything disabled builds nothing", nothing.body.built === false);
  ok("and clears the bundle instead of failing", nothing.body.cleaned === true);
  ok("and says so", /Bundle cleared/.test(nothing.body.reason ?? ""));
  ok("and the bundle is gone", nothing.body.bundle.status === "none");
}

{
  await call("POST", `/api/instances/${instance}/scripts/${first.id}`, {
    cookie,
    origin: "http://localhost:5173",
    body: { enabled: true },
  });
  const second = await call("POST", `/api/instances/${instance}/scripts`, {
    cookie,
    origin: "http://localhost:5173",
    body: { name: "later.rs", source: SOURCE.replace("Watch", "Later") },
  });
  ok("a second script can be added", second.status === 201);

  const reordered = await call("POST", `/api/instances/${instance}/scripts`, {
    cookie,
    origin: "http://localhost:5173",
    body: { order: [second.body.script.id, first.id] },
  });
  ok("the order is sent whole", reordered.status === 200, `status ${reordered.status}`);

  const partial = await call("POST", `/api/instances/${instance}/scripts`, {
    cookie,
    origin: "http://localhost:5173",
    body: { order: [first.id] },
  });
  ok("an order that leaves one out is refused", partial.status === 422);
  await call("POST", `/api/instances/${instance}/build`, { cookie, origin: "http://localhost:5173" });
  ok("and the build respects the order it was put in", asked.at(-1).names.join() === "later.rs,watch.rs", asked.at(-1).names.join());
}

{
  forge.outcome = {
    ok: false,
    ms: 40,
    diagnostics: [
      { level: "error", script: "watch.rs", line: 3, message: "no method named `nope`", rendered: "error[E0599]..." },
    ],
  };
  const failed = await call("POST", `/api/instances/${instance}/build`, {
    cookie,
    origin: "http://localhost:5173",
  });
  ok("a failed build is a 422, not a 500", failed.status === 422, `status ${failed.status}`);
  ok("the bundle says it failed", failed.body.bundle.status === "failed");
  ok("and the diagnostics are kept", failed.body.bundle.log[0].message === "no method named `nope`");
  ok("pointing at the operator's own line", failed.body.bundle.log[0].line === 3);
}

{
  const gone = await call("GET", `/api/instances/${instance}/bundle`, { cookie });
  ok("there is no bundle to fetch after a failed build", gone.status === 404 || gone.status === 409, `status ${gone.status}`);
}

{
  const removed = await call("POST", `/api/instances/${instance}/scripts/${first.id}/delete`, {
    cookie,
    origin: "http://localhost:5173",
  });
  ok("a script can be deleted", removed.status === 200 && removed.body.scripts.length === 1);

  const after = await call("GET", `/api/instances/${instance}/scripts/${first.id}`, { cookie });
  ok("and is then a 404", after.status === 404);
}

console.log(failures ? `\n${failures} failed` : "\nall good");
process.exitCode = failures ? 1 : 0;
