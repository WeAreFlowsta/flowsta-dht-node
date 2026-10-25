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
- Keeps itself current from a **signed manifest**: Flowsta publishes
  what a node should run (conductor images by digest, the public DNAs,
  the agent itself), signed offline with Team Flowsta's identity. Your
  node verifies the signature before it acts, applies conductor changes
  in your maintenance window, and rolls back if the new conductor does
  not verify. Nobody, Flowsta included, can push anything unsigned to it.
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

That's it. The script checks Docker, writes `.env` (production
network, stable channel, a 03:00-05:00 maintenance window in your time
zone) and starts the agent. The agent fetches the signed manifest,
creates one conductor per Holochain generation the manifest lists,
installs the public DNAs (each bundle verified against the manifest's
sha256 before install) and keeps all of it current. Images are public;
no registry login.

<details>
<summary>Prefer to do it by hand?</summary>

```bash
printf 'API_URL=https://auth-api.flowsta.com\nCHANNEL=stable\nTZ=%s\nUPDATE_WINDOW=03:00-05:00\n' "$(cat /etc/timezone)" > .env
docker compose up -d
```
</details>

**Upgrading a node from the previous version** (sidecar + compose-managed
conductor), in two steps so the agent can read your running conductor
before anything is removed:

```bash
git pull
echo 'UPDATE_WINDOW=00:00-00:00' >> .env   # open the window for this first run
docker compose up -d agent
docker logs -f flowsta-agent        # wait for "now on sha256:…" (about a minute)
docker compose up -d --remove-orphans              # add --profile bootstrap if you run that role
```

Then set `UPDATE_WINDOW` in `.env` back to the hours you want (default
`03:00-05:00` in your `TZ`) and run `docker compose up -d agent` once
more; the agent keeps its state across the recreate.

The agent adopts the running conductor: it carries your auth material
and data path over from its config, stops it, creates the new conductor
on the same data volume, verifies that every app came across (and rolls
back if not), then removes the old container. The second command removes
the old sidecar (and, with the bootstrap profile, replaces the old
bootstrap server with the proxy and the per-generation servers). A
minute offline, no data lost. If the old conductor was already gone, the
agent still finds its data volume, but then renders the config from
defaults instead of carrying yours over.

## What you're signing up for

- **Public data only.** Your node stores identity records and document
  signatures - the network's public layer. Private user data never
  reaches your node, by construction.
- **Disk** grows slowly with network history (20 GB headroom is plenty
  today). **Bandwidth** is light for the basic node; only the optional
  bootstrap role relays traffic.
