#!/usr/bin/env bash
# Browser profiles: `id` owns the Chrome user-data dir, `label` is display-only.
#   cage-profile list             -> "id|label" lines, then "--<current id>"
#   cage-profile create <id> <label>
#   cage-profile label <id> <label>   (no restart: it is only a name)
#   cage-profile use <id>             (restarts Chrome on the new profile)
set -euo pipefail
REG=/root/.cage-profiles
CUR=/root/.cage-profile

ensure_reg() {
  local d existing
  [ -f "$REG" ] || : > "$REG"
  # adopt profiles that already exist on disk (created before the registry)
  for d in /root/.chrome-*; do
    [ -d "$d" ] || continue
    existing=${d#/root/.chrome-}
    grep -q "^$existing|" "$REG" 2>/dev/null || printf '%s|%s\n' "$existing" "$existing" >> "$REG"
  done
  [ -s "$REG" ] || printf 'cage|cage\n' > "$REG"
  [ -f "$CUR" ] || echo cage > "$CUR"
}

case "${1:-list}" in
  list)
    ensure_reg
    cat "$REG"
    echo "--$(cat "$CUR")"
    ;;
  create)
    id="${2:?usage: cage-profile create <id> <label>}"
    label="${3:-$2}"
    [[ "$id" =~ ^[A-Za-z0-9._-]{1,32}$ ]] || { echo "invalid id" >&2; exit 2; }
    ensure_reg
    if grep -q "^$id|" "$REG"; then echo "profile exists" >&2; exit 2; fi
    printf '%s|%s\n' "$id" "$label" >> "$REG"
    mkdir -p "/root/.chrome-$id"
    echo "$id" > "$CUR"
    systemctl restart cage-browser
    ;;
  label)
    id="${2:?usage: cage-profile label <id> <label>}"
    label="${3:?label required}"
    ensure_reg
    grep -q "^$id|" "$REG" || { echo "unknown profile" >&2; exit 2; }
    # rewrites one line; the running browser keeps its dir, so no restart
    awk -F'|' -v id="$id" -v l="$label" 'BEGIN{OFS="|"} $1==id{$2=l} {print}' "$REG" > "$REG.tmp"
    mv "$REG.tmp" "$REG"
    ;;
  remove)
    id="${2:?usage: cage-profile remove <id>}"
    ensure_reg
    grep -q "^$id|" "$REG" || { echo "unknown profile" >&2; exit 2; }
    cur=$(cat "$CUR")
    if [ "$id" = "$cur" ]; then
      # Deleting the active profile: move to another one first (one restart),
      # then remove; refuse only when it is the last one left.
      other=$(awk -F'|' -v id="$id" '$1!=id {print $1; exit}' "$REG")
      [ -n "$other" ] || { echo "cannot remove the only profile" >&2; exit 3; }
      echo "$other" > "$CUR"
      mkdir -p "/root/.chrome-$other"
      systemctl restart cage-browser
      sleep 2
    fi
    awk -F'|' -v id="$id" '$1!=id' "$REG" > "$REG.tmp" && mv "$REG.tmp" "$REG"
    rm -rf "/root/.chrome-$id"
    ;;
  use)
    id="${2:?usage: cage-profile use <id>}"
    [[ "$id" =~ ^[A-Za-z0-9._-]{1,32}$ ]] || { echo "invalid id" >&2; exit 2; }
    ensure_reg
    grep -q "^$id|" "$REG" || { echo "unknown profile" >&2; exit 2; }
    echo "$id" > "$CUR"
    mkdir -p "/root/.chrome-$id"
    systemctl restart cage-browser
    ;;
  *) echo "usage: cage-profile [list|create|label|use]" >&2; exit 2 ;;
esac
