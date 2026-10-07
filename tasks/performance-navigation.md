# Project navigation performance

Required workspace resources: `/Users/jango/Documents/jb/v6/evm/AGENTS.md`, `workflow/ponytail/SKILL.md`, `workflow/ponytail/README.md`, `docs/PLAN_REFINEMENT.md`, `tasks/lessons.md`; local `AGENTS.md` applies. Parent execution plan: `/Users/jango/Documents/jb/v6/evm/docs/WEBSITE_PERFORMANCE_IMPLEMENTATION.md`.

## Plan refinement

- **Objective:** Keep pretty project URLs and make same-project tab/hash/history navigation client-local while revalidating mutable aliases within a five-second successful verification window.
- **System fit:** The existing server resolver remains the sole authority for alias identity; a read-only endpoint and route snapshot feed the existing client route provider. Positively changed bindings reset the document, failed verification blocks stale actions, and durable transaction recovery and fresh execution checks retain their existing owners.
- **Reuse and simplicity:** First extract the resolver without changing behavior, then reuse TanStack Query for a five-second, nonpersistent success cache. Reuse existing hash updates and retained tabs; add one route boundary rather than another routing framework.
- **Evidence and unknowns:** Existing alias hash/popstate handlers call document reload. Ordinary same-project views can preserve state under a verified lease; replacing only a positively changed binding avoids retaining old financial preparations. Endpoint errors cannot prolong stale identity.
- **Verification:** Run resolver regressions before the behavior change, then transition tests for same-identity reuse, expiry, rebinding, failed verification, late responses, history restoration and encoded aliases. Check exact serial IDs and no-store endpoint behavior. Parent owns combined build/browser/release gates.
- **Resource budget:** Isolated perf/jbm-navigation worktree, Node 26.7, existing installed dependencies and focused tests only. Coordinate shared page imports with server worker; no builds, pushes or deployments.

## Work

- [x] Extract route resolver; preserve behavior and verify. 705bd6e, 58 focused tests passed.
- [x] Add shared snapshot/endpoint, bounded client verification and project boundary.
- [x] Route hash/history transitions through verification, preserve same-project state, block stale actions.
- [x] Verify transitions, API behavior, type/lint checks and document result.

## Plan refinement

- **Objective:** Complete local alias navigation plus scoped approval verification without replaying declined actions or changing pretty URLs.
- **System fit:** The existing global transaction review queue captures the current project identity and awaits verification when the user approves; changed identity or canceled review declines. Final immutable transaction checks and durable recovery remain unchanged.
- **Reuse and simplicity:** Extend the existing review owner and native modal lifecycle rather than intercepting arbitrary buttons or editing thirteen write seams. Keep five-second browsing leases interaction-driven, not periodic.
- **Evidence and unknowns:** Independent review found clock-skew, force-cancellation and native top-layer dialog hazards. Report server lease age and conservatively account for transit locally; preserve unavailable errors, and close native modal presentation while gated without discarding its form state.
- **Verification:** Test >5-second review approval with unchanged identity, rebinding during verification, cancel while awaiting, stale dialog IDs, modal Retry reachability and concurrent normal/forced server resolution.
- **Resource budget:** Continue focused Node 26.7 checks, one independent reader and root-managed integration; no builds or deployments.

## Final refinement: proven alias rebinding

- **Objective and evidence:** Preserve client-local same-project tabs, hashes and graphs. Independent review found that a delayed financial preparation can enqueue after an alias has rebound, bypassing a scope captured only at enqueue time.
- **Architecture decision:** Root approved one document reload only when the authoritative endpoint positively proves a different tuple/authority. This replaces the proposed RSC refresh acknowledgement state machine and cancels old JavaScript preparations and global reviews. Expiry, unavailable evidence and unchanged proofs never reload. No transaction journal is cleared.
- **Reuse and scope:** Keep the existing review queue's asynchronous approval check and final immutable write guards. Avoid adding origin propagation across every transaction preparation owner. The boundary preserves local state while verifying the same identity; failed proof closes modal presentation so Retry remains reachable.
- **Gate:** Plan check passed: the observable goal is preserved, the exception has positive authority evidence, failure remains recoverable, durable recovery is untouched, and tests enforce exactly one reload only on a changed tuple/authority. Parent confirmed the exception explicitly before this refinement.
- **Verification:** Cover unchanged TTL checks and idle navigation with zero reloads; changed project or authority with one reload and a retained destination hash; blocked/retry with no reload; canceled/slow reviews and stale proof responses. Parent owns real-browser and combined build gates.

## Review and verification

- Node 26.7.0: 182 tests passed across 16 focused suites covering route/cache/API, retained tabs, handle editing, native modal recovery, global review and existing Safe transaction flows. The final test-only probe cleanup passed its 10 navigation cases again.
- TypeScript `tsc --noEmit`, ESLint on every changed source/test file with zero warnings, source invariants, transaction inventory and `git diff --check` passed. Next type generation had already completed for this isolated checkout; no production build was run here.
- Independent final review by `wallet_startup` found no remaining blocking issue. Earlier review findings are enforced by clock-age conversion, server failure invalidation, stale-request guards, blocked late enqueue rejection, scoped approval cancellation and modal recovery tests.
- Parent integration must place the boundary around both the new streamed project fallback and completed content. Parent owns combined build and controlled real-browser validation. No push or deployment performed.
