# Parity with Juicescan and revnet.money (2026-11-13)

jango: fix everywhere juicebox.money is behind Juicescan, align revnet.money (revnet scope), thorough, unsure items in one list at the end. Source reports: scratchpad `parity-1..5-*.md`, `parity-rev-*.md` (juicebox.money 0512c604).

- [x] B1 Holder actions: cash out, loan and burn run on any chain the holder holds on; the cash out delay is named in the cash out flow; the prepaid fee range reaches the protocol maximum. Held for jango: claim credits and the credits line for revnets.
- [x] B2 Pay: a failed credit read blocks checkout with a retry (`shopCheckoutBlocked`). Not changed after re-reading: Pay stays enabled on a short balance because the button offers the card or bank purchase; the unread credit flag already fails closed here (the gap was Juicescan's).
- [x] B8 Tickers read without a dollar sign (jango, 2026-11-13).
- [x] B10 Token deploy: a token extended to a new chain keeps the salt that reproduces its address, the older Juicescan salt included (`tokenDeployPlan`); the review says whether the address matches, and a first deploy says that later chains need the same account, name and symbol.
- [ ] B9 From jango's rulings of 2026-11-13, not built yet: buyback hook and router terminal resolved through the ruleset data hook, and the revnet fee netted in cash out values, both moved into the SDK; one `.jb` format shared with Juicescan and revnet.money; a Safe pays with approval and payment in one batch; Relayr first, ordered sends as the fallback.
- [ ] B3 Shop: remove item, set discount, edit name and description. Not built yet: each needs its own snapshot action, call policy and review modal on the `shop-batch` pattern.
- [ ] B4 Rulesets: approval hook, base currency, custom duration; surplus allowance for operators and other chains.
- [ ] B5 Read surface: done: data hook rows in the ruleset detail, words for the empty activity state, a "Rules change in" line above the pay card (`RulesChangeNotice`). Open: unknown-contracts warning, bridge moves labelled in activity, activity chain filter.
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
- [ ] Commit façade work and merge latest main.
- [ ] Verify candidate on merged main, preserving locked dependency graph.
- [ ] Update to published SDK6.7.0 and coordinate reviewed PR/merge.
