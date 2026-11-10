
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORE = join(root, "core");
const BUILT = join(CORE, "target/wasm32-unknown-unknown/release/aos_instance.wasm");
const OUT = join(root, "assets/core/aos_core.wasm");
const STAMP = join(root, "assets/core/aos_core.json");

const EMPTY = `// Generated. Do not edit by hand -- the server rewrites this file whenever an
// instance's scripts change, and \`npm run core\` rewrites it back to empty for
// the committed default bundle.

use aos_sim::script::Registry;

pub fn register(_registry: &mut Registry) {
    // No scripts. This is the default bundle: the console's own five hazard
    // kinds, its own physics, and an empty notification board.
}
`;

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });

async function main() {
  await writeFile(join(CORE, "aos-instance/src/scripts.rs"), EMPTY);
  await run("cargo", ["build", "-p", "aos-instance", "--target", "wasm32-unknown-unknown", "--release"], {
    cwd: CORE,
  });
  await mkdir(dirname(OUT), { recursive: true });
  await copyFile(BUILT, OUT);

  const wasm = await readFile(OUT);
  const contract = /pub const CONTRACT_VERSION: u32 = (\d+)/.exec(
    await readFile(join(CORE, "aos-sim/src/lib.rs"), "utf8"),
  );
  await writeFile(
    STAMP,
    `${JSON.stringify(
      {
        contract: Number(contract?.[1] ?? 0),
        bytes: wasm.length,
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`[aos] engine built: ${(wasm.length / 1024).toFixed(0)}KB, contract ${contract?.[1]}`);
}

main().catch((error) => {
  console.error(`[aos] ${error.message}`);
  process.exitCode = 1;
});
