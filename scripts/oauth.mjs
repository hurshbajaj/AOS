
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const TIMEOUT_MS = 15000;

export const configured = (env = process.env) =>
  Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

export const settings = (env = process.env) => ({
  clientId: env.GOOGLE_CLIENT_ID ?? "",
  clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
  redirectUri: env.GOOGLE_REDIRECT_URI ?? `http://localhost:${env.PORT ?? 5173}/api/auth/google/callback`,
});

export function authUrl({ clientId, redirectUri }, state) {
  const url = new URL(AUTH);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  }).toString();
  return url.toString();
}

export async function exchange(code, config, fetcher = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetcher(TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: "authorization_code",
      }).toString(),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error_description || body.error || `Google returned ${response.status}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export function decode(jwt) {
  const part = String(jwt).split(".")[1];
  if (!part) {
    throw new Error("not a token");
  }
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

export function claims(idToken, { clientId }, now = Date.now()) {
  const payload = decode(idToken);
  if (!ISSUERS.has(payload.iss)) {
    throw new Error(`id_token from an unexpected issuer: ${payload.iss}`);
  }
  if (payload.aud !== clientId) {
    throw new Error("id_token was issued for a different application");
  }
  if (!payload.exp || payload.exp * 1000 < now) {
    throw new Error("id_token has expired");
  }
  if (!payload.sub) {
    throw new Error("id_token carries no subject");
  }
  if (!payload.email) {
    throw new Error("Google did not share an email address");
  }
  if (payload.email_verified === false) {
    throw new Error("Google has not verified that address");
  }
  const email = String(payload.email).toLowerCase();
  return {
    sub: payload.sub,
    email,
    name: payload.name || email.split("@")[0],
    picture: payload.picture ?? null,
    domain: payload.hd ?? null,
  };
}
