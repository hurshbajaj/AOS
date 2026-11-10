
import { randomBytes, randomInt, randomUUID, scrypt as scryptCb, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

const COST = { N: 2 ** 16, r: 8, p: 1, keylen: 32, maxmem: 160 * 1024 * 1024 };
const SESSION_DAYS = 30;
const VERIFY_MINUTES = 5;

export const LIMITS = {
  email: 254,
  name: 80,
  org: 80,
  phone: 32,
  notes: 500,
  password: [10, 200],
};

const trim = (value) => (typeof value === "string" ? value.trim() : "");

const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const PHONE = /^[0-9+()\-. \/]+$/;

export function check(input, { password = true } = {}) {
  const fields = {
    email: trim(input.email).toLowerCase(),
    name: trim(input.name),
    org: trim(input.org),
    phone: trim(input.phone),
    notes: trim(input.notes),
  };
  const errors = {};

  if (!fields.email) {
    errors.email = "An email address is needed.";
  } else if (fields.email.length > LIMITS.email || !EMAIL.test(fields.email)) {
    errors.email = "That does not look like an email address.";
  }
  if (!fields.name) {
    errors.name = "A name is needed.";
  } else if (fields.name.length > LIMITS.name) {
    errors.name = `Names stop at ${LIMITS.name} characters.`;
  }
  if (!fields.org) {
    errors.org = "An organisation is needed.";
  } else if (fields.org.length > LIMITS.org) {
    errors.org = `Organisation names stop at ${LIMITS.org} characters.`;
  }
  if (fields.phone && (fields.phone.length > LIMITS.phone || !PHONE.test(fields.phone))) {
    errors.phone = "Digits, spaces and + ( ) - only.";
  }
  if (fields.notes.length > LIMITS.notes) {
    errors.notes = `Notes stop at ${LIMITS.notes} characters.`;
  }

  if (password) {
    const [min, max] = LIMITS.password;
    const value = typeof input.password === "string" ? input.password : "";
    if (value.length < min) {
      errors.password = `At least ${min} characters.`;
    } else if (value.length > max) {
      errors.password = `At most ${max} characters.`;
    }
  }

  return { fields, errors, ok: Object.keys(errors).length === 0 };
}

export const orgKey = (org) => String(org ?? "").trim().toLowerCase();

export function checkEmail(value) {
  const email = trim(value).toLowerCase();
  if (!email) {
    return { email, error: "An email address is needed." };
  }
  if (email.length > LIMITS.email || !EMAIL.test(email)) {
    return { email, error: "That does not look like an email address." };
  }
  return { email, error: null };
}

export async function hash(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, COST.keylen, COST);
  return ["scrypt", COST.N, COST.r, COST.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verify(password, stored) {
  const parts = String(stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const [, N, r, p, salt, expected] = parts;
  const want = Buffer.from(expected, "base64url");
  let got;
  try {
    got = await scrypt(password, Buffer.from(salt, "base64url"), want.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: COST.maxmem,
    });
  } catch {
    return false;
  }
  return got.length === want.length && timingSafeEqual(got, want);
}

export function code() {
  const value = String(randomInt(0, 1_000_000)).padStart(6, "0");
  return { code: value, token_hash: fingerprint(value) };
}

export const CONFIRM = { digits: 6, attempts: 10 };

export function mint() {
  const token = randomBytes(32).toString("base64url");
  return { token, token_hash: fingerprint(token) };
}

export const fingerprint = (token) => createHash("sha256").update(String(token)).digest("hex");

export const userId = () => `usr_${randomUUID().replaceAll("-", "").slice(0, 20)}`;

const iso = (date) => date.toISOString();
const plus = (ms, from = Date.now()) => new Date(from + ms);

export const sessionExpiry = (from) => iso(plus(SESSION_DAYS * 86400_000, from));
export const verifyExpiry = (from) => iso(plus(VERIFY_MINUTES * 60_000, from));
export const VERIFY_MINUTES_VALUE = VERIFY_MINUTES;
export const SESSION_MAX_AGE = SESSION_DAYS * 86400;

export const THROTTLE = { limit: 8, windowMs: 15 * 60_000 };

export function throttled(row, now = Date.now()) {
  if (!row) {
    return false;
  }
  return row.count >= THROTTLE.limit && new Date(row.until).getTime() > now;
}

export const throttleUntil = (now = Date.now()) => iso(plus(THROTTLE.windowMs, now));

export const publicUser = (row) =>
  row && {
    id: row.id,
    email: row.email,
    name: row.name,
    org: row.org,
    phone: row.phone ?? "",
    notes: row.notes ?? "",
    verified: Boolean(row.verified),
    altEmail: row.alt_email ?? "",
    altVerified: Boolean(row.alt_verified),
    joined: row.created_at,
  };
