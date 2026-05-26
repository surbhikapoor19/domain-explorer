#!/bin/bash
# Switch the active domain data for local dashboard testing.
#
# Usage:
#   ./scripts/switch-domain.sh motion_planning
#   ./scripts/switch-domain.sh grasp_planning
#
# This copies pre-built JSON from data-<domain>/ into data/ so the
# dashboard serves that domain. Build domain data first:
#   python -m scripts.precompute --domain domains/<domain>.yaml \
#          --output public/data-<domain>

set -e
cd "$(dirname "$0")/.."

DOMAIN="${1:?Usage: switch-domain.sh <domain_name>}"
SRC="public/data-${DOMAIN//_/-}"

if [ ! -d "$SRC" ]; then
  echo "Error: $SRC not found. Build it first:"
  echo "  python -m scripts.precompute --domain domains/${DOMAIN}.yaml --output $SRC"
  exit 1
fi

echo "Switching to domain: $DOMAIN"
echo "  Source: $SRC"

# Copy all JSON files (preserving existing non-JSON files like papers/)
# domain-config.json is already part of the precomputed output — no need
# to overwrite it with a stub.
cp "$SRC"/*.json public/data/ 2>/dev/null || true

echo "  Done. Restart dev server or refresh browser."
echo "  Active domain: $(python3 -c "import json; print(json.load(open('public/data/domain-config.json')).get('displayName','unknown'))" 2>/dev/null || echo "$DOMAIN")"
