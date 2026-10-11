# Defifa entries and verified flavor

## Plan refinement
- **Objective:** Display original Defifa entries and native Flavor in Juicebox Money, preserving generic project behavior and read-only native inventory.
- **System fit:** SDK owns protocol identity; Metalog's bounded public API owns canonical receipt verification and chart data; Juicebox Money validates binding and displays it, without contract writers or reconstructed probabilities.
- **Reuse and simplicity:** Extract the existing PayPanel bounded identity query unchanged for header reuse; retain inventory card and native disclosure controls, installed React Query, existing explorer/download formatting, and lazy loading.
- **Evidence and unknowns:** Current main 9a3ffc2 contains verified native inventory; API Metalog schema is adding public GET CORS. Bind chain/project/hook and original pagination snapshot, reject malformed/bounded responses, and show unavailable evidence explicitly.
- **Verification:** Run parser identity/bounds/chart/status/pagination regression tests, actual UI recovery/download checks, desktop/mobile fixture browser tests, full pinned npm check and hosted CI; public API/live verification awaits API deployment.
- **Resource budget:** One API parser, one lazy read-only entry component, one shared protocol identity hook; <=8 receipts/61 ranges/600 chart samples, preserve existing SDK dependencies, and measure client budgets rather than broaden gates speculatively.

- [x] Extract bounded SDK identity query without behavior change.
- [x] Add verified native Flavor and lazy native Entries view.
- [x] Validate bound public API, snapshot continuation and unavailable states.
- [ ] Run focused/full/browser/budget gates and prepare PR, without merging.

## Review checkpoint
Shared identity extraction committed separately as 875a623 with 13 payment-guard tests passing. Native Flavor and Entries retain API ownership of receipt verification and chart math. Center-backed installed SDK2.28 independently verifies Base27 native hook, and binds the public block52459661 snapshot with its original verified100-NFT receipt and600 chart samples. Full lint/type/protocol/schema/writer gates passed; final coverage/build/budget/browser/hosted CI remain pending. No merge, deployment, wallet connection or transaction performed.

Measured delivery evidence: exact Node26.7/npm12 browser builds emit193chunks, aggregate2618208→2623516B (+5308B). Entries validator/chart/export is lazy; home441.0/create512.5/project168.6KiB and largest/style/lazy gates pass. Reviewed aggregate-only ceiling2563KiB; all other limits unchanged.218files/2940unit tests pass. First separate browser run67/70 passes; three desktop cases timed out in context teardown across laptop closure, with no assertion failure. Fresh full check and hosted CI still required.

## Copy correction refinement
The user requested ordinary punctuation instead of middots. Replace only new native Entries summary/caption and Flavor retry separators; no analogous native inventory block caption exists here. Preserve receipt snapshots and JSON audit context. Add the no-middot assertion to the existing desktop/mobile Entries browser gate, rerun full pinned checks and exact-head hosted CI, and keep merge/deployment with root. Previous d2ffc68 passed all local and hosted gates before this correction.
