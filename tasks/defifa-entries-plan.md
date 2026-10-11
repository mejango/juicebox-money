# Generic Defifa NFT inventory and verified flavor

## Plan refinement
- **Objective:** Show verified Defifa Flavor and generic native NFT tier inventory in Juicebox Money. Curve information remains exclusively in Metalog.
- **System fit:** SDK identity proves the Defifa protocol family, not application identity. Existing Center-backed SDK reads own tier names, per-tier prices, current supply and phase. No Metalog API, automatic application links or curve evidence belongs in this consumer.
- **Reuse and simplicity:** Reuse the existing bounded payment protocol query for both header flavors, and the native read-only inventory component for payment and Shop. Remove the obsolete lazy Entries view, its API/parser and dedicated fixtures/tests entirely.
- **Evidence and unknowns:** Installed SDK2.28 verifies native Defifa inventory. Unknown protocol or inventory reads remain unavailable with retry; generic pay/cash-out/management guards remain intact. Nonnumeric tier names and mixed prices exercise app-independent inventory.
- **Verification:** Run generic inventory/payment regressions, desktop/mobile no-curve/no-Metalog-link browser assertions, full pinned npm check and exact-head hosted CI before root merge/deployment.
- **Resource budget:** No new dependencies, readers or chart/math ownership. Keep existing route/largest/style/lazy budgets and measure reduced aggregate delivery after removing consumer curve code.

- [x] Reuse bounded SDK identity query without changing payment guards.
- [x] Remove consumer curve views and automatic Metalog navigation; show generic NFT tiers/phase.
- [ ] Verify generic names/mixed prices and absent curve/API/links in actual consumers.
- [ ] Complete full local and hosted checks and prepare final PR without merging.

## Authority and recovery
The latest user instruction supersedes earlier Entries requests: curve information belongs only in Metalog. Parent root owns final merge/publication; no contract changes, wallet connections or transactions are performed here. Preserve existing read-only native guards and Center access. Earlier release heads remained unmerged; branch changes remain reviewable in PR121.

## Review checkpoint
Independent source review approved the generic-only diff and 28 focused tests across six files. The phase owner matches all six real DefifaGamePhase enum values, unknown values remain unavailable, and native writer guards remain intact. Full local check has passed lint/types/source/deployment/schema/writer checks and unit coverage; optimized build/budget/browser gates and final hosted CI remain pending. No merge, deployment or transactions performed.
