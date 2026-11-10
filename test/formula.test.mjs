
import { CONSTANTS, FormulaError, compute, dependencies, parse, tokenise } from "../src/orbital/formula.js";
import { Operator, checkName, prefer } from "../src/orbital/operator.js";
import { lines, search } from "../src/orbital/documents.js";

let failures = 0;
const ok = (label, pass, detail = "") => {
  console.log(`  ${pass ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!pass) failures += 1;
};
const near = (a, b, slack = 1e-9) => Math.abs(a - b) < slack;
const refuses = (source, env = {}) => {
  try {
    compute(source, (name) => env[name]);
    return null;
  } catch (error) {
    return error.message;
  }
};

{
  const env = { a: 3, b: 4, kp: 5.8 };
  const run = (source) => compute(source, (name) => env[name]);

  ok("it adds", run("1 + 2") === 3);
  ok("precedence is the usual one", run("2 + 3 * 4") === 14);
  ok("brackets override it", run("(2 + 3) * 4") === 20);
  ok("powers lean right, as in mathematics", run("2 ^ 3 ^ 2") === 512);
  ok("unary minus binds tighter than addition", run("-2 + 5") === 3);
  ok("but looser than a power", run("-2 ^ 2") === -4, String(run("-2 ^ 2")));
  ok("names come from the environment", run("a * b") === 12);
  ok("comparisons give one or nothing", run("a < b") === 1 && run("a > b") === 0);
  ok("and chain through and/or", run("a < b && kp > 5") === 1);
  ok("functions work", near(run("hypot(a, b)"), 5));
  ok("as do nested ones", near(run("round(sqrt(pow(a, 2) + pow(b, 2)), 1)"), 5));
  ok("pi and e are known", near(run("pi"), Math.PI) && near(run("e"), Math.E));
  ok("exponent notation parses", run("1.5e3") === 1500);

  env.zero = 0;
  ok("if does not evaluate the branch it did not take", run("if(zero != 0, a / zero, -1)") === -1);
  ok("and does evaluate the one it did", near(run("if(a != 0, b / a, -1)"), 4 / 3));

  const ship = { isp_s: 230, dry_mass_kg: 1200, propellant_kg: 310 };
  const deltaV = compute(
    "isp_s * 9.80665 * ln((dry_mass_kg + propellant_kg) / dry_mass_kg)",
    (name) => ship[name],
  );
  ok("the rocket equation comes out right", near(deltaV, 518.2938, 0.001), deltaV.toFixed(2));
}

{
  ok("no property access", Boolean(refuses("window.alert(1)")), refuses("window.alert(1)"));
  ok("no assignment", Boolean(refuses("x = 9", { x: 1 })));
  ok("no semicolons, so no second statement", Boolean(refuses("1; 2")));
  ok("no strings to smuggle anything in", Boolean(refuses('"hello"')));
  ok("no function it was not given", Boolean(refuses("fetch(1)")));
  ok("constructors are just unknown names", Boolean(refuses("constructor")));
  ok("an unknown name is refused, not treated as zero", Boolean(refuses("mystery")));
  ok("a name holding something other than a number is refused", Boolean(refuses("x + 1", { x: "9" })));
  ok("a trailing operator is a syntax error", Boolean(refuses("1 +")));
  ok("so is something left over", Boolean(refuses("1 2")));
  ok("an unclosed bracket is caught", Boolean(refuses("(1 + 2")));
  ok("and a result that is not finite is refused", Boolean(refuses("1 / 0")));
  ok("constants cannot be shadowed by the environment", compute("pi", () => 3) === CONSTANTS.pi);
  ok("the error is the kind callers can catch", refuses("@") !== null);
  ok("tokenising says where it gave up", /character 1/.test(refuses("@") ?? ""), refuses("@"));
}

{
  const deps = dependencies(parse("a + max(b, c * 2) - pi"));
  ok("every name a formula needs is found", deps.join(",") === "a,b,c", deps.join(","));
  ok("constants are not dependencies", !deps.includes("pi"));
  ok("function names are not dependencies either", !deps.includes("max"));
  ok("tokenise keeps dotted names whole", tokenise("sat.altitude_km")[0].value === "sat.altitude_km");
}

{
  const live = { kp: 5.8 };
  const op = new Operator({ readings: (name) => live[name] });

  ok("a name must be a name", Boolean(checkName("2fast").error) && checkName("dry_mass_kg").name === "dry_mass_kg");
  ok("and is folded to lower case", checkName("  Dry_Mass_KG ").name === "dry_mass_kg");

  op.setFact({ name: "dry_mass_kg", value: 1200, unit: "kg", source: "fleet-spec.csv line 4" });
  op.setFact({ name: "propellant_kg", value: 310, unit: "kg", source: "fleet-spec.csv line 5" });
  op.setFact({ name: "isp_s", value: 230, unit: "s", source: "engine-note.md line 12" });
  ok("facts are recorded", op.size.facts === 3);
  ok("with where they came from, which is the point", op.list().facts[0].source === "fleet-spec.csv line 4");

  op.setModel({
    name: "delta_v_ms",
    formula: "isp_s * 9.80665 * ln((dry_mass_kg + propellant_kg) / dry_mass_kg)",
    unit: "m/s",
  });
  ok("a model works out from its facts", near(op.value("delta_v_ms"), 518.2938, 0.001));

  op.setModel({ name: "storm_margin", formula: "clamp(9 - kp, 0, 9)", unit: "Kp" });
  ok("a model can read a live figure", near(op.value("storm_margin"), 3.2, 1e-9));
  live.kp = 2.1;
  ok("and is right again when that figure moves", near(op.value("storm_margin"), 6.9, 1e-9));

  op.setModel({ name: "doubled", formula: "delta_v_ms * 2" });
  ok("models can be built on models", near(op.value("doubled"), op.value("delta_v_ms") * 2));

  op.setModel({ name: "ouroboros", formula: "ouroboros + 1" });
  const circle = op.tryValue("ouroboros");
  ok("a model that depends on itself is caught", /circle/.test(circle.error ?? ""), circle.error);
  op.setModel({ name: "left", formula: "right + 1" });
  op.setModel({ name: "right", formula: "left + 1" });
  ok("and so is a longer loop", /depends on/.test(op.tryValue("left").error ?? ""), op.tryValue("left").error);
  ok("naming the chain, which is the only actionable form of it", /left depends on right depends on left/.test(op.tryValue("left").error));

  let refused = null;
  try {
    op.setFact({ name: "delta_v_ms", value: 1 });
  } catch (error) {
    refused = error.message;
  }
  ok("one name cannot be both a fact and a model", /already a model/.test(refused ?? ""), refused);

  let broken = null;
  try {
    op.setModel({ name: "bad", formula: "1 +" });
  } catch (error) {
    broken = error.message;
  }
  ok("a formula that will not parse is refused when written", Boolean(broken), broken);
  ok("not when it is asked for", !op.entry("bad"));

  const warned = op.setModel({ name: "early", formula: "not_yet_recorded * 2" });
  ok("depending on something not recorded yet is a warning", warned.missing.join() === "not_yet_recorded");
  ok("not a refusal, since it may be recorded next", Boolean(op.entry("early")));

  const listed = op.list();
  ok("the listing works out every model it can", listed.models.find((m) => m.name === "delta_v_ms").value > 0);
  ok("and reports the ones it cannot, rather than throwing", Boolean(listed.models.find((m) => m.name === "ouroboros").error));

  ok("a value can be forgotten", op.forget("doubled") && !op.entry("doubled"));
  ok("and forgetting something absent says so", op.forget("never_existed") === false);
}

{
  const op = new Operator({ readings: () => undefined });
  op.setFact({ name: "mass_kg", value: 900, unit: "kg", source: "spec.csv line 2" });
  op.setModel({ name: "half", formula: "mass_kg / 2", unit: "kg" });
  const saved = JSON.parse(JSON.stringify(op.capture()));
  ok("what is saved is plain JSON", typeof saved.models[0].formula === "string");
  ok("with no parse tree in it", saved.models[0].tree === undefined);

  const back = new Operator({ readings: () => undefined });
  back.restore(saved);
  ok("and it comes back working", back.value("half") === 450);
  ok("with its provenance intact", back.entry("mass_kg").source === "spec.csv line 2");

  back.restore({ facts: [{ name: "fine", value: 1 }, { name: "2bad", value: 2 }], models: [{ name: "nope", formula: "1 +" }] });
  ok("a saved row that breaks the rules is skipped, not fatal", Boolean(back.entry("fine")) && !back.entry("2bad") && !back.entry("nope"));
}

{
  const op = new Operator({ readings: () => undefined });
  const modelled = prefer(op, "propellant_ms", 58, "m/s");
  ok("with nothing recorded, the console's own figure stands", modelled.value === 58 && modelled.source === "modelled");

  op.setFact({ name: "propellant_ms", value: 41.2, unit: "m/s", source: "fleet-spec.csv line 41" });
  const theirs = prefer(op, "propellant_ms", 58, "m/s");
  ok("recorded, theirs wins", theirs.value === 41.2 && theirs.source === "operator");
  ok("and what it replaced is still reported", theirs.modelled === 58);
  ok("along with where it came from", theirs.from === "fleet-spec.csv line 41");

  op.forget("propellant_ms");
  op.setModel({ name: "propellant_ms", formula: "nothing_here + 1" });
  const broken = prefer(op, "propellant_ms", 58, "m/s");
  ok("a broken model falls back rather than failing", broken.value === 58 && broken.source === "modelled");
  ok("saying what is wrong with it", /broken/.test(broken.note ?? ""), broken.note);
}

{
  const csv = "name,dry_kg,prop_kg\nAOS-04,1200,310\nAOS-05,1180,298\nAOS-06,1205,301";
  ok("lines are counted the way an operator counts them", lines(csv).length === 4);
  const hits = search(csv, "AOS-05");
  ok("a search says which line", hits[0].line === 3, String(hits[0].line));
  ok("and shows the line either side, for context", hits[0].before === "AOS-04,1200,310" && hits[0].after === "AOS-06,1205,301");
  ok("case does not matter", search(csv, "aos-04").length === 1);
  ok("an empty search finds nothing rather than everything", search(csv, "   ").length === 0);
  ok("and a miss is simply empty", search(csv, "AOS-99").length === 0);
}

console.log(failures ? `\n${failures} failed` : "\nall green");
process.exit(failures ? 1 : 0);
