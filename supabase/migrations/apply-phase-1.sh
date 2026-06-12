#!/usr/bin/env bash
# Apply all Phase 1 social migrations in order.
# Usage: ./apply-phase-1.sh "$DATABASE_URL"
set -euo pipefail

DB_URL="${1:?Usage: $0 DATABASE_URL}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PHASE_DIR="$SCRIPT_DIR/phase-1-social"

if ! command -v psql >/dev/null 2>&1; then
  echo "Error: psql not found. Install PostgreSQL client or use Supabase MCP apply_migration." >&2
  exit 1
fi

echo "Applying Phase 1 migrations to database..."
for dir in $(find "$PHASE_DIR" -mindepth 1 -maxdepth 1 -type d | sort); do
  up="$dir/up.sql"
  if [[ -f "$up" ]]; then
    name="$(basename "$dir")"
    echo "  → $name"
    psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$up"
  fi
done
echo "Done. Applied all up.sql files in $PHASE_DIR"
