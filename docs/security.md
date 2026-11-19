# Security model

The goal is narrow and testable: **no packet from the cage reaches the
internet except through the one configured proxy node**, and when that path is
broken the cage is offline. Anonymity is not the goal; a single static exit is
the opposite of anonymity.

## Layer 1 — network isolation

- `cage-lan` is a libvirt network with `forward mode='none'`, no `<ip>`, no
  DHCP, and bridge `virbr-cage`. The host has no address on it.
- The cage has one NIC and one static route: `default via 10.99.0.1`.
- Therefore the cage sees only the gateway. It cannot ARP the host, reach the
  host LAN, or use the host as a router. There is no NAT or masquerade for
  `cage-lan`.
- The gateway is a normal VM on the host's `default` network; a compromise of
  the cage gives an attacker one L2 neighbour, not the host.

## Layer 2 — fail-closed firewall

`assets/nft/gateway.nft`, loaded on the gateway:

- `forward` and `input` chains are `policy drop`.
- The only egress path is `prerouting` REDIRECT: TCP to `:7892`, DNS over TCP
  and UDP to `:1053`. A redirected socket terminates in mihomo; if mihomo is
  down, the port is closed and the connection is refused.
- UDP other than DNS is dropped: no STUN/TURN, QUIC, mDNS, NTP, or arbitrary
  UDP. This closes the usual WebRTC leak paths.
- Private, loopback, and link-local destinations
  (`10/8`, `127/8`, `169.254/16`, `172.16/12`, `192.168/16`, `fc00::/7`,
  `fe80::/10`) are dropped before the redirect. Global mode ignores mihomo
  rules, so this guard must exist in nft, not only in the config.
- The only forwarded packets accepted are replies
  (`ct state established,related`) to mihomo's own outbound dials.
- `output` drops the controller port for non-root users, so a local
  unprivileged process cannot flip mode or select `DIRECT`.
- Every accept and drop has a counter; there are no counter-free catch-all
  accepts. Reading the counters is how you prove the ruleset is doing work.

The nat `prerouting` fake-ip redirect is ordered before the private-range drop
because the fake-ip v6 range is inside `fc00::/7`.

## Layer 3 — proxy policy

- One hysteria2 proxy, one `EXIT` group, `GLOBAL -> EXIT`, `MATCH,EXIT`.
  Global mode is only safe when `GLOBAL` is defined; without it mihomo falls
  back to `DIRECT`.
- No `DIRECT` appears anywhere in the rendered config. Rules `REJECT` private
  destinations and force everything else through `EXIT`.
- DNS uses fake-ip and every upstream is suffixed `#EXIT`, so resolver queries
  are proxied too. A dead node kills DNS as well as traffic.
- `tun.enable: false`: the gateway intentionally has no TUN. A TUN would give
  the gateway a second path and races the host's TUN over route table 2022.
  REDIRECT is the only ingress.
- Controller is `127.0.0.1:11098`, protected by the nft output rule.

## Layer 4 — application design

- The app and agent have **no listening ports**. Control, terminal, and noVNC
  are SSH exec channels with stdin/stdout as transport. There is no daemon to
  reach, no RPC socket, and no agent port to firewall.
- The renderer's only listener is a loopback WebSocket bridge for noVNC
  (`ws://127.0.0.1:<ephemeral>/`), alive only while the view is open.
- The client never receives guest credentials; the agent holds the jump path
  and runs `ssh` to the guest.
- Destructive or path-changing operations require confirmation (typing the
  instance name), and checks gate the result rather than assuming success.

### What the app refuses to do

- **There is no direct-connect switch.** No toggle, button, CLI flag, or config
  option routes the cage around the proxy. If the node is down, the cage is
  offline — that is the intended behaviour, not a bug to work around.
- No host-network mode for the cage, no second NIC, no DHCP on `cage-lan`.
- No UDP forwarding and no "temporarily open" rule.
- No exposing the mihomo controller beyond `127.0.0.1`, and no non-root access
  to it.
- No fallback to the host's proxy or the host's network under any failure.
- No silent success: a check that cannot verify an item reports failure.

## Threat model limits

Assume these are **not** protected against:

- **Host root / hypervisor.** Root on the host can read VM memory, change
  iptables, attach interfaces, or bridge the cage. Nothing in the guest can
  prevent that. A QEMU/libvirt/kernel escape is out of scope.
- **A compromised proxy node.** The node terminates TLS and sees every
  destination, SNI, and payload that is not end-to-end encrypted. It is a
  trusted component.
- **Guest root exfiltration through the allowed tunnel.** The cage can send
  anything it wants to any public destination; that is the product. Data-loss
  prevention, clipboard control, and session recording are not implemented.
- **Traffic analysis.** Timing, volume, and connection patterns are visible to
  the node and to the local network.
- **DNS/SNI metadata.** fake-ip hides resolver answers inside the cage, but the
  node still sees TLS SNI and destination IPs.
- **The Mac and the user's account.** Malware or a local user with access to
  the app's storage, SSH keys, or logs can change the node or read secrets.
- **Physical access** to the host or the Mac, and **supply-chain attacks** on
  the cloud image, the Chrome deb, mihomo, or the node.
- **Shared-host side channels** (CPU, cache, memory bandwidth) between the
  gateway, the cage, and other VMs.
- **IPv6 plumbing on the host.** An IPv6-only node requires host IPv6
  forwarding/NAT66 and policy routing; a misconfigured host relay can make the
  gateway double-proxied or offline, though it cannot create a cage bypass.

Treat the app as a containment and hygiene tool for agent workloads, not as an
anonymity system or a defence against a hostile host.
