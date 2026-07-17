# B11 spec — website/ pay card + money flows (scout report, 2026-07-16)

All line numbers are in website/src/discover.js unless named. Project-page
pay card = renderPayCard (5553-6726); standalone equivalents in
pay-component.js / cashout-component.js; shared preview pay-preview.js.

## Structure (top to bottom)
1. Countdown banner when ruleset.start is future — pay disabled "Not started".
2. Shop strip (721 tiers, first 12, discount badges, qty steppers, shared cart).
3. "[Pay|Add to balance] on [chain]" row — mode select + chain select (multi).
4. Amount input + currency control + Pay button.
5. Memo input ("Add a note (optional)").
6. Feedback block ("You get..."), status line, terminal notice, prompt footer.

## Currency control
- Tokens = terminal accountingContextsOf (direct) + ETH/USDC via router ONLY if
  surface.hasRouter AND routerPayRouteWorks probe passes (dead route = trap).
- Select valued by INDEX not address (same address can appear direct+router).
- chooseRefinedPayToken: keep user pick only if tokenTouched, else default to
  list[0] = real accounting token (fund-loss desync fix: dropdown showed USDC,
  tx paid 1 ETH).
- Amount parsed in the SELECTED token's decimals (ETH 18, USDC 6).
- currency id = t.currency ?? uint32(uint160(address)).

## Preview ("You get")
- computePayPreview → previewPayFor (view, no simulate), debounced 400ms,
  generation counters guard staleness.
- addbalance: "Adds to the project balance — nothing else" (+ conversion line
  for viaRouter).
- Zero-issuance suppression: verified 0 beneficiary + 0 reserved → omit token
  lines, keep NFT receipts. Verified zero CAN submit (minReturned 0); an
  UNAVAILABLE preview blocks submit ("preview unavailable").
- Routing tag: Issuance vs AMM (buyback metadata decode, 14-field tuple,
  noop=false → received=minBeneficiary, reserved=minReserved + poolId/TWAP).
- "You get" = beneficiaryTokenCount; "Splits get" = reservedTokenCount.
- payMinTokens: issuance exact; AMM discounted by slippageBps
  (quotedOutputFloor(received, 10000-bps)).
- AMM detail: pool link + "AMM: X vs Issuance: Y" (issuance side scales gross
  wouldMintByIssuance by beneficiary/(beneficiary+reserved)).

## 721 mini-shop
- shop = {hook, idTarget, store, resolver, tiers, pricing}; revnets resolve
  hook via REVOwner.tiered721HookOf, others via ruleset dataHook /
  JBOmnichainDeployer.tiered721HookOf.
- Discount: effective = price - price*discountPercent/200 (denom 200; UI "%
  off" = d/2). Unlimited if initial >= TIER_UNLIMITED_SUPPLY.
- Metadata: JBMetadataResolver envelope; id = bytes4(bytes20(idTarget) ^
  bytes20(keccak256("pay"))) where idTarget = hook's METADATA_ID_TARGET (the
  IMPLEMENTATION address, not the clone!) — wrong key = no NFT. data =
  abi.encode(true /*allowOverspending*/, uint16[] tierIds) (tier id repeated
  per qty). NFTs only mint on pay (not addbalance).
- NFT checkout: only DIRECT tokens offered (router-swapped landed context
  unprovable). Cross-currency via JBPrices.pricePerUnitOf; no feed =
  unsupported. Amount due = ceil(due * pricePerUnit / 10^pricingDecimals)
  (round UP); entered value = floor(payment * 10^dec / pricePerUnit).
- Shop credits: hook.payCreditsOf(account); cantBuyWithCredits items need
  fresh funds; applied = min(credits, subtotal - restrictedCost).

## Cash out (separate MODAL, not a pay-card tab; opened from holdings/token actions)
- "Cash out on [chain], reclaim in [token]" (multi-token: per-token pick).
- Amount in project tokens + %/Max buttons. Slippage control (0.5/1/3/5%,
  default 1%) shown only on pool routes.
- Preview: JBMultiTerminal.previewCashOutFrom(who,pid,count,token,who,0x)
  (hook-aware: nets REV fee + buyback) IN PARALLEL WITH
  JBTerminalStore.currentReclaimableSurplusOf (no-hook curve; gap = REV fee).
- Fee layering: afterHook = preview reclaim; REV fee = hook-spec amounts where
  !noop && hook==dataHook; protocol fee = reclaim/40 if taxRate>0 else
  min(reclaim, feeFreeSurplus)/40; net = afterHook - protocolFee. Fee mints
  JB#1 tokens back to holder (fee receipt shown).
- Surplus = currentSurplusOf (balance - remaining payout limit), token's own
  decimals. Curve: reclaim = surplus * share * ((1-tax) + tax*share).
- Gating: preview revert → check revnet cashOutDelay → countdown + disable;
  else hard-block (never estimate). 100% tax → "Cash outs are off". Zero
  floor → reject send. Min floor: 99% of previewed net (quotedOutputFloor
  9900); standalone uses 95%.
- Routes: treasury | amm (buyback via terminal, works on credits) | directsell
  (UR V4 swap, claimed ERC-20 only, no 2.5% fee).
- Call: cashOutTokensOf(holder, pid, count, tokenToReclaim, minReclaimed,
  beneficiary, metadata) — metadata 0x treasury / buildCashOutAmmMetadata.

## Router + direct-swap
- (A) viaRouter pay: JBRouterTerminalRegistry same pay signature; ERC-20 via
  gasless Permit2 signature metadata (keyed getId("permit2", router));
  native via msg.value. addbalance+viaRouter refused (no min-out field).
- (B) Direct AMM swap (plain native/USDC buys, no NFTs): poolKeyOf pool; if
  quoteDirectSwap (V4 Quoter) > pay route output → UR execute V4_SWAP;
  amountOutMinimum = floor by slippage; "splits take 0" note. Mirror for
  cash-out: directsell.
- feeWillRoute probe: primaryTerminalOf(#1, token) + previewPayFor(#1) live
  ruleset id != 0 (accountingContextForTokenOf is a FALSE probe). Dead route
  → fee forgiven → NO fee note.

## Submit (doPay)
- Gates in order: start-time, contextsReady, amount>0, NFT floor (bump amount
  up + re-review), wallet connect (connect then ask to re-click), FREEZE
  reviewed state + payInputsUnchanged re-checks after every await, payment
  surface allows terminal, wallet balance pre-flight.
- pay(projectId, token, amount, beneficiary=account, minReturnedTokens, memo,
  metadata) value=amount if native; addToBalanceOf(pid, token, amount,
  shouldReturnHeldFees=false, memo, metadata) mints nothing.
- Confirm modal itemizes: chain, contract, function, decoded calldata, value,
  approval, NFT mints, minReturned + slippage note, memo. Then send, status
  "Payment processing" → "confirmed" + explorer link; success clears cart,
  refreshes credits, dispatches project-updated.

## Revnet differences
- USDC swap option injected for isRevnet (router installed by REVDeployer).
- Rule-change notice links Terms tab (revnet) vs Rulesets.
- Shop hook via REVOwner.tiered721HookOf.
- Cash out: REV fee 2.5%-of-tokens to fee revnet (FEE_REVNET_ID) + delay lock
  countdown (readCashOutDelay).
- Pay card otherwise identical.

## Constants
- Pay AMM floor: received*(10000-bps)/10000; standalone flat 99%.
- Cash-out fee: reclaim/40; min floor 99% modal / 95% standalone.
- Discount denom 200. Beneficiary always connected wallet on project card.
- No beneficiary field on project card (standalone has one).
