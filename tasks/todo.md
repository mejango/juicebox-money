# website/ create-flow parity backlog (audited 2026-07-16)

Exhaustive control-by-control audit of website/src/create-flow.js vs our
flow. Goal: every option present, in our own UX language.

## Missing — big

- [ ] P1 Suckers / chain linking. website links selected chains (bridge
      selector: Native / CCIP / Both → sucker deployer configs, shared salt
      + deployStart so addresses/configs match). We deploy independent
      per-chain with empty sucker config. Needs: bridge-type choice when >1
      chain (hidden detail by default), parseSuckerDeployerConfig wiring for
      both flavors, omnichain deployer for the project flavor (shared salt),
      "linked" explainer.
- [ ] P2 Multi-token payouts (payoutByKind). website: per-accounting-token
      payout mode + fixed amounts when ETH+USDC/custom. We replicate one
      config across contexts (same % splits; same numeric limit per token).
      Needs per-token payout amounts UI when >1 context.
- [ ] P3 Relayr "pay gas once" multichain deploy quote. website quotes one
      gas payment chain; we sign one tx per chain. (Decide: keep per-chain
      signing as our UX, or add Relayr.)

## Missing — medium

- [ ] P4 Surplus allowance amounts. website: owner surplus access can be
      Unlimited OR a capped amount + currency, and coexists with limited
      payouts. Ours: flexible = unlimited only, exclusive of routed. Add a
      "cap it" amount to Flexible withdrawals, and allow owner-surplus
      toggle alongside Routed payouts.
- [ ] P5 Base-currency choice for issuance (ETH vs USD per stage; revnet-
      wide revBaseCurrency). Ours derives from accounting (ETH if present).
      Add a per-[flow] ETH/USD denomination choice when both are sensible.
- [ ] P6 Revnet auto-issuances: rows "Issue N $TOK to addr" minted at stage
      start (per-chain beneficiary override). We have none.
- [ ] P7 Revnet operator store permissions (can adjust items / update
      metadata / mint free / raise discounts → preventOperator* flags). We
      hardcode all-allowed.
- [ ] P8 Item categories: named categories (+ Add category…), pinned names,
      tier.category numbering. We hardcode category 0.
- [ ] P9 Per-item flags: owner can mint free (allowOwnerMint), transfers
      pausable, permanent (cantBeRemoved), allow credit purchases
      (cantBuyWithCredits inv), owner can edit discounts
      (cantIncreaseDiscountPercent inv), custom voting units. We hardcode
      defaults.
- [ ] P10 Split locks (lockedUntil) on reserved/payout splits when the
      stage has a fixed duration.
- [ ] P11 Project-split routing: Pay vs Add to balance
      (preferAddToBalance) for payout splits to projects.
- [ ] P12 Custom approval-hook address option (deadline 'Custom…' with
      per-chain override) beyond our presets/none.
- [ ] P13 Router terminal toggle: "allow payers to pay in any token" vs
      accounting-token-only (we always include the router registry).
- [ ] P14 Custom-token per-chain verification: confirm the SAME token
      exists on every selected chain (we read decimals/symbol on the first
      chain only).
- [ ] P15 Per-chain owner/operator override.

## Missing — small

- [ ] P16 Project tags (up to 3 from the fixed list) in Basics metadata.
- [ ] P17 Custom cash-out tax % input (we offer 4 presets; website adds
      Custom 0–99%).
- [ ] P18 ToS / risk-acknowledgement checkbox before launch.
- [ ] P19 Item media cap 25MB (ours 10MB).
- [ ] P20 In-flow mainnet/testnet toggle (ours is env-driven — decide if
      deliberate).

## Covered differently (no action; note for review)

- "Issue tokens when paid" off-switch → our rate can be 0 / empty-inherit.
- Cycle-mode issuance cut → our cut input appears whenever duration > 0.
- Items cash-out access → our Store config toggle (revnets: REV forces on).
- Draft persistence, .jb import/export, per-chain split recipients +
  beneficiaries, ENS everywhere, curve preview, hold fees, superpowers,
  Afterwards, deadline presets — done in our UX.

## Deliberately excluded (user said no hooks; website has no UI either)

- Split hook recipients (Fund market LP hook / custom hook) — excluded per
  "no need to accommodate hooks" (revisit for Fund market later?).
- Croptop allowedPosts (website passes [] with no UI), loans config,
  per-chain payout amounts / per-chain item supply (import-only in website
  too), Pinata JWT input (we pin server-side), copy-build/audit-prompt
  links (website-specific AI helpers).
