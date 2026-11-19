# Operations

Day-to-day operation of one host, one gateway, one cage. The app is the front
end; the commands below are the manual equivalents for recovery.

## Health check

Run the app's check (or the equivalent probes) after any change:

- egress IPv4 **and** IPv6 equal the node's exit, not the host's;
- DNS answers are `198.18.0.0/16` (fake-ip);
- STUN/QUIC probes on UDP 3478/19302 get no reply;
- `192.168.122.1` and the host LAN are unreachable from the cage;
- stopping mihomo makes the cage offline (proves fail-closed).

A check that cannot prove an item is a failure, not a warning.

## Changing the proxy node

The app's proxy flow is: drain -> switch -> verify -> start -> done, with
`rollback` if verification fails and `offline` if rollback also fails.

1. **Preflight the new node from the host** (not from the cage): the server
   must be reachable over the expected address family and the credentials must
   be valid. IPv6-only nodes need working host IPv6.
2. **Switch in the app.** The confirmation dialog requires typing the instance
   name; this is deliberate friction for an operation that can cut the guest
   off.
3. **Watch the events.** `verifying` checks the exit IP, DNS, and node
   liveness. Do not start work in the cage while it runs.
4. **Re-run the full check** after `done`.

### Risks

- **All in-flight connections reset.** mihomo restarts with the new config, so
  every TCP flow through the gateway is dropped: downloads, installs, API
  calls, SSH sessions that originate in the cage.
- **tmux sessions survive; terminals do not.** Processes inside tmux keep
  running in the cage, but the app's PTY channels close. Reopen a terminal and
  `tmux attach`. Anything not under tmux is lost.
- **A bad node means an offline cage, not a direct path.** If verification
  fails the app rolls back; if rollback fails it reports `offline`. There is no
  fallback to the host's network. Fix the node or restore the old one.
- **Node changes do not stop VMs.** Only a stop/re-provision does, and that
  loses tmux sessions and unsaved in-memory browser state (the disk, including
  `/root/.chrome-cage`, persists unless the disk is recreated).
- **Not reversible for time.** Switching back restores the config, not
  connections that were cut.

### Manual rollback

If the app cannot roll back, on the gateway:

```bash
ssh gw@192.168.122.50
sudo cp /etc/mihomo/config.yaml /root/config.bad
# restore the last known-good render, then:
sudo systemctl restart mihomo
sudo systemctl status mihomo --no-pager
sudo nft list table inet gw
```

Then confirm from the cage that egress is the node and DNS is fake-ip. If
mihomo will not start, leave it stopped: the redirect ports stay closed, which
is the safe state, but the cage is offline until it is fixed.

## Start / stop

- `instanceStart` / `instanceStop` control the cage (and the gateway as a
  dependency). Stopping the gateway takes the cage offline; stopping the cage
  ends its tmux sessions.
- `virsh shutdown` is graceful; a hung guest may need `virsh destroy`, which
  risks filesystem corruption inside the guest. Use it as a last resort.
- The gateway recovers its nft rules and mode at boot (`gw-mode.service`); the
  cage boots IPv4-only via netplan and cloud-init.

## Address-family notes

The reference cage image is IPv4-only (`disable_ipv6=1`) and has only a static
`10.99.0.2/24` route. The gateway always speaks IPv6 to an IPv6-only node; that
is independent of what the cage sees. If a cage image is changed to dual-stack,
`gw-mode v6` on the gateway adds `fdfd:99::1/64` to `eth1` and enables mihomo's
IPv6 DNS answers; it does not open any additional traffic path.

## Audit log

What happened, in order:

| Where | Contents |
|---|---|
| app log, `~/Library/Application Support/TNYC Agent KVM/logs/app.log` (macOS), `~/.config/TNYC Agent KVM/logs/app.log` (Linux), `%APPDATA%\TNYC Agent KVM\logs\app.log` (Windows) | every RPC call and result, provision steps, proxy steps, check results, agent stderr |
| gateway: `journalctl -u mihomo` | core start/stop, config errors, dial failures |
| gateway: `journalctl -u gw-mode` | nft reloads and mode at boot |
| host: `journalctl -u libvirtd`, `virsh` | VM lifecycle |

The agent keeps no log of its own; its stderr is captured by the app. Check
results include exit IPs and timestamps — treat the log as sensitive. Rotate it
if it grows; the app appends one line per event.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Cage exits with the home/ISP IP | mihomo fell back to `DIRECT` (no `GLOBAL` group, or config not reloaded) | verify `GLOBAL -> EXIT` and that no group lists `DIRECT`; restart mihomo; re-run check |
| DNS answers are real IPs, not `198.18.x.x` | DNS not redirected, or mihomo DNS disabled | `nft list table inet gw` (53 -> 1053); check `dns.enable` |
| Cage online while mihomo is stopped | a forward accept or masquerade exists | remove it; load `assets/nft/gateway.nft` again; this is a leak |
| Cage has no network at all | mihomo down, node unreachable, or nft not loaded | `systemctl status mihomo`; `journalctl -u mihomo`; check node from host |
| `ssh root@10.99.0.2` hangs | stale host key, or wrong user (non-root) | `ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new root@10.99.0.2`; clear `known_hosts` |
| Browser view blank | `cage-browser` not running, or websockify/x11vnc died | `systemctl status cage-browser`; `journalctl -u cage-browser`; check `ss -ltn` in the cage |
| Chrome will not start as root | missing `--no-sandbox` | re-run `assets/guest/bootstrap.sh`; flags live in `/usr/local/bin/cage-browser-start` |
| Gateway's own egress mirrors the desktop proxy | host policy routing captured forwarded VM traffic | ensure the `iif virbr0` rules/tables on the host; re-apply the host relay |
| `Start TUN listening error ... table 2022` | more than one mihomo TUN on the host | the gateway must keep `tun.enable: false`; move any other TUN off this host |
| Guest bootstrap apt fails | no egress: gateway or DNS is down | fix the gateway first; this is fail-closed behaviour, not a bootstrap bug |
| `websockify` fails: port in use | another instance of the browser stack | `systemctl restart cage-browser`; check for a stray `websockify` |
| VM boots with no address | netplan not applied, or MAC/interface name mismatch | `ip -br a`; `netplan apply`; check the cloud-init netplan file |

## Upgrading

The app uploads a new `agent.cjs` on connect; it is stateless, so an upgrade is
a reconnect. Gateway changes (nft, mihomo config, `gw-mode`) are applied by the
app on provision/switch; hand edits on the gateway are lost on the next
provision. Keep the node secret out of shell history and the repo.
