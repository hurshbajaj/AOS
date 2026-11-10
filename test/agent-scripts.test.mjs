
import { World } from "../src/orbital/world.js";
import { createTools, callTool } from "../src/orbital/tools.js";
import { scriptNote } from "../src/orbital/sybil.js";

let failures = 0;
const ok = (label, pass, detail = "") => {
  console.log(`  ${pass ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!pass) failures += 1;
};

{
  ok("no scripts means nothing is added to the prompt", scriptNote(null) === "");
  ok("and neither does an empty console", scriptNote({ scripts: [], hazardKinds: [], overrides: [] }) === "");

  const note = scriptNote({
    scripts: [
      { id: "storm_watch", name: "Storm watch", summary: "Warns on G1.", notes: ["RMSE 1.12 Kp."] },
    ],
    hazardKinds: [{ id: "rain", name: "Rain fade", unit: "mm/h", blurb: "Hydrometeor absorption." }],
    overrides: [{ slot: "screening", name: "Acme OD covariance" }],
    craftAdded: 48,
  });
  ok("a script is named by the id a question is addressed to", /storm_watch/.test(note));
  ok("with the author's own summary", /Warns on G1/.test(note));
  ok("and their notes", /RMSE 1\.12/.test(note));
  ok("silence is explained as an answer", /did not answer/.test(note));
  ok("and prose is ruled out as a source of numbers", /not yours to quote/.test(note));
  ok("hazard kinds the scripts added are offered to inject_hazard", /inject_hazard can create/.test(note));
  ok("replaced algorithms are named", /Acme OD covariance/.test(note));
  ok("and attributed to the operator rather than the console", /the operator's own, not the console's/.test(note));
  ok("craft the scripts added are counted", /48 craft/.test(note));
}

const world = new World();

{
  const tools = createTools(world, null, {});
  ok("with no scripts there is no list_scripts tool", tools.list_scripts === undefined);
  ok("and no ask_script", tools.ask_script === undefined);
}

{
  const asked = [];
  const instance = {
    describe: () => ({
      scripts: [{ id: "watch", name: "Watch", summary: "Counts.", notes: [] }],
      hazardKinds: [],
      overrides: [{ slot: "screening", name: "Mine" }],
      craftAdded: 0,
    }),
    report: () => [{ script: "watch", lines: [{ label: "ticks", value: "12", unit: null }] }],
    ask: (question, who) => {
      asked.push([question, who]);
      if (!question.includes("tick")) {
        return { answers: [] };
      }
      return {
        answers: [{ script: "watch", text: "Counted here.", figures: [{ name: "ticks", value: 12, unit: "" }] }],
      };
    },
  };
  const tools = createTools(world, null, { instance });

  const listed = callTool(tools, "list_scripts", {});
  ok("list_scripts names what is running", listed.scripts[0].id === "watch");
  ok("and says which algorithms were replaced", listed.overrides[0].name === "Mine");
  ok("with what each one currently thinks", listed.reports[0].lines[0].value === "12");

  const answer = callTool(tools, "ask_script", { question: "how many ticks", script: "watch" });
  ok("a question reaches the named script", asked.at(-1).join("|") === "how many ticks|watch");
  ok("and its figures come back as figures", answer.answers[0].figures[0].value === 12);

  const silent = callTool(tools, "ask_script", { question: "what is the weather" });
  ok("a script with nothing to say returns no answer", silent.answers.length === 0);
  ok("and the note says so rather than leaving a blank", /No script answered/.test(silent.note));

  const empty = callTool(tools, "ask_script", {});
  ok("a question is required", Boolean(empty.error));

  const nobody = callTool(tools, "ask_script", { question: "anything", script: "nope" });
  ok("an unknown script id is reported, not guessed at", /nope had nothing to say/.test(nobody.note));
}

{
  const instance = { describe: () => null, report: () => [], ask: () => ({ answers: [] }) };
  const tools = createTools(world, null, { instance });
  const listed = callTool(tools, "list_scripts", {});
  ok("an unbuilt console says what is actually running", /own five hazard kinds/.test(listed.note));
  ok("and lists no scripts", listed.scripts.length === 0);
}

{
  const world = new World();
  const files = [
    { id: "s1", name: "storm_watch.rs", bytes: 900, enabled: true, position: 0 },
    { id: "s2", name: "rain_fade.rs", bytes: 400, enabled: false, position: 1 },
  ];
  const did = [];
  let open = "cns_a";
  let built = "built";

  const authoring = {
    console: () => open,
    consoles: () => [{ id: "cns_a", name: "Main console", note: "", state: { hazards: [{}] }, updated: "now" }],
    unsaved: () => null,
    scripts: async () => ({ scripts: files, bundle: { status: "stale", log: [] } }),
    script: async (instance, id) => ({ id, name: files.find((f) => f.id === id).name, source: "fn whole_file() {}" }),
    upload: async (instance, file) => { did.push(["upload", file.name, file.source]); return { script: { id: "s3", name: file.name } }; },
    save: async (instance, id, file) => { did.push(["save", id, file.name, file.source]); return { script: { id, name: file.name } }; },
    enable: async (instance, id, on) => { did.push(["enable", id, on]); return { ok: true }; },
    reorder: async (instance, order) => { did.push(["reorder", order.join(",")]); return { ok: true }; },
    remove: async (instance, id) => { did.push(["remove", id]); return { ok: true }; },
    build: async () => ({ bundle: { status: built, log: built === "built" ? [] : ["expected `;`"] } }),
    reference: async () => ({ files: [{ file: "aos-sim/emit.rs", lines: 388 }] }),
    referenceFile: async (file, from, lines) => ({ file, from, lines, text: "// ..." }),
    find: () => null,
    open: async () => ({ opened: true }),
    save_console: async () => ({ saved: true }),
    create: async () => ({ created: true }),
    rename: async () => ({ renamed: true }),
    drop: async (which, confirmed) => (confirmed ? { deleted: which } : { deleted: false, error: "no undo" }),
    screen: async () => ({ available: true }),
    screening: () => ({ available: false }),
  };

  const globe = { select() {}, lookAtGeo() {}, frame() {}, distance: () => 1, dollyTo() {}, controls: { maxDistance: 1 } };
  const tools = createTools(world, globe, { authoring });
  const has = (name) => Boolean(tools[name]);

  ok("she can list the files, read one and write one", has("list_script_files") && has("read_script") && has("write_script"));
  ok("switch one off, reorder them and delete one", has("enable_script") && has("reorder_scripts") && has("delete_script"));
  ok("and compile", has("build_scripts"));
  ok("the contract is readable, because it is on no registry", has("list_scripting_reference") && has("read_scripting_reference"));
  ok("consoles are hers too", has("list_consoles") && has("open_console") && has("save_console") && has("create_console") && has("delete_console"));
  ok("so is screening", has("run_screening") && has("screening_result"));

  const read = await callTool(tools, "read_script", { script: "storm_watch" });
  ok("a script is found by the name somebody would type", read.id === "s1");
  ok("and reading gives the whole file", read.source === "fn whole_file() {}");

  const missing = await callTool(tools, "read_script", { script: "nope.rs" });
  ok("an unknown name is a sentence, not a throw", /No script called/.test(missing.error));
  ok("and it says where the names are", /list_script_files/.test(missing.error));

  await callTool(tools, "write_script", { script: "rain_fade.rs", source: "fn replaced() {}" });
  ok("writing an existing script replaces it in place", did.at(-1)[0] === "save" && did.at(-1)[1] === "s2");
  ok("with the whole file", did.at(-1)[3] === "fn replaced() {}");

  const written = await callTool(tools, "write_script", { name: "new_one.rs", source: "fn fresh() {}" });
  ok("and a new one is an upload", did.at(-1)[0] === "upload" && did.at(-1)[1] === "new_one.rs");
  ok("every write says the bundle is stale until it is built", /stale until build_scripts/.test(written.note));

  const unnamed = await callTool(tools, "write_script", { source: "fn x() {}" });
  ok("a new script with no name is refused", /needs a name/.test(unnamed.error));
  const blank = await callTool(tools, "write_script", { name: "x.rs", source: "   " });
  ok("and an empty one is too", /empty/.test(blank.error));

  await callTool(tools, "reorder_scripts", { order: ["rain_fade.rs", "storm_watch"] });
  ok("reordering resolves names to ids before sending them", did.at(-1)[1] === "s2,s1");

  const asked = await callTool(tools, "delete_script", { script: "s1" });
  ok("deleting without confirm deletes nothing", asked.deleted === false && !did.some((row) => row[0] === "remove"));
  ok("and comes back with what would be lost", /storm_watch\.rs/.test(asked.error) && /no undo/.test(asked.error));
  const gone = await callTool(tools, "delete_script", { script: "s1", confirm: true });
  ok("confirmed, it goes", gone.deleted === "storm_watch.rs" && did.at(-1)[0] === "remove");

  const good = await callTool(tools, "build_scripts", {});
  ok("a build that worked says it is running", /now running/.test(good.note));
  built = "failed";
  const bad = await callTool(tools, "build_scripts", {});
  ok("a build that failed is a result, not an error", !bad.error && /Not built/.test(bad.note));
  ok("and the compiler's own words come back with it", bad.bundle.log[0] === "expected `;`");

  open = null;
  const nowhere = await callTool(tools, "list_script_files", {});
  ok("with no console open, she is told why rather than throwing", /No console is open/.test(nowhere.error));
}

{
  const bare = createTools(new World(), null, {});
  ok("no authoring adapter, no authoring tools", !bare.write_script && !bare.build_scripts && !bare.delete_console);
}

console.log(failures ? `\n${failures} failed` : "\nall good");
process.exitCode = failures ? 1 : 0;
