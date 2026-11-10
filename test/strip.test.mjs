
import { El, flush, install, textOf } from "./dom-shim.mjs";

install();

const { World } = await import("../src/orbital/world.js");
const { HazardStrip } = await import("../src/orbital/ui.js");

const world = new World();
world.addHazard({ kind: "storm", lat: 62, lon: -20, origin: "observed", label: "A" });
world.addHazard({ kind: "jam", lat: 16, lon: 44, origin: "observed", label: "B" });

const root = new El("div");
const strip = new HazardStrip(root, world, { onSelect(){}, onAdd(){} });
const count = () => root.children.length;
console.log("  first render:", count(), "children (2 cards + inject)");
if (count() !== 3) throw new Error("expected 3 children after first render");

if (root.children.some((c) => c.className.includes("is-arriving"))) {
  throw new Error("pre-existing hazards must not animate in on first render");
}

const settled = root.children.filter((c) => c !== strip.add);
const moves = [];
const realInsert = El.prototype.insertBefore;
root.insertBefore = function (node, ref) { moves.push(node); return realInsert.call(this, node, ref); };

const h = world.addHazard({ kind: "flare" });
strip.render(); strip.render();
root.insertBefore = realInsert;
console.log("  after inject:", count(), "children");
if (count() !== 4) throw new Error("expected 4 after inject");
if (root.lastElementChild.className.includes("haz--add") === false) throw new Error("inject button must stay last");
const shifted = settled.concat(strip.add).filter((c) => c.style.transform);
console.log("  siblings inverted by transform:", shifted.length);
if (!shifted.length) throw new Error("arrival did not FLIP the nodes it displaced");
for (const node of root.children) {
  if (node.style.height || node.style.paddingTop) {
    throw new Error("arrival animated a layout property");
  }
}

const disturbed = moves.filter((node) => settled.includes(node));
console.log("  existing cards moved during inject:", disturbed.length);
if (disturbed.length) throw new Error("inject moved cards that were already in place");

world.removeHazard(h.id);
strip.render();
console.log("  after clear (leaving card still present):", count());
if (count() !== 4) throw new Error("leaving card must survive its exit animation");
flush();
console.log("  after the exit animation settles:", count());
if (count() !== 3) throw new Error("leaving card must be gone once the exit finishes");

const { Inspector } = await import("../src/orbital/ui.js");

const panelFor = (craft) => {
  const root = new El("div");
  new Inspector(root).showSatellite(craft, world);
  return textOf(root);
};

{
  const modelled = panelFor(world.satellites[0]);
  const labels = (lines) => lines.join(" | ");

  if (modelled.length < 25) throw new Error(`modelled panel rendered only ${modelled.length} fields`);
  for (const field of ["Delta-v remaining", "Power margin", "Altitude", "Inclination", "Plane / slot", "Platform"]) {
    if (!modelled.includes(field)) throw new Error(`modelled panel is missing ${field}`);
  }
  console.log("  modelled satellite:", modelled.length, "fields");

  const tracked = { ...world.satellites[0], source: "catalogue", name: "GPS BIIR-5 (PRN 22)", noradId: "26407",
    latitude: -54.8, longitude: 161.1, altitudeKm: 19942, speedKms: 3.91, eccentricity: 0.01155 };
  delete tracked.raan;
  delete tracked.u;
  delete tracked.plane;
  delete tracked.slot;

  const catalogue = panelFor(tracked);
  if (catalogue.length < 25) throw new Error(`catalogue panel rendered only ${catalogue.length} fields`);
  for (const field of ["Catalogue no.", "Sub-point", "Speed", "Eccentricity", "Altitude"]) {
    if (!catalogue.includes(field)) throw new Error(`catalogue panel is missing ${field}`);
  }
  for (const absent of ["RAAN", "Plane / slot", "Arg. latitude"]) {
    if (catalogue.includes(absent)) throw new Error(`catalogue panel invented ${absent}`);
  }
  if (!labels(catalogue).includes("54.8°S")) throw new Error("sub-point hemisphere is wrong");
  if (!labels(catalogue).includes("SGP4")) throw new Error("catalogue panel does not say where its position came from");
  if (!labels(modelled).includes("Modelled constellation")) throw new Error("modelled panel does not say it is modelled");
  console.log("  catalogue satellite:", catalogue.length, "fields, no invented ones");

  for (const [name, lines] of [["modelled", modelled], ["catalogue", catalogue]]) {
    const bad = lines.filter((line) => /NaN|undefined/.test(line));
    if (bad.length) throw new Error(`${name} panel shows ${bad.join(", ")}`);
  }
  console.log("  no NaN or undefined in either panel");
}

