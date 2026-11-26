# tnyc-agent-kvm

An Electron workbench for disposable agent VMs. It provisions one isolated KVM
guest (the **cage**) behind a dedicated **gateway** VM: the cage has exactly one
network path, and that path is a single proxy node. If the proxy is not running,
the cage is offline. There is **no direct-connect switch, by design**.

## What it does

- Creates and manages two libvirt VMs on an Ubuntu host: `gateway-kvm` and the
  cage, connected by the isolated `cage-lan` bridge.
- Renders a mihomo (hysteria2) gateway config from one node and keeps it
  fail-closed: nftables redirects all cage traffic into mihomo, and drops
  everything else.
- Gives you a terminal (tmux-backed PTY) and a browser (noVNC) for the cage
  without SSHing to it from your Mac.
- Runs leak checks (egress IP, fake-ip DNS, STUN/QUIC, private ranges,
  core-down behaviour) and refuses to pretend a broken gateway is fine.

## Prerequisites

- **Host**: Ubuntu 22.04+ (22.04 or 24.04), KVM/libvirt, `virt-install`,
  `cloud-localds`, `qemu-img`, `nftables`, OpenSSH server.
- **pnpm 11+** (the repo pins `packageManager: pnpm@12.18.0`; build
  approvals live in `pnpm-workspace.yaml` → `allowBuilds`)
- **Node.js 20+ on the host** — the uploaded agent is run as
  `node ~/.local/share/tnyc-agent-kvm/agent.cjs`.
- A user reachable over SSH **with keys**; it needs passwordless sudo (or
  libvirt group membership) for `virsh`, `nft`, and image operations.
- An Ubuntu cloud image, e.g.
  `/var/lib/libvirt/images/noble-base.qcow2` (Ubuntu 24.04 cloud image).
- One reachable **hysteria2** node. The reference setup uses an IPv6-only node,
  which requires the host to have working IPv6: the app declares the gateway's
  ULA and NAT66 on the libvirt `default` network (`<nat ipv6='yes'/>`, needs
  libvirt >= 6.5), so libvirt — not a relay unit — owns IPv6 forwarding.

## 5-minute quickstart

1. **Prepare the host**

   ```bash
   sudo apt update
   sudo apt install -y qemu-kvm libvirt-daemon-system libvirt-clients \
     virtinst cloud-image-utils nftables openssh-server
   sudo usermod -aG libvirt "$USER"   # log back in afterwards
   node --version                     # must be >= 20
   ```

   Put the cloud image where libvirt can read it:

   ```bash
   sudo wget -O /var/lib/libvirt/images/noble-base.qcow2 \
     https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
   ```

2. **Build and run the app**

   ```bash
   pnpm install
   pnpm run build     # bundles main, preload, renderer and agent/agent.cjs
   pnpm start         # or: pnpm run dist
   ```

3. **Connect a host** in the app: hostname/IP, port, user, private key. The
   app uploads `agent.cjs` and checks the host (libvirt, qemu, nft, node,
   base image, disk space).

4. **Provision** by choosing an image from the list, typing a custom path, or
   downloading one through the app proxy — then the hysteria2 node (server,
   port, password, SNI, obfs, fingerprint). The app creates `cage-lan`, enables
   IPv6 on the `default` network, boots the gateway, installs mihomo + nft, and
   creates the cage.

5. **Bootstrap and open the cage**: run *guest bootstrap* (installs Xvfb,
   Chrome, x11vnc, noVNC), then open a terminal or the browser view. Full
   check: run the leak check and expect every item to pass.
6. **Changing the node requires everything off.** The agent refuses a switch
   while the cage or gateway runs; it boots the gateway only to write the
   config and verify it, then powers it off again. The cage — the only source
   of user traffic — is down for the whole switch.

Manual equivalents for the embedded assets live in `assets/` (see below); the
gateway and cage cloud-init files are templates with `{{PLACEHOLDER}}` values.

## Security model (summary)

