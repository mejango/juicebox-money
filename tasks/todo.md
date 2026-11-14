# Parity with Juicescan and revnet.money (2026-11-13)

jango: fix everywhere juicebox.money is behind Juicescan, align revnet.money (revnet scope), thorough, unsure items in one list at the end. Source reports: scratchpad `parity-1..5-*.md`, `parity-rev-*.md` (juicebox.money 0512c604).

- [x] B1 Holder actions: cash out, loan and burn run on any chain the holder holds on; the cash out delay is named in the cash out flow; the prepaid fee range reaches the protocol maximum. Held for jango: claim credits and the credits line for revnets.
- [x] B2 Pay: a failed credit read blocks checkout with a retry (`shopCheckoutBlocked`). Not changed after re-reading: Pay stays enabled on a short balance because the button offers the card or bank purchase; the unread credit flag already fails closed here (the gap was Juicescan's).
- [x] B8 Tickers read without a dollar sign (jango, 2026-11-13).
- [x] B10 Token deploy: a token extended to a new chain keeps the salt that reproduces its address, the older Juicescan salt included (`tokenDeployPlan`); the review says whether the address matches, and a first deploy says that later chains need the same account, name and symbol.
- [x] B9 SDK rules (needs SDK 6.6.0, PR Bananapus/juice-sdk-v4#307): ERC-20 pay asks a plain wallet for a free Permit2 signature (after one approval of Permit2), a Safe or contract wallet for the exact approval (`planErc20PayAuthorization`); the buyback card and Market resolve the hook and router terminal through the ruleset's data hook (`resolveProjectBuybackHook`, `resolveProjectRouterTerminal`); a revnet's own cash out fee is netted in the holder value, the market floor and the price charts. Still open from the same rulings: one shared `.jb` format (schema question with jango).
- [x] B10 Safe pay as one batch: an ERC-20 payment from a Safe app goes as one proposal of the approval and the payment (core's `batch`), settling as the payment (`useStepRun`). A resumed run still proposes step by step.
- [ ] B11 Relayr first, ordered sends otherwise: not built. A first version (core's sequence journal under `runAuthorityCalls`) was withdrawn after three Codex passes: dropping an unfinished run when the wallet does something else can resend a confirmed call, and keeping it can resume past a call that no longer holds. It needs a journal keyed by the flow, which refuses a changed request until the person finishes or discards the old run, as Juicescan's does: a `scope` from each caller and a Discard exit. Question with jango. revnet.money already sends in order (`runSequentialWrites`).
- [x] B12 The shared `.jb` file, version 2 (rulings of 2026-11-14, needs SDK 6.8.0): `src/lib/jb-draft.ts` maps the SDK's `JbDraft` to and from the create form and refuses a file holding what the form cannot express, each by name; import, export and the Extras export go through it; the browser's saved draft keeps the form's own shape and no longer reads another site's file. Logo, cover and item media pin when chosen, so a file carries their URIs. `/llms.txt` and `public/examples/project.jb` state the new fields. No version 1 import.
- [x] B3 Shop: remove item, set discount, edit name and description, each from the item detail (see the 2026-11-14 shop item actions section below).
- [x] B12 Set terminals sends an empty list only with Allow an empty list turned on (it stops payments and cash outs); the card and a queued batch step share the rule (`emptyWith`, `parseAddressList`), and a step saved before the field reads as off. Same field in Juicescan.
- [x] B11 Owner calls Relayr cannot take (one chain twice, an unsupported chain, a target without the forwarder) are reviewed once and sent in order from the wallet, under core's journal keyed as revnet.money keys its own (account, and each call's chain, target and function): the same calls continue after the last confirmed one, other arguments replace the run, and a run left unfinished stays direct. Relayr is still tried first. jango's ruling of 2026-11-14 (match revnet.money), with its known weakness: set X on two chains, fail on the second, set Y by another route, request X again, and the old run resumes past the first chain.
- [x] B4 Rulesets: Edit rules takes any cycle length, a rule-change notice and the issuance currency; the surplus allowance runs on any chain and for operators (see the 2026-11-14 ruleset section below). Not built, for jango: a field for a new custom approval contract; the allowance for a Safe signer not connected as the Safe.
- [x] B5 Read surface: done: data hook rows in the ruleset detail, words for the empty activity state, a "Rules change in" line above the pay card (`RulesChangeNotice`). An activity chain filter (a native select of the chains in the loaded events, display order; `activityChains`, `activityOnChain`). Inbound bridge claims already read "claimed X from Chain" (`bridgeClaimEvent`). A bridge send reads "sending X to Chain" and the cash out the sucker makes inside it is hidden (`withoutBridgeCashOuts`). The project page warns about contracts it does not recognize (`auditProjectContracts`, `ProjectContractWarning`).
- [x] B6 Copy: "cash out" written open, chain slugs in display order, logo hint matches the 25 MB check, fees to JBP6, account title without a dash, each client names the other's `.jb` draft. Not changed after checking the recorded rules: there is no blanket em dash rule (only page titles) and no rule against `$` tickers, so both go to the end list.
- [x] B7 Buyback card: a pool registration at exactly the maximum TWAP window is refused (the hook stores 30 minutes). Held for jango: resolving the current hook and router terminal through the ruleset data hook, as revnet.money does, belongs in the SDK.

## Plan refinement
- **Objective:** For the same action on the same project, juicebox.money does what Juicescan and revnet.money do where they are ahead, and breaks none of the ruled copy rules.
- **System fit:** Flows keep their owners (`CashOutFlow`, `GetLoanFlow`, `BurnTokensFlow`, `PayPanel`); the You card owns which chain an action runs on, from the already verified linked deployments. Rules shared with revnet.money that live in neither SDK nor one client go to the end list rather than a third copy.
- **Reuse and simplicity:** The chain picker passes a verified `[chainId, projectId]` pair into the existing flows, which already take both as props; no flow changes. Native select.
- **Evidence and unknowns:** Reports are subagent readings, re-read before each change. Whether revnets can hold credits is unverified until the contract is read.
- **Verification:** A unit test per rule, `npm run check` with budgets and browser tests per PR, CI green before asking to merge.
- **Resource budget:** One worktree, edits in the main session, one full gate per PR.



## 2026-11-13: Trusted-site Safe API through Center

## Plan refinement
- **Objective:** Center keeps SAFE_API_KEY server-side and proxies Safe Transaction Service requests from its existing trusted sites; revnet and juicebox.money use the proxy, eliminating browser-key setup. Success includes authenticated upstream calls, exact response/status propagation and no key exposure.
- **System fit:** Existing Center /v1 origin policy and Store budgets govern the new narrow proxy; SDK owns Safe endpoint selection and retry behavior; both client roots opt into their existing Center environment. Signing, Safe hash verification and execution stay in existing owners. Deployment/key configuration are separate from tested local code; user supplies key via server environment.
- **Reuse and simplicity:** Reuse fixed Safe chain prefixes and existing origin/rate-limit/body/fetch patterns. Add a narrow SDK configuration point rather than app-local Safe transports or persisted localStorage mutations. No arbitrary target URLs, no new dependency, no server-side transaction signing.
- **Evidence and unknowns:** Current origin/main Center f6b033b and SDK641e385 are newer than dirty local checkouts; use isolated worktrees. Installed SDK requests directly and retries monthly429. Safe API docs confirm bearer auth and account quotas. Center trusts exact configured origins; origin checks are browser policy, not cryptographic caller authentication, so shared/per-client limits remain necessary.
- **Verification:** Proxy tests cover allowed/denied origins, endpoint/method/path validation, credential forwarding and non-disclosure, redirects, upstream errors, size/time limits and budgets. SDK tests cover opt-in routing, preserved default/custom routes and monthly-quota no-retry. Run relevant checks and both full client suites before any proposed push; no publishing or main pushes without approval.
- **Resource budget:** Delegate Center implementation and SDK implementation separately after this plan gate; parent integrates paired clients and reviews boundaries. Reuse dependencies only with matching lockfiles; serialize heavy gates. Replan on missing auth/hosting capability rather than broadening proxy access or exposing the key.

- [ ] Implement and test bounded Center Safe proxy.
- [ ] Implement SDK opt-in routing and quota retry handling.
- [ ] Integrate revnet and juicebox.money together, verify with candidate SDK.
- [ ] Review changes and document exact deployment/key activation steps and outstanding authorization.


## Plan refinement
- **Objective:** Route every Safe service call through Center while preserving lazy loading on pages without Safe features.
- **System fit:** SDK remains transport owner; one local configured re-export module supplies the existing SDK API to browser and server callers, before requests execute.
- **Reuse and simplicity:** Reuse safe-service-config and replace direct SDK imports with that owner; remove eager root bootstrap and duplicate authority bootstrap. No new transport or asynchronous initialization.
- **Evidence and unknowns:** Full revnet candidate tests3168 passed but eager root config added approximately20KiB to static route bundles. Actual rebuilt route budgets will determine success.
- **Verification:** Enforce configured import boundary in source checks; retain browser/server first-read routing tests; rerun full consumer checks and measure budgets without blanket increases.
- **Resource budget:** Import rewrites only, bounded frontend gates; preserve all SDK candidate code and other bot work.


## Plan refinement
- **Objective:** Integrate the reviewed Safe service façade with merged JBM PR181 and release SDK6.7.0 after all consumer checks pass.
- **System fit:** Preserve latest main SDK6.6.0 behavior and the local configured transport owner; signing, recovery and authority remain in SDK. User authorized merge; coordinate external mutations with parent.
- **Reuse and simplicity:** Commit current import/configuration work then merge origin/main normally; preserve exact non-SDK locked dependencies and existing paired-client tests.
- **Evidence and unknowns:** Parent reports main67e4a881 and candidate SHA25691b1f6405530cf81760b28622f572f1b9ced87ea306577078c07cf388087eb41; verify fetched commit and installed graph. Candidate package metadata6.5.0 is temporary verification only, never committed as release6.7.0.
- **Verification:** Source invariants and first-read tests, full npm check in the granted exclusive slot, then published dependency and lock verification before PR/merge.
- **Resource budget:** JBM worktree only; hold heavy checks for parent slot; do not disturb other bot branches or non-SDK versions.
- [x] Commit façade work and merge latest main.
- [x] Verify candidate on merged main, preserving locked dependency graph.
- [ ] Update to published SDK6.7.0 and coordinate reviewed PR/merge.

### JBM integration verification (2026-11-14)
- Façade commit69f8c5f4, normal merge4d3199f5 includes main67e4a881 (SDK6.6.0 and paired-client corrections).
- Candidate tarball SHA25691b1f6405530cf81760b28622f572f1b9ced87ea306577078c07cf388087eb41 installed with npm12.0.1 on Node26.13.1. All non-SDK lock records and1110 installed non-SDK package manifests unchanged. Temporary file dependency satisfied dependency validation, then original tracked6.6.0 package/lock restored for example-version fixtures; no fabricated release metadata.
- Dependency, dead-code, production-audit, container, lint, type, source-invariant, protocol, live-schema, transaction and wallet gates pass. First coverage attempt passed3622 tests and failed only6 example-pin fixtures due to the temporary file dependency; rerun with restored actual6.6.0 manifest passed3628/3628 tests in298 files and all coverage thresholds. Candidate code remained installed throughout. Browser build passed. Budget checks passed after minimal rounded project543KiB and aggregate2725KiB ceilings (measured542.0KiB and2724.3KiB); static-route ceilings and lazy-wallet checks unchanged. Browser tests90/90 passed on isolated appport3198 and original build fixture4399; first browser startup was blocked by another process already occupying3100, with no assertions run.

### Published SDK and final integration (2026-11-14)
- Normal merge70160383 includes mainf83dc5f3 (PR182 activity filtering and explicit empty-terminal acknowledgement) without conflicts. Earlier full candidate evidence remains bound to67e4a881; final combined head will run the full remote CI.
- Installed actual registry SDK6.7.0 after successful automated release43557177856 and metadata propagation. All1939 package files match the checked91b1f640 candidate except package.json; no extra/missing files. All1110 non-SDK installed manifests and lock entries unchanged. Evidence:/tmp/jbm-sdk670-equivalence.json.
- Explicit Node26.13.1/npm12.0.1 final installation/dependency check,84 focused tests across7 files (routing, documentation pins, PR182 behavior, queue/account integration), types and source invariants pass. Prior full tests/build/browser used Node26.13.1 with npm-run launcher11.20.0 due PATH ordering; candidate install used explicitnpm12. Final remote CI enforces the declared toolchain. No fullsuite rerun solely for launcher choice.
- Examples now pin6.7.0 while retaining the original6.6.0 live-read/simulation attribution. Awaiting exact-head remote CI and paired-client merge coordination.

- Final CI on41dd4518 passed Test/build11m12s and OCI3m23s. MainPR183 then introduced ordered direct owner sends and a budget-comment conflict. Normal mergef917cace preserves both behaviors and the configured authority import;64 authority/routing tests, types and source checks pass. Fresh combined browserbuild passes, with aggregate2725.1KiB requiring only rounded2726 cap; project542.2KiB stays below543 and all static-route caps stay unchanged. Final corrected head receives new full remote CI.

## 2026-11-14: Shop item actions (B3)

- [x] `shop-batch`: one table of shop actions (permission, wording, whether the item's metadata is rewritten); `readShopSnapshot` and `reverifyShopCall` read it. A removed item no longer passes `readShopTier`.
- [x] Builders: `buildSet721DiscountRequest`; removal through the existing `buildAdjustTiersRequest`; `buildShopItemCalls` for media, details, discount and removal.
- [x] One item modal with a mode (media, details, discount, remove); the item detail offers each action the viewer may take, a Safe signer included.
- [x] Tests with `wallet-action:` markers, inventory rows, full `npm run check`, Codex until clean.

### Review
Built on the reviewed shop batch: `SHOP_ACTIONS` names each action's permission (remove 24, discount 27, details and media 25), its call and whether it rewrites metadata; `reverifyShopCall` holds saved bytes to the reviewed action on the reviewed item. The item detail offers each action to the owner, a signer of the owner Safe (who was not offered Replace media before) or an operator with the permission. Codex, three passes: pass 1 (the new description was missing from the review), pass 2 (older `productName` keys kept the old name on screen; a chain already at the new discount blocked the rest; a locked page chain hid removal for peers), all fixed with tests. Pass 3 set aside, for jango: an item with no IPFS file (metadata from a custom resolver) cannot be removed or discounted here, since linked chains are matched on that file; actions are offered by the viewer's rights on the chain the page shows, so a viewer with rights only on another chain switches to it first. `npm run check` gates pass (3660 unit tests, budgets with all scripts raised 2736 to 2738 on a measured 2737.4, 90 browser tests run on port 3187 because 3100 was held by another process). Not rendered in a browser with an owner wallet.

## Plan refinement
- **Objective:** A shop owner or operator can remove an item, set its discount and edit its name and description on juicebox.money, on every linked chain that holds the same item, as on Juicescan.
- **System fit:** These are three more actions on the existing reviewed shop batch (`shop-batch`, `runProjectBatch`), which already owns authority resolution (owner, Safe signer, operator), the per-chain snapshot, freshness re-check and recovery journal. No new send path.
- **Reuse and simplicity:** The media modal becomes one item modal with a mode, not three copies. Removal uses the existing `adjustTiers` builder. The percent to 200-point conversion gets one home (`discountUnits`) used by launch, add items and this action.
- **Evidence and unknowns:** Contract facts from `nana-721-hook-v6` (subagent reading, re-read where the code depends on it): removal reverts on `cantBeRemoved`; a discount reverts on a removed item, above 200, or an increase under `cantIncreaseDiscountPercent`; `setMetadata` never checks that an item exists, so the client must. Peer chains are matched on the item's metadata URI, as media does.
- **Verification:** Unit tests for each call's exact bytes, each permission id, each refusal, and the modal journey per mode; `npm run check`; Codex review until clean.
- **Resource budget:** One branch stacked on the `.jb` branch, one full gate, review passes as needed.

## 2026-11-14: Ruleset choices and the surplus allowance (B4)

- [x] One cycle length control and model for the create form and Edit rules (`DurationSelect`, `durationFieldsSeconds`, `durationFields`); a custom length is 1 second to uint32 seconds.
- [x] Edit rules: the rule-change notice as a choice, sent as each chain's own deadline contract (`deadlineHookAddress`); an unknown contract stays unless the notice changes.
- [x] Edit rules: issuance priced in ETH or USD, behind a live probe of the price pairs the new currency adds on every selected chain (`newBaseFeedPairs`, `probeFeedPairs`).
- [x] Funds: the surplus allowance on any chain of the project, for the owner or a holder of USE_ALLOWANCE (`canUseAllowance`).

## Plan refinement
- **Objective:** An owner can queue, from juicebox.money, the same ruleset choices Juicescan offers (cycle length, approval condition, base currency), and the surplus allowance is usable by whoever the contract lets use it, on whichever chain holds it.
- **System fit:** Edit rules keeps one editor state per stage; the per-chain carry-over copies only changed fields, so chain-neutral values (a notice choice, a currency id) carry and chain-specific addresses are resolved at encoding. The create form already owns these models, so they move to shared homes instead of second copies.
- **Reuse and simplicity:** The create form's duration control, deadline table and feed probe are reused. No new send path: the queue still goes through `runAuthorityCalls`, the allowance through `useReviewedAction`.
- **Evidence and unknowns:** `JBRulesets` bounds duration to uint32 and requires an approval hook to pass ERC-165, which a known deadline contract does. A changed base currency needs a JBPrices pair for each accepted token; the probe reads the project's own feeds, then the defaults.
- **Verification:** Unit tests for the duration model, the per-chain notice address, the base currency carry-over and added pairs, and the allowance rights; `npm run check`; Codex until clean.
- **Resource budget:** One branch stacked on the shop actions, one full gate, review passes as needed.

### Review
Codex (`gpt-6.1-sol`) came back CLEAN on the first pass. `npm run check` gates pass: 3667 unit tests, budgets (all scripts raised 2738 to 2741 on a measured 2740.1), 90 browser tests on port 3187 (3100 held by another process). Not rendered in a browser with an owner wallet.

## 2026-11-14: Bridge sends in activity and the unknown contracts warning (B5)

- [x] Activity: the feed reads `bridgeToOutboxEvent` and shows "sending X TOKEN to Chain"; a cash out whose holder is that event's sucker, in the same transaction, makes no row. Project feed and home rail share the rule.
- [x] Project page: one audit per chain of the controller, terminals, rule-change hook, data hook, omnichain extra hook and buyback hook against the SDK's known deployments, the address registry's deployer, and the project's verified Defifa game. A failed read says the check did not finish.

## Plan refinement
- **Objective:** juicebox.money says the same two things Juicescan says: a bridge send is a send, and a project pointing at a contract the app does not know carries a warning. Success is both shown from live data shapes with tests.
- **System fit:** The feed rule lives beside the other feed filters in `ActivityList`; the audit is a pure reader in `src/lib` that a client card displays, read through the paced browser RPC lanes after the page loads, so page renders and crawlers cost no RPC.
- **Reuse and simplicity:** SDK `knownAddressName`, `getCurrentRuleset`, `resolveProjectBuybackHook`, `getProjectNftInventory`. Juicescan's extra 721 clone identity reads are skipped: its own fallback accepts any instance from a known deployer, so the result is the same.
- **Evidence and unknowns:** One live Bendystraw transaction shows the outbox event and the sucker's cash out side by side with matching sucker and holder. The audit run against 17 live Base projects flags one, project 20's extra data hook, which has no registry deployer and is not in Juicescan's table either. Unknown: the SDK table lacks Defifa deployers and old LP split hook generations, which no audited role uses today.
- **Verification:** Unit tests for the feed rule, the audit and the card; `npm run check`; Codex until clean.
- **Resource budget:** One branch stacked on the ruleset editor, one full gate, review passes as needed.
- **Authority and recovery:** Draft PR only, merged on jango's word. Two commits for the feed, one for the warning; each reverts alone.
- **Agent-system impact:** None.

### Review
- Activity: a bridge send (`prepare` on a sucker) reads "sending X TOKEN to Chain" by the account that called the sucker; the cash out the sucker makes inside it is dropped in the one grouping function, so the project, account and homepage feeds agree. A bridge claim names the account inside a 32-byte beneficiary.
- Project page: `auditProjectContracts` checks the controller, terminals, the terminal a known router registry forwards to, the rule-change hook, the data hook, the omnichain deployer's extra hook and the buyback hook for payments and cash outs. A failed read says the check did not finish instead of showing a clean project. Run live against 17 Base projects: only project 20's extra data hook was named.
- The check's readers and RPC client load on demand. Budgets raised with measured numbers: `/[urn]` 543 to 544 KiB, all scripts 2741 to 2744 KiB.
- Verification: full `npm run check` green (3687 unit tests, 90 browser tests). Codex `gpt-6.1-sol` six passes: seven findings fixed, one set aside (a send and its inner cash out split across a 250 event page, self-correcting on Load more), pass 6 CLEAN.
- Not done here: Croptop's deployer is a constant in the audit until the SDK table has it; revnet.money has no such card yet. New copy for jango: "Bridged out", "Bridge sends", "sending X to Chain", the two contract card titles and their sentences, "Router terminal".
