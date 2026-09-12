# Routing and rollout risks

## Priority risks

- A deployed gateway does not migrate a project. The operator view checks directory attachment, reads the project's registry selection, and resolves a selected gateway's `ROUTER()`. Previous and v1 routers can remain active. The payment form also recognizes directly attached recorded gateways and routers, keeping the same entry for preview, approval and payment.
- A successful outer transaction does not prove that an eligible fee route settled. The gateway can retain the original input for retry. Queue and failure events describe pending custody; `ProcessPendingCall` confirms settlement and `RefundPendingCall` confirms a source-project refund. A failed refund leaves custody pending.
- Deployment records and successful previews do not guarantee current registry permission, liquidity, price or execution. State can change between discovery, review and submission. The current buyback hook's mint fallback does not remove an explicit settlement minimum.

## Trust assumptions and accepted behaviors

- [Generated rollout records](src/lib/protocol-rollout.json) trust the pinned canonical deployment checkout. Generation checks contract identity, chain ID and successful mined-receipt evidence; it is not an independent live-chain verification. Proposed addresses do not enable a chain. Historical records remain available for existing routes and transaction labels.
- The production snapshot at `a6ab40c5806b52ff4cb21f9eaefe275e621796f9` now includes executed hook/router/gateway records on all four supported mainnets as well as Sepolia, Base Sepolia and Arbitrum Sepolia. OP Sepolia remains feed-only. This enables recorded migration choices, not an assumption that every project selected the new gateway.
- Presets and mirrored hook/gateway selections require recorded deployment, live bytecode and the registry's live allowance. A false allowance blocks the new selection; it does not establish that an existing historical route is unusable. Missing counterparts require direct per-chain configuration. Mirroring rejects invalid source ordering and skips pool actions dependent on a hook selection that could not be mirrored.
- Failed registry/default reads remain unknown instead of prefilling a retired selection. Payment discovery propagates RPC failures and rechecks on retry; unknown terminal addresses are not assumed to be routers. Draft export rejects directly attached routing that the create editor cannot preserve, and a failed directory read does not silently disable routing in the exported draft.
- Gateway custody applies only to eligible calls reaching that gateway. Other routes keep their own failure semantics. Recovery depends on qualified retries and a source terminal that accepts the eventual refund. The app explains custody but does not derive outstanding calls or balances from `pendingCallCount`, which counts lifetime issued IDs; per-call state requires indexed records or gateway events.

## Invariants to verify

- Regenerate and run `protocol:check` against the exact recorded deployment commit, preserving per-chain capabilities and previous/v1 history. Follow [the regeneration procedure](docs/protocol-rollout.md) after execution; a proposal or another chain's deployment must not activate a migration.
- Keep preview, approval and payment on the actual attached entry. Do not substitute the raw router for a selected gateway or interpret a failed read as route absence.
- Recheck bytecode and allowances before offering a mirrored selection, retain source-order/dependency checks, and reconcile each queued call by chain, gateway and pending ID until a process or refund event proves its outcome.
