# Project server performance

Workspace resources (also apply in this isolated checkout): `/Users/jango/Documents/jb/v6/evm/AGENTS.md`, `/Users/jango/Documents/jb/v6/evm/workflow/ponytail/SKILL.md`, `/Users/jango/Documents/jb/v6/evm/workflow/ponytail/README.md`, `/Users/jango/Documents/jb/v6/evm/docs/PLAN_REFINEMENT.md`, root `tasks/lessons.md`, and this repository's `AGENTS.md` and `tasks/lessons.md`. Parent authorization and integration plan: `/Users/jango/Documents/jb/v6/evm/docs/WEBSITE_PERFORMANCE_IMPLEMENTATION.md`.

## Plan refinement

- **Objective:** Show project identity promptly, let activity stream independently, remove repeated page/metadata/preview reads, and reuse successful public display reads for explicit nonzero windows without turning unavailable data into verified empty data.
- **System fit:** The server display owner feeds the project route, metadata and link preview. Raw fallback/existence and the live alias authority resolver preserve their contracts; cached display is not alias or transaction authority. Retry and confirmed local edits invalidate the affected display records; negative/error reads remain immediately retryable.
- **Reuse and simplicity:** Extract request-scoped React cache ownership first and commit parity checks. Reuse installed TanStack QueryClient.fetchQuery for bounded per-process display freshness; Next unstable_cache revalidate serves expired data while revalidating and can retain it after failures, which does not enforce this owner's hard freshness contract. Keep existing Next metadata fetch caching at its content-addressed URI, and existing read/write SDK paths.
- **Evidence and unknowns:** Clean baseline 096540c; source shows duplicate preview identity reads, a blocking 250-event fetch, no-store sibling reads, and later authority reads. Installed Next16.3.8 docs were reviewed. Successful indexed project and complete group display records use30s freshness with5min inactive eviction; actual activity data uses15s freshness including its completion timestamp. Identity/existence failure and incomplete group results are never stored as successes. Alias revalidation remains owned by the navigation worker and raw live authority functions.
- **Verification:** Focused tests prove request reuse, hard expiry, failed/negative retry, chain/project isolation, explicit invalidation, activity timestamp age, and delayed activity independence. Preserve fallback/404/redirect, metadata/preview, chain completeness and fresh authority checks. Parent integration owns full pinned-toolchain build/browser/release gates and deployed comparison.
- **Resource budget:** One isolated worktree at .worktrees/perf-jbm-server, existing node_modules symlink used read-only with Node26.7.0; no installs, shared build outputs, network, deployment or original-main edits. Separate extraction commit from behavior changes; coordinate client timestamp and server cache rules before editing those boundaries.

- [x] Extract one request-scoped project display read owner; run existing fallback and preview checks; commit separately.
- [ ] Add successful-only30s display freshness and explicit exact-project invalidation; preserve raw authority/existence readers and retry semantics.
- [ ] Stream activity with actual successful read timestamp, preserving existing full feed/category/paging semantics.
- [ ] Decouple initial indexed identity from onchain metadata reconciliation and independent activity/history; preserve later metadata correctness.
- [ ] Run focused regressions, types, touched-file lint and source gates; record evidence and commit.

Extraction review: shared React request memoization now owns page and preview identity resolution; raw fallback/API authority contracts are unchanged. Existing fallback, preview, project-name, OG availability and handle checks:57 tests across5 files pass under Node26.7.0. Whitespace check passes.
