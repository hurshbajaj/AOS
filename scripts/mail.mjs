
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TIMEOUT_MS = 20000;
const b64 = (value) => Buffer.from(String(value), "utf8").toString("base64");

const header = (value) => String(value ?? "").replace(/[\r\n]+/g, " ").trim();

const encodeSubject = (subject) => {
  const clean = header(subject);
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${b64(clean)}?=`;
};

const body = (value) => String(value).split(/\r?\n/).map((line) => (line.startsWith(".") ? `.${line}` : line));

export function message({ from, to, subject, text, html, name = "AOS" }) {
  const head = [
    `From: ${header(name)} <${header(from)}>`,
    `To: <${header(to)}>`,
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@aos.local>`,
    "MIME-Version: 1.0",
  ];

  if (!html) {
    return `${[...head, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit", "", ...body(text)].join("\r\n")}\r\n.\r\n`;
  }

  const boundary = `aos-${randomUUID()}`;
  const lines = [
    ...head,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    ...body(text),
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    ...body(html),
    "",
    `--${boundary}--`,
  ];
  return `${lines.join("\r\n")}\r\n.\r\n`;
}

export function* conversation({ host, from, to, user, pass, starttls, body }) {
  yield { expect: 220, what: "greeting" };
  yield { send: `EHLO ${header(host)}`, expect: 250 };
  if (starttls) {
    yield { send: "STARTTLS", expect: 220 };
    yield { upgrade: true };
    yield { send: `EHLO ${header(host)}`, expect: 250 };
  }
  if (user) {
    yield { send: "AUTH LOGIN", expect: 334 };
    yield { send: b64(user), expect: 334, secret: true };
    yield { send: b64(pass), expect: 235, secret: true };
  }
  yield { send: `MAIL FROM:<${header(from)}>`, expect: 250 };
  yield { send: `RCPT TO:<${header(to)}>`, expect: 250 };
  yield { send: "DATA", expect: 354 };
  yield { send: body, expect: 250, raw: true };
  yield { send: "QUIT", expect: 221, lenient: true };
}

export const statusOf = (reply) => Number(/^(\d{3})/.exec(reply)?.[1] ?? 0);

export const complete = (buffer) => /^\d{3} [^\n]*\r?\n$|\n\d{3} [^\n]*\r?\n$/.test(buffer);

export const config = (env = process.env) => {
  const host = env.SMTP_HOST;
  if (!host) {
    return null;
  }
  const port = Number(env.SMTP_PORT ?? 465);
  return {
    host,
    port,
    implicit: port === 465,
    user: env.SMTP_USER ?? "",
    pass: env.SMTP_PASS ?? "",
    from: env.MAIL_FROM ?? env.SMTP_USER ?? `aos@${host}`,
  };
};

function talk(socket, steps, { onUpgrade }) {
  return new Promise((resolve, reject) => {
    let current = socket;
    let buffer = "";
    let step = steps.next();
    let done = false;

    const fail = (error) => {
      if (!done) {
        done = true;
        current.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const finish = () => {
      if (!done) {
        done = true;
        current.end();
        resolve();
      }
    };

    const advance = () => {
      step = steps.next();
      if (step.done) {
        finish();
        return;
      }
      if (step.value.upgrade) {
        current.removeAllListeners("data");
        current = onUpgrade(current);
        attach(current);
        advance();
        return;
      }
      if (step.value.send !== undefined) {
        current.write(step.value.raw ? step.value.send : `${step.value.send}\r\n`);
      }
    };

    const attach = (sock) => {
      sock.setTimeout(TIMEOUT_MS, () => fail(new Error("the mail server stopped responding")));
      sock.on("error", fail);
      sock.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (!complete(buffer)) {
          return;
        }
        const reply = buffer;
        buffer = "";
        const status = statusOf(reply);
        const expected = step.value?.expect;
        if (expected && status !== expected && !step.value.lenient) {
          fail(new Error(`SMTP ${status} at ${step.value.what ?? step.value.send?.slice(0, 12) ?? "?"}: ${reply.trim()}`));
          return;
        }
        advance();
      });
    };

    attach(current);
  });
}

export async function send({ to, subject, text, html }, settings) {
  const payload = message({ from: settings.from, to, subject, text, html });
  const socket = settings.implicit
    ? tlsConnect({ host: settings.host, port: settings.port, servername: settings.host })
    : netConnect({ host: settings.host, port: settings.port });

  const steps = conversation({
    host: "aos",
    from: settings.from,
    to,
    user: settings.user,
    pass: settings.pass,
    starttls: !settings.implicit,
    body: payload,
  });

  await talk(socket, steps, {
    onUpgrade: (plain) =>
      tlsConnect({ socket: plain, servername: settings.host }),
  });
}

export async function deliverable(email, { lookup, timeout = 4000 } = {}) {
  const domain = String(email).split("@")[1];
  if (!domain) {
    return { ok: false, reason: "That does not look like an address." };
  }
  const resolveMx = lookup ?? (await import("node:dns/promises")).resolveMx;
  try {
    const records = await Promise.race([
      resolveMx(domain),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeout)),
    ]);
    if (Array.isArray(records) && records.length > 0) {
      return { ok: true };
    }
    return { ok: false, reason: `Nothing at ${domain} can receive mail. Check the spelling.` };
  } catch (error) {
    if (error.code === "ENOTFOUND" || error.code === "ENODATA" || error.code === "NXDOMAIN") {
      return { ok: false, reason: `Nothing at ${domain} can receive mail. Check the spelling.` };
    }
    return { ok: true, unverified: true };
  }
}

const MAIL_DIR = fileURLToPath(new URL("../data/mail/", import.meta.url));

export async function deliver(letter, env = process.env) {
  const settings = config(env);
  if (settings) {
    await send(letter, settings);
    return { sent: true, via: `${settings.host}:${settings.port}` };
  }

  mkdirSync(MAIL_DIR, { recursive: true });
  const stamp = `${Date.now()}-${letter.to.replace(/[^a-z0-9]+/gi, "-")}`;
  const file = `${MAIL_DIR}${stamp}.txt`;
  writeFileSync(file, `To: ${letter.to}\nSubject: ${letter.subject}\n\n${letter.text}\n`);
  if (letter.html) {
    writeFileSync(`${MAIL_DIR}${stamp}.html`, letter.html);
  }
  console.log(`\n[aos] No SMTP_HOST set, so nothing was emailed. The message for ${letter.to}:\n`);
  console.log(letter.text.split("\n").map((line) => `       ${line}`).join("\n"));
  console.log(`\n[aos] Also written to ${file}\n`);
  return { sent: false, via: "console" };
}
