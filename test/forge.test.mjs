
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Forge, dependenciesFrom, sandboxed } from "../scripts/forge.mjs";

let failures = 0;
const ok = (label, pass, detail = "") => {
  console.log(`  ${pass ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!pass) failures += 1;
};

const forge = new Forge();

{
  const { deps, errors } = dependenciesFrom(`
[package]
name = "whatever"

[dependencies]
nalgebra = "0.33"
libm = { version = "0.2", default-features = false }
# commented = "1"

[dev-dependencies]
proptest = "1"
`);
  ok("dependencies are read from the right table", deps.length === 2, deps.map((d) => d.name).join());
  ok("and a dev-dependency is not one of them", !deps.some((d) => d.name === "proptest"));
  ok("comments are ignored", !deps.some((d) => d.name === "commented"));
  ok("nothing else in the file matters", errors.length === 0);
}

{
  const { deps, errors } = dependenciesFrom('[dependencies]\nescape = { path = "/etc" }\n');
  ok("a path dependency is refused", deps.length === 0 && /not allowed/.test(errors[0] ?? ""));

  const git = dependenciesFrom('[dependencies]\nescape = { git = "https://example.invalid/x" }\n');
  ok("and so is a git one", git.deps.length === 0 && /not allowed/.test(git.errors[0] ?? ""));

  const pinned = dependenciesFrom('[dependencies]\naos-sim = "9.9"\n');
  ok("a script cannot pin the contract against the engine", pinned.deps.length === 0);

  const many = dependenciesFrom(
    `[dependencies]\n${Array.from({ length: 40 }, (_, i) => `c${i} = "1"`).join("\n")}\n`,
  );
  ok("too many dependencies is refused", /more than the/.test(many.errors.at(-1) ?? ""));
}

if (!sandboxed()) {
  ok("no bubblewrap on this host, so dependencies are refused", forge.capabilities.dependencies === 0);
} else {
  const work = mkdtempSync(join(tmpdir(), "aos-jail-"));
  const cargoHome = join(work, "cargo-home");
  mkdirSync(cargoHome);
  const toolchain = process.env.RUSTUP_HOME ?? join(process.env.HOME ?? "", ".rustup");
  const found = spawnSync("sh", ["-c", "command -v cargo"], { encoding: "utf8" });
  const cargo = (found.stdout ?? "").trim().replace(/\/cargo$/, "") || "/usr/bin";

  const argv = [
    "--unshare-all",
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
    ...(cargo !== "/usr/bin" ? ["--ro-bind", cargo, cargo] : []),
    "--bind", work, work,
    "--bind", cargoHome, cargoHome,
    "--chdir", work,
    "--setenv", "PATH", "/usr/bin:/bin",
    "--setenv", "HOME", "/tmp",
  ];
  const reaches = (command) =>
    spawnSync("bwrap", [...argv, "/bin/sh", "-c", command], { encoding: "utf8", timeout: 20_000 })
      .status === 0;

  const root = process.cwd();
  ok("the repository is not in the sandbox", !reaches(`ls ${root}`));
  ok("the account database cannot be read", !reaches(`cat ${root}/data/aos.db`));
  ok("nor the environment file", !reaches(`cat ${root}/.env`));
  ok("nor the operator's home", !reaches(`ls ${process.env.HOME}/.ssh`));
  ok("the system is read-only", !reaches("touch /usr/pwned"));
  ok("there is no network", !reaches("exec 3<>/dev/tcp/1.1.1.1/80"));
  ok("and no resolver", !reaches("getent hosts crates.io"));
  ok("other processes are invisible", !reaches("test $(ls /proc | grep -c '^[0-9]') -gt 5"));
  ok("but its own work directory is writable", reaches(`touch ${work}/fine`));
  rmSync(work, { recursive: true, force: true });
}

const GOOD = `use aos_sim::prelude::*;

struct StormWatch;

impl Script for StormWatch {
    fn manifest(&self) -> Manifest {
        Manifest::new("storm_watch", "Storm watch", "Warns when tomorrow crosses G1.")
            .ticking(3600.0)
    }

    fn on_load(&mut self, _env: &Env, out: &mut Emit) {
        out.info("Storm watch running", "Watching the next day's forecast.");
    }

    fn on_tick(&mut self, env: &Env, out: &mut Emit) {
        let Some(f) = env.forecast else { return };
        if f.kp >= 5.0 {
            out.notify(
                Notification::new(Level::Warning, "G1 expected", format!("Forecast Kp {:.1}", f.kp))
                    .dedupe("storm_watch/g1"),
            );
        }
    }
}

pub fn register(registry: &mut Registry) {
    registry.script(StormWatch);
}
`;

{
  const built = await forge.build({ id: "test-good" }, [{ name: "storm_watch.rs", source: GOOD, manifest: "" }]);
  ok("a script written against the contract compiles", built.ok, (built.diagnostics ?? []).map((d) => d.message).join(" | "));
  ok("and produces a bundle of a plausible size", (built.bytes ?? 0) > 200_000, `${built.bytes}`);
  ok("in well under the build timeout", built.ms < 120_000, `${built.ms}ms`);
}

{
  const broken = `use aos_sim::prelude::*;
struct X;
impl Script for X {
    fn manifest(&self) -> Manifest { Manifest::new("x", "X", "nope") }
    fn on_tick(&mut self, env: &Env, _out: &mut Emit) {
        let _ = env.weather.no_such_field;
    }
}
pub fn register(r: &mut Registry) { r.script(X); }
`;
  const failed = await forge.build({ id: "test-broken" }, [{ name: "broken.rs", source: broken, manifest: "" }]);
  ok("a script that does not compile fails", !failed.ok);
  const first = failed.diagnostics.find((d) => d.level === "error");
  ok("the diagnostic names their file", first?.script === "broken.rs", String(first?.script));
  ok("and their line", first?.line === 6, String(first?.line));
  ok("and reads as a compiler would say it", /no_such_field/.test(first?.message ?? ""));
}

{
  const withDep = `use aos_sim::prelude::*;
struct Dep;
impl Script for Dep {
    fn manifest(&self) -> Manifest { Manifest::new("dep", "Dep", "Uses a crate.").ticking(60.0) }
    fn on_tick(&mut self, _env: &Env, out: &mut Emit) {
        let v = nalgebra::Vector3::new(1.0f64, 2.0, 2.0);
        out.metric("norm", v.norm());
    }
}
pub fn register(r: &mut Registry) { r.script(Dep); }
`;
  const built = await forge.build({ id: "test-dep" }, [
    {
      name: "dep.rs",
      source: withDep,
      manifest: '[dependencies]\nnalgebra = { version = "0.33", default-features = false, features = ["libm"] }\n',
    },
  ]);
  ok("a script may depend on any crate", built.ok, (built.diagnostics ?? []).map((d) => d.message).join(" | "));
  ok("and the build says which it pulled in", (built.dependencies ?? []).includes("nalgebra"));
}

{
  const tooMany = Array.from({ length: 9 }, (_, i) => ({
    name: `s${i}.rs`,
    source: GOOD.replaceAll("storm_watch", `s${i}`).replaceAll("StormWatch", `S${i}`),
    manifest: "",
  }));
  const refused = await forge.build({ id: "test-many" }, tooMany);
  ok("more scripts than an instance may carry is refused before compiling", !refused.ok && refused.ms === 0);
}

{
  const clashing = [
    { name: "watch.rs", source: GOOD, manifest: "" },
    { name: "Watch.RS", source: GOOD, manifest: "" },
  ];
  const refused = await forge.build({ id: "test-clash" }, clashing);
  ok("two scripts with the same crate name are refused, not silently merged", !refused.ok);
  ok("and said as a name clash", /same crate name/.test(refused.diagnostics[0]?.message ?? ""));
}

console.log(failures ? `\n${failures} failed` : "\nall good");
process.exitCode = failures ? 1 : 0;
