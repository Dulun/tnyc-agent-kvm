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
CHROME_DIR=/root/.chrome-cage
NOVNC_WEB=/usr/share/novnc
export DEBIAN_FRONTEND=noninteractive

# --- packages ---------------------------------------------------------------
apt-get update -qq
apt-get install -y --no-install-recommends \
  tigervnc-standalone-server openbox novnc websockify tmux curl ca-certificates

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

# --- browser launcher -------------------------------------------------------
install -d -m 0700 "$CHROME_DIR"
cat >/usr/local/bin/cage-browser-start <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
export DISPLAY=:99
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
  --user-data-dir=/root/.chrome-cage \
  --lang=en-US \
  --no-first-run \
  --no-default-browser-check \
  --start-maximized \
  about:blank
EOF
chmod 0755 /usr/local/bin/cage-browser-start

# --- unit -------------------------------------------------------------------
cat >/etc/systemd/system/cage-browser.service <<'EOF'
[Unit]
Description=Cage browser stack (Xvfb :99, Chrome kiosk, x11vnc, noVNC)
After=network.target

[Service]
Type=simple
Environment=HOME=/root
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
