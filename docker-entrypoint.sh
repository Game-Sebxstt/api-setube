#!/bin/bash
set -e

COOKIES_FILE="/app/cookies.txt"

if [ -n "$YOUTUBE_COOKIES_JSON" ]; then
  echo "Convirtiendo YOUTUBE_COOKIES_JSON a cookies.txt (formato Netscape)..."
  python3 - <<'PYEOF'
import os, json

cookies_json = os.environ.get("YOUTUBE_COOKIES_JSON", "[]")
cookies = json.loads(cookies_json)

lines = ["# Netscape HTTP Cookie File", "# https://curl.haxx.se/rfc/cookie_spec.html", "# This is a generated file!  Do not edit.", ""]

for c in cookies:
    domain     = c.get("domain", "")
    # hostOnly false → accesible desde subdominios → flag TRUE en Netscape format
    host_only  = "FALSE" if c.get("hostOnly", False) else "TRUE"
    path       = c.get("path", "/")
    secure     = "TRUE" if c.get("secure", False) else "FALSE"
    expiry     = str(int(c.get("expirationDate", 0)))
    name       = c.get("name", "")
    value      = c.get("value", "")
    lines.append(f"{domain}\t{host_only}\t{path}\t{secure}\t{expiry}\t{name}\t{value}")

with open("/app/cookies.txt", "w") as f:
    f.write("\n".join(lines) + "\n")

print(f"cookies.txt generado con {len(cookies)} cookies.")
PYEOF
else
  echo "No se encontró YOUTUBE_COOKIES_JSON. yt-dlp operará sin cookies (puede haber limitaciones)."
fi

exec "$@"
