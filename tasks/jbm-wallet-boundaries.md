# Juicebox final wallet boundaries

## Plan refinement

- **Objective:** Refuse account, chain, connector, Safe-route or View-as drift at the final authority send, Safe signature/write, and payer deployment wallet invocation; keep recovery intact.
- **System fit:** Existing reviews prepare exact actions; wallet-core acquires a chain wallet; a small wallet-context owner captures review identity and synchronously checks live authority after the last await. Existing Safe verification and payer/project journals still own result evidence and recovery. Parent owns project-batch prewrite cleanup integration.
- **Reuse and simplicity:** Reuse wagmi getAccount, assertNoViewAs, existing Safe-route checks, and real viem chain selection. One shared captureWalletContext guard replaces repeated final account-only checks, with no new orchestration or dependency. Existing SDK beforeSend remains parent-owned shared contract-write integration.
- **Evidence and unknowns:** Inspected five wallet calls in authority.ts, safe.ts and payer-relayr.ts; each lacks some final context checks. Tests currently mock wallet acquisition. Final payload chains will come from configured public clients so tests must model actual chain identity. Ambiguous wallet errors must retain intent; only explicit prewrite refusal may clear it.
- **Verification:** Add deferred simulation/reverify/onSending drift regressions for account, chain, connector, View-as and Safe route; assert no wallet call and safe persisted recovery. Run only focused authority-gas, safe-orchestration, payer-relayr and wallet-context checks plus targeted type checks. Parent runs full gates.
- **Resource budget:** Keep changes to three delegated modules, one small shared guard and their existing focused tests. No dependency writes, full suites, builds or commits. Replan if shared APIs cannot preserve cleanup or identity.

- [x] Read required resources, relevant lessons and installed Next docs; audit every delegated call.
- [x] Write failing focused late-drift regression checks (28 new cases failed before the fix; two were already protected).
- [x] Apply shared final wallet guard and exact chain payloads; integrate payer prewrite recovery and expose authority cleanup hook for parent-owned project journal.
- [x] Run focused checks and report evidence to parent.

## Review

- `captureWalletContext` is the framework adapter for live account, selected chain, connector uid and View-as checks. It captures before asynchronous preparation without prohibiting an intentional chain switch; the returned guard is synchronous.
- Authority direct/Safe app sends, Safe signatures/executions and payer deployment sends now check after their last asynchronous or persistence callback. Wallet writes explicitly supply the acquired wallet chain. Safe signatures are also checked after signing before service publication.
- Authority prewrite refusal calls `onBeforeSubmissionAborted`; parent owns precise project journal cleanup. Payer prewrite refusal restores the original unsent outcome and can resume through the real journal. Errors after wallet invocation preserve ambiguous submissions.
- Verification: 196/196 focused tests passed in authority-gas, safe-orchestration, payer-relayr and wallet-context; targeted ESLint and `git diff --check` passed. Logs: `/private/tmp/jbm-other-wallets-before.log`, `/private/tmp/jbm-other-wallets-after.log`, `/private/tmp/jbm-other-wallets-lint.log`. Parent owns final full suite, types, builds and browser verification.
