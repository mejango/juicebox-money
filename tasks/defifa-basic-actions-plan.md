# Defifa basic actions in Juicebox Money

## Plan refinement
- **Objective:** Restore compatible basic funding/admin flows for Defifa and provide native NFT checkout, owned NFT transfer and native cash-out through the existing reviewed transaction engine, without disabled placeholder UI.
- **System fit:** Center/SDK own contract identity/read context and native metadata/action preparation. Juicebox Money presents supported choices and retains exact account/chain/ownership/phase/price simulation and review boundaries; no Metalog classification, curves or public wallet writes.
- **Reuse and simplicity:** First correct the pay-only guards that wrongly block add-to-balance, reusing its existing independent request builder and transaction sequence. Then integrate the mechanics agent's shared native SDK adapter with existing checkout/redemption/transfer controls, without copied native rules or new transaction machinery.
- **Evidence and unknowns:** Latest main4f2e9d1 unconditionally hides the native PayPanel and blocks both modes despite a hook-free add-to-balance builder. Defifa1.0.2/d3c46d uses address+uint16[] pay metadata, native cashOutCount0 and ordinary ERC721 transfer; fresh SDK action API is under refinement. ETH-zero cash-outs can still claim positive project-token rewards.
- **Verification:** Actual PayPanel tests must prove native and unknown identities cannot send generic pay but can review compatible add-to-balance; ordinary pay parity must remain. Native tests cover exact metadata/default delegation, price/phase/identity changes, selected NFT ownership/pause, zeroETH reward claims, simulations/reviews/receipts and mock-only wallet sends; full pinned checks/budgets/browser/hostedCI precede root publication.
- **Resource budget:** Use one clean worktree on main4f2e9d1, preserve parent edits, delegate bounded read-only transfer/cashout tracing, and separate funding correction from native integration. Reuse existing adapters and SDK package release; avoid unbounded NFT scans, duplicate lifecycle engines or concurrent builds.

- [x] Correct compatible add-to-balance UI/guards with regression evidence, separate commit.
- [x] Integrate shared native SDK checkout and owned NFT transfer/cashout.
- [x] Verify ordinary/native/unknown behavior and all required local gates.
- [ ] Publish reviewable app PR and obtain exact-head hosted CI before root merge.

Root owns release coordination and the shared SDK mechanics design. No public wallet connection, contract transaction or publication is performed during implementation tests.

## Initial funding evidence
15 actual reviewed-account payment tests pass, including native and unknown protocol funding through mocked wallet addToBalanceOf with metadata0x, preserved generic pay/account guards, future mint start and paused pay bypass only for funding. No source helper copies or native encoders introduced. Native adapter integration and final full/browser gates remain pending.

## Recovery refinement after review
- **Objective:** A native request retains its exact original evidence through funding-mode changes, project-tab navigation and reload; unknown direct-wallet submission cannot silently become a new retry.
- **System fit:** Reuse SDK createBrowserWriteRecovery reservation/schema/locks and the new shared decoder that binds an exact recovered call to verified native inventory. Do not add a second journal or application calldata decoder.
- **Reuse and simplicity:** An app adapter binds existing recovery callbacks to native pay/approval/cash-out/transfer engines. Native panels display recovered evidence and use read-only proof for the original wallet-returned hash or Safe proposal; hashless uncertainty remains retained because an identical historical call cannot prove the original invocation; finalized success/revert or typed pre-write rejection alone permit clearing.
- **Evidence and unknowns:** Review found local component markers vanished on parent unmount. Existing Safe registry covers known in-session proposals only. SDK recovery scope must isolate project/hook/action so native terminal calls cannot block other projects, funding or independent new intents; exact shared scope/decoder API is under owner implementation.
- **Verification:** Add parent mode/tab/remount and reload regressions, two-tab reservation exclusion, hashless uncertainty retention without guessed hash adoption, typed rejected versus ambiguous sends, finalized native/approval failure, and preserved ordinary funding parity. Final required checks use exact locked npm graph and checked published SDK, not development preview results.
- **Resource budget:** Keep one shared recovery adapter and existing transaction engine; coordinate the SDK scope/decoder with its owner before writing UI adapters. No wallet writes, copied persistence rules, global pending lock or alternate journal.

## Preliminary integration evidence
The built development SDK preview exercised 220 test files /2971 tests, source/dead-code/transaction gates and70 deterministic browser journeys. These are preliminary, because the initial no-save install disabled lock handling and drifted a dev range. Exact npm ci was restored before final verification. Release-qualified SDK, durable recovery, final full checks and CI remain incomplete.

## Native integration review
Shared checked SDK preview0b0809ae7b0d was installed against the restored lock graph (only core changed; Playwright1.62.1 retained).77 focused tests in5files pass, including actual reviewed-wallet checkout, original native journal storage/locks, parent funding-mode/remount retention, historical read-only recovery, typed rejection/revert, zero-currency rewards and actor changes. Global types and touched-source lint pass. Official core2.29 dependency pin, full local checks/browser/budgets, independent final review and hosted CI remain pending; no publication or real wallet write occurred.

## Final official SDK verification
Official core2.29.0 is exact-pinned from the normal npm registry and npm ci preserves all other locked packages. Required dependency/dead-code/audit/container/lint/type/source/protocol/schema/transaction gates passed; coverage passed222files/3007tests. Independent narrow final review approved75tests across4files for retained-record dismissal, Safe lookup cancellation and complete-zero ownership controls. No public wallet writes occurred.

Matched Node26.7.0/npm12.0.1 builds measure main4f2e9d1 aggregate2,618,445B; SDK-only2.29 adds536B; official native checkout/owned/recovery adoption totals2,640,204B (+21,223B app delivery). Only aggregate is rounded to2579KiB; all route/largest/style/lazy-boundary gates remain unchanged. The exact final full check, browser journeys and hosted CI remain release gates.

Final official `npm run check` passed on the final source and aggregate-only cap: 222 test files /3007 tests, all required gates and70 browser journeys (44.5s). Browser proof uses deterministic test-only inventory; mobile390 and desktop1280 screenshots were inspected. Log: `/tmp/jbm-defifa-actions-check-official-final.log`. Final narrow independent review approved. Hosted CI and root merge/production acceptance remain pending.
