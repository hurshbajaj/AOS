
import { El, install, textOf } from "./dom-shim.mjs";

install();

const { Inspector } = await import("../src/orbital/ui.js");
const { CAVEAT } = await import("../src/orbital/conjunctions.js");

let failures = 0;
const ok = (label, pass, detail = "") => {
  console.log(`  ${pass ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!pass) failures += 1;
};
const find = (node, className) => node.querySelector(`.${className}`);
const all = (node, className) => {
  const out = [];
  const walk = (n) => { for (const c of n.children) { if (c._cls.has(className)) out.push(c); walk(c); } };
  walk(node);
  return out;
};

const root = new El("div");
const inspector = new Inspector(root);
const noop = { onBack() {}, onRun() {}, onFocus() {} };

{
  let asked = 0;
  const panel = inspector.showConsoles([], {
    signedIn: true,
    documents: [],
    onOpen() {}, onCreate() {}, onRename() {}, onDelete() {},
    onAddDoc() {}, onDropDoc() {},
    onScreen: () => (asked += 1),
  });
  const button = find(panel, "screenbtn");
  ok("the consoles panel offers screening", Boolean(button));
  ok("under the documents, not among the consoles", textOf(button).join(" ").includes("Conjunction screening"));
  button.dispatch("click");
  ok("and pressing it asks for the mode", asked === 1);

  const out = inspector.showConsoles([], { signedIn: false, onOpen() {}, onCreate() {}, onRename() {}, onDelete() {}, onScreen() {} });
  ok("signed out it is not offered at all", !find(out, "screenbtn"));
}

{
  const panel = inspector.showScreening({ message: "Fetching the tracked catalogue…", fraction: null, detail: "one download a session" }, noop);
  ok("a run in progress says what it is doing", textOf(panel).some((line) => /Fetching the tracked catalogue/.test(line)));
  const fill = find(panel, "screen__fill");
  ok("with a bar", Boolean(fill));
  ok("which paces while there is nothing to measure", fill._cls.has("is-sliding"));

  const half = inspector.showScreening({ message: "Screening…", fraction: 0.5 }, noop);
  ok("and fills once there is", !find(half, "screen__fill")._cls.has("is-sliding"));
  ok("to the fraction given", /scaleX\(0.5\)/.test(find(half, "screen__fill").style.transform ?? ""), find(half, "screen__fill").style.transform);
}

{
  const result = {
    from: new Date().toISOString(),
    hours: 24,
    alertKm: 10,
    catalogue: 18556,
    total: 6548,
    alerts: 17,
    fleet: [{ id: "mesh-1", name: "AOS-04", screened: 2227, encounters: 1714, closestKm: 1.97 }],
    encounters: [
      { mine: "mesh-1", mineName: "AOS-04", other: "norad-1", name: "FENGYUN 1C DEB", km: 1.973, inHours: 16.27, alert: true },
      { mine: "mesh-1", mineName: "AOS-04", other: "norad-2", name: "COSMOS 2251 DEB", km: 48.1, inHours: 3.4, alert: false },
    ],
    histogram: [{ from: 1, to: 2, n: 1 }, { from: 25, to: 50, n: 1 }],
  };

  let focused = null;
  let backed = 0;
  const panel = inspector.showScreening({ result, caveat: CAVEAT }, { onBack: () => (backed += 1), onRun() {}, onFocus: (row) => (focused = row) });
  const words = textOf(panel).join(" ");

  ok("the result says what it screened against", /18,556 objects/.test(words), words.slice(0, 90));
  ok("and over what horizon", /24 h/.test(words));
  ok("the closest approach is on the face of it", /1.97 km/.test(words));
  ok("as is how many need looking at", /17/.test(words));

  const dots = all(panel, "screen__dot");
  ok("every encounter is a point on the chart", dots.length === 2, String(dots.length));
  ok("the close one is marked as such", dots.filter((d) => d._cls.has("is-alert")).length === 1);
  ok("and the line it crossed is drawn", Boolean(find(panel, "screen__floor")));

  const rows = all(panel, "screen__row");
  ok("each is a row as well", rows.length === 2);
  ok("the alerting one is flagged", rows[0]._cls.has("is-alert"));
  rows[0].dispatch("click");
  ok("and picking one hands back which", focused?.other === "norad-1");

  ok("sample data is not flagged when the result is real", !find(panel, "screen__pill"));

  ok("the caveat is shown with the numbers", /covariance/.test(words), "no caveat on the panel");

  const back = find(panel, "backlink--screen");
  ok("there is a way out", Boolean(back));
  back.dispatch("click");
  ok("which works", backed === 1);
}

{
  const quiet = inspector.showScreening({
    result: { hours: 24, alertKm: 10, catalogue: 2667, total: 0, alerts: 0, fleet: [], encounters: [], histogram: [] },
    caveat: CAVEAT,
  }, noop);
  ok("an empty result gets the shape of a result", Boolean(find(quiet, "screen__none")));
  ok("saying what was found", textOf(quiet).some((line) => /No close approaches/.test(line)));

  const apart = inspector.showScreening({
    result: { hours: 24, alertKm: 10, catalogue: 2667, pairs: 0, total: 0, alerts: 0, fleet: [{ id: "a" }, { id: "b" }], encounters: [], histogram: [] },
  }, noop);
  ok("a fleet nowhere near the catalogue says so instead", textOf(apart).some((line) => /Nothing to screen against/.test(line)));
  ok("and explains that no pair was ever in range", textOf(apart).some((line) => /share an altitude band/.test(line)));
  ok("and what it was looked for in", textOf(quiet).some((line) => /2,667 tracked objects/.test(line)));
  ok("with no chart to read, since there is nothing in it", !find(quiet, "screen__svg"));
  ok("and no caveat, since there are no distances for it to qualify", !textOf(quiet).some((line) => /covariance/.test(line)));

  const sample = inspector.showScreening({
    result: { sample: true, hours: 24, alertKm: 10, catalogue: 18556, total: 10704, alerts: 31, fleet: [], encounters: [], histogram: [] },
  }, noop);
  ok("and is flagged in as many words when it is not", Boolean(find(sample, "screen__pill")));
  ok("saying how to get the real thing", /screen=sample/.test(textOf(sample).join(" ")));

  let cancelled = 0;
  const running = inspector.showScreening({ message: "Sweeping\u2026", fraction: 0.4 }, { ...noop, onCancel: () => (cancelled += 1) });
  const stop = find(running, "screen__cancel");
  ok("a run in flight can be called off", Boolean(stop));
  stop.dispatch("click");
  ok("which says so", cancelled === 1);
  ok("and there is no cancel once it has finished", !find(sample, "screen__cancel"));

  let retried = 0;
  const bad = inspector.showScreening({ error: "CelesTrak returned 403 for active" }, { ...noop, onRun: () => (retried += 1) });
  const words = textOf(bad).join(" ");
  ok("a failure says what happened in words", /The catalogue did not answer/.test(words), words.slice(0, 80));
  ok("and what to do about it", /another go/.test(words));
  ok("drawn as a clear sky is, not as a fault", Boolean(find(bad, "screen__none")));
  ok("with no stack trace under it", !/403/.test(words));
  const retry = find(bad, "screen__retry");
  ok("and a button sized to itself", Boolean(retry) && !find(bad, "detail__new"));
  retry.dispatch("click");
  ok("which runs it again", retried === 1);
  ok("the way out is still there when it failed", Boolean(find(bad, "backlink--screen")));

  const modelled = inspector.showScreening({ error: "The fleet on screen is modelled rather than tracked" }, noop);
  ok("a modelled fleet is explained rather than retried", /not tracked/.test(textOf(modelled).join(" ")));
  ok("and offers no button that cannot help", !find(modelled, "screen__retry"));
}

{
  const { Chat } = await import("../src/orbital/ui.js");
  const root = new El("div");
  const log = new El("ul");
  const form = new El("form");
  const input = new El("input");
  root.querySelector = (sel) =>
    ({ "[data-chat-log]": log, "[data-chat-form]": form, "[data-chat-input]": input })[sel] ?? null;
  const chat = new Chat(root, { onSend() {} });

  ok("an empty log still has the idle mark in it", Boolean(find(log, "chat__idle")));
  ok("with the art in a child, since a container cannot style itself", Boolean(find(log, "chat__idle-art")));

  chat.push("you", "hello");
  ok("and it stays last as messages arrive", log.children.at(-1) === chat.idle);
  chat.push("agent", "hello back");
  ok("still last", log.children.at(-1) === chat.idle);

  globalThis.getComputedStyle = () => ({ paddingTop: "16px", paddingBottom: "16px" });
  const withMark = chat.naturalHeight();
  chat.idle.remove();
  ok("and it is not counted in the drag ceiling", chat.naturalHeight() === withMark, `${chat.naturalHeight()} vs ${withMark}`);
}

console.log(failures ? `\n${failures} failed` : "\nall green");
process.exit(failures ? 1 : 0);
