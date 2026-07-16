# Full parity build (user 2026-07-16: "do them all", incl. split hooks +
# per-chain payout amounts & item supply)

Order minimizes rework. Commit per batch; Sepolia sims per encoding change.

- [ ] B1 P5 issuance base currency (ETH/USD choice; project-wide, encodes
      per-ruleset — website has per-stage granularity, ours is one choice)
- [ ] B2 smalls: P17 custom cash-out tax %, P16 tags, P18 ToS checkbox,
      P19 25MB media
- [ ] B3 flavor batch: P12 custom approval-hook address (+per-chain),
      P13 router terminal toggle, P15 per-chain owner/operator, P14 verify
      custom token on every selected chain
- [ ] B4 splits batch: P10 split locks (fixed-duration stages),
      P11 pay vs add-to-balance for project payout splits, split HOOK
      recipients (custom hook addr + optional projectId/beneficiary; Fund
      market LP option for reserved splits)
- [ ] B5 P4 surplus allowance: capped amount + currency; owner-surplus
      toggle alongside routed payouts
- [ ] B6 P2 multi-token payouts (per-context modes/amounts) + per-chain
      payout AMOUNT overrides (website has data model only; jango adds UI
      there)
- [ ] B7 store batch: P8 categories, P9 per-item flags + voting units,
      per-chain item supply overrides, P7 revnet operator store
      permissions, P6 revnet auto-issuances
- [ ] B8 P1 suckers/chain linking: bridge choice (native/ccip/both),
      parseSuckerDeployerConfig both flavors, omnichain deployer + shared
      salt for projects
- [ ] B9 P3 Relayr pay-once (evaluate; may keep per-chain signing — decide
      with user)
- [ ] P20 network toggle: SKIPPED as architecture — jbm is env-scoped per
      network (bendystraw + wagmi config baked per deployment); flag for
      user sign-off

Watch: website/ baseline a1ef87b (see memory jb-jbm-website-parity-watch).
