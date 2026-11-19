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
  xvfb x11vnc novnc websockify tmux curl ca-certificates

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
set -g mouse on
set -g history-limit 50000
EOF
chmod 0644 /root/.tmux.conf

# --- browser launcher -------------------------------------------------------
install -d -m 0700 "$CHROME_DIR"
cat >/usr/local/bin/cage-browser-start <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
export DISPLAY=:99
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp &
for _ in $(seq 1 100); do
  [ -S /tmp/.X11-unix/X99 ] && break
  sleep 0.1
done
x11vnc -display :99 -localhost -rfbport 5900 -nopw -shared -forever &
websockify --web /usr/share/novnc 127.0.0.1:6080 localhost:5900 &
exec google-chrome \
  --no-sandbox \
  --disable-gpu \
  --user-data-dir=/root/.chrome-cage \
  --lang=en-US \
  --no-first-run \
  --no-default-browser-check \
  --kiosk \
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
