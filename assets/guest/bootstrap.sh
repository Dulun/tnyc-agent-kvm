#!/usr/bin/env bash
# cage bootstrap: browser stack for the isolated guest.
#
# Idempotent. Run as root inside the cage:
#   bootstrap.sh           install + enable, do not start
#   bootstrap.sh --start   install + enable + (re)start
set -euo pipefail

START=0
if [ "${1:-}" = "--start" ]; then
  START=1
elif [ -n "${1:-}" ]; then
  echo "usage: $0 [--start]" >&2
  exit 2
fi

[ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 1; }

DISPLAY_NUM=:99
NODE_TZ=America/Los_Angeles
NODE_LANG=en_US.UTF-8
ln -sf "/usr/share/zoneinfo/$NODE_TZ" /etc/localtime 2>/dev/null || true
echo "$NODE_TZ" > /etc/timezone 2>/dev/null || true
NOVNC_WEB=/usr/share/novnc
export DEBIAN_FRONTEND=noninteractive

# --- packages ---------------------------------------------------------------
apt-get update -qq
apt-get install -y --no-install-recommends \
  tigervnc-standalone-server openbox novnc websockify tmux curl ca-certificates \
  fonts-noto-color-emoji fonts-dejavu-core fonts-liberation

# --- Google Chrome stable ---------------------------------------------------
if ! command -v google-chrome >/dev/null 2>&1; then
  [ "$(dpkg --print-architecture)" = "amd64" ] || {
    echo "Chrome deb is amd64-only; this guest is $(dpkg --print-architecture)" >&2
    exit 1
  }
  deb=$(mktemp --suffix=.deb)
  trap 'rm -f "$deb"' EXIT
  curl -fsSL -o "$deb" \
    https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  apt-get install -y "$deb"
  rm -f "$deb"
  trap - EXIT
fi

# --- tmux -------------------------------------------------------------------
cat >/root/.tmux.conf <<'EOF'
# Mouse mode would route the wheel into tmux copy-mode, where typing is silently
# swallowed; the app's terminal handles scrolling locally instead.
set -g mouse off
set -g history-limit 50000
set -g status off
EOF
chmod 0644 /root/.tmux.conf

# --- fonts ----------------------------------------------------------------
# A Linux desktop without a colour emoji font renders emoji as blank boxes,
# which fingerprint tests score heavily ("emoji style"). Ship the real ones and
# rebuild the font cache so Chrome sees them.
fc-cache -f >/dev/null 2>&1 || true

# --- browser launcher -------------------------------------------------------
cat >/usr/local/bin/cage-browser-start <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
export DISPLAY=:99
PROFILE_FILE=/root/.cage-profile
profile="$(cat "$PROFILE_FILE" 2>/dev/null || echo cage)"
CHROME_DIR="/root/.chrome-$profile"
mkdir -p "$CHROME_DIR"
# Xvnc (not Xvfb+x11vnc) because it implements SetDesktopSize: noVNC can then
# resize the guest desktop to the pane, which is the only way the picture is
# pixel-exact instead of a scaled-down 1080p frame. openbox makes Chrome follow
# that resize (a bare X server has no window manager to re-maximise it).
if ! pgrep -x Xvnc >/dev/null 2>&1; then
  # Migration: an earlier build ran Xvfb+x11vnc on :99; they must go or Xvnc
  # cannot bind the display.
  pkill -f 'Xvfb :99' 2>/dev/null || true
  pkill -x x11vnc 2>/dev/null || true
  sleep 0.5
  rm -f /tmp/.X11-unix/X99 /tmp/.X99-lock 2>/dev/null || true
  Xvnc :99 -geometry 1920x1080 -depth 24 -rfbport 5900 -localhost \
    -SecurityTypes None -AlwaysShared -AcceptSetDesktopSize &
fi
for _ in $(seq 1 100); do
  [ -e /tmp/.X11-unix/X99 ] && break
  sleep 0.1
done
pgrep -x openbox >/dev/null 2>&1 || openbox --sm-disable >/dev/null 2>&1 &
pgrep -f 'websockify --web' >/dev/null 2>&1 || websockify --web /usr/share/novnc 127.0.0.1:6080 localhost:5900 &
exec google-chrome \
  --no-sandbox \
  --test-type \
  --disable-gpu \
  --disable-dev-shm-usage \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --disable-blink-features=AutomationControlled \
  --user-data-dir="$CHROME_DIR" \
  --lang=en-US \
  --no-first-run \
  --no-default-browser-check \
  --start-maximized \
  --force-device-scale-factor=2 \
  about:blank
EOF
chmod 0755 /usr/local/bin/cage-browser-start

cat >/usr/local/bin/cage-profile <<'PF'
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
  [ -f "$REG" ] || : > "$REG"
  # adopt profiles that already exist on disk (created before the registry)
  for d in /root/.chrome-*; do
    [ -d "$d" ] || continue
    id=${d#/root/.chrome-}
    grep -q "^$id|" "$REG" 2>/dev/null || printf '%s|%s\n' "$id" "$id" >> "$REG"
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
PF
chmod 0755 /usr/local/bin/cage-profile

# --- unit -------------------------------------------------------------------
cat >/etc/systemd/system/cage-browser.service <<'EOF'
[Unit]
Description=Cage browser stack (Xvfb :99, Chrome kiosk, x11vnc, noVNC)
After=network.target

[Service]
Type=simple
Environment=HOME=/root
Environment=TZ=America/Los_Angeles
Environment=LANG=en_US.UTF-8
ExecStart=/usr/local/bin/cage-browser-start
Restart=on-failure
RestartSec=2
KillMode=control-group

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable cage-browser.service >/dev/null

if [ "$START" -eq 1 ]; then
  systemctl restart cage-browser.service
  echo "cage-browser started; noVNC on 127.0.0.1:6080, VNC on localhost:5900 (no password)"
else
  echo "cage-browser enabled; start it with: systemctl start cage-browser"
fi
