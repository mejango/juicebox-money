# Parity with Juicescan and revnet.money (2026-11-13)

jango: fix everywhere juicebox.money is behind Juicescan, align revnet.money (revnet scope), thorough, unsure items in one list at the end. Source reports: scratchpad `parity-1..5-*.md`, `parity-rev-*.md` (juicebox.money 0512c604).

- [ ] B1 Holder actions: cash out, loan and burn run on any chain the holder holds on; cash out delay named in the cash out flow; prepaid fee range to the protocol maximum; claim credits and the credits line for revnets.
- [ ] B2 Pay: insufficient balance blocks before review; a failed credit read blocks checkout; unknown credit flag.
- [ ] B3 Shop: remove item, set discount, edit name and description (or stop advertising "reprice").
- [ ] B4 Rulesets: approval hook, base currency, custom duration; surplus allowance for operators and other chains.
- [ ] B5 Read surface: unknown-contracts warning, "Rules change in" notice, bridge moves labelled in activity, activity chain filter, data hook rows.
- [ ] B6 Copy rules: em dashes out, "cash out" open, tickers without `$`, JBP6, chain order in llms.txt, logo size hint.

## Plan refinement
- **Objective:** For the same action on the same project, juicebox.money does what Juicescan and revnet.money do where they are ahead, and breaks none of the ruled copy rules.
- **System fit:** Flows keep their owners (`CashOutFlow`, `GetLoanFlow`, `BurnTokensFlow`, `PayPanel`); the You card owns which chain an action runs on, from the already verified linked deployments. Rules shared with revnet.money that live in neither SDK nor one client go to the end list rather than a third copy.
- **Reuse and simplicity:** The chain picker passes a verified `[chainId, projectId]` pair into the existing flows, which already take both as props; no flow changes. Native select.
- **Evidence and unknowns:** Reports are subagent readings, re-read before each change. Whether revnets can hold credits is unverified until the contract is read.
- **Verification:** A unit test per rule, `npm run check` with budgets and browser tests per PR, CI green before asking to merge.
- **Resource budget:** One worktree, edits in the main session, one full gate per PR.

