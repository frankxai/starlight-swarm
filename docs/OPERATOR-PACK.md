# Starlight Swarm Operator Pack

The operator pack is the public, sellable subset of `starlight-swarm`.

It includes:

- the typed `src/swarm` runtime and tests;
- the swarm architecture docs;
- four portable substrate skills: `swarm-queen-coordination`, `payments-mandate`, `agentic-income`, and `affiliate-audit`;
- source attribution, license terms, install notes, proof notes, a generated manifest, and a package hash.

It excludes:

- `.git`, `.next`, `node_modules`, `.agent-harness.json`, `.env` files, private memory, credentials, local-only paths, and internal strategy.

Build it with:

```bash
npm run pack:operator
```

The exporter writes to:

```text
../_generated/operator-packs/starlight-swarm-operator-pack/
```

The generated archive is a local release candidate. Uploading metadata to IPFS/Arweave, minting access tokens, and activating marketplace downloads happen in the marketplace/on-chain release wave.
