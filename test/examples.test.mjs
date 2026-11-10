
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Forge } from "../scripts/forge.mjs";

let failures = 0;
const ok = (label, pass, detail = "") => {
  console.log(`  ${pass ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!pass) failures += 1;
};

const forge = new Forge();
const dir = new URL("../examples/", import.meta.url).pathname;
const files = (await readdir(dir)).filter((name) => name.endsWith(".rs")).sort();

ok("there are examples to check", files.length > 0, `${files.length} found`);

for (const name of files) {
  const source = await readFile(join(dir, name), "utf8");
  const built = await forge.build({ id: `example-${name.replace(/\W/g, "-")}` }, [
    { name, source, manifest: "" },
  ]);

  const errors = (built.diagnostics ?? []).filter((d) => d.level === "error");
  ok(
    `${name} compiles`,
    built.ok,
    built.ok ? `${built.ms}ms` : errors.map((d) => `${d.line}: ${d.message}`).join(" | "),
  );

  const warnings = (built.diagnostics ?? []).filter((d) => d.level === "warning");
  ok(
    `${name} compiles clean`,
    warnings.length === 0,
    warnings.map((d) => `${d.line}: ${d.message}`).join(" | "),
  );

  ok(`${name} opens by saying what it demonstrates`, /^\/\/ .+\n\/\/\n\/\/ Shows:/m.test(source));
}

console.log(failures ? `\n${failures} failed` : "\nall good");
process.exitCode = failures ? 1 : 0;