{
  const hazard = world.hazards[0];
  const root = new El("div");
  const changes = [];
  new Inspector(root).showHazard(hazard, world, { onChange: (patch) => changes.push(patch), onRemove(){} });

  const row = root.querySelector(".detail__name");
  const pen = root.querySelector(".detail__rename");
  const input = root.querySelector(".detail__title-edit");
  const kicker = root.querySelector(".detail__kicker");
  const title = root.querySelector(".detail__title");
  if (!row || !pen || !input) throw new Error("the hazard panel has no rename control");
  if (input.hidden !== true) throw new Error("the edit field must start hidden");
  const subtitle = kicker.textContent;

  pen.dispatch("click");
  if (input.hidden) throw new Error("the pen did not open the edit field");
  if (!row.classList.contains("is-editing")) throw new Error("the row is not marked as editing");
  if (input.value !== hazard.label) throw new Error("the field did not start from the current name");
  if (kicker.textContent === subtitle) throw new Error("the kicker did not become the hint");
  if (title.parentNode !== row) throw new Error("the title must keep its space while hidden");

  if (input._caret?.[0] !== hazard.label.length || input._caret[1] !== hazard.label.length) {
    throw new Error(`the field opened with ${JSON.stringify(input._caret)}, not a caret at the end`);
  }

  input.value = "  Baltic uplink outage  ";
  input.dispatch("keydown", { key: "Enter" });
  if (changes.length !== 1 || changes[0].label !== "Baltic uplink outage") {
    throw new Error(`Enter committed ${JSON.stringify(changes)}`);
  }
  if (kicker.textContent !== subtitle) throw new Error("the kicker did not go back to the subtitle");

  if (row.classList.contains("is-editing")) throw new Error("Enter did not leave the editing state");
  if (!row.classList.contains("is-closing")) throw new Error("Enter cut the field instead of retracting it");
  if (input.hidden) throw new Error("the field was hidden before its rule had retracted");
  flush();
  if (!input.hidden || row.classList.contains("is-closing")) throw new Error("the retract never finished");

  pen.dispatch("click");
  input.value = "discard me";
  input.dispatch("keydown", { key: "Escape" });
  input.dispatch("blur");
  if (changes.length !== 1) throw new Error(`Escape committed ${JSON.stringify(changes.slice(1))}`);
  flush();

  pen.dispatch("click");
  input.value = "Committed on blur";
  input.dispatch("blur");
  if (changes.length !== 2 || changes[1].label !== "Committed on blur") {
    throw new Error(`blur committed ${JSON.stringify(changes)}`);
  }

  pen.dispatch("click");
  if (row.classList.contains("is-closing")) throw new Error("reopening kept the closing state");
  flush();
  if (input.hidden || !row.classList.contains("is-editing")) throw new Error("a stale timer closed the reopened field");

  input.value = "   ";
  input.dispatch("keydown", { key: "Enter" });
  if (changes.length !== 2) throw new Error("an empty name was accepted");
  flush();
  console.log("  rename: pen opens, Enter and blur commit, Escape and blank do not");
}

