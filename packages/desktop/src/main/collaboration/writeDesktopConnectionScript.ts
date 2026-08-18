/** Host-side script packed into the self-host zip. Prints only the output path. */
export const writeDesktopConnectionScript = `#!/bin/sh
set -eu
cd "$(dirname "$0")"

if [ ! -f .operator-token ]; then
  echo "write-desktop-connection: missing .operator-token" >&2
  exit 1
fi
if [ ! -f server.json ]; then
  echo "write-desktop-connection: missing server.json" >&2
  exit 1
fi

chmod 600 .operator-token 2>/dev/null || true

ORIGIN=$(python3 - <<'PY'
import json
from pathlib import Path
config = json.loads(Path("server.json").read_text())
origin = None
transport = config.get("transport")
if isinstance(transport, dict):
    origin = transport.get("advertisedOrigin")
if not origin:
    origin = config.get("publicUrl")
if not isinstance(origin, str) or not origin:
    raise SystemExit("write-desktop-connection: advertised origin missing")
print(origin if origin.endswith("/") else origin + "/")
PY
)

BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT
HTTP=$(curl -sS -o "$BODY" -w "%{http_code}" -X POST "\${ORIGIN}api/v1/setup-codes" -H "Authorization: Bearer $(cat .operator-token)" -H "Content-Type: application/json" --connect-timeout 10 --max-time 30 -d '{"schemaVersion":"workspace-setup/v1","purpose":"device_session"}')

if [ "$HTTP" != "201" ]; then
  echo "write-desktop-connection: setup-codes HTTP $HTTP" >&2
  python3 - "$BODY" <<'PY'
import json, sys
from pathlib import Path
raw = Path(sys.argv[1]).read_text()
try:
    data = json.loads(raw)
except json.JSONDecodeError:
    print("write-desktop-connection: non-json error body", file=sys.stderr)
    raise SystemExit(1)
err = data.get("error") if isinstance(data, dict) else None
print("write-desktop-connection: " + str(err or "request failed"), file=sys.stderr)
raise SystemExit(1)
PY
fi

python3 - "$BODY" "$ORIGIN" <<'PY'
import json, os, sys
from pathlib import Path
resp = json.loads(Path(sys.argv[1]).read_text())
code = resp.get("setupCode")
if not isinstance(code, str) or not code.startswith("pw_setup_"):
    raise SystemExit("write-desktop-connection: setup code missing")
origin = sys.argv[2]
text = "planweave-server-setup/v1:" + json.dumps({
    "serverBaseUrl": origin,
    "setupCode": code,
    "allowInsecureTransport": False,
}, separators=(",", ":")) + chr(10)
path = Path(".setup-handoff.txt")
path.write_text(text)
os.chmod(path, 0o600)
print("Wrote " + str(path.resolve()) + " (" + str(path.stat().st_size) + " bytes). Paste that file into PlanWeave Desktop → Settings → Server.")
PY
`;
