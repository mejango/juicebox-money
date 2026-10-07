# Project navigation performance

Required workspace resources: `/Users/jango/Documents/jb/v6/evm/AGENTS.md`, `workflow/ponytail/SKILL.md`, `workflow/ponytail/README.md`, `docs/PLAN_REFINEMENT.md`, `tasks/lessons.md`; local `AGENTS.md` applies. Parent execution plan: `/Users/jango/Documents/jb/v6/evm/docs/WEBSITE_PERFORMANCE_IMPLEMENTATION.md`.

## Plan refinement

- **Objective:** Keep pretty project URLs and make same-project tab/hash/history navigation client-local while revalidating mutable aliases within a five-second successful verification window.
- **System fit:** The existing server resolver remains the sole authority for alias identity; a read-only endpoint and route snapshot feed the existing client route provider. Changed identities reset project UI, failed verification blocks stale actions, and durable transaction recovery and fresh execution checks retain their existing owners.
- **Reuse and simplicity:** First extract the resolver without changing behavior, then reuse TanStack Query for a five-second, nonpersistent success cache. Reuse existing hash updates and retained tabs; add one route boundary rather than another routing framework.
- **Evidence and unknowns:** Existing alias hash/popstate handlers call document reload, and project-scoped cart/state is not keyed. Refresh merges RSC without resetting client state, so a successful snapshot acknowledgement and identity key are required; endpoint errors cannot prolong stale identity.
- **Verification:** Run resolver regressions before the behavior change, then transition tests for same-identity reuse, expiry, rebinding, failed verification, late responses, history restoration and encoded aliases. Check exact serial IDs and no-store endpoint behavior. Parent owns combined build/browser/release gates.
- **Resource budget:** Isolated perf/jbm-navigation worktree, Node 26.7, existing installed dependencies and focused tests only. Coordinate shared page imports with server worker; no builds, pushes or deployments.

## Work

- [ ] Extract route resolver; preserve behavior and verify.
- [ ] Add shared snapshot/endpoint, bounded client verification and keyed project boundary.
- [ ] Route hash/history transitions through verification, preserve same-project state, block stale actions.
- [ ] Verify transitions, API behavior, type/lint checks and document result.
