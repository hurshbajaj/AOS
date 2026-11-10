
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE = join(ROOT, "core");
const BUNDLES = join(ROOT, "data", "bundles");
const CARGO_CACHE = join(ROOT, "data", "forge", "cargo");
const BASE_VENDOR = join(ROOT, "data", "forge", "base");

export const LIMITS = {
  scripts: 8,
  sourceBytes: 64 * 1024,
  dependencies: 24,
  cpuSeconds: 180,
  fetchMs: 120_000,
  buildMs: 300_000,
  fileBytes: 512 * 1024 * 1024,
  vendorBytes: 512 * 1024 * 1024,
};

export const sandboxed = () => existsSync("/usr/bin/bwrap") || existsSync("/bin/bwrap");

const slugOf = (name) =>
  name
    .toLowerCase()
    .replace(/\.rs$/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "script";

function run(command, args, { cwd, env, timeoutMs, keepBytes = 256 * 1024 } = {}) {
  return new Promise((settle) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let truncated = false;
    let timedOut = false;
    const take = (into, chunk) => {
      if (into.length > keepBytes) {
        truncated = true;
        return into;
      }
      return into + chunk;
    };
    child.stdout.on("data", (chunk) => (out = take(out, chunk)));
    child.stderr.on("data", (chunk) => (err = take(err, chunk)));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      settle({ code: -1, out, err: `${err}\n${error.message}`, timedOut, truncated });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      settle({ code, out, err, timedOut, truncated });
    });
  });
}

function jail({ work, cargoHome, network, toolchain, cargo, extra = [] }) {
  return [
    "--unshare-all",
    ...(network ? ["--share-net"] : []),
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/sbin", "/sbin",
    "--ro-bind", toolchain, toolchain,
    ...(cargo && cargo !== "/usr/bin" ? ["--ro-bind", cargo, cargo] : []),
    ...(existsSync("/etc/ssl") ? ["--ro-bind", "/etc/ssl", "/etc/ssl"] : []),
    ...(existsSync("/etc/ca-certificates")
      ? ["--ro-bind", "/etc/ca-certificates", "/etc/ca-certificates"]
      : []),
    ...(network && existsSync("/etc/resolv.conf")
      ? ["--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf"]
      : []),
    "--bind", work, work,
    "--bind", cargoHome, cargoHome,
    ...extra,
    "--chdir", work,
    "--setenv", "PATH", cargo && cargo !== "/usr/bin" ? `${cargo}:/usr/bin:/bin` : "/usr/bin:/bin",
    "--setenv", "HOME", "/tmp",
    "--setenv", "CARGO_HOME", cargoHome,
    "--setenv", "RUSTUP_HOME", toolchain,
    "--setenv", "CARGO_TERM_COLOR", "never",
    "--setenv", "TERM", "dumb",
  ];
}

function limited(argv) {
  const quoted = argv.map((part) => `'${String(part).replace(/'/g, "'\\''")}'`).join(" ");
  return ["-c", `ulimit -t ${LIMITS.cpuSeconds} -f ${Math.floor(LIMITS.fileBytes / 512)}; exec ${quoted}`];
}

function toolchainHome() {
  return process.env.RUSTUP_HOME ?? join(process.env.HOME ?? "/root", ".rustup");
}

function cargoBin() {
  if (process.env.CARGO) {
    return dirname(process.env.CARGO);
  }
  const found = spawnSync("sh", ["-c", "command -v cargo"], { encoding: "utf8" });
  const path = (found.stdout ?? "").trim();
  return path ? dirname(path) : "/usr/bin";
}

export function dependenciesFrom(text) {
  const errors = [];
  const deps = [];
  if (!text || !text.trim()) {
    return { deps, errors };
  }
  let inside = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (/^\[/.test(line)) {
      inside = /^\[dependencies\]$/.test(line);
      continue;
    }
    if (!inside || !line) {
      continue;
    }
    const match = /^([A-Za-z0-9_-]{1,64})\s*=\s*(.+)$/.exec(line);
    if (!match) {
      errors.push(`Could not read this dependency line: ${raw.trim()}`);
      continue;
    }
    const [, name, value] = match;
    if (name === "aos-sim" || name === "aos_sim") {
      continue;
    }
    if (/\bpath\s*=/.test(value) || /\bgit\s*=/.test(value)) {
      errors.push(`${name}: path and git dependencies are not allowed. Crates come from crates.io.`);
      continue;
    }
    deps.push({ name, value });
  }
  if (deps.length > LIMITS.dependencies) {
    errors.push(`${deps.length} dependencies is more than the ${LIMITS.dependencies} allowed.`);
  }
  return { deps, errors };
}

