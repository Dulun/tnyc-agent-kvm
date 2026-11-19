# Architecture

## Topology

```
your Mac
  Electron main process (ssh2 client)
    |
    |  SSH exec channel
    v
Ubuntu host
  sshd -> node agent.cjs            modes: rpc | pty | pipe
            |                         |
            | virsh / qemu-agent      | ssh -J gw@192.168.122.50 root@10.99.0.2
            v                         v
          libvirt                 gateway-kvm
          virbr0 (host LAN)       eth0 192.168.122.50/24
                                  eth0 fd00:3c6a:484c:c7ee:122::2/64
                                  eth1 10.99.0.1/24
                                  eth1 fdfd:99::1/64
                                    |
                                    |  cage-lan: libvirt network virbr-cage
                                    |  forward='none', no host address, no DHCP
                                    |
                                  cage
                                  eth0 10.99.0.2/24
                                  IPv6 disabled
```

The host never has an address on `virbr-cage`. The cage only knows
`10.99.0.1`; the host's LAN (`192.168.122.0/24`, `192.168.0.0/24`, ...) is not
routable from it. The gateway is a normal VM on the host's `default` network.

## Data path

For a request from the cage to the internet:

```
cage 10.99.0.2
  -> eth1 on gateway
  -> nft prerouting: TCP REDIRECT to :7892, DNS REDIRECT to :1053
  -> mihomo (redir-port 7892, fake-ip DNS 1053)
  -> hysteria2 node
  -> internet
```

There is no forward rule from `eth1` to `eth0`. The only cross-interface
forward accept is for `ct state established,related` on the reply direction
mihomo's own dials use. `forward` policy is `drop`.

## Channel model

The app talks only to the host, over SSH. Every remote operation is one of
three `agent.cjs` modes started as an SSH exec channel (stdin/stdout are the
transport; there is no RPC server):

| Channel | Command | Payload | Used for |
|---|---|---|---|
| Control | `agent.cjs rpc` | one JSON object per line (`RpcRequest` / `RpcResponse` / `RpcEvent`) | host status, provisioning, proxy get/set, checks, guest exec, bootstrap |
| Terminal | `agent.cjs pty --cols N --rows M [--session NAME]` | raw PTY bytes | xterm in the renderer; attaches to a tmux session so the shell survives disconnects |
| Tunnel | `agent.cjs pipe --port 6080` | raw TCP bytes, bridged to loopback on the guest | noVNC (`websockify` in the cage) |

The agent itself shells out to the gateway and the cage:

- management: `ssh gw@192.168.122.50` (installing mihomo config, `gw-mode`,
  `nft`, reading status);
- guest: `ssh -J gw@192.168.122.50 root@10.99.0.2` (the client never needs
  guest credentials, and there is no host-to-cage L2 path);
- libvirt: `virsh` and the qemu guest agent for instance lifecycle and
  out-of-band exec.

## Why there are no listening ports

- The agent has no daemon and no socket. SSH starts it, SSH ends it. A crashed
  or killed channel leaves nothing behind.
- Nothing inbound has to be allowed on the host: the only required port is
  SSH. The host firewall can drop everything else.
- The gateway's mihomo controller binds `127.0.0.1:11098`; nft drops it for
  non-root users. mihomo's `redir-port` and DNS are reachable only from
  `eth1` (the cage).
- noVNC is served by `websockify` on the guest's loopback. To view it, the app
  opens a **local** WebSocket listener on `127.0.0.1` and bridges it through a
  `pipe` channel. That listener exists only in the Electron process, only on
  loopback, and only while the view is open.

The consequence is a small attack surface at rest: no port to scan, no service
to keep patched, no session token to leak on the network.

## Files and where they go

| Asset | Installed to |
|---|---|
| `assets/cloud-init/gateway.yaml` + netplan | gateway cloud-init (NoCloud seed) |
| `assets/cloud-init/cage.yaml` + netplan | cage cloud-init (NoCloud seed) |
| `assets/net/cage-lan.xml` | `virsh net-define cage-lan` on the host |
| `assets/nft/gateway.nft` | `/etc/nftables-gw.nft` on the gateway, loaded with `nft -f` |
| `assets/mihomo/template.yaml` (rendered) | `/etc/mihomo/config.yaml` on the gateway |
| `assets/guest/bootstrap.sh` | copied into the cage and run as root |
| `agent/agent.cjs` | `~/.local/share/tnyc-agent-kvm/agent.cjs` on the host |

## Invariants

- `cage-lan` stays `forward='none'`; no host address, no DHCP, no masquerade.
- `forward`/`input` on the gateway stay `policy drop`.
- Only one node; `GLOBAL` always points at `EXIT`; no `DIRECT` target.
- The tunnel and terminal are SSH channels, never listening sockets.
- The app exposes no operation that adds a direct path: there is no
  direct-connect switch.
