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

**Everything must be powered off first.** The agent refuses the switch while the
cage or the gateway is running (`power off the cage and the gateway before
switching node`); there is no toggle that switches a live instance.

The app's proxy flow is: gate (all stopped) -> start the gateway -> switch ->
verify -> stop the gateway -> done, with `rollback` if verification fails and
`offline` if rollback also fails. The gateway runs only for the duration of the
switch: the config lives on its root filesystem and the delay test needs it
online. The cage — the only source of user traffic — stays down the whole time,
and the end state is "everything off".

1. **Preflight the new node from the host** (not from the cage): the server
   must be reachable over the expected address family and the credentials must
   be valid. IPv6-only nodes need working host IPv6.
2. **Stop the cage and the gateway in the app** (`stop` on the cage also stops
   the gateway).
3. **Switch in the app.** The confirmation dialog requires typing the instance
   name; this is deliberate friction for an operation that can cut the guest
   off. Save the node in the editor — it is stored with the host and prefills
   next time.
4. **Watch the events.** `starting` means the gateway is booting just to write
   the config; `verifying` checks the exit IP, DNS, and node liveness.
5. **Start the cage and re-run the full check** after `done`.

### Risks

- **The cage is off, so nothing of yours is running.** tmux sessions inside
  the cage end with the guest; unsaved in-memory state is gone.
- **The gateway is restarted twice** (once to write the config, once when you
  start it again): its own connections do not survive.
- **A bad node means an offline cage, not a direct path.** If verification
  fails the app rolls back; if rollback fails it reports `offline`. There is no
  fallback to the host's network. Fix the node or restore the old one.
- **Disks are untouched.** Only a delete-with-disks removes an overlay; the
  base image is never deleted.
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
- **Delete** (`instance.delete`) shuts the instance down if needed, `virsh
  undefine --nvram`s the cage and gateway domains, and only removes that
  instance's qcow2 overlays when 连同磁盘删除 is checked. Base/cloud images are
  never touched, and a delete is not undoable.
- `virsh shutdown` is graceful; a hung guest may need `virsh destroy`, which
  risks filesystem corruption inside the guest. Use it as a last resort.
- The gateway recovers its nft rules and mode at boot (`gw-mode.service`); the
  cage boots IPv4-only via netplan and cloud-init.
- **IPv6 for the gateway is libvirt's job**: the `default` network carries
  `<ip family='ipv6' address='fd00:3c6a:484c:c7ee:122::1' prefix='64'/>` and
  `<nat ipv6='yes'/>`, so libvirt owns the ULA, IPv6 forwarding and the NAT66
  masquerade. There is no host relay unit and no `iif virbr0` policy table.
  Needs libvirt >= 6.5.

## Address-family notes

The reference cage image is IPv4-only (`disable_ipv6=1`) and has only a static
`10.99.0.2/24` route. The gateway always speaks IPv6 to an IPv6-only node; that
is independent of what the cage sees. If a cage image is changed to dual-stack,
`gw-mode v6` on the gateway adds `fdfd:99::1/64` to `eth1` and enables mihomo's
IPv6 DNS answers; it does not open any additional traffic path.

## Images and the app proxy

- **Download** happens in the app, not on the host: the HTTP(S) request goes
  through the app-level proxy (设定 → 本软件代理), the finished file is uploaded
  and `mv`d into `/var/lib/libvirt/images` by the agent. A `.part` file never
  becomes a bootable image, and a failed download leaves nothing behind.
- **Choose or type a path**: the provision form lists images already in
  `/var/lib/libvirt/images` and takes a custom absolute path. Anyone can point
  it at a base image that already exists — provisioning overlays on top of the
  chosen image instead of copying it.
- **The app proxy is not the node proxy.** It only affects this software's own
  traffic (image downloads, app HTTP). The cage's traffic always goes through
  the gateway's mihomo node; the app proxy never touches it.

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
| Gateway has no IPv6 / cannot reach the node | the `default` network lacks IPv6 (libvirt < 6.5, or the network was redefined) | `virsh net-dumpxml default` must show `<nat ipv6='yes'>` and the ULA `<ip family='ipv6'>`; restart the network |
| `Start TUN listening error ... table 2022` | more than one mihomo TUN on the host | the gateway must keep `tun.enable: false`; move any other TUN off this host |
| Guest bootstrap apt fails | no egress: gateway or DNS is down | fix the gateway first; this is fail-closed behaviour, not a bootstrap bug |
| `websockify` fails: port in use | another instance of the browser stack | `systemctl restart cage-browser`; check for a stray `websockify` |
| VM boots with no address | netplan not applied, or MAC/interface name mismatch | `ip -br a`; `netplan apply`; check the cloud-init netplan file |

## Upgrading

The app uploads a new `agent.cjs` on connect; it is stateless, so an upgrade is
a reconnect. Gateway changes (nft, mihomo config, `gw-mode`) are applied by the
app on provision/switch; hand edits on the gateway are lost on the next
provision. Keep the node secret out of shell history and the repo.
