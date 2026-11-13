# Parity with Juicescan and revnet.money (2026-11-13)

jango: fix everywhere juicebox.money is behind Juicescan, align revnet.money (revnet scope), thorough, unsure items in one list at the end. Source reports: scratchpad `parity-1..5-*.md`, `parity-rev-*.md` (juicebox.money 0512c604).

- [x] B1 Holder actions: cash out, loan and burn run on any chain the holder holds on; the cash out delay is named in the cash out flow; the prepaid fee range reaches the protocol maximum. Held for jango: claim credits and the credits line for revnets.
- [x] B2 Pay: a failed credit read blocks checkout with a retry (`shopCheckoutBlocked`). Not changed after re-reading: Pay stays enabled on a short balance because the button offers the card or bank purchase; the unread credit flag already fails closed here (the gap was Juicescan's).
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

