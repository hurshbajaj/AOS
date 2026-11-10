
const BLACK = "#07090c";
const CARD = "#101318";
const HAIR = "#262b33";
const WHITE = "#ffffff";
const MUTED = "#9aa3ad";
const DIM = "#767e88";
const AMBER = "#ffc34d";

const FACE = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const escape = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export const subjectFor = (code) => `${code} is your AOS confirmation code`;

export function plain({ name, code, kind, minutes, to }) {
  return [
    `${name},`,
    "",
    `${code} is your AOS confirmation code.`,
    "",
    kind === "alt"
      ? "Type it into the profile page to add this address to your account."
      : "Type it into the profile page to confirm this address.",
    "",
    `Expires    in ${minutes} minutes`,
    "Uses       once",
    `Address    ${to}`,
    "",
    "If you did not ask for it, nothing has happened that you need to undo --",
    "ignore this and the address stays unconfirmed.",
    "",
    "AOS — Autonomous Orbital Sentinel",
  ].join("\n");
}

const STAR_COUNT = 260;

const sequence = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const STARS = (() => {
  let next = sequence(0x4a05);
  const roll = () => {
    const value = next();
    next = sequence(Math.floor(value * 0xffffffff));
    return value;
  };
  const span = (low, high) => low + roll() * (high - low);
  const out = [];
  for (let index = 0; index < STAR_COUNT; index += 1) {
    const x = span(0, 100).toFixed(2);
    const y = span(0, 100).toFixed(2);
    const r = span(0.4, 1.3).toFixed(2);
    const a = span(0.18, 0.85).toFixed(2);
    out.push(`radial-gradient(${r}px ${r}px at ${x}% ${y}%,rgba(255,255,255,${a}) 50%,rgba(255,255,255,0) 100%)`);
  }
  return out.join(",");
})();

const detail = (key, value) => `
            <tr>
              <td style="padding:0 0 9px;font-family:${FACE};font-size:10px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:${DIM};white-space:nowrap;">${key}</td>
              <td style="padding:0 0 9px 18px;font-family:${FACE};font-size:13px;color:#d5dae0;" align="right">${value}</td>
            </tr>`;

export function html({ name, code, kind, minutes, to }) {
  const safeName = escape(name);
  const safeCode = escape(code);
  const safeTo = escape(to);
  const initials = escape(
    String(name ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0].toUpperCase())
      .join(""),
  );
  const line =
    kind === "alt"
      ? "Type it into the profile page to add this address to your account."
      : "Type it into the profile page to confirm this address.";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${safeCode} is your AOS confirmation code</title>
</head>
<body style="margin:0;padding:0;background:${BLACK};">
<div itemscope itemtype="https://schema.org/EmailMessage" style="display:none;max-height:0;overflow:hidden;">
  <meta itemprop="description" content="AOS confirmation code ${safeCode}">
</div>
<div style="display:none;max-height:0;overflow:hidden;color:${BLACK};">${safeCode} is your AOS confirmation code.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BLACK};background-image:${STARS};padding:48px 16px;">
  <tr>
    <td align="center">

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:400px;background-color:${CARD};border:1px solid ${HAIR};border-radius:18px;">

        <!-- The rail's head: monogram, name, organisation. -->
        <tr>
          <td style="padding:24px 24px 0;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td width="46" style="padding:0 12px 0 0;">
                  <table role="presentation" width="46" cellpadding="0" cellspacing="0" border="0" style="width:46px;height:46px;background-color:#191e25;border:1px solid ${HAIR};border-radius:23px;">
                    <tr>
                      <td align="center" height="44" style="font-family:${FACE};font-size:15px;font-weight:800;color:${WHITE};">${initials || "AOS"}</td>
                    </tr>
                  </table>
                </td>
                <td>
                  <p style="margin:0;font-family:${FACE};font-size:15px;font-weight:800;letter-spacing:-0.2px;color:${WHITE};">${safeName}</p>
                  <p style="margin:2px 0 0;font-family:${FACE};font-size:12px;color:${DIM};">AOS &middot; Autonomous Orbital Sentinel</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- The pill, in the shade the console uses for something pending. -->
        <tr>
          <td style="padding:16px 24px 0;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding:4px 11px;background-color:#2a2314;border:1px solid #4a3d1c;border-radius:999px;font-family:${FACE};font-size:9px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:${AMBER};">
                  Unconfirmed
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <tr><td style="padding:20px 24px 0;"><div style="height:1px;background-color:${HAIR};line-height:1px;font-size:0;">&nbsp;</div></td></tr>

        <!-- The message. -->
        <tr>
          <td style="padding:18px 24px 0;">
            <p style="margin:0;font-family:${FACE};font-size:19px;font-weight:800;letter-spacing:-0.3px;line-height:1.3;color:${WHITE};">
              Here is your code
            </p>
            <p style="margin:8px 0 0;font-family:${FACE};font-size:13px;line-height:1.6;color:#aab2bb;">${line}</p>
          </td>
        </tr>

        <!-- The code. Narrower than the panel it sits in, which is what
             makes it read as the one thing on the page to act on. The inset
             is on the cell's padding rather than the table's width, because
             Outlook resolves a percentage width against the wrong box. -->
        <tr>
          <td style="padding:18px 44px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#171b21;border:1px solid #30363f;border-radius:12px;">
              <tr>
                <td align="center" style="padding:13px 10px;font-family:${MONO};font-size:31px;font-weight:700;letter-spacing:22px;text-indent:22px;color:${WHITE};">${safeCode}</td>
              </tr>
            </table>
          </td>
        </tr>

        <tr><td style="padding:20px 24px 0;"><div style="height:1px;background-color:${HAIR};line-height:1px;font-size:0;">&nbsp;</div></td></tr>

        <!-- The details, as the rail lists them. -->
        <tr>
          <td style="padding:16px 24px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${detail("Expires", `in ${minutes} minutes`)}${detail("Uses", "once")}${detail("Address", safeTo)}
            </table>
          </td>
        </tr>

        <tr>
          <td style="padding:6px 24px 24px;">
            <p style="margin:0;font-family:${FACE};font-size:11px;line-height:1.6;color:#5f6771;">
              If you did not ask for this, nothing has happened that you need to undo. Ignore it and the address stays unconfirmed.
            </p>
          </td>
        </tr>
      </table>

      <p style="margin:18px 0 0;font-family:${FACE};font-size:10px;letter-spacing:1.4px;text-transform:uppercase;color:#434a53;">
        <!-- The tooltip's spark, as near as mail will allow. It is drawn
             there from an SVG behind a mask; Gmail strips SVG and refuses
             data: URIs, so the glyph is stretched vertically instead, which
             is the tapering the shape is really about. A client that ignores
             transforms gets an unstretched star rather than nothing. -->
        <span style="display:inline-block;transform:scaleY(1.45);-webkit-transform:scaleY(1.45);font-size:9px;color:#6f7884;">&#10022;</span>
        &nbsp;&nbsp;AOS&nbsp;&nbsp;|&nbsp;&nbsp;Code requested for email verification
      </p>
    </td>
  </tr>
</table>
</body>
</html>`;
}
