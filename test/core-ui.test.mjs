
import { El, install, textOf } from "./dom-shim.mjs";

install();

const { renderBoard, renderBoot, renderBrief, renderConsoles, renderScripts, renderViewer, titleOf } =
  await import("../src/core/ui.js");

let failures = 0;
const ok = (label, pass, detail = "") => {
  console.log(`  ${pass ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!pass) failures += 1;
};
const find = (node, className) => node.querySelector(`.${className}`);
const all = (node, className) => {
  const out = [];
  const walk = (n) => {
    for (const c of n.children) {
      if (c._cls.has(className)) out.push(c);
      walk(c);
    }
  };
  walk(node);
  return out;
};
const words = (node) => textOf(node).join(" ");

{
  const root = new El("section");

  renderBoard(root, { state: "none", detail: "No bundle yet." });
  ok("with no bundle the board says so", /No bundle yet/.test(words(root)));
  ok("and draws no empty-state lecture over the top of it", !find(root, "board__quiet"));

  renderBoard(root, { state: "ready", entries: [] });
  ok("a built bundle that posted nothing explains itself", Boolean(find(root, "board__quiet")));
  ok("saying nothing posts on its own", /starts empty and stays empty/.test(words(root)));
  ok("and naming the call that would change that", /out\.notify/.test(words(root)));

  const entries = [
    { level: "info", title: "Running", detail: "Watching.", from: "storm_watch", at: Date.now() },
    { level: "alarm", title: "G4", detail: "Kp 8.1 measured.", from: "storm_watch", at: Date.now() - 1000 },
    { level: "notice", title: "Quiet", detail: "Nothing in play.", from: "other", at: Date.now() - 2000 },
  ];
  renderBoard(root, { state: "ready", entries });
  const rows = all(root, "note");
  ok("entries are drawn", rows.length === 3);
  ok("loudest first, not newest first", rows[0]._cls.has("note--alarm"), rows[0].className);
  ok("and each says which script said it", /storm_watch/.test(words(rows[0])));

  renderBoard(root, { state: "error", detail: "The bundle would not run." });
  ok("a bundle that will not load says that instead of showing an empty board", !find(root, "board__quiet"));
  ok("and says what happened", /would not run/.test(words(root)));
}

{
  const root = new El("nav");
  renderConsoles(root, { rows: [], signedIn: false, onOpen() {}, onRename() {}, onDrop() {} });
  ok("signed out, the shelf says why it is empty", /Sign in/.test(words(root)));

  let opened = 0;
  renderConsoles(root, {
    rows: [{ id: "a", name: "Drill", note: "Nights" }],
    current: "a",
    signedIn: true,
    onOpen: () => (opened += 1),
    onRename() {},
    onDrop() {},
  });
  ok("signed in, consoles are listed", /Drill/.test(words(root)));
  ok("the open one is marked", find(root, "row")._cls.has("is-current"));
  find(root, "row__open").dispatch("click");
  ok("and one can be opened", opened === 1);
  ok("but not made here", !find(root, "panel__act"));
}

{
  const root = new El("div");
  renderScripts(root, { current: null, onPick() {}, onAdd() {}, onBuild() {}, onEnable() {}, onMove() {}, onDrop() {} });
  ok("with no console open there is nothing to show", /Open a console/.test(words(root)));

  renderScripts(root, {
    current: "a",
    rows: [],
    bundle: { status: "none" },
    forge: { sandboxed: true, dependencies: 24 },
    onPick() {}, onAdd() {}, onBuild() {}, onEnable() {}, onMove() {}, onDrop() {},
  });
  ok("an empty console invites a file", /Upload a \.rs/.test(words(root)));
  ok("and says dependencies are allowed when the host can sandbox", /Any crate/.test(words(root)));
  ok("with the build button disabled, there being nothing to build", find(root, "build__go").disabled === true);

  renderScripts(root, {
    current: "a",
    rows: [],
    bundle: { status: "none" },
    forge: { sandboxed: false, dependencies: 0 },
    onPick() {}, onAdd() {}, onBuild() {}, onEnable() {}, onMove() {}, onDrop() {},
  });
  ok("and says they are refused when it cannot", /cannot sandbox/.test(words(root)));
}

{
  const root = new El("div");
  const rows = [
    { id: "s1", name: "first.rs", bytes: 900, enabled: true, dependencies: [] },
    { id: "s2", name: "second.rs", bytes: 1200, enabled: false, dependencies: ["nalgebra"] },
  ];
  const moves = [];
  let built = 0;
  const toggled = [];
  renderScripts(root, {
    current: "a",
    rows,
    bundle: { status: "stale" },
    forge: { sandboxed: true },
    selected: "s1",
    onPick() {},
    onAdd() {},
    onBuild: () => (built += 1),
    onEnable: (row, on) => toggled.push([row.id, on]),
    onMove: (from, to) => moves.push([from, to]),
    onDrop() {},
  });

  const files = all(root, "row");
  ok("files are listed in order", files.length === 2);
  ok("the open one is marked", files[0]._cls.has("is-open"));
  ok("a disabled one is marked off rather than broken", files[1]._cls.has("is-off"));
  ok("and says so in the row itself", /\boff\b/.test(words(files[1])));
  ok("a script's crates are shown in the list", /nalgebra/.test(words(files[1])));

  ok("a stale bundle asks to be rebuilt", /Stale/.test(words(root)));
  ok("and the build button is live", find(root, "build__go").disabled === false);
  find(root, "build__go").dispatch("click");
  ok("which builds", built === 1);

  const arrows = all(root, "row__tool").filter((b) => b.textContent === "↑" || b.textContent === "↓");
  ok("order can be changed, because register runs in sequence", arrows.length === 4);
  ok("and the first cannot move up", arrows[0].disabled === true);
  arrows[1].dispatch("click");
  ok("moving reports both ends of the move", moves[0].join() === "0,1", moves[0]?.join());

  all(root, "row__tool")
    .find((b) => b.textContent === "Off")
    .dispatch("click");
  ok("and a disabled script can be put back", toggled[0].join() === "s2,true", toggled[0]?.join());
}

{
  const root = new El("div");
  const steps = [
    { label: "Sending the source", state: "done", word: "done" },
    { label: "Compiling", state: "running", word: "" },
    { label: "Loading the bundle", state: "waiting", word: "" },
    { label: "Injecting the scripts", state: "waiting", word: "" },
  ];
  renderScripts(root, {
    current: "a",
    rows: [{ id: "s1", name: "one.rs", bytes: 10, enabled: true, dependencies: [] }],
    bundle: { status: "building" },
    forge: { sandboxed: true },
    busy: true,
    steps,
    onPick() {}, onAdd() {}, onBuild() {}, onEnable() {}, onMove() {}, onDrop() {},
  });
  ok("while building, the startup list is drawn", Boolean(find(root, "boot")));
  ok("and the build button is gone rather than disabled", !find(root, "build__go"));

  const drawn = all(root, "boot__step");
  ok("one row per observed phase", drawn.length === 4);
  ok("finished phases are marked done", drawn[0]._cls.has("is-done"));
  ok("exactly one is in flight", drawn.filter((r) => r._cls.has("is-running")).length === 1);
  ok("and the rest are waiting, not running", drawn[3]._cls.has("is-waiting"));

  const failed = renderBoot([{ label: "Compiling", state: "failed", word: "failed" }]);
  ok("a failed phase says so", /failed/.test(words(failed)));
}

{
  ok("snake case becomes a title", titleOf("conjunction_watch.rs") === "Conjunction Watch");
  ok("dashes too", titleOf("own-fleet.rs") === "Own Fleet");
  ok("one word still works", titleOf("watch.rs") === "Watch");
  ok("and the extension is optional", titleOf("storm_watch") === "Storm Watch");
  ok("a name with capitals is left alone", titleOf("StormWatch.rs") === "StormWatch.rs");
  ok("so is one with spaces", titleOf("My Script.rs") === "My Script.rs");
  ok("and one with dots in the stem", titleOf("a.b.rs") === "a.b.rs");
}

{
  const root = new El("section");
  renderViewer(root, { script: null });
  ok("nothing open points at the contract", /SCRIPTING\.md/.test(words(root)));

  const script = { id: "s1", name: "storm_watch.rs", source: "let x = 1;\nfn go() {}\n// a note\n", manifest: "" };
  let saved = 0;
  renderViewer(root, {
    script,
    diagnostics: [],
    dirty: false,
    onSave: () => (saved += 1),
    onRevert() {},
    onBuild() {},
  });
  ok("the heading is the file, titled", find(root, "viewer__name").textContent === "Storm Watch");
  ok("with the real filename above it", /storm_watch\.rs/.test(find(root, "viewer__kicker").textContent));
  ok("the source is shown", find(root, "code__text").value === script.source);
  ok("with a painted copy behind it", Boolean(find(root, "code__paint")));
  ok("opening a file is marked for its entrance", renderViewer(root, { script, fresh: true, onSave() {}, onRevert() {}, onBuild() {} }) === undefined && root._cls.has("is-fresh"));
  renderViewer(root, { script, fresh: false, onSave() {}, onRevert() {}, onBuild() {} });
  ok("and redrawing the same one is not", !root._cls.has("is-fresh"));
  ok("and the two share a cell so neither can drift", Boolean(find(root, "code__stack")));
  ok("with a line number each", all(root, "code__line").length === 4, `${all(root, "code__line").length}`);
  ok("keywords are picked out", all(root, "t-keyword").length > 0);
  ok("and comments are too", all(root, "t-comment").length > 0);
  ok("Save is dead until something changes", find(root, "viewer__tool--go").disabled === true);
  ok("and there is nothing to revert to", !all(root, "viewer__tool").some((b) => b.textContent === "Revert"));

  renderViewer(root, { script, diagnostics: [], dirty: true, onSave: () => (saved += 1), onRevert() {}, onBuild() {} });
  ok("edited, Save comes alive", find(root, "viewer__tool--go").disabled === false);
  ok("and the filename survives the unsaved marker", /storm_watch\.rs · unsaved/.test(find(root, "viewer__kicker").textContent));
  find(root, "viewer__tool--go").dispatch("click");
  ok("and saves", saved === 1);

  const diagnostics = [
    { level: "error", script: "watch.rs", line: 2, message: "no field `nope`", rendered: "error[E0609]\n  --> line 2" },
    { level: "warning", script: "watch.rs", line: 3, message: "unused variable", rendered: "" },
  ];
  renderViewer(root, { script, diagnostics, dirty: false, onSave() {}, onRevert() {}, onBuild() {} });
  ok("what the compiler said is shown", /no field/.test(words(root)));
  ok("with the operator's own line number", /line 2/.test(words(root)));
  const gutter = all(root, "code__line");
  ok("and marked in the gutter", gutter[1]._cls.has("is-error"), gutter[1].className);
  ok("warnings marked differently from errors", gutter[2]._cls.has("is-warning"), gutter[2].className);
  ok("the compiler's own rendering is kept", Boolean(find(root, "said__rendered")));

  renderViewer(root, {
    script: { ...script, manifest: '[dependencies]\nnalgebra = "0.33"\n' },
    diagnostics: [],
    dirty: false,
    onSave() {}, onRevert() {}, onBuild() {},
  });
  ok("a manifest is shown when there is one", find(root, "manifest__text").value.includes("nalgebra"));
  ok("and it says only the dependency table is used", /Only the dependency table/.test(words(root)));
  ok("opened, because a folded box with content in it is content nobody finds", find(root, "manifest").open === true);
}

{
  const root = new El("aside");
  renderBrief(root, { state: "idle" });
  ok("with nothing built the brief says what would fill it", /from the bundle itself/.test(words(root)));

  renderBrief(root, { state: "error", detail: "It would not instantiate." });
  ok("and a bundle that would not run says that", /would not instantiate/.test(words(root)));

  const manifest = {
    contract: 1,
    scripts: [
      {
        id: "storm_watch",
        name: "Storm watch",
        version: "1.1.0",
        author: "Ida",
        summary: "Warns when tomorrow crosses G1.",
        glyph: "≋",
        tint: "#7fd4ff",
        tickEverySeconds: 3600,
        notes: ["Uses the shipped forecaster, RMSE 1.12 Kp."],
      },
    ],
    hazardKinds: [
      { id: "flare", name: "Solar flare", glyph: "✸", colour: "#ffb067", unit: "X", blurb: "x", stock: true, actsOn: ["links"], limits: {} },
      {
        id: "rain",
        name: "Rain fade",
        glyph: "⟋",
        colour: "#8fb8ff",
        unit: "mm/h",
        blurb: "Hydrometeor absorption on the slant path.",
        stock: false,
        actsOn: ["links"],
        limits: { radiusLowKm: 5, radiusHighKm: 200, durationHighMin: 120 },
      },
    ],
    overrides: [
      { slot: "screening", name: "Acme OD covariance", consequence: "Which conjunctions are found." },
    ],
    clashes: [{ slot: "propagator", ignored: "Second one" }],
    craftAdded: 48,
  };
  const reports = [{ script: "storm_watch", lines: [{ label: "worst", value: "6.2", unit: "Kp" }] }];
  renderBrief(root, { state: "ready", manifest, reports });

  ok("the scripts are described", /Storm watch/.test(words(root)));
  ok("in their author's own words", /crosses G1/.test(words(root)));
  ok("a cadence is said in time, not in seconds", /1 h of simulated time/.test(words(root)), words(root).slice(0, 200));
  ok("what the script currently thinks is shown beside it", /worst: 6\.2 Kp/.test(words(root)));
  ok("and its notes survive", /RMSE 1\.12/.test(words(root)));

  ok("hazard kinds the scripts added are listed", /Rain fade/.test(words(root)));
  ok("and the console's own are not", !/Solar flare/.test(words(root)));
  ok("with the mechanism rather than a label", /Hydrometeor/.test(words(root)));
  ok("and its own footprint bounds", /5–200 km/.test(words(root)), words(root).slice(-400));

  ok("replaced algorithms are named", /Acme OD covariance/.test(words(root)));
  ok("with what replacing them costs", /Which conjunctions are found/.test(words(root)));
  ok("a second override in one slot is reported, not hidden", /was not loaded/.test(words(root)));
  ok("and craft the scripts added are counted", /48 craft/.test(words(root)));

  const badges = all(root, "badge");
  ok("each carries the mark it will be drawn with elsewhere", badges.length >= 2);
  ok("tinted by the script's own choice", badges[0]._style["--tint"] === "#7fd4ff", badges[0]._style["--tint"]);

  renderBrief(root, {
    state: "ready",
    manifest: { ...manifest, scripts: [], hazardKinds: [], overrides: [], clashes: [], craftAdded: 0 },
    reports: [],
  });
  ok("a bundle that registered nothing says so", /registered nothing/.test(words(root)));
}

console.log(failures ? `\n${failures} failed` : "\nall good");
process.exitCode = failures ? 1 : 0;
