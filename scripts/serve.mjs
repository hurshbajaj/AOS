import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chooseProvider, relay } from "./llm.mjs";
import { Accounts } from "./api.mjs";

try {
  for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
    }
  }
} catch {
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = Number(process.env.PORT ?? 5173);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

const PAGES = new Map([
  ["/", "/index.html"],
  ["/console", "/orbital.html"],
  ["/profile", "/profile.html"],
  ["/core", "/core.html"],
  ["/device", "/device.html"],
]);

const MOVED = new Map([
  ["/index.html", "/"],
  ["/orbital.html", "/console"],
  ["/profile.html", "/profile"],
  ["/core.html", "/core"],
  ["/device.html", "/device"],
]);

const tidy = (pathname) => pathname.replace(/\/+$/, "") || "/";

async function resolveFile(pathname) {
  const target = normalize(join(ROOT, decodeURIComponent(pathname)));
  if (!target.startsWith(ROOT)) {
    return null;
  }
  const info = await stat(target).catch(() => null);
  if (info?.isDirectory()) {
    return resolveFile(join(pathname, "index.html"));
  }
  return info ? { path: target, size: info.size } : null;
}

const json = (response, status, body) =>
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(body));

async function chat(request, response, probe) {
  const provider = chooseProvider();
  if (probe) {
    json(response, 200, {
      ready: Boolean(provider),
      provider: provider?.id ?? null,
      model: provider?.model ?? null,
      accepts: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"],
    });
    return;
  }
  if (!provider) {
    json(response, 503, { error: "No model configured. Set one of ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, GEMINI_API_KEY or OPENROUTER_API_KEY and restart." });
    return;
  }

  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) {
      json(response, 413, { error: "Too large." });
      return;
    }
  }
  try {
    const reply = await relay(JSON.parse(body), provider, {
      onRetry: ({ attempt, delay, reason }) =>
        console.log(`[aos] ${provider.id} said ${reason}; retrying in ${Math.round(delay)}ms (attempt ${attempt})`),
    });
    json(response, 200, reply);
  } catch (error) {
    console.error("[aos] relay failed:", error.message);
    json(response, 502, { error: String(error.message ?? error) });
  }
}

async function missing(request, response) {
  const wantsPage = String(request.headers.accept ?? "").includes("text/html");
  const page = wantsPage ? await resolveFile("/404.html") : null;
  if (!page) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }
  response.writeHead(404, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  createReadStream(page.path).pipe(response);
}

const CATALOGUE_DIR = new URL("../data/catalogue/", import.meta.url);
const CATALOGUE_SOURCE = "https://celestrak.org/NORAD/elements/gp.php";
const CATALOGUE_FRESH_MS = 2 * 60 * 60 * 1000;
const CATALOGUE_GROUPS = new Set([
  "gps-ops", "starlink", "geo", "active",
  "cosmos-2251-debris", "fengyun-1c-debris", "iridium-33-debris", "cosmos-1408-debris",
]);

async function catalogue(request, response, group) {
  if (!CATALOGUE_GROUPS.has(group)) {
    json(response, 404, { error: "No such catalogue group." });
    return;
  }
  const file = new URL(`${group}.tle`, CATALOGUE_DIR);
  const held = await readFile(file, "utf8").catch(() => null);
  const age = await stat(file).then((info) => Date.now() - info.mtimeMs).catch(() => Infinity);

  if (held && age < CATALOGUE_FRESH_MS) {
    response
      .writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache", "X-Catalogue-Age": String(Math.round(age / 1000)) })
      .end(held);
    return;
  }

  try {
    const fresh = await fetch(`${CATALOGUE_SOURCE}?GROUP=${group}&FORMAT=tle`, { signal: AbortSignal.timeout(25000) });
    const text = fresh.ok ? await fresh.text() : null;
    if (text && text.includes("\n1 ")) {
      await mkdir(CATALOGUE_DIR, { recursive: true });
      await writeFile(file, text);
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache", "X-Catalogue-Age": "0" }).end(text);
      return;
    }
    if (!held) {
      throw new Error(`CelesTrak answered ${fresh.status}`);
    }
    console.log(`[aos] ${group}: CelesTrak said ${fresh.status}, serving the copy from ${Math.round(age / 60000)} min ago`);
  } catch (error) {
    if (!held) {
      json(response, 502, { error: `Could not reach the catalogue: ${error.message}` });
      return;
    }
    console.log(`[aos] ${group}: ${error.message}, serving the copy from ${Math.round(age / 60000)} min ago`);
  }
  response
    .writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache", "X-Catalogue-Age": String(Math.round(age / 1000)) })
    .end(held);
}

