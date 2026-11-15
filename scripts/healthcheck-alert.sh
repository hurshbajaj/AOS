#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${ENV_FILE:-/home/hursh/Proj/aos/deploy/aos-alert.env}"
STATE_FILE="${STATE_FILE:-/tmp/aos-health.state}"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

URL="${URL:-http://127.0.0.1:5173/}"
TO="${TO:-}"
FROM="${FROM:-}"
SMTP_HOST="${SMTP_HOST:-}"
SMTP_PORT="${SMTP_PORT:-587}"
SMTP_USER="${SMTP_USER:-}"
SMTP_PASS="${SMTP_PASS:-}"
HOSTNAME_LABEL="${HOSTNAME_LABEL:-$(hostname)}"

if curl -fsS --max-time 10 "$URL" >/dev/null 2>&1; then
  echo ok > "$STATE_FILE"
  exit 0
fi

if [ "$(cat "$STATE_FILE" 2>/dev/null || echo ok)" = "down" ]; then
  exit 0
fi
echo down > "$STATE_FILE"

if [ -z "$TO" ] || [ -z "$FROM" ] || [ -z "$SMTP_HOST" ] || [ -z "$SMTP_USER" ] || [ -z "$SMTP_PASS" ]; then
  echo "[$(date -Is)] ALERT: health check failed for $URL ($HOSTNAME_LABEL) but mail is not configured" >&2
  exit 0
fi

python3 - "$URL" "$TO" "$FROM" "$SMTP_HOST" "$SMTP_PORT" "$SMTP_USER" "$SMTP_PASS" "$HOSTNAME_LABEL" <<'PY'
import smtplib, ssl, sys
from email.message import EmailMessage
url,to,from_addr,host,port,user,password,label = sys.argv[1:9]
msg = EmailMessage()
msg["Subject"] = f"AOS alert: site check failed ({label})"
msg["From"] = from_addr
msg["To"] = to
msg.set_content(f"Health check failed for {url} on {label}. Check: systemctl status aos cloudflared-aos (or cloudflared) and logs.")
ctx = ssl.create_default_context()
with smtplib.SMTP(host, int(port), timeout=20) as s:
    s.starttls(context=ctx)
    s.login(user, password)
    s.send_message(msg)
PY
