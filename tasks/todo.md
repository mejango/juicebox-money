# Create flow completion: Flavor step, revnet path, full options, .jb files

Spec (user, 2026-07-16): (a) new Flavor step choosing Revnet vs Project —
move accounting context, chain select there, add project owner/operator
field; (b) revnet flavor turns Rules into Stages (REVDeployer semantics);
(c) fold remaining per-ruleset options into the friendly UX; (d) .jb
import/export like website/.

## Facts
- SDK v6 revnets: buildRevnetStageConfig (startsAtOrAfter ABSOLUTE unix,
  strictly increasing; initialIssuance 1n = inherit-with-cuts sentinel;
  splitPercent /10000; splits total EXACTLY 1e9; issuanceCutFrequency secs =
  ruleset duration; cut% /1e9; cashOutTaxRate /10000) and buildDeployRevnetTx
  (payable creationFee for new; tiered721Config switches to 6-arg overload;
  suckerConfig empty deployerConfigurations for unlinked).
- Custom-flow missing options (website/): pausePay ("Accept payments"),
  pauseCreditTransfers, owner superpowers (allowSetTerminals/Controller/
  TerminalMigration/SetCustomToken/AddAccountingContext/AddPriceFeed).

## Tasks
- [ ] A1 Flavor step (step 0): Project|Revnet picker + copy; move Chains +
      Treasury/Accounting; Owner (project) / Operator (revnet) AddressField
      defaulting to connected wallet; 5-step stepper (dynamic Rules|Stages)
- [ ] A2 Basics: ticker field (revnet requires; custom optional for store
      symbol); owner used in launch encoding
- [ ] B1 launch.ts: RevnetPlan → buildDeployRevnetTx per chain (no suckers,
      independent chains like custom flow); stages map (daysAfter cumulative
      from shared deployStart, snapped to prev cutFreq multiples)
- [ ] B2 Stage editor revnet mode: Timing (starts N days after prev),
      Tokens (issuance, cut % + every N days, split % + splits to operator
      remainder), Cash outs; hide Payouts/Owner powers; store via 721
      overload
- [ ] C  Custom stage editor: Accept payments toggle (Timing), Advanced
      subsection (pause credit transfers + 6 superpowers w/ warning copy)
- [ ] D  .jb export/import of the whole draft + localStorage persistence
- [ ] Verify: tsc, Sepolia sims (revnet single+multi stage, 721 revnet),
      screenshots; commit per phase
