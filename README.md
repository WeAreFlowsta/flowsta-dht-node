# Flowsta Community Node

Run a node on the Flowsta network. Your node stores and serves the
network's **public** data — decentralized identities and document
signatures — adding redundancy and geographic spread. Optionally, it
can also serve as an **open bootstrap/relay**, helping peers find and
reach each other even if Flowsta's own infrastructure is unreachable.

- Stores **public data only**: identity records (W3C DIDs, agent
  linking attestations, public profiles) and Sign It signatures
  (document signatures, content rights, perceptual hashes,
  thumbnails). Private user data never reaches your node — it lives in
  per-user encrypted networks your node is not a member of, by
  construction.
- Auto-installs the current DNAs on first boot and auto-updates by
  polling the Flowsta API every 6 hours, verifying every download
  against published checksums.
- Runs anywhere Docker runs: an old PC, a home server, a repurposed
  HoloPort, a small VPS.

## Requirements

- 64-bit Linux with Docker + Docker Compose
- 2 GB+ RAM, 20 GB+ free disk (grows slowly with network history)
- Always-on internet; no inbound ports needed for the basic node
- For the optional **bootstrap role**: a public IP or forwarded port
  443, a domain name, and a TLS certificate (guide below)

## Quick start (basic node)

```bash
git clone https://github.com/WeAreFlowsta/flowsta-dht-node.git
cd flowsta-dht-node
./setup.sh
```

That's it. The script checks Docker, writes the production-network
config, and starts the node. The conductor image is public (no registry
login), the bundled DNAs install on first boot, and the sidecar keeps
them current - including any public DNAs Flowsta adds in the future,
each download verified against published checksums before install.

<details>
<summary>Prefer to do it by hand?</summary>

```bash
cp conductor-config-example.yaml conductor-config.yaml   # works as-is for production
echo "API_URL=https://auth-api.flowsta.com" > .env
docker compose up -d
```
</details>

## What you're signing up for

- **Public data only.** Your node stores identity records and document
  signatures - the network's public layer. Private user data never
  reaches your node, by construction.
- **Disk** grows slowly with network history (20 GB headroom is plenty
  today). **Bandwidth** is light for the basic node; only the optional
  bootstrap role relays traffic.