{
  const { Chat } = await import("../src/orbital/ui.js");

  const log = new El("ul");
  const form = new El("form");
  const input = new El("input");
  const host = {
    querySelector: (sel) => ({ "[data-chat-log]": log, "[data-chat-form]": form, "[data-chat-input]": input })[sel],
  };
  log.scrollHeight = 900;
  log.clientHeight = 300;
  log.scrollTop = 0;

  const chat = new Chat(host, { onSend(){} });
  const resize = (height) => {
    log.clientHeight = height;
    chat.reflow();
  };
  const fromBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight;

  log.scrollTop = 600;
  log.dispatch("scroll");
  resize(460);
  if (log.scrollTop !== 440) throw new Error(`growing the panel left scrollTop at ${log.scrollTop}`);
  resize(300);
  if (log.scrollTop !== 600) throw new Error(`shrinking the panel left scrollTop at ${log.scrollTop}`);
  if (fromBottom() !== 0) throw new Error(`the last line is ${fromBottom()}px off the bottom`);
  console.log("  chat: pinned to the bottom stays pinned, both ways");

  log.scrollTop = 450;
  log.dispatch("scroll");
  resize(500);
  if (fromBottom() !== 150) throw new Error(`reading position moved to ${fromBottom()}px from the bottom`);
  resize(260);
  if (fromBottom() !== 150) throw new Error(`reading position moved to ${fromBottom()}px from the bottom`);
  console.log("  chat: scrolled up, the reading position holds");

  resize(1200);
  if (log.scrollTop !== 0) throw new Error(`a log shorter than its panel scrolled to ${log.scrollTop}`);

  log.scrollTop = 0;
  log.dispatch("scroll");
  resize(300);
  chat.push("agent", "Storm front crossing the Atlantic.");
  if (fromBottom() !== 0) throw new Error("a new message did not scroll to the bottom");
  console.log("  chat: a new message returns to the bottom");

  {
    const log2 = new El("ul");
    const host2 = { querySelector: (sel) => ({ "[data-chat-log]": log2, "[data-chat-form]": new El("form"), "[data-chat-input]": new El("input") })[sel] };
    log2.scrollHeight = 400;
    log2.clientHeight = 400;
    log2.scrollTop = 0;
    const booting = new Chat(host2, { onSend(){} });
    const run = booting.boot([["relay", "Reaching the relay", "is-running"], ["feed", "Reading space weather"]]);

    const block = log2.querySelector(".boot");
    if (!block) throw new Error("the startup block was not drawn");
    if (log2.children[0] !== block) throw new Error("the startup block must be first, where the gap is");
    const steps = () => block.querySelector(".boot__list").children;
    if (steps().length !== 2) throw new Error(`${steps().length} steps drawn`);
    if (!steps()[0].classList.contains("is-running")) throw new Error("the started step is not running");
    if (!steps()[1].classList.contains("is-waiting")) throw new Error("a step that has not begun is claiming to run");
    run.start("feed");
    if (!steps()[1].classList.contains("is-running") || steps()[1].classList.contains("is-waiting")) {
      throw new Error("starting a step did not move it out of waiting");
    }

    booting.push("aos", "Console live.");
    if (log2.children[0] !== block) throw new Error("a message displaced the startup block");

    run.done("relay", "ready");
    if (!steps()[0].classList.contains("is-done") || steps()[0].classList.contains("is-running")) {
      throw new Error("a finished step is still running");
    }
    if (steps()[1].classList.contains("is-done")) throw new Error("finishing one step finished another");
    if (block.parentNode !== log2) throw new Error("the block left before every step had settled");

    run.done("relay", "again");
    run.fail("relay", "no");
    if (block.parentNode !== log2) throw new Error("a repeated settle dismissed the block early");

    run.start("relay");
    if (!steps()[0].classList.contains("is-done")) throw new Error("starting a settled step un-settled it");

    run.fail("feed", "offline");
    if (!steps()[1].classList.contains("is-failed")) throw new Error("a failed step is not marked failed");
    flush();
    flush();
    if (block.parentNode === log2) throw new Error("the block stayed after every step settled");
    const said = [...log2.children].filter((node) => !node._cls.has("chat__idle"));
    if (said.length !== 1) throw new Error(`${said.length} messages left, expected just the one`);
    if (log2.children.at(-1) !== log2.querySelector(".chat__idle")) throw new Error("the idle mark is not last");
    console.log("  chat: the startup block fills the gap, then leaves");
  }

  globalThis.getComputedStyle = () => ({ paddingTop: "16px", paddingBottom: "16px" });
  const empty = new Chat({ querySelector: () => new El("div") }, { onSend(){} });
  if (empty.naturalHeight() !== 0) throw new Error("an empty log claimed a height");
  chat.push("you", "one");
  chat.push("agent", "two");
  const natural = chat.naturalHeight();
  if (natural !== 148 + 32 + 44 + 2) throw new Error(`the ceiling came out at ${natural}`);
  resize(80);
  if (chat.naturalHeight() !== natural) throw new Error("the ceiling followed the panel height");
  console.log("  chat: the drag ceiling is the conversation's own height,", natural);
}

