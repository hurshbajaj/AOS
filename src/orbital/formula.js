
export const FUNCTIONS = {
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  exp: Math.exp,
  ln: Math.log,
  log10: Math.log10,
  pow: Math.pow,
  floor: Math.floor,
  ceil: Math.ceil,
  round: (value, places = 0) => {
    const scale = 10 ** places;
    return Math.round(value * scale) / scale;
  },
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  hypot: Math.hypot,
  sign: Math.sign,
  clamp: (value, low, high) => Math.min(Math.max(value, low), high),
  if: null,
};

export const CONSTANTS = {
  pi: Math.PI,
  e: Math.E,
  true: 1,
  false: 0,
};

const OPERATORS = ["<=", ">=", "==", "!=", "&&", "||", "+", "-", "*", "/", "%", "^", "<", ">"];

const BINDING = {
  "||": [1, 2],
  "&&": [3, 4],
  "==": [5, 6],
  "!=": [5, 6],
  "<": [7, 8],
  ">": [7, 8],
  "<=": [7, 8],
  ">=": [7, 8],
  "+": [9, 10],
  "-": [9, 10],
  "*": [11, 12],
  "/": [11, 12],
  "%": [11, 12],
  "^": [16, 15],
};

export class FormulaError extends Error {}

export function tokenise(source) {
  const text = String(source ?? "");
  const tokens = [];
  let at = 0;

  while (at < text.length) {
    const char = text[at];

    if (/\s/.test(char)) {
      at += 1;
      continue;
    }

    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(text[at + 1] ?? ""))) {
      const match = /^[0-9]*\.?[0-9]+(e[+-]?[0-9]+)?/i.exec(text.slice(at));
      tokens.push({ type: "number", value: Number(match[0]) });
      at += match[0].length;
      continue;
    }

    if (/[a-z_]/i.test(char)) {
      const match = /^[a-z_][a-z0-9_.]*/i.exec(text.slice(at));
      tokens.push({ type: "name", value: match[0] });
      at += match[0].length;
      continue;
    }

    if (char === "(" || char === ")" || char === ",") {
      tokens.push({ type: char });
      at += 1;
      continue;
    }

    const operator = OPERATORS.find((candidate) => text.startsWith(candidate, at));
    if (operator) {
      tokens.push({ type: "operator", value: operator });
      at += operator.length;
      continue;
    }

    throw new FormulaError(`I do not know what "${char}" means, at character ${at + 1}.`);
  }

  return tokens;
}

export function parse(source) {
  const tokens = tokenise(source);
  let at = 0;
  const peek = () => tokens[at];
  const take = () => tokens[at++];

  const expect = (type, what) => {
    const token = take();
    if (!token || token.type !== type) {
      throw new FormulaError(`Expected ${what}.`);
    }
    return token;
  };

  const unit = () => {
    const token = take();
    if (!token) {
      throw new FormulaError("The formula stops in the middle of itself.");
    }
    if (token.type === "number") {
      return { type: "number", value: token.value };
    }
    if (token.type === "operator" && (token.value === "-" || token.value === "+")) {
      return { type: "negate", sign: token.value === "-" ? -1 : 1, argument: expression(13) };
    }
    if (token.type === "(") {
      const inner = expression(0);
      expect(")", "a closing bracket");
      return inner;
    }
    if (token.type === "name") {
      if (peek()?.type === "(") {
        take();
        const args = [];
        if (peek()?.type !== ")") {
          for (;;) {
            args.push(expression(0));
            if (peek()?.type === ",") {
              take();
              continue;
            }
            break;
          }
        }
        expect(")", "a closing bracket");
        return { type: "call", name: token.value, args };
      }
      return { type: "name", name: token.value };
    }
    throw new FormulaError(`"${token.value ?? token.type}" cannot start a term.`);
  };

  const expression = (power) => {
    let left = unit();
    for (;;) {
      const next = peek();
      if (!next || next.type !== "operator") {
        break;
      }
      const binding = BINDING[next.value];
      if (!binding || binding[0] < power) {
        break;
      }
      take();
      left = { type: "binary", operator: next.value, left, right: expression(binding[1]) };
    }
    return left;
  };

  const tree = expression(0);
  if (at < tokens.length) {
    throw new FormulaError("There is something left over at the end of the formula.");
  }
  return tree;
}

export function dependencies(tree) {
  const found = new Set();
  const walk = (node) => {
    if (!node) {
      return;
    }
    if (node.type === "name" && !(node.name in CONSTANTS)) {
      found.add(node.name);
    }
    if (node.type === "call") {
      node.args.forEach(walk);
    }
    if (node.type === "binary") {
      walk(node.left);
      walk(node.right);
    }
    if (node.type === "negate") {
      walk(node.argument);
    }
  };
  walk(tree);
  return [...found];
}

const APPLY = {
  "+": (a, b) => a + b,
  "-": (a, b) => a - b,
  "*": (a, b) => a * b,
  "/": (a, b) => a / b,
  "%": (a, b) => a % b,
  "^": (a, b) => a ** b,
  "<": (a, b) => (a < b ? 1 : 0),
  ">": (a, b) => (a > b ? 1 : 0),
  "<=": (a, b) => (a <= b ? 1 : 0),
  ">=": (a, b) => (a >= b ? 1 : 0),
  "==": (a, b) => (a === b ? 1 : 0),
  "!=": (a, b) => (a !== b ? 1 : 0),
  "&&": (a, b) => (a && b ? 1 : 0),
  "||": (a, b) => (a || b ? 1 : 0),
};

export function evaluate(tree, lookup) {
  const resolve = (node) => {
    switch (node.type) {
      case "number":
        return node.value;
      case "negate":
        return node.sign * resolve(node.argument);
      case "name": {
        if (node.name in CONSTANTS) {
          return CONSTANTS[node.name];
        }
        const value = lookup(node.name);
        if (value === undefined || value === null) {
          throw new FormulaError(`Nothing is called "${node.name}".`);
        }
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new FormulaError(`"${node.name}" is not a number I can work with.`);
        }
        return value;
      }
      case "call": {
        if (node.name === "if") {
          if (node.args.length !== 3) {
            throw new FormulaError("if takes three things: a test, and what to do either way.");
          }
          return resolve(node.args[resolve(node.args[0]) ? 1 : 2]);
        }
        const fn = FUNCTIONS[node.name];
        if (typeof fn !== "function") {
          throw new FormulaError(`There is no function called ${node.name}.`);
        }
        return fn(...node.args.map(resolve));
      }
      case "binary":
        return APPLY[node.operator](resolve(node.left), resolve(node.right));
      default:
        throw new FormulaError("I could not read that formula.");
    }
  };

  const answer = resolve(tree);
  if (!Number.isFinite(answer)) {
    throw new FormulaError("That works out to something that is not a number.");
  }
  return answer;
}

export const compute = (source, lookup) => evaluate(parse(source), lookup);
