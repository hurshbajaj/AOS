
const KEYWORDS = new Set([
  "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern",
  "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub",
  "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true", "type", "union",
  "unsafe", "use", "where", "while", "box", "macro_rules",
]);

const PRIMITIVES = new Set([
  "bool", "char", "f32", "f64", "i8", "i16", "i32", "i64", "i128", "isize",
  "str", "u8", "u16", "u32", "u64", "u128", "usize",
  "String", "Vec", "Option", "Some", "None", "Result", "Ok", "Err", "Box",
]);

const isIdentStart = (c) => /[A-Za-z_]/.test(c);
const isIdent = (c) => /[A-Za-z0-9_]/.test(c);
const isDigit = (c) => /[0-9]/.test(c);

export function tokenise(source) {
  const out = [];
  const push = (kind, text) => {
    if (!text) {
      return;
    }
    const last = out[out.length - 1];
    if (last && last.kind === kind) {
      last.text += text;
    } else {
      out.push({ kind, text });
    }
  };

  let at = 0;
  const n = source.length;

  while (at < n) {
    const c = source[at];
    const next = source[at + 1];

    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", at);
      const stop = end === -1 ? n : end;
      push("comment", source.slice(at, stop));
      at = stop;
      continue;
    }
    if (c === "/" && next === "*") {
      let depth = 0;
      let i = at;
      while (i < n) {
        if (source[i] === "/" && source[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (source[i] === "*" && source[i + 1] === "/") {
          depth -= 1;
          i += 2;
          if (depth === 0) {
            break;
          }
        } else {
          i += 1;
        }
      }
      push("comment", source.slice(at, i));
      at = i;
      continue;
    }

    if (c === "#" && (next === "[" || (next === "!" && source[at + 2] === "["))) {
      let depth = 0;
      let i = at;
      while (i < n) {
        if (source[i] === "[") {
          depth += 1;
        } else if (source[i] === "]") {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            break;
          }
        }
        i += 1;
      }
      push("attribute", source.slice(at, i));
      at = i;
      continue;
    }

    if (c === "r" && (next === '"' || next === "#")) {
      let i = at + 1;
      let hashes = 0;
      while (source[i] === "#") {
        hashes += 1;
        i += 1;
      }
      if (source[i] === '"') {
        i += 1;
        const closer = `"${"#".repeat(hashes)}`;
        const end = source.indexOf(closer, i);
        const stop = end === -1 ? n : end + closer.length;
        push("string", source.slice(at, stop));
        at = stop;
        continue;
      }
    }

    if (c === '"' || (c === "b" && next === '"')) {
      let i = c === "b" ? at + 2 : at + 1;
      while (i < n) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      push("string", source.slice(at, i));
      at = i;
      continue;
    }

    if (c === "'") {
      const escaped = source[at + 1] === "\\";
      const closes = escaped
        ? source.indexOf("'", at + 2)
        : source[at + 2] === "'"
          ? at + 2
          : -1;
      if (closes !== -1 && closes - at <= 8) {
        push("string", source.slice(at, closes + 1));
        at = closes + 1;
        continue;
      }
      let i = at + 1;
      while (i < n && isIdent(source[i])) {
        i += 1;
      }
      push("lifetime", source.slice(at, i));
      at = i;
      continue;
    }

    if (isDigit(c)) {
      let i = at;
      while (i < n && /[0-9a-fA-FxXoObB_.+\-eE]/.test(source[i])) {
        if ((source[i] === "+" || source[i] === "-") && !/[eE]/.test(source[i - 1])) {
          break;
        }
        if (source[i] === "." && source[i + 1] === ".") {
          break;
        }
        i += 1;
      }
      while (i < n && isIdent(source[i])) {
        i += 1;
      }
      push("number", source.slice(at, i));
      at = i;
      continue;
    }

    if (isIdentStart(c)) {
      let i = at;
      while (i < n && isIdent(source[i])) {
        i += 1;
      }
      const word = source.slice(at, i);
      const after = source[i];
      let kind = "ident";
      if (KEYWORDS.has(word)) {
        kind = "keyword";
      } else if (PRIMITIVES.has(word)) {
        kind = "type";
      } else if (after === "!" && source[i + 1] !== "=") {
        kind = "macro";
        i += 1;
      } else if (/^[A-Z]/.test(word)) {
        kind = "type";
      } else if (after === "(") {
        kind = "call";
      }
      push(kind, source.slice(at, i));
      at = i;
      continue;
    }

    if (/\s/.test(c)) {
      let i = at;
      while (i < n && /\s/.test(source[i])) {
        i += 1;
      }
      push("plain", source.slice(at, i));
      at = i;
      continue;
    }

    push("punct", c);
    at += 1;
  }

  return out;
}

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

export function paint(source) {
  const html = tokenise(source)
    .map(({ kind, text }) => {
      const safe = text.replace(/[&<>]/g, (c) => ESCAPES[c]);
      return kind === "plain" ? safe : `<span class="t-${kind}">${safe}</span>`;
    })
    .join("");
  return source.endsWith("\n") ? `${html} ` : html;
}
