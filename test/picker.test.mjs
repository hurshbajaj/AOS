
import { El, install, textOf } from "./dom-shim.mjs";

install();

const { Inspector } = await import("../src/orbital/ui.js");

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

const KINDS = [
  { id: "flare", name: "Solar flare", glyph: "✸", colour: "#ffb067", blurb: "Ionospheric absorption." },
  {
    id: "rain",
    name: "Rain fade",
    glyph: "⟋",
    colour: "#8fb8ff",
    blurb: "Hydrometeor absorption.",
    scripted: true,
  },
];

const root = new El("div");
const inspector = new Inspector(root);

{
  const picked = [];
  let away = 0;
  inspector.showPicker(KINDS, (id) => picked.push(id), () => (away += 1));

  const options = all(root, "picker__option");
  ok("every kind is offered", options.length === 2);
  ok("the console's own and the operator's alike", /Solar flare/.test(words(root)) && /Rain fade/.test(words(root)));

  const tags = all(root, "picker__from");
  ok("a scripted kind says where it came from", tags.length === 1);
  ok("and the console's own kinds do not", !options[0].querySelector(".picker__from"));

  options[1].dispatch("click");
  ok("picking one injects that kind", picked.join() === "rain", picked.join());

  ok("the footer says it can be tuned afterwards", /tune it afterwards/.test(words(root)));
  ok("and does not tell anyone to drag a slider", !/drag/i.test(words(root)));

  ok("there is a way out when none of these is the thing", /Looking for something else/.test(words(root)));
  find(root, "picker__away-go").dispatch("click");
  ok("which goes to Core", away === 1);
}

{
  inspector.showPicker(KINDS, () => {});
  ok("and none is drawn when there is nowhere to go", !find(root, "picker__away"));
}

console.log(failures ? `\n${failures} failed` : "\nall good");
process.exitCode = failures ? 1 : 0;
