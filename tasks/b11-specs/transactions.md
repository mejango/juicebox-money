# B11 spec — website/ project-page TRANSACTION inventory (scout, 2026-07-16)

Dispatch engines in website/: executeTransaction (single-chain: decoded
confirm → chain switch → account-unchanged recheck → ERC20 approve →
MANDATORY simulateContract → write(simulation.request) → receipt);
runAuthorityActionAcrossChains (EOA→Relayr bundle one-payment / Safe→propose
per chain then approve+execute in Owner tab); lpSendTx (simulate→write).
jbm equivalent: useSafeTx (simulate-first) + per-chain sends (no Relayr, B9).

## Master list (48). R=revnet-only, C=custom-only, M=multichain-only
 1  pay (JBMultiTerminal | JBRouterTerminalRegistry) — anyone
 2  addToBalanceOf — anyone (no min floor by design; metadata idx 5)
 3  UniversalRouter.execute direct AMM buy — anyone
 4  cashOutTokensOf treasury (min=99% net; metadata 0x) — holder
 5  cashOutTokensOf buyback-AMM (terminal min=0, floor in hook metadata,
    re-quoted at submit, fallback treasury) — holder
 6  UR.execute direct pool sell (claimed ERC20 only; dodges 2.5% fee) — holder
 7  JBController.claimTokensFor(holder,pid,count,beneficiary) per chain — holder
 8R REVLoans.borrowFrom 2-step (step1 setPermissionsFor BURN_TOKENS to
    REVLoans if missing; minBorrow=99% of FRESH borrowableAmountFrom read,
    abort if 0 (delay-locked); prepaidFeePercent 25..500)
 9R REVLoans.repayLoan (re-read loanOf + determineSourceFeeAmount at submit;
    native value=principal+fee+fee/50 drift buffer; ERC20 approve maxRepay)
10M JBSucker.prepare (+ERC20 approve; checks: sucker pid match, remoteTokenFor
    enabled+matches dest accounting context, native-vs-CCIP infra class
    (block canonical ERC20 over native bridge), min=99% of live
    previewCashOutFrom net or 0+explicit warning when zero backing)
11M JBSucker.toRemote(token) — PERMISSIONLESS, ships whole outbox; value =
    findToRemoteValue (simulate increasing values)
12M JBSucker.claim({token,leaf,proof}) on DESTINATION chain; low-gas warning
13M JBSucker.syncAccountingData on the PEER sucker (payable, findSyncValue)
14  UniV4 PositionManager.modifyLiquidities MINT (+Permit2 multicall) — lpSendTx
15  modifyLiquidities BURN full exit (mins = 95% of displayed, 0 for zero side)
16  BannyLPSplitHook.deployPool(pid,0) (op-gated until weight ≤10% then anyone)
17  BannyLPSplitHook.addLiquidity(pid,tok,0) — anyone
18  BannyLPSplitHook.collectAndRouteLPFees — anyone
19  BannyLPSplitHook.claimFeeTokensFor — anyone
20  JBController.sendReservedTokensToSplitsOf(pid) per chain — anyone,
    disabled unless pending>0
21R REVOwner.autoIssueFor(revnetId, stageId, beneficiary) — keeper/anyone
22  JBMultiTerminal.sendPayoutsOf(pid,token,amount,currency,minOut) — anyone
    unless ownerMustSendPayouts; re-read live limit; min = quoted exact for
    token-keyed currency else 99%
23  useAllowanceOf(pid,token,amt,currency,minOut=99%,bene,bene,'') — owner/op
24  addAccountingContextsFor(pid,[{token,decimals,currency=u32(u160(t))}]) —
    owner/op, danger-gated, irreversible
25  queueRulesetsOf(pid, configs, memo) — JBController (revnets ALWAYS
    JBController to preserve REVOwner) or JBOmnichainDeployer only when live
    ruleset already uses wrapper. QUEUE_RULESETS.
26  new-shop deploy via queue (721 deployer wiring)
27  setSplitGroupsOf — fingerprint-compares live splits vs verified prefill
    before send (stale prefill can't clear recipients). SET_SPLIT_GROUPS.
28  JB721TiersHook.adjustTiers(add,[]) — per-chain hook target, tiers sorted
    by category, reserve splits 1e9-scaled. ADJUST_721_TIERS operator.
29  adjustTiers([],[tierId]) remove
30  setDiscountPercentsOf
31  setUriOf (add store categories, pinned IPFS)
32  JBProjectPayerDeployer.deployProjectPayer(...) — anyone, per chain
33  setUriOf (edit project metadata; pin JSON first)
34  setTokenMetadataOf(pid,name,symbol) (deployed branch)
35  deployERC20For(pid,name,symbol,salt=0) (undeployed branch)
36C JBProjects.transferFrom(from,to,pid) per chain — ownership IS the NFT
37R REVOwner.setOperatorOf(revnetId, operator) — zero addr relinquishes
38  JBPermissions.setPermissionsFor — OVERWRITES whole bitmap for slot
39C JBController.mintTokensOf — allowOwnerMinting flag
40C addPriceFeedFor — allowAddPriceFeed
41C JBDirectory.setTerminalsOf — allowSetTerminals
42C JBDirectory.setControllerOf — allowSetController
43C JBMultiTerminal.migrateBalanceOf — allowTerminalMigration
44C JBController.setTokenFor — allowSetCustomToken
45  JBBuybackHookRegistry.setHookFor — owner/op, AMM chains only
46  JBRouterTerminalRegistry.setTerminalFor
47  JBBuybackHookRegistry.initializePoolFor
48  Safe queue approve (tx-service or on-chain approveHash) + execTransaction

NOT project-page: burnTokensOf (Actions-tab demo only), launch (create flow),
protocol Admin tab txs.

## Cross-cutting safety requirements (acceptance criteria)
- Simulation before EVERY send; write the simulated request.
- Decoded confirm step: contract, function, args, value, approvals, notes.
- Min-param floors: pay 99% (0 only for VERIFIED zero-issuance), cash out
  99%/hook-metadata, payouts 99% (exact token-keyed), allowance 99%, borrow
  99% fresh read, prepare 99% (0+warning), LP remove 95%, swaps user slippage.
  Displayed min == sent param, re-quoted at submit.
- Account-unchanged + inputs-unchanged rechecks after every await.
- Danger gates (explicit checkbox) on irreversible owner powers.
- Infra verification: pay surface, sucker mapping/infra class, split
  fingerprints, Safe DELEGATECALL/value warnings.

## Revnet vs custom
- Operator vs Owner tab; revnet hides Powers (read-only perms); loans/auto-
  issue/setOperatorOf/cash-out-delay revnet-only; Funds/Rulesets/Tokens tabs +
  Powers + transferFrom custom-only; everything else shared.