async function assemble(work, { instance, scripts, allowDeps }) {
  await cp(join(CORE, "aos-sim"), join(work, "aos-sim"), { recursive: true });
  await cp(join(CORE, "aos-core"), join(work, "aos-core"), { recursive: true });
  await cp(join(CORE, "aos-instance"), join(work, "aos-instance"), { recursive: true });
  await mkdir(join(work, ".cargo"), { recursive: true });

  const members = ["aos-sim", "aos-core", "aos-instance"];
  const crates = [];
  const problems = [];
  let dependencies = [];

  for (const script of scripts) {
    const slug = slugOf(script.name);
    if (crates.some((c) => c.slug === slug)) {
      problems.push({
        script: script.name,
        message: `Two scripts resolve to the same crate name (${slug}). Rename one.`,
      });
      continue;
    }
    const { deps, errors } = dependenciesFrom(script.manifest);
    for (const message of errors) {
      problems.push({ script: script.name, message });
    }
    if (deps.length && !allowDeps) {
      problems.push({
        script: script.name,
        message:
          "This host cannot sandbox a build, so dependencies are refused. Install bubblewrap, or write the script against aos-sim alone.",
      });
      continue;
    }
    dependencies = dependencies.concat(deps);

    const dir = join(work, "scripts", slug);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "Cargo.toml"),
      `# Generated around the operator's source. Their own manifest is read for
# its [dependencies] and nothing else -- a [patch] section or a build script
# in it would apply to the whole workspace.
[package]
name = "${slug}"
version = "0.0.0"
edition = "2021"
publish = false

[lib]
path = "src/lib.rs"
crate-type = ["rlib"]

[dependencies]
aos-sim = { path = "../../aos-sim" }
${deps.map((d) => `${d.name} = ${d.value}`).join("\n")}
`,
    );
    await writeFile(join(dir, "src", "lib.rs"), script.source);
    members.push(`scripts/${slug}`);
    crates.push({ slug, script: script.name });
  }

  await writeFile(
    join(work, "Cargo.toml"),
    `[workspace]
resolver = "2"
members = [${members.map((m) => `"${m}"`).join(", ")}]

[workspace.package]
version = "0.1.0"
edition = "2021"
license = "MIT"

[profile.release]
opt-level = 3
lto = "fat"
codegen-units = 1
panic = "abort"
strip = true
`,
  );

  await writeFile(
    join(work, "aos-instance", "src", "scripts.rs"),
    `// Generated for instance ${instance.id}. Do not edit.
use aos_sim::script::Registry;

pub fn register(registry: &mut Registry) {
${crates.map((c) => `    ${c.slug}::register(registry);`).join("\n")}
${crates.length ? "" : "    let _ = registry;"}
}
`,
  );

  const manifest = await readFile(join(work, "aos-instance", "Cargo.toml"), "utf8");
  await writeFile(
    join(work, "aos-instance", "Cargo.toml"),
    manifest.replace(
      /\[dependencies\]/,
      `[dependencies]\n${crates.map((c) => `${c.slug} = { path = "../scripts/${c.slug}" }`).join("\n")}`,
    ),
  );

  return { crates, problems, dependencies };
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function diagnostics(out, crates) {
  const found = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith("{")) {
      continue;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.reason !== "compiler-message" || !message.message) {
      continue;
    }
    const { level, message: text, rendered, spans = [] } = message.message;
    if (level !== "error" && level !== "warning") {
      continue;
    }
    const span = spans.find((s) => s.is_primary) ?? spans[0];
    const owner = span && /^scripts\/([^/]+)\//.exec(span.file_name);
    found.push({
      level,
      message: text,
      script: owner ? (crates.find((c) => c.slug === owner[1])?.script ?? null) : null,
      line: span?.line_start ?? null,
      column: span?.column_start ?? null,
      rendered: (rendered ?? text).replace(ANSI, ""),
    });
  }
  return found;
}

const dirBytes = (path) => {
  const result = spawnSync("du", ["-sb", path], { encoding: "utf8" });
  return Number.parseInt(result.stdout ?? "0", 10) || 0;
};

const fail = (message, script = null, rendered = "") => ({
  ok: false,
  ms: 0,
  diagnostics: [{ level: "error", script, message, rendered }],
});

export class Forge {
  #queue = Promise.resolve();
  #busy = false;

  get busy() {
    return this.#busy;
  }

  get capabilities() {
    return {
      sandboxed: sandboxed(),
      dependencies: sandboxed() ? LIMITS.dependencies : 0,
      limits: LIMITS,
    };
  }