Four independent layers, each fail-closed:

1. **Network isolation** — `cage-lan` is a libvirt network with
   `forward mode='none'`, no DHCP, and no host address. The cage's only next
   hop is the gateway.
2. **Firewall** — `assets/nft/gateway.nft` defaults `input`/`forward` to drop,
   redirects TCP to mihomo `7892` and DNS to `1053`, drops all other UDP, and
   drops private destinations.
3. **Proxy policy** — mihomo runs one node in global mode, `GLOBAL -> EXIT`,
   with no `DIRECT` target. A dead core closes the redirect ports; the cage
   goes offline instead of falling back.
4. **Application** — the app never listens on the host or guest. Control,
   terminal, and noVNC all travel as SSH exec channels. **The app intentionally
   has no direct-connect switch**: there is no toggle that bypasses the proxy.

See `docs/security.md` for the threat model and its limits.

## macOS vs Linux

On macOS the app only connects to a remote host over SSH. On Linux it can also
run the same agent locally (`本机` target, no sshd/key needed) and do the whole
provisioning flow — image download, both VMs, bootstrap, checks.

## macOS notes

- macOS 15+ asks for **Local Network** permission on first SSH connect. An unsigned build gets
  denied silently and every LAN connection fails with `EHOSTUNREACH` (Tailscale addresses still work).
  `pnpm run pack:mac` ad-hoc signs the bundle, which makes the prompt appear; approve it under
  System Settings → Privacy & Security → Local Network.
- Distribution builds need a Developer ID certificate and notarisation; the ad-hoc signature is
  only for local use.

## Verified against a live host

Tested 2026-11-19 on macOS (Electron 33) against an Ubuntu 26.04 host with libvirt 12 / QEMU 10.2,
attached to an existing pair of guests (`gateway-kvm` + `agent-vm-xlarge`) behind one hysteria2 node:

- connect → agent upload → `host.status` (relay ULA + 2 policy rules, node name, egress IP, instance discovery)
- terminal: tmux session `cage` attaches, `TERM` is forced to `xterm-256color`, reconnects resume the session
- leak check, 5/5: `exit 179.255.127.122 == node`, v6 exit is the node address, DNS fake-ip `198.18.0.9`,
  STUN/QUIC `dropped dropped dropped`, host LAN `blocked`
- DNS mode switch `fake-ip → redir-host → fake-ip`: real answer `104.20.23.154` returned, mihomo restarted,
  checks stayed green
- browser pane: tunnel `http://127.0.0.1:<ephemeral>/vnc.html` returns 200 (noVNC 17.8 KB) and the
  WebSocket upgrade completes an RFB handshake (`RFB 003.008`) through
  Electron → SSH → host agent → `ssh -J gateway` → cage → `127.0.0.1:6080`

Not yet exercised: `provision.run` on a blank host (needs a fresh qcow2/cloud image), node change
(`proxy.set`) rollback path, and packaging on Windows/Linux.

## Repository layout

| Path | Purpose |
|---|---|
| `src/main`, `src/preload`, `src/renderer` | Electron app |
| `agent/` | host agent, bundled to `agent/agent.cjs` and uploaded over SFTP |
| `assets/cloud-init/gateway.yaml` | gateway VM cloud-config (static dual-stack) |
| `assets/cloud-init/cage.yaml` | cage cloud-config (IPv4-only, root key SSH) |
| `assets/net/cage-lan.xml` | libvirt network, `forward='none'` |
| `assets/nft/gateway.nft` | fail-closed gateway ruleset (`nft -f`) |
| `assets/mihomo/template.yaml` | mihomo config template, single hysteria2 node |
| `assets/guest/bootstrap.sh` | idempotent browser stack installer for the cage |
| `docs/architecture.md` | topology and channel model |
| `docs/operations.md` | node changes, rollback, logs, troubleshooting |
| `docs/security.md` | leak-prevention layers and trust boundaries |

## License

MIT — see `LICENSE`.