{
  const { Chat } = await import("../src/orbital/ui.js");

  const make = () => {
    const log = new El("ul");
    log.scrollHeight = 400;
    log.clientHeight = 400;
    log.scrollTop = 0;
    const host = {
      querySelector: (sel) =>
        ({ "[data-chat-log]": log, "[data-chat-form]": new El("form"), "[data-chat-input]": new El("input") })[sel],
    };
    return { log, chat: new Chat(host, { onSend(){} }) };
  };
  const spoken = (log) => log.children.filter((node) => node._cls.has("msg"));

  const said = [
    { who: "you", text: "what is the forecast", meta: null, at: Date.UTC(2026, 0, 1) },
    { who: "aos", text: "Kp 5.2 tomorrow.", meta: "forecast()", at: Date.UTC(2026, 0, 1, 0, 1) },
  ];

  {
    const { log, chat } = make();
    const run = chat.boot([["relay", "Reaching the relay", "is-running"]]);
    chat.replay(said);
    if (spoken(log).length) throw new Error("the conversation was drawn during boot");
    chat.push("aos", "Console live.");
    run.done("relay", "ready");
    flush();
    flush();
    const lines = spoken(log);
    if (lines.length !== 3) throw new Error(`${lines.length} lines after boot, expected 3`);
    if (!textOf(lines[0]).join(" ").includes("Console live.")) {
      throw new Error("the restored conversation came out above the opening line");
    }
    if (!textOf(lines[2]).join(" ").includes("Kp 5.2")) {
      throw new Error("the restored conversation is out of order");
    }
    if (chat.transcript().length !== 2) {
      throw new Error(`the transcript holds ${chat.transcript().length}, expected the 2 restored`);
    }
    console.log("  chat: a restored conversation waits for the console to come up");
  }

  {
    const { log, chat } = make();
    chat.replay(said);
    if (spoken(log).length !== 2) throw new Error("the first console's chat was not drawn");
    chat.replay([{ who: "you", text: "anything over Japan", meta: null, at: Date.UTC(2026, 0, 2) }]);
    const lines = spoken(log);
    if (lines.length !== 1) throw new Error(`${lines.length} lines after switching, expected 1`);
    if (!textOf(lines[0]).join(" ").includes("Japan")) throw new Error("the wrong console's chat is on screen");
    if (chat.transcript().length !== 1) throw new Error("the new console adopted the old one's transcript");

    chat.replay(undefined);
    if (spoken(log).length) throw new Error("an empty console kept the last one's lines");
    if (chat.transcript().length) throw new Error("an empty console kept the last one's transcript");
    console.log("  chat: switching consoles takes the last one's conversation with it");
  }

  {
    const { log, chat } = make();
    chat.push("aos", "Console live.", "anthropic · 14 tools", { transient: true });
    chat.push("you", "what is the forecast");
    const working = chat.push("aos", "thinking…", "", { transient: true });
    working.remove();
    chat.push("aos", "Kp 5.2 tomorrow.", "forecast()");

    const kept = chat.transcript();
    if (kept.length !== 2) throw new Error(`${kept.length} entries saved, expected the exchange only`);
    if (kept.some((entry) => entry.text.includes("thinking"))) {
      throw new Error("the working line was saved");
    }
    if (kept.some((entry) => entry.text.includes("Console live"))) {
      throw new Error("the opening line was saved");
    }
    if (spoken(log).length !== 3) throw new Error(`${spoken(log).length} lines on screen, expected 3`);

    chat.replay([{ who: "you", text: "anything over Japan", meta: null, at: Date.UTC(2026, 0, 2) }]);
    const after = spoken(log).map((node) => textOf(node).join(" "));
    if (after.length !== 2) throw new Error(`${after.length} lines after switching, expected 2`);
    if (!after[0].includes("Console live")) throw new Error("switching consoles took the opening line with it");
    if (!after[1].includes("Japan")) throw new Error("the new console's chat is not on screen");
    console.log("  chat: the console's own chatter is drawn but never saved");
  }

  {
    const { log, chat } = make();
    chat.push("you", "what is the forecast");
    const working = chat.working();
    const line = log.children.find((node) => node._cls.has("msg--working"));
    if (!line) throw new Error("the working line was not drawn");
    if (line.querySelector(".msg__who")) throw new Error("the working line is announcing itself as a turn");
    if (line.querySelector(".msg__time")) throw new Error("the working line is stamped with a time");
    working.say("conjunctions…");
    if (!textOf(line).join(" ").includes("conjunctions")) throw new Error("the running tool is not shown");
    working.done();
    if (log.children.includes(line)) throw new Error("the working line outlived the turn");
    if (chat.transcript().length !== 1) throw new Error("the working line reached the transcript");
    console.log("  chat: the working line is a state, not a turn");
  }

  {
    const { log, chat } = make();
    chat.boot([["relay", "Reaching the relay", "is-running"], ["feed", "Reading space weather"]]);
    chat.replay(said);
    if (spoken(log).length) throw new Error("drawn before the rescue was due");
    flush();
    flush();
    if (spoken(log).length !== 2) throw new Error("a hung boot step swallowed the conversation");
    console.log("  chat: a boot step that never reports does not cost the conversation");
  }
}

