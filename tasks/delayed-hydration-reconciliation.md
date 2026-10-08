# Delayed hydration of persisted reads

- [x] Reproduce a delayed component hydration mismatch through an existing persisted query hook.
- [x] Reuse Sticky's kept-query adapter for JBM persisted reads, preserving ordinary queries and cache behavior.
- [x] Verify delayed hydration, later client mounts, cache updates, persisted-query ownership and focused lint.
- [ ] Reference-client owner completes final whole-app types/suites on the physical qualified preview3 dependency install.

## Plan refinement

- **Objective:** Carry the current RN/Sticky hydration correction into JBM so restored browser data never changes a component's initial hydration markup and remains immediately available afterward.
- **System fit:** Browser storage restores through query-persist after window.load, but React may hydrate individual SSR boundaries later. The query adapter must give each hydrating consumer its original empty server result before displaying the restored cache; wallet authority, final transaction reads and submission journals are unaffected.
- **Reuse and simplicity:** Reuse Sticky's existing useKeptQuery implementation, based on RN's useSyncExternalStore hydration snapshot, for the demonstrated persisted queries. JBM's persisted queries have no initialData; do not introduce a new QueryClient, observer implementation or SDK release. Ordinary unpersisted query callers retain their existing hook.
- **Evidence and unknowns:** Installed React19/TanStack5 useBaseQuery uses the live observer result as its server snapshot, and Providers restores persisted values at window.load. Installed Next16 docs describe selective hydration. A DOM regression through useShop721 with restored cache before hydrateRoot must fail before the change; enumerate every PERSIST/cachedQuery/projectTokenQuery consumer before edits.
- **Verification:** Run failed-before and passed-after renderToString/hydrateRoot coverage with recoverable-error capture, assert preserved server DOM and immediate restored data, plus later mount and revalidation behavior. Run persisted-scope and affected component tests, nonincremental TypeScript and focused lint. Reuse app owners' final full suites/builds; no browser/heavy-build slot or live wallet operation.
- **Resource budget:** One writer owns JBM query adapter/callers; a separate child owns Homerun's seed-preserving equivalent. Bound investigation to persisted query consumers and existing source tests. Stop and refine if a persisted JBM query has SSR initialData or a fixture reveals a different server-result contract.

## Review

The original useShop721Media DOM regression failed with React's hydration-mismatch error: server `Loading item`/loading=true became restored `Saved shop item`/loading=false during hydration. The fixed regression retains the original server DOM node with no recoverable error, then shows saved data. A later client mount sees saved data on its first render and follows subsequent cache updates.

All 27 persisted reads in 14 consumer modules now use the existing Sticky pattern. No persisted JBM caller has initialData or placeholderData; the persisted-scope source gate checks that assumption and prevents tagged queries (including projectTokenQuery consumers) bypassing the hydration adapter. Ordinary useQuery callers, persistence keys/tiers, data freshness and transaction paths retain their owners.

The initial persistence/DOM group passed 114 checks. The expanded group passed 16 suites/158 checks; its three holder-availability cases exposed an old wholesale TanStack mock missing skipToken, corrected to retain official exports. The final 11-suite group passed 198 checks including those three, the DOM/persistence gate and affected write/holder/pay/liquidity regressions. Focused ESLint and git diff --check passed. Full nonincremental TypeScript reported only the concurrently added RelayrPaymentNotSentError export absent from the old installed preview; no hydration errors remain. Dependency readers are drained for the reference-client owner's qualified preview3 physical install and final whole-app gates.

Homerun's companion correction reuses RN's useHydrated in its five persisted reader components, retaining server project/metadata seeds and explicit null INCOME bindings. Its separate `tasks/homerun-delayed-hydration.md` records seven DOM regressions, five failed-before cases, 76 component checks, 108 persistence checks and passing types/lint.