- **Low maintenance, not zero.** DNA updates are automatic and
  checksum-verified. Three things are still yours to do, occasionally:
  `git pull && docker compose pull && docker compose up -d` for node
  software and conductor updates, your operating system's own updates,
  and (bootstrap role only) a `docker restart` after a certificate
  renewal. See [Updating](#updating).
- **Your node reports its health.** Every 10 minutes the sidecar sends
  the Flowsta API a small report: which public DNAs it holds, whether
  its copy agrees with the rest of the network, how recently it
  gossiped with each peer, and whether its connections are direct or
  relayed. Peers appear as anonymous connection ids - never as agent
  keys, and never any private data. This is how the network's health is
  monitored as a whole and how a node earns a place in the bootstrap
  fallback list later. Set `REPORT_DISABLED=1` to opt out; the node
  works the same either way.
- **Stop anytime.** `docker compose down` - the network loses one
  redundant copy and nothing else. No penalties, no obligations.

Questions or want to tell us your node exists (especially bootstrap
nodes - see below)? [Discord](https://discord.gg/p7sfaZTaEc) or
hello@flowsta.com.

## Verify your node actually joined the network

A node can *look* healthy while gossiping with nobody (wrong config,
wrong network, blocked egress). Two checks, a couple of minutes after
startup:

```bash
# 1. DNAs installed and enabled?
docker exec flowsta-sidecar node -e "
import('@holochain/client').then(async ({ AdminWebsocket }) => {
  const a = await AdminWebsocket.connect({ url: new URL('ws://localhost:4444'),
    wsClientOptions: { origin: 'flowsta-dht-node' } });
  const apps = await a.listApps({});
  console.log(apps.map(x => x.installed_app_id + ' [' + x.status.type + ']').join('\n'));
  process.exit(0); });"

# 2. Seeing remote peers? (should climb well past your own app count)
docker exec flowsta-sidecar node -e "
import('@holochain/client').then(async ({ AdminWebsocket }) => {
  const a = await AdminWebsocket.connect({ url: new URL('ws://localhost:4444'),
    wsClientOptions: { origin: 'flowsta-dht-node' } });
  console.log('peer store entries:', (await a.agentInfo({ dna_hashes: null })).length);
  process.exit(0); });"
```

If the peer count stays at (roughly) your own app count, your node is
isolated — check the bootstrap URLs and auth material in
`conductor-config.yaml`, and that outbound HTTPS/QUIC isn't blocked.

## The bootstrap role (optional): network redundancy

Flowsta's primary bootstrap server is how peers first find each other.
Community bootstrap nodes are the network's **fallback**: an open
(unauthenticated), rate-limited rendezvous + relay that keeps peer
discovery alive even if the primary is unreachable. Running one is the
single most valuable thing a community operator can contribute.

Extra requirements: a domain (or dynamic DNS) pointing at your node,
port 443 reachable from the internet, and a TLS certificate.

**Check for CGNAT first** — before touching DNS or certificates:
compare your router's WAN IP (its status page) with what the internet
sees (`curl ifconfig.me`). If they differ — especially if the router
shows an address starting with `100.64`–`100.127`, `10.`, or `172.` —
your ISP has you behind carrier-grade NAT and **no port forwarding can
work**. Ask your ISP for a public IP (many provide one on request,
free or cheap), then continue. The basic node needs none of this —
CGNAT only blocks the bootstrap role.

Then, with a domain pointed at your public IP and ports 80/443
forwarded:

```bash
./setup.sh bootstrap
```

The script re-checks CGNAT with you, verifies your DNS, obtains the
certificate, and starts the node with the bootstrap role.

<details>
<summary>Prefer to do it by hand?</summary>

```bash
sudo certbot certonly --standalone -d node.example.com   # stop anything on :80 first
TLS_DOMAIN=node.example.com docker compose --profile bootstrap up -d
```
</details>

Verify: `curl -s https://node.example.com/` should answer. Then tell
us about your node — community bootstrap URLs are distributed to
Flowsta apps as fallback rendezvous.

**Bandwidth note, honestly:** the bootstrap role includes an Iroh
*relay*, which carries traffic for peers that can't connect to each
other directly. On a home connection this is typically modest, but it
is not zero — monitor it, and drop the role at any time by restarting
without the profile.

## Repurposing a HoloPort

A HoloPort is a capable little x86 box for this. The path:

Tested end-to-end on a real HoloPort (it becomes the network's kind of
node it was always meant to be):

1. Flash **Ubuntu Server 24.04 LTS** (amd64) to a 4 GB+ USB stick
   (balenaEtcher or `dd`). Everything on the HoloPort - HoloPortOS and
   any HoloFuel state - will be erased.
2. Plug in keyboard, monitor, ethernet, and the USB. Power on and tap
   the boot-menu key: **F11** (then F10 or DEL/F2 for the BIOS boot
   order if the menu doesn't bite).
3. Through the installer: **use entire disk**, and **install the
   OpenSSH server** - after this the box runs headless.
4. While you're in the BIOS anyway: enable **restore on power loss**
   (usually under Chipset/ACPI) so the node comes back by itself after
   an outage.
5. Reboot, pull the USB, SSH in, install Docker
   (`curl -fsSL https://get.docker.com | sh`,
   `sudo usermod -aG docker $USER`, log out and back in).
6. Follow the Quick start above. Done in ~45 minutes, most of it
   unattended.

## Configuration reference

Create a `.env` file in the repo root:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `API_URL` | Yes | — | Flowsta API URL for auto-updates |
| `CONDUCTOR_IMAGE` | No | public Flowsta image | Override the conductor image |
| `UPDATE_INTERVAL` | No | `21600` (6 h) | Seconds between auto-update checks |
| `TLS_DOMAIN` | bootstrap role | — | Domain whose Let's Encrypt cert to serve |
| `NODE_SECRET` | No | — | Legacy; bundle downloads are open (sha256-verified) |
| `NODE_LABEL` | No | hostname | Name your node reports under (lowercase letters, digits, dashes) |
| `REPORT_INTERVAL` | No | `600` (10 min) | Seconds between health reports |
| `REPORT_DISABLED` | No | `0` | Set `1` to send no health reports |

**Networks:** the example config joins the **production** network —
the only network community nodes should join. (Flowsta operates
separate internal networks for testing; nodes must never mix networks.)

**Auth material:** the value in the example config is the **shared
community client id** — public by design. It identifies community
nodes to Flowsta's rate limiting and can be rotated if abused; it is
not a secret and grants nothing beyond bootstrap access.

## Architecture

Three containers (host networking):

1. **conductor** — Holochain 0.6.1/Iroh edge node; stores data, runs
   gossip, admin WebSocket on `localhost:4444` (not exposed beyond the
   host). Data persists in the `conductor-data` Docker volume across
   restarts and upgrades.
2. **sidecar** — installs bundled DNAs on first boot; polls the
   Flowsta API for new versions every 6 hours and verifies every
   bundle against the manifest's sha256 before installing.
3. **bootstrap-srv** *(optional, `--profile bootstrap`)* — upstream
   `kitsune2-bootstrap-srv`: open peer discovery + SBD signal + Iroh
   relay.

## Updating

DNA updates are automatic. To trigger one manually:

```bash
docker exec flowsta-sidecar node /app/updater/dht-update.mjs
```

To update the node software itself:

```bash
git pull
docker compose pull
docker compose up -d          # add --profile bootstrap if you run it
```

Old DNA versions are kept on purpose — your node keeps serving history
for peers on older versions.

**What is still manual today** (an automatic, verified update path is
planned - see the Flowsta docs when it ships): the conductor image and
node software (`docker compose pull` above), your operating system's
updates, and a `docker restart flowsta-bootstrap` after Let's Encrypt
renews the certificate (bootstrap role only). If your OS applies Docker
updates unattended, turn on Docker's `live-restore` so a Docker restart
leaves the conductor running:

```bash
echo '{ "live-restore": true }' | sudo tee /etc/docker/daemon.json && sudo systemctl reload docker
```
(merge into an existing `daemon.json` rather than overwriting it).

## Logs & troubleshooting

```bash
docker logs flowsta-conductor --tail 50    # conductor
docker logs flowsta-sidecar --tail 50      # DNA installs + updates
```

- **Peer count stuck at ~your own apps** — wrong bootstrap URL/auth
  material, or the config was edited after first boot: recreate the
  conductor container to regenerate from the template.
- **`CellAlreadyExists` / `AppAlreadyInstalled` in sidecar logs** —
  harmless; the DNA is already installed.
- **Disk growth** — logs are capped by the compose logging config; DHT
  data growth is gradual at current network size.
- **Bootstrap role: cert renewal** — certbot renews automatically;
  restart the container after renewal
  (`docker restart flowsta-bootstrap-srv`).

## License

Apache-2.0 - see [LICENSE](LICENSE). The bundled `.happ` files are built
from Flowsta's DNA repositories, also Apache-2.0.
