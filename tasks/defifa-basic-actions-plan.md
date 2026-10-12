# Defifa basic actions in Juicebox Money

## Plan refinement
- **Objective:** Restore compatible basic funding/admin flows for Defifa and provide native NFT checkout, owned NFT transfer and native cash-out through the existing reviewed transaction engine, without disabled placeholder UI.
- **System fit:** Center/SDK own contract identity/read context and native metadata/action preparation. Juicebox Money presents supported choices and retains exact account/chain/ownership/phase/price simulation and review boundaries; no Metalog classification, curves or public wallet writes.
- **Reuse and simplicity:** First correct the pay-only guards that wrongly block add-to-balance, reusing its existing independent request builder and transaction sequence. Then integrate the mechanics agent's shared native SDK adapter with existing checkout/redemption/transfer controls, without copied native rules or new transaction machinery.
- **Evidence and unknowns:** Latest main4f2e9d1 unconditionally hides the native PayPanel and blocks both modes despite a hook-free add-to-balance builder. Defifa1.0.2/d3c46d uses address+uint16[] pay metadata, native cashOutCount0 and ordinary ERC721 transfer; fresh SDK action API is under refinement. ETH-zero cash-outs can still claim positive project-token rewards.
- **Verification:** Actual PayPanel tests must prove native and unknown identities cannot send generic pay but can review compatible add-to-balance; ordinary pay parity must remain. Native tests cover exact metadata/default delegation, price/phase/identity changes, selected NFT ownership/pause, zeroETH reward claims, simulations/reviews/receipts and mock-only wallet sends; full pinned checks/budgets/browser/hostedCI precede root publication.
- **Resource budget:** Use one clean worktree on main4f2e9d1, preserve parent edits, delegate bounded read-only transfer/cashout tracing, and separate funding correction from native integration. Reuse existing adapters and SDK package release; avoid unbounded NFT scans, duplicate lifecycle engines or concurrent builds.

- [x] Correct compatible add-to-balance UI/guards with regression evidence, separate commit.
- [ ] Integrate shared native SDK checkout and owned NFT transfer/cashout.
- [ ] Verify ordinary/native/unknown behavior and required local/hosted gates.

Root owns release coordination and the shared SDK mechanics design. No public wallet connection, contract transaction or publication is performed during implementation tests.

## Initial funding evidence
15 actual reviewed-account payment tests pass, including native and unknown protocol funding through mocked wallet addToBalanceOf with metadata0x, preserved generic pay/account guards, future mint start and paused pay bypass only for funding. No source helper copies or native encoders introduced. Native adapter integration and final full/browser gates remain pending.
