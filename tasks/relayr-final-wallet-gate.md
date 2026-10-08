# Relayr final wallet gate

## Plan refinement
- **Objective:** Stop a reviewed execution payment if its live account, funding chain, connector, Safe mode, view-as state or exact quote changes during the last asynchronous check or saved-attempt callback, without unlocking an ambiguous wallet send.
- **System fit:** `relayrPay` owns the sole native payment send and `signForwardedRequest` owns the adjacent authorization signature in this module; their final live-wallet rule is shared locally. Callers and the SDK Safe Relayr controller own durable attempt markers. Final authority must be checked synchronously after all preparation, and a proven pre-wallet abort must be distinguishable from transport uncertainty.
- **Reuse and simplicity:** Reuse the JBM wallet owner's `captureWalletContext` rule, Relayr-specific Safe refusal, exact `relayrPaymentDetails` binding and SDK payment-attempt classification. Coordinate one shared typed pre-wallet-abort outcome with the SDK owner instead of duplicating journal cleanup across adapters or pretending the user rejected a wallet prompt.
- **Evidence and unknowns:** The original account check preceded awaited `reverify`, retry proof and asynchronous `onSending`. Root approved SDK-owned `RelayrPaymentNotSentError` for proven local final-guard failures. The shared `relayrWalletPaymentError` neutralizer owns preventing an invoked wallet from returning that privileged error type. Preview4 passed all 226 targeted JBM cases. The actual wallet await is never wrapped as a pre-send abort.
- **Verification:** Add deferred final-validation and marker-boundary regressions for account, funding chain, connector, Safe and view-as changes; verify exact quote rereading, explicit chain binding, proven pre-send marker cleanup and preservation after an ambiguous send. Run focused Relayr orchestration/adapter tests and scoped lint, with typecheck coordinated through the reference owner.
- **Resource budget:** One writer owns `src/lib/relayr.ts` and focused tests; the SDK owner owns shared lifecycle changes. No dependency mutation, full suite, build or browser run; keep unrelated Sticky cancellation work with root.

## Work
- [x] Establish shared proven pre-wallet-abort handling and final authority gate.
- [x] Add focused deferred race and durable recovery regressions.
- [x] Run bounded checks and release files to the reference owner.

## Review
- The payment boundary rechecks shared live wallet context, Relayr Safe refusal and exact reviewed quote synchronously after the awaited saved-attempt marker. Forwarded signatures use the same live wallet context guard; payment sends bind the reviewed chain explicitly.
- SDK pre-wallet abort classification restores a proven unsent attempt, while the shared wallet-error neutralizer preserves uncertainty for invoked-wallet failures, including branded errors with a nested rejection code.
- Qualified SDK preview4: `vitest run test/transactions/relayr-orchestration.test.ts test/transactions/relayr-editor-rechecks.test.ts --maxWorkers=2` passed 226/226 tests; scoped ESLint passed with zero warnings; `git diff --check` passed. Checks used pinned Node 26.7/npm 12.
- The reference owner retains aggregate native typecheck and full-suite qualification. Source and focused test ownership released; no commit or dependency edits in this task.
