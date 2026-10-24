# Node manifests

One body per channel (`stable.json`, `staging.json`, `proofpoll.json`): what every node on that channel should run. `tools/sign-manifest.mjs <channel>` stamps `issued_at` and the next `sequence`, has the Vault sign the statement with Team Flowsta's identity, verifies the result with the node agent's own code, writes `<channel>.signed.json` (not committed) and publishes it through the API, which accepts it on the strength of the signature alone (no session: nobody but that identity can produce a newer manifest). Nodes accept a manifest only with that signature.

Rules the agent enforces (see `agent/lib/manifest.mjs`): images pinned by digest; one admin port per generation; generation states `serving` | `retiring` | `retired`; a `retired` generation's conductor stops and its data volume stays; a lower or equal sequence is never applied.

`generation-holochain-0.7.json` is the 0.7.1 generation entry, to be added to a channel's `generations` once that channel has a bootstrap host running the kitsune2 0.5.x server (the 0.6 and 0.7 lines need different bootstrap servers; the bootstrap role in `docker-compose.yml` runs both behind an SNI proxy).

Image digests (2026-10-24, Cloud Build):

| Image | Tag | Digest |
|---|---|---|
| `flowsta-dht-node` (agent) | 2.0.4 | `sha256:d91d0fdff1df88da6457b588dcf0eff2100c0847bb21c61c1eca6858ada3f2de` |
| `flowsta-edgenode` | hc0.6.1 | `sha256:900987b0daadd3fda65821c8855e06fac92398fe3872c53ac133bbfb1158d0f2` |
| `flowsta-edgenode` | hc0.7.1 | `sha256:dd17ec0f89b7e91a66875036d7c0d65bee3ca67576d8018ce1db81f630e3ec0f` |

**Channels and who signs them (2026-10-24).** `stable`: Team Flowsta's identity in the Vault, nothing else. `staging` and `proofpoll`: a local key on the release machine, trusted by the staging API (`NODE_MANIFEST_SIGNER_DID`) and by each node's `MANIFEST_SIGNER_DID`, until the Vault signs manifests itself; both channels are published through the staging API meanwhile. ProofPoll bundles come from the ProofPoll repository at its release tag (sha256-verified by the agent before install).