async function contract(response) {
  const tar = spawn("tar", ["-czf", "-", "-C", new URL("../core/", import.meta.url).pathname, "aos-sim"]);
  response.writeHead(200, {
    "Content-Type": "application/gzip",
    "Content-Disposition": 'attachment; filename="aos-sim.tar.gz"',
    "Cache-Control": "no-store",
  });
  tar.stdout.pipe(response);
  tar.on("error", () => response.destroy());
  tar.stderr.on("data", (chunk) => console.log(`[aos] aos-sim.tar.gz: ${chunk}`));
}

const REFERENCE = {
  "aos-sim": {
    dir: new URL("../core/aos-sim/src/", import.meta.url),
    note: "The contract itself: every type and trait a script may use.",
  },
  examples: {
    dir: new URL("../examples/", import.meta.url),
    note: "Worked scripts, each one showing a different part of the contract.",
  },
};

async function referenceList(response) {
  const out = [];
  for (const [group, { dir, note }] of Object.entries(REFERENCE)) {
    for (const name of (await readdir(dir)).sort()) {
      if (!name.endsWith(".rs") && !name.endsWith(".md")) {
        continue;
      }
      const text = await readFile(new URL(name, dir), "utf8");
      out.push({
        file: `${group}/${name}`,
        group,
        note,
        bytes: Buffer.byteLength(text),
        lines: text.split("\n").length,
        summary: summarise(text),
      });
    }
  }
  json(response, 200, { files: out });
}

function summarise(text) {
  const lines = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(?:\/\/!?|\/\/\/)\s?(.*)$/.exec(line);
    if (!match) {
      break;
    }
    if (!match[1].trim() && lines.length) {
      break;
    }
    lines.push(match[1].trim());
  }
  return lines.join(" ").slice(0, 300);
}

async function referenceFile(response, group, name, searchParams) {
  const where = REFERENCE[group];
  if (!where || !(await readdir(where.dir)).includes(name)) {
    json(response, 404, { error: "No such reference file." });
    return;
  }
  const text = await readFile(new URL(name, where.dir), "utf8");
  const all = text.split("\n");
  const from = Math.max(1, Number(searchParams.get("from")) || 1);
  const count = Math.min(600, Math.max(1, Number(searchParams.get("lines")) || 400));
  const slice = all.slice(from - 1, from - 1 + count);
  json(response, 200, {
    file: `${group}/${name}`,
    from,
    to: from - 1 + slice.length,
    lines: all.length,
    more: from - 1 + slice.length < all.length,
    text: slice.join("\n"),
  });
}

const accounts = new Accounts();

createServer(async (request, response) => {
  const { pathname, searchParams } = new URL(request.url, "http://localhost");
  if (pathname === "/api/chat") {
    await chat(request, response, searchParams.has("probe") || request.method === "GET");
    return;
  }
  if (pathname === "/api/scripting/aos-sim.tar.gz") {
    await contract(response);
    return;
  }
  if (pathname === "/api/scripting/reference") {
    await referenceList(response);
    return;
  }
  const page = /^\/api\/scripting\/reference\/([a-z-]+)\/([A-Za-z0-9_.-]+)$/.exec(pathname);
  if (page) {
    await referenceFile(response, page[1], page[2], searchParams);
    return;
  }
  const wanted = /^\/api\/catalogue\/([a-z0-9-]{1,40})$/.exec(pathname);
  if (wanted) {
    await catalogue(request, response, wanted[1]);
    return;
  }
  if (pathname.startsWith("/api/")) {
    if (await accounts.handle(request, response, pathname)) {
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" }).end('{"error":"No such endpoint."}');
    return;
  }
  const moved = MOVED.get(pathname);
  if (moved) {
    const query = searchParams.toString();
    response
      .writeHead(301, { Location: query ? `${moved}?${query}` : moved, "Cache-Control": "no-store" })
      .end();
    return;
  }

  const file = await resolveFile(PAGES.get(tidy(pathname)) ?? pathname);
  if (!file) {
    await missing(request, response, pathname);
    return;
  }
  const headers = {
    "Content-Type": TYPES[extname(file.path)] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
  };
  const range = /bytes=(\d*)-(\d*)/.exec(request.headers.range ?? "");
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), file.size - 1) : file.size - 1;
    response.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${file.size}`, "Content-Length": end - start + 1 });
    createReadStream(file.path, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, { ...headers, "Content-Length": file.size });
  createReadStream(file.path).pipe(response);
}).listen(PORT, () => {
  const provider = chooseProvider();
  console.log(`AOS running at http://localhost:${PORT}`);
  console.log(provider ? `Sybil: ${provider.id} / ${provider.model}` : "Sybil: no API key set — the chat falls back to its keyword parser");
  console.log(process.env.GOOGLE_CLIENT_ID ? "Google sign-in: configured" : "Google sign-in: off — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
  console.log(process.env.SMTP_HOST ? `Mail: ${process.env.SMTP_HOST}` : "Mail: off — verification links print here on the terminal");
});