- **Low maintenance.** DNA, conductor and agent updates arrive through
  the signed manifest and apply themselves in your maintenance window,
  with verification and rollback. What stays yours: your operating
  system's own updates, and (bootstrap role only) a `docker restart` of
  the bootstrap containers after a certificate renewal. See
  [Updating](#updating).
- **Your node reports its health.** Every 10 minutes the agent sends
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
# 1. What the agent did and what it is waiting for
docker compose logs -f agent
curl -s localhost:8787/status.json       # manifest sequence, generations, last change, history

# 2. DNAs installed and enabled, per conductor (admin port from status.json)
docker exec flowsta-agent node -e "
import('@holochain/client').then(async ({ AdminWebsocket }) => {
  const a = await AdminWebsocket.connect({ url: new URL('ws://localhost:4444'),
    wsClientOptions: { origin: 'flowsta-dht-node' } });
  const apps = await a.listApps({});
  console.log(apps.map(x => x.installed_app_id + ' [' + JSON.stringify(x.status) + ']').join('\n'));
  process.exit(0); });"

# 3. Seeing remote peers? (should climb well past your own app count)
docker exec flowsta-agent node -e "
import('@holochain/client').then(async ({ AdminWebsocket }) => {
  const a = await AdminWebsocket.connect({ url: new URL('ws://localhost:4444'),
    wsClientOptions: { origin: 'flowsta-dht-node' } });
  console.log('peer store entries:', (await a.agentInfo({ dna_hashes: null })).length);
  process.exit(0); });"
```

(For a 0.7 conductor use `holochain-client-07` in place of
`@holochain/client` and its admin port, 4445 by default.) If the peer
count stays at (roughly) your own app count, your node is isolated:
check that outbound HTTPS/QUIC isn't blocked, and the agent log for a
refused manifest or a rolled-back change.

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
| `API_URL` | Yes | — | Flowsta API URL (manifest, DNA bundles, health reports) |
| `CHANNEL` | No | `stable` | Manifest channel. Community nodes stay on `stable` |
| `UPDATE_WINDOW` | No | `03:00-05:00` | When conductor and agent changes may happen, in `TZ` |
| `TZ` | No | `UTC` | Your time zone, so the window is yours |
| `SECURITY_UPDATES_ANYTIME` | No | `1` | Let security advisories act outside the window |
| `TLS_DOMAIN` | bootstrap role | — | Domain whose Let's Encrypt cert the 0.6-line bootstrap server serves |
| `TLS_DOMAIN_07` | bootstrap role | — | Same for the 0.7-line server (second hostname, `--profile bootstrap-07`) |
| `NODE_LABEL` | No | hostname | Name your node reports under (lowercase letters, digits, dashes) |
| `NODE_SECRET` | No | — | Fleet nodes only |
| `REPORT_INTERVAL` | No | `600` (10 min) | Seconds between health reports |
| `REPORT_DISABLED` | No | `0` | Set `1` to send no health reports |
| `BOOTSTRAP_AUTH_MATERIAL`, `RELAY_AUTH_MATERIAL` | No | community client id | Bootstrap/relay auth material in the rendered conductor configs |
| `CONDUCTOR_MEMORY` | No | none | Memory cap per conductor container, e.g. `1400m`; `CONDUCTOR_MEMORY_SWAP` the memory+swap cap (default twice) |
| `CONDUCTOR_ALLOWED_ORIGINS` | No | `flowsta-agent,flowsta-auth-api` | Origins the conductor's admin interface answers (comma-separated); add your own tools here |
| `AGENT_IMAGE` | No | the published agent image | Only for developing the agent itself |
| `DRY_RUN` | No | `0` | Set `1` to plan and log only; the agent changes nothing. Useful for the first start on an existing node |
| `MANIFEST_SIGNER_DID` | No | Team Flowsta's DID | Only for Flowsta's own test channels |

**Networks:** the `stable` channel joins the **production** network, the
only network community nodes should join. (Flowsta operates separate
internal networks for testing; nodes must never mix networks.)

**Auth material:** the default is the **shared community client id**,
public by design. It identifies community nodes to Flowsta's rate
limiting and can be rotated if abused; it is not a secret and grants
nothing beyond bootstrap access.

**The status page** (`curl -s localhost:8787/status.json`, loopback only)
shows the manifest in force, each generation's image and last change,
advisories and whether they were applied, what is waiting for the
window, and the agent's recent history.

## Architecture

All containers use host networking.

1. **agent** (`flowsta-agent`, the one container in `docker-compose.yml`)
   fetches `GET /api/v1/vault/node/manifest?channel=…` once a minute,
   verifies the Ed25519 signature against Team Flowsta's identity
   (`did:flowsta:uhCAkWuA-Ehm9…`, baked into the image) and refuses
   anything unsigned, signed by another key, or older than what it
   already applied. It then reconciles: one conductor per generation,
   the DNAs each lists, itself. See `agent/agent.mjs`; the verification
   is `agent/lib/manifest.mjs` and is tested on paper in `agent/test/`.
2. **conductors** (`flowsta-conductor-<generation>`, created by the
   agent) — the Flowsta edge node image at the digest the manifest
   names. Each generation has its own data volume
   (`flowsta-conductor-data-<generation>`), admin port on localhost
   (4444 for the 0.6 line, 4445 for 0.7) and bootstrap host. During a
   Holochain line transition two run side by side; when a generation
   is marked `retired` its conductor stops and its volume stays.
3. **bootstrap role** *(optional, `--profile bootstrap`, plus
   `--profile bootstrap-07` once you have the second hostname)* — one
   upstream `kitsune2-bootstrap-srv` per line behind an HAProxy SNI
   pass-through on :443 (`bootstrap/haproxy.cfg`): the proxy reads the
   hostname from the TLS hello and forwards the still-encrypted bytes;
   each server terminates its own TLS with its own certificate.

**How a conductor change happens:** pull the new image → stop the
running conductor and keep it as `…-previous` → create the new
container on the same volume with the config rendered from the
manifest → verify (admin port answers, every expected app enabled, no
panic in the log, a gossip round within 10 minutes when peers exist)
→ remove `…-previous`. If verification fails the new container is
removed and the previous one started again; the agent logs the
rollback, reports it, and does not retry that image for 24 hours. The
agent replaces itself the same way, from the manifest's digest.

## Updating

Everything the manifest covers updates itself: public DNAs (any time,
additive, sha256-verified), conductor images and configs and the agent
(in your maintenance window, verified, rolled back on failure), and
Flowsta's **advisories** ("restart the conductor", "security update"),
which the status page lists with whether they were applied. Security
advisories may act outside the window unless you set
`SECURITY_UPDATES_ANYTIME=0`.

Old DNA versions and retired generations are kept on purpose: your
node keeps serving history for peers on older versions, and the agent
never deletes a data volume.

`git pull && docker compose up -d` is only needed when this repository
changes (the compose file, the bootstrap proxy config); the agent image
itself comes through the manifest.

**What is still manual:** your operating system's updates, and
`docker restart flowsta-bootstrap-srv-06 flowsta-bootstrap-srv-07`
after Let's Encrypt renews a certificate (bootstrap role only). If
your OS applies Docker updates unattended, turn on Docker's
`live-restore` so a Docker restart leaves the conductors running:

```bash
echo '{ "live-restore": true }' | sudo tee /etc/docker/daemon.json && sudo systemctl reload docker
```
(merge into an existing `daemon.json` rather than overwriting it).

## Logs & troubleshooting

```bash
docker logs flowsta-agent --tail 50                      # manifest, changes, rollbacks, DNA installs, reports
docker logs flowsta-conductor-holochain-0.6 --tail 50    # a conductor (one per generation)
curl -s localhost:8787/status.json                       # the agent's view of the node
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
