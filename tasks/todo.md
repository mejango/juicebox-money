# Create flow: 4 steps (identity+treasury+chains / rules / store / review)

Spec (user, 2026-07-16):
- Step 1: identity + accounting context selector (ETH | USDC) + chain selectors move in.
- Step 2: quick rules questionnaire (website/-style checkboxes, far less verbose).
  Defaults: flexible project, no payouts, no cash outs, simple issuance, 0 reserved.
- Step 3: Store (website/ create-flow Shop, in jbm style/language).
- Step 4: Review & launch.

## Encoding facts (from website/ + SDK)
- Accounting context: token USDC_ADDRESSES[chain] dec 6 (or native, 18); context
  currency = uint32(uint160(token)). Ruleset baseCurrency = 1 ETH / 2 USD.
- No payouts = NO fundAccessLimitGroups entry. Flexible = payoutLimit UINT224_MAX
  in context currency, no splits (remainder → owner).
- Cash outs off = cashOutTaxRate 10000. Flexible payouts ⇒ no surplus ⇒ force off.
- Reserved % out of 10000, no splits → all reserved to owner.
- Store: JB721TiersHookProjectDeployer.launchProjectFor(owner, hookCfg,
  {projectUri, rulesetConfigurations(payDataHook variant — same metadata object,
  viem drops extra dataHook/useDataHookForPay keys), terminalConfigs, memo},
  controller, salt) payable=creationFee. Tier prices in standard currency
  (1/18dec ETH, 2/6dec USD). encodedIpfsUri = bytes32 sha256 digest of CIDv0
  (Infura /api/v0/add already returns CIDv0). Unlimited supply = 999999999.

## Tasks
- [x] Explore website/ create flow + SDK surface
- [x] src/lib/launch.ts: LaunchPlan type, USDC context, payouts/cashout/reserved
      encoding, 721 store branch, salt
- [x] src/lib/ipfs-cid.ts: base58 CIDv0 → bytes32 digest (verified vs
      independent BigInt decode; rejects CIDv1)
- [x] /api/ipfs/pin-item: pin {name, description?, image?} tier metadata
- [x] StoreEditor.tsx: item list editor (image, name, price, qty, description)
- [x] CreateForm.tsx: 4 sections, plan state, pin items during launch
- [x] Verify: ts:check clean; live Sepolia simulateContract PASS ×5
      (eth-default, eth-flexible+reserved+minting, usdc-taxed-cashouts,
      eth-store, usdc-store-two-items); UI screenshots (USDC/store states)
- [ ] Commit

## Review
The controller path is unchanged for default launches. Store launches go
through JB721TiersHookProjectDeployer with the same ruleset/terminal configs
(viem drops the metadata keys the payDataHook tuple omits). Cash outs are
forced off with flexible payouts (no surplus). Tier metadata pins as CIDv0 via
the existing Infura route; encodedIpfsUri is its sha2-256 digest.