  build(instance, scripts) {
    const task = this.#queue.then(() => this.#run(instance, scripts));
    this.#queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async #run(instance, scripts) {
    this.#busy = true;
    const started = Date.now();
    const work = await mkdtemp(join(tmpdir(), "aos-forge-"));
    const cargoHome = join(work, "cargo-home");
    const toolchain = toolchainHome();
    const cargo = cargoBin();
    const allowDeps = sandboxed();

    try {
      if (scripts.length > LIMITS.scripts) {
        return fail(`An instance may carry ${LIMITS.scripts} scripts.`);
      }
      for (const script of scripts) {
        if (Buffer.byteLength(script.source) > LIMITS.sourceBytes) {
          return fail(
            `${(LIMITS.sourceBytes / 1024) | 0}KB is the most one script may be.`,
            script.name,
          );
        }
      }

      const { crates, problems, dependencies } = await assemble(work, {
        instance,
        scripts,
        allowDeps,
      });
      if (problems.length) {
        return {
          ok: false,
          ms: Date.now() - started,
          diagnostics: problems.map((p) => ({ level: "error", rendered: "", ...p })),
        };
      }

      await mkdir(cargoHome, { recursive: true });
      await mkdir(CARGO_CACHE, { recursive: true });

      const extra = [];
      if (dependencies.length) {
        const vendored = await this.#vendor(work, toolchain, cargo);
        if (!vendored.ok) {
          return { ...vendored, ms: Date.now() - started };
        }
        const bytes = dirBytes(join(work, "vendor"));
        if (bytes > LIMITS.vendorBytes) {
          return {
            ...fail(
              `Those dependencies come to ${(bytes / 1e6) | 0}MB of source, more than the ${
                (LIMITS.vendorBytes / 1e6) | 0
              }MB allowed.`,
            ),
            ms: Date.now() - started,
          };
        }
      } else {
        const base = await this.#base(toolchain, cargo);
        if (!base.ok) {
          return { ...base, ms: Date.now() - started };
        }
        extra.push("--ro-bind", base.path, join(work, "vendor"));
      }
      await writeFile(join(work, ".cargo", "config.toml"), vendorConfig(await cargoConfig()));

      const built = await run(
        "/bin/sh",
        limited([
          "bwrap",
          ...jail({ work, cargoHome, network: false, toolchain, cargo, extra }),
          "cargo",
          "build",
          "-p",
          "aos-instance",
          "--target",
          "wasm32-unknown-unknown",
          "--release",
          "--offline",
          "--message-format=json",
        ]),
        { timeoutMs: LIMITS.buildMs },
      );

      const found = diagnostics(built.out, crates);
      if (built.code !== 0) {
        if (!found.some((d) => d.level === "error")) {
          found.push({
            level: "error",
            script: null,
            message: built.timedOut
              ? `The build ran longer than ${LIMITS.buildMs / 1000} seconds and was stopped.`
              : "The build failed without a diagnostic, which usually means it ran out of memory or time.",
            rendered: (built.err || "").slice(-8000),
          });
        }
        return { ok: false, ms: Date.now() - started, diagnostics: found };
      }

      const wasm = join(work, "target", "wasm32-unknown-unknown", "release", "aos_instance.wasm");
      const info = await stat(wasm).catch(() => null);
      if (!info) {
        return {
          ok: false,
          ms: Date.now() - started,
          diagnostics: [
            ...found,
            {
              level: "error",
              script: null,
              message: "The build reported success and produced no bundle.",
              rendered: "",
            },
          ],
        };
      }

      await mkdir(BUNDLES, { recursive: true });
      const out = join(BUNDLES, `${instance.id}.wasm`);
      await cp(wasm, out);

      return {
        ok: true,
        ms: Date.now() - started,
        bytes: info.size,
        path: out,
        diagnostics: found,
        dependencies: dependencies.map((d) => d.name),
      };
    } finally {
      this.#busy = false;
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  async #base(toolchain, cargo) {
    const path = join(BASE_VENDOR, "vendor");
    if (existsSync(join(path, "sgp4"))) {
      return { ok: true, path };
    }
    const work = await mkdtemp(join(tmpdir(), "aos-base-"));
    try {
      await assemble(work, { instance: { id: "base" }, scripts: [], allowDeps: false });
      await mkdir(join(work, ".cargo"), { recursive: true });
      await writeFile(join(work, ".cargo", "config.toml"), await cargoConfig());
      await mkdir(CARGO_CACHE, { recursive: true });
      const result = await this.#vendor(work, toolchain, cargo);
      if (!result.ok) {
        return result;
      }
      await mkdir(BASE_VENDOR, { recursive: true });
      await rm(path, { recursive: true, force: true });
      await cp(join(work, "vendor"), path, { recursive: true });
      return { ok: true, path };
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  async #vendor(work, toolchain, cargo) {
    const inSandbox = (...argv) =>
      run(
        "/bin/sh",
        limited([
          "bwrap",
          ...jail({ work, cargoHome: CARGO_CACHE, network: true, toolchain, cargo }),
          "--setenv",
          "CARGO_NET_RETRY",
          "2",
          ...argv,
        ]),
        { timeoutMs: LIMITS.fetchMs },
      );

    let result = await inSandbox("cargo", "vendor", "--versioned-dirs", "--locked", "vendor");
    if (result.code !== 0) {
      await inSandbox("cargo", "generate-lockfile");
      result = await inSandbox("cargo", "vendor", "--versioned-dirs", "vendor");
    }
    if (result.code !== 0) {
      return fail(
        result.timedOut
          ? "Downloading the dependencies took too long."
          : "The dependencies could not be resolved.",
        null,
        (result.err || result.out).slice(-8000),
      );
    }
    return { ok: true };
  }
}

const vendorConfig = (base) => `${base}
[source.crates-io]
replace-with = "vendored"

[source.vendored]
directory = "vendor"
`;

async function cargoConfig() {
  return readFile(join(CORE, ".cargo", "config.toml"), "utf8").catch(
    () => `[target.wasm32-unknown-unknown]
rustflags = ["-C", "link-arg=--allow-undefined"]
`,
  );
}

export { BUNDLES, CARGO_CACHE };
