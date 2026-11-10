
import { paint, tokenise } from "../src/core/highlight.js";

let failures = 0;
const ok = (label, pass, detail = "") => {
  console.log(`  ${pass ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!pass) failures += 1;
};

const kinds = (source) => tokenise(source).map((t) => t.kind);
const textOf = (source, kind) => tokenise(source).find((t) => t.kind === kind)?.text;

{
  const sources = [
    'fn main() { let x = "hi"; }',
    "// just a comment",
    "/* /* nested */ */ let a = 1;",
    'r#"raw "quoted" string"#',
    "impl<'a> Trait for &'a str {}",
    "#[derive(Debug)]\nstruct X;",
    "let n = 6.674e-11f64;",
    "",
    "\n\n\n",
    "λ // non-ascii",
  ];
  let intact = true;
  for (const source of sources) {
    const back = tokenise(source).map((t) => t.text).join("");
    if (back !== source) {
      intact = false;
      ok("round-trips", false, `${JSON.stringify(source)} -> ${JSON.stringify(back)}`);
    }
  }
  ok("every character survives tokenising, once and in order", intact);
}

{
  const nasty = 'let s = "</span><img src=x onerror=alert(1)>";';
  const html = paint(nasty);
  ok("angle brackets never reach the page as markup", !/<img/.test(html));
  ok("and are escaped rather than dropped", html.includes("&lt;img"));
  ok("ampersands too", paint("let a = b & c;").includes("&amp;"));
  ok("including inside a comment", !/<b>/.test(paint("// <b>bold</b>")));
}

{
  ok("a lifetime is a lifetime", kinds("&'a str").includes("lifetime"));
  ok("and is not left open as a string", !kinds("&'a str").includes("string"));
  const after = tokenise("impl<'a> Trait for &'a str { fn f() {} }");
  ok("so the rest of the line still tokenises", after.some((t) => t.kind === "keyword" && t.text === "fn"));

  ok("a character literal is a string", textOf("let c = 'x';", "string") === "'x'");
  ok("an escaped one too", textOf("let c = '\\n';", "string") === "'\\n'");
  ok("and a lifetime in a where clause is not", !kinds("where T: 'static").includes("string"));
}

{
  ok("a raw string holds its own quotes", textOf('r#"he said "no" to it"#', "string") === 'r#"he said "no" to it"#');
  ok("a plain raw string works", textOf('r"C:\\path"', "string") === 'r"C:\\path"');
  ok("and r on its own is still an identifier", !kinds("let r = 1;").includes("string"));
  ok("an escaped quote does not end a string early", textOf('"a \\" b"', "string") === '"a \\" b"');
}

{
  const source = "/* outer /* inner */ still outer */ fn f() {}";
  ok("a nested comment closes at the right place", textOf(source, "comment") === "/* outer /* inner */ still outer */");
  ok("and the code after it is code again", kinds(source).includes("keyword"));
  ok("an unterminated one swallows the rest rather than throwing", tokenise("/* never closed").length === 1);
}

{
  ok("keywords are keywords", kinds("pub fn go() {}").slice(0, 3).join() === "keyword,plain,keyword");
  ok("a call is marked", kinds("go()").includes("call"));
  ok("a macro keeps its bang", textOf("println!(\"x\")", "macro") === "println!");
  ok("but != is not a macro", !kinds("if a != b {}").includes("macro"));
  ok("a type by its capital", textOf("let v: Vec<Geo> = x;", "type") === "Vec");
  ok("an attribute is one token", textOf("#[derive(Debug)]", "attribute") === "#[derive(Debug)]");
  ok("a nested attribute too", textOf('#[cfg_attr(x, serde(rename = "A"))]', "attribute") === '#[cfg_attr(x, serde(rename = "A"))]');
  ok("an inner attribute as well", textOf("#![no_std]", "attribute") === "#![no_std]");

  ok("numbers with separators and suffixes", textOf("let n = 1_000u32;", "number") === "1_000u32");
  ok("and with exponents", textOf("let g = 6.674e-11f64;", "number") === "6.674e-11f64");
  ok("but a range is not one number", textOf("for i in 0..10 {}", "number") === "0");
  ok("and subtraction is not part of a number", tokenise("1-2").filter((t) => t.kind === "number").length === 2);
}

{
  ok("a trailing newline keeps its line", paint("let a = 1;\n").endsWith(" "));
  ok("and one that does not end in a newline is left alone", !paint("let a = 1;").endsWith(" "));
}

console.log(failures ? `\n${failures} failed` : "\nall good");
process.exitCode = failures ? 1 : 0;
