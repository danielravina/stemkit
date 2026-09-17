#!/usr/bin/env bash
# Install stats from the telemetry worker (one ping per install, ever).
# Token is read from STEMKIT_STATS_TOKEN, or from .stats-token next to this script.
set -euo pipefail

URL="${STEMKIT_STATS_URL:-https://stemkit-stats.danielravina.workers.dev/stats}"
HERE="$(cd "$(dirname "$0")" && pwd)"
TOKEN="${STEMKIT_STATS_TOKEN:-}"

if [ -z "$TOKEN" ] && [ -f "$HERE/.stats-token" ]; then
  TOKEN="$(tr -d '[:space:]' < "$HERE/.stats-token")"
fi

if [ -z "$TOKEN" ]; then
  echo "No token. Set STEMKIT_STATS_TOKEN or create telemetry-worker/.stats-token" >&2
  exit 1
fi

curl -sf -H "Authorization: Bearer $TOKEN" "${URL%/stats}/stats" |
  python3 -c '
import json, sys

d = json.load(sys.stdin)
daily = d.get("daily", [])
total = d["totalInstalls"]

print(f"total installs : {total}")
print("per OS         :", ", ".join(f"{k} {v}" for k, v in d.get("os", {}).items()) or "-")
print("per version    :", ", ".join(f"{k} {v}" for k, v in sorted(d.get("versions", {}).items())) or "-")
print()
print("installs per day (last 14)")
for x in daily[-14:]:
    date, fresh = x["date"], x["new"]
    print(f"  {date}  {fresh:>6}")
'
