The app reads buyback, router, gateway and ratio-feed addresses from the generated `src/lib/protocol-rollout.json`. Its source commit pins the canonical `deploy-all-v6` checkout. The generator verifies contract identity, chain ID and successful receipt evidence before accepting an artifact. Proposed deployments are not an input.

After each chain's deployment executes and its canonical artifacts land, regenerate from that checkout:

```sh
PROTOCOL_DEPLOYMENTS_DIR=/path/to/deploy-all-v6 npm run protocol:generate
PROTOCOL_DEPLOYMENTS_DIR=/path/to/deploy-all-v6 npm run protocol:check
npm test
npm run build
```

This updates the rollout address history, the app deployment fixture and the gateway ABI used for reads and Safe queue labels. A chain becomes eligible for the migration preset only when both its canonical buyback hook and gateway have executed deployment records. Preset resolution also checks bytecode and live registry allowance. Mirroring applies the same per-chain checks, rejects invalid source ordering and skips dependent pool actions when a hook migration is unavailable.

The operator card resolves `JBDirectory.isTerminalOf(projectId, registry)`, then `registry.terminalOf(projectId)`, and reads `gateway.ROUTER()` for a selected gateway. Registry defaults prefill new selections; they do not imply that a project already migrated. Unknown routes stay unknown. Previous and v1 addresses remain available for Safe transaction labels and existing project selections; the old addresses in generated records and migration regression fixtures are intentional.

The payment form also recognizes directly attached gateways and current or historical routers. Preview, approval and payment retain the same attached entry, and route discovery propagates RPC failures instead of caching them as absent routes. Draft export refuses a directly attached router or gateway that the create editor cannot reproduce, and a failed directory read does not silently remove routing from the draft.

Eligible failed fee routes stay in gateway custody until successful retry or qualified finalization refunds the source project. They are not settled payments or forgiven fees. The operator view explains this state; it does not infer a pending balance from `pendingCallCount`, which counts lifetime issued IDs. The generated ABI preserves retry/finalize calls and queue/process/failure/refund events for decoding. Individual retained calls remain discoverable through the indexer or their gateway events.

At deployment source `8522541297557c80f8bc2dd674c3098f8849b527`, Sepolia, Base Sepolia and Arbitrum Sepolia have the new hook/router/gateway; OP Sepolia has only the new ratio feed; mainnet artifacts still select the previous generation. The checked-in snapshot, not this dated description, controls availability. Published SDK addresses for these mutable rollout contracts are overlaid by the generated app records until the matching SDK release is installed.

The deterministic production build measures 2422.8 KiB gzip across all emitted client scripts, 5.8 KiB above the previous aggregate cap. The rollout adds verified per-chain records and retained history, gateway payment routing and migration allowance checks. Bundle inspection found the rollout snapshot and gateway ABI each emitted once. The aggregate cap is 2423 KiB, the next whole KiB; route, largest-chunk, stylesheet and lazy-loading constraints stay unchanged. The prior recorded 2414.6 KiB result used an earlier build, so its 8.2 KiB difference also includes intervening toolchain changes and is not an isolated measurement of the rollout code.