{
  const { Inspector } = await import("../src/orbital/ui.js");

  const root = new El("div");
  const renames = [];
  new Inspector(root).showConsoles(
    [{ id: "a", name: "Main console", note: "the old one", created: "2026-11-01T00:00:00Z", updated: "2026-11-08T00:00:00Z", state: { hazards: [] } }],
    {
      current: "a",
      unsaved: "a",
      signedIn: true,
      onOpen() {}, onCreate() {}, onSave() {},
      onRename: (row, name, note) => renames.push({ name, note }),
      onDelete() {},
    },
  );

  const card = root.querySelector(".consoles").children[0];
  const form = card.querySelector(".cns__edit");
  const open = card.querySelector(".cns__open");
  const pen = card.querySelector(".cns__act");
  const held = (name) => card._cls.has(name);

  const mark = card.querySelector(".cns__unsaved");
  if (!mark.children.includes(card.querySelector(".cns__tip"))) {
    throw new Error("the tooltip is not attached to the mark it belongs to");
  }

  pen.dispatch("click");
  if (!held("is-opening")) throw new Error("the card did not start fading its own lines out");
  if (!form.hidden) throw new Error("the fields arrived before the lines had left");
  flush();
  if (held("is-opening") || !held("is-editing")) throw new Error("the handover never completed");
  if (form.hidden || !open.hidden) throw new Error("the fields are not up");

  card.querySelector(".cns__cancel").dispatch("click");
  if (held("is-editing")) throw new Error("cancel did not leave the editing state");
  if (!held("is-closing")) throw new Error("cancel cut the rule instead of retracting it");
  if (form.hidden) throw new Error("the fields were hidden before the rule had retracted");
  flush();
  if (!form.hidden || open.hidden) throw new Error("the retract never finished");
  if (!held("is-settling")) throw new Error("the card's own lines came back without fading");
  flush();
  if (held("is-settling")) throw new Error("the card never settled");
  if (renames.length) throw new Error("cancel committed a rename");

  pen.dispatch("click");
  flush();
  const name = form.querySelector(".cns__field--name");
  name.value = "  Screening  ";
  form.dispatch("submit");
  if (!held("is-closing")) throw new Error("committing cut the rule instead of retracting it");
  flush();
  flush();
  if (renames.length !== 1 || renames[0].name !== "Screening") {
    throw new Error(`committed ${JSON.stringify(renames)}`);
  }
  console.log("  consoles: renaming hands over in two beats, and back again");
}

{
  const fleet = new World();
  fleet.addHazard({ kind: "storm", lat: 62, lon: -20, origin: "observed", label: "Observed one" });
  fleet.addHazard({ kind: "flare", lat: 10, lon: 10, origin: "injected", label: "Theirs" });

  const column = new El("div");
  const deck = new HazardStrip(column, fleet, { onSelect(){}, onAdd(){} });
  const cards = () => column.children.filter((node) => node !== deck.add && !node._cls.has("is-leaving"));
  if (cards().length !== 2) throw new Error(`${cards().length} cards to start with`);
  if (cards().some((node) => node._cls.has("is-arriving"))) {
    throw new Error("the console's opening stack animated in");
  }

  for (const hazard of fleet.hazards.filter((h) => h.origin === "injected")) {
    fleet.removeHazard(hazard.id);
  }
  fleet.addHazard({ kind: "debris", lat: -4, lon: 120, origin: "injected", label: "The next one's" });

  const before = cards().find((node) => node !== null);
  deck.restage();
  const after = cards();
  if (after.length !== 2) throw new Error(`${after.length} cards after re-dealing`);
  const still = after.filter((node) => !node._cls.has("is-moving") && !node._cls.has("is-arriving"));
  if (still.length) throw new Error(`${still.length} card(s) did not animate in`);
  if (after.includes(before)) throw new Error("a card survived the re-deal and will not animate");
  if (deck.active !== null) throw new Error("a selection survived into a different console");
  console.log("  strip: opening a console deals every card again, not just the new ones");
}

console.log("\nall green");
