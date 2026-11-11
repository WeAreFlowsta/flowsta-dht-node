# Node manifests

One body per channel (`stable.json`, `staging.json`, `proofpoll.json`): what every node on that channel should run. `tools/sign-manifest.mjs <channel>` stamps `issued_at` and the next `sequence`, has the Vault sign the statement with Team Flowsta's identity, verifies the result with the node agent's own code, writes `<channel>.signed.json` (not committed) and publishes it through the API, which accepts it on the strength of the signature alone (no session: nobody but that identity can produce a newer manifest). Nodes accept a manifest only with that signature.

Rules the agent enforces (see `agent/lib/manifest.mjs`): images pinned by digest; one admin port per generation; generation states `serving` | `retiring` | `retired`; a `retired` generation's conductor stops and its data volume stays; a lower or equal sequence is never applied.

`generation-holochain-0.7.json` is the 0.7.1 generation entry, to be added to a channel's `generations` once that channel has a bootstrap host running the kitsune2 0.5.x server (the 0.6 and 0.7 lines need different bootstrap servers; the bootstrap role in `docker-compose.yml` runs both behind an SNI proxy).

**`conductor.build` (agent 2.0.13; optional; a generation's conductor).** Names the [holochain-build](https://github.com/WeAreFlowsta/holochain-build) release the image's conductor comes from, for example `"build": "flowsta.4"`; leave it out for an image with upstream's binary. A 0.7 conductor from `flowsta.4` or later answers a gossip offer of any size, so the agent writes its config without the 1 MiB gossip cap; every other 0.7 conductor keeps the cap. Set it only together with an image built with `_HOLOCHAIN_BUILD` (`cloudbuild-edgenode.yaml`): an upstream binary without the cap drops large gossip exchanges. Older agents ignore the field and keep the cap, which is safe with either binary.

**`memory_restart` (agent 2.0.11; optional).** When a conductor of a named generation holds more than `share` of the VM's memory (page cache excluded), the agent restarts it cleanly in that node's slot (`slots`: node label → `HH:MM`, node-local like `UPDATE_WINDOW`; 20 minutes long), at most once in `every_hours` (default 24, at least 6) and never within 6 hours of a start. A node without a slot never restarts for memory, except above `urgent_share` when that is set. Older agents ignore the block. Example:

```json
"memory_restart": { "generations": ["holochain-0.7"], "share": 0.45, "urgent_share": 0.6, "slots": { "europe-dht": "05:20", "singapore-dht": "05:50" } }
```

**`carrier` (agent 2.0.12; optional; the `proofpoll` channel).** The agent runs the ProofPoll carrier (`proofpoll-carrier`, in an image built with `_CARRIER_URL` and `_CARRIER_SHA256`; `agent/lib/carrier.mjs`): one pass that carries ProofPoll's public records from DNA v1.3 (the `v06` generation's conductor) and v1.4 (`v07`) to v1.5 on `v07`, at most once in `every_hours`. A pass starts only when both conductors have run for 15 minutes, the VM has `min_free_mb` + 200 MB free, and nothing else changed the node in that tick (otherwise it tries again in 10 minutes); a pass running for 2 hours is stopped. After a pass that wrote, the agent restarts the `v07` conductor (`restart_after_write`, default true) to give back the memory the calls kept. `dry_run` counts only. The signing credentials are kept in `<STATE_DIR>/proofpoll-carrier.json` (owner-readable only), so the node's chains get one grant per cell, not one per pass. No pass after `until`. Older agents ignore the block. Example:

```json
"carrier": { "lines": { "v06": "holochain-0.6", "v07": "holochain-0.7" }, "every_hours": 6, "dry_run": true, "min_free_mb": 150 }
```

Image digests (2026-10-24, Cloud Build):

| Image | Tag | Digest |
|---|---|---|
| `flowsta-dht-node` (agent) | 2.0.7 | `sha256:abf3f821aa249de5b954259433c29416c5fd8c1a002bebad4b9e529e99d95095` |
| `flowsta-dht-node` (agent) | 2.0.9 | `sha256:6a4482e2776ae346a6f4bfa61e60d0ab28fa9a55a395eed83e7a313e6bf95432` |
| `flowsta-dht-node` (agent) | 2.0.10 | `sha256:9cf38cfbfffd142fe061adfb508a5062f6c307acbc2ffb5f159bb4c389cb41e0` |
| `flowsta-dht-node` (agent) | 2.0.11 | `sha256:0d438c808ee417777b0b8417100f36b0e52d9c506893b8e465bb5b5657be446b` |
| `flowsta-edgenode` | hc0.6.1 | `sha256:900987b0daadd3fda65821c8855e06fac92398fe3872c53ac133bbfb1158d0f2` |
| `flowsta-edgenode` | hc0.7.1 | `sha256:dd17ec0f89b7e91a66875036d7c0d65bee3ca67576d8018ce1db81f630e3ec0f` |
| `flowsta-edgenode` | hc0.7.1-flowsta.4 (2026-11-11) | `sha256:1f0604bc2e26a6dd6f842c46334c0b9ebd26172a4e3b31dee6caeb6d49e4ad5b` |
| `flowsta-dht-node` (agent) | 2.0.13 (2026-11-11) | `sha256:1ec09ee1eb2766d12f664c1923ca4264133a421636f748c96f13d3b6ecd23129` |

**Channels and who signs them (2026-10-24).** `stable`: Team Flowsta's identity in the Vault, nothing else. `staging` and `proofpoll`: a local key on the release machine, trusted by the staging API (`NODE_MANIFEST_SIGNER_DID`) and by each node's `MANIFEST_SIGNER_DID`, until the Vault signs manifests itself; both channels are published through the staging API meanwhile. ProofPoll bundles come from the ProofPoll repository at its release tag (sha256-verified by the agent before install).

# App release manifests

`tools/release-manifest.mjs` does the same for an app's releases: one manifest per app, channel and release, listing the version and every installer and updater file with its size and SHA-256. The apps check it with [flowsta-update-check](https://github.com/WeAreFlowsta/flowsta-update-check) before installing an update.

```
node tools/release-manifest.mjs vault vault-v1.8.1 --dry-run   # print it, sign nothing
node tools/release-manifest.mjs vault vault-v1.8.1             # sign in the Vault, upload
```

- It reads the finished release from GitHub. The SHA-256 of each file comes from GitHub's own asset digests, and the sidecar hashes from the `kit-hashes-<target>.json` files the release workflow publishes.
- The Vault signs through `/sign-release-manifest`. Its dialog shows the app, version, channel, rollout and every file; compare them with what the tool printed before approving. The tool then checks the signature against Team Flowsta's identity.
- Options:
  - `--rollout <percent>` sets the rollout share;
  - `--from <version>` makes installs older than that version install it first;
  - `--changes-line` marks a release that moves data to another Holochain line;
  - `--sequence N` confirms a jump in the sequence.
- Where the manifest goes:
  - **Stable:** `release-manifest.json` is uploaded to the release itself (installs read `releases/latest/download/`).
  - **Beta:** it is also uploaded, with the release's `latest.json`, to the app's fixed beta pre-release (`vault-beta`).
- It uses the same tool key and Vault link as the node manifest tool.
