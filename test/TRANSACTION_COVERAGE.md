# Transaction coverage — Juicebox Money V6

This inventory tracks semantic coverage of wallet-affecting operations. The
contracts and canonical SDK ABIs are authoritative; Bendystraw is display and
discovery data only.

Legend:

- **E** — exact request or calldata encode/decode assertions
- **S** — canonical selector/ABI-shape assertion only
- **P** — pure planning/state-machine assertions
- **—** — no dedicated regression test yet

| User action | Contract function or authorization | Coverage | Test |
| --- | --- | :---: | --- |
| Launch a project | 721 deployer `launchProjectFor` | **E** | `contracts/launch.test.ts` |
| Launch linked chains | omnichain deployer `launchProjectFor` | **E** | `contracts/launch.test.ts` |
| Deploy a revnet | `REVDeployer.deployFor` | **E** | `contracts/launch.test.ts` |
| Add shop tiers | `JB721TiersHook.adjustTiers` | **E** | `contracts/transaction-builders.test.ts` |
| Deploy a project payer address | `JBProjectPayerDeployer.deployProjectPayer` | **E** | `contracts/transaction-backlog.test.ts`, `components/write-flows.test.tsx` |
| Pay a project | `JBMultiTerminal.pay` | **E** | `contracts/transaction-builders.test.ts` |
| Add to treasury balance | `JBMultiTerminal.addToBalanceOf` | **E** | `contracts/transaction-builders.test.ts` |
| Approve an ERC-20 | `ERC20.approve` | **E** | `contracts/transaction-builders.test.ts` |
| Cash out project tokens | `JBMultiTerminal.cashOutTokensOf` | **E** | `contracts/cash-out.test.ts`, `components/write-flows.test.tsx` |
| Redeem shop NFTs | `cashOutTokensOf` + 721 metadata | **E** | `contracts/transaction-backlog.test.ts` |
| Distribute payouts | `JBMultiTerminal.sendPayoutsOf` | **E** | `contracts/transaction-builders.test.ts` |
| Use surplus allowance | `JBMultiTerminal.useAllowanceOf` | **E** | `contracts/transaction-builders.test.ts` |
| Queue rulesets | `JBController.queueRulesetsOf` | **E** | `contracts/transaction-builders.test.ts` |
| Edit split groups | `JBController.setSplitGroupsOf` | **E** | `contracts/transaction-builders.test.ts` |
| Claim project-token credits | `JBController.claimTokensFor` | **E** | `contracts/transaction-backlog.test.ts` |
| Distribute reserved tokens | `sendReservedTokensToSplitsOf` | **E** | `contracts/transaction-backlog.test.ts` |
| Update project metadata | `JBController.setUriOf` | **E** | `contracts/manage.test.ts` |
| Deploy project ERC-20 | `JBController.deployERC20For` | **E** | `contracts/manage.test.ts` |
| Rename project ERC-20 | `setTokenMetadataOf` | **E** | `contracts/transaction-backlog.test.ts` |
| Mint or burn project tokens | active `mintTokensOf`; no standalone burn action | **E/—** | `contracts/transaction-backlog.test.ts`; burn is intentionally not exposed |
| Transfer project ownership | `JBProjects.transferFrom` | **E** | `contracts/transaction-backlog.test.ts` |
| Add or revoke permissions | `JBPermissions.setPermissionsFor` | **E** | `contracts/transaction-builders.test.ts` |
| Change owner/operator powers | controller/directory/terminal setters + `REVOwner.setOperatorOf` | **E** | `contracts/transaction-backlog.test.ts` |
| Configure buyback/router | registry setter/initializer calls | **E** | `contracts/transaction-backlog.test.ts` |
| Borrow or repay | `REVLoans.borrowFrom` / `repayLoan` | **E** | `contracts/transaction-builders.test.ts` |
| Auto-issue tokens | revnet auto-issuance call | **E** | `contracts/transaction-backlog.test.ts`, `components/write-flows.test.tsx` |
| Prepare/move tokens cross-chain | terminal + sucker calls | **E** | `contracts/transaction-backlog.test.ts` |
| Claim bridged funds | sucker claim call | **E** | `contracts/transaction-backlog.test.ts` |
| Sync sucker accounting | sucker sync call | **E** | `contracts/transaction-backlog.test.ts` |
| Add Uniswap V4 liquidity | approvals + `modifyLiquidities` | **E** | `contracts/transaction-backlog.test.ts` |
| Authorize the Uniswap position manager | Permit2 `approve` | **E** | `contracts/transaction-backlog.test.ts` |
| Review a direct transaction | exact review payload | **P/E** | `transactions/review.test.ts` |
| Submit a reviewed direct write | review → chain/account check → simulate → exact simulated write | **P** | `transactions/contract-write.test.ts`, `transactions/use-safe-tx.test.ts` |
| Propose/confirm/execute a Safe tx | EIP-712 + `execTransaction` | **P/E** | `transactions/safe.test.ts`, `transactions/safe-orchestration.test.ts` |
| Relay a multichain bundle | EIP-2771 + prepaid Relayr payment | **P/E** | `transactions/relayr.test.ts`, `transactions/relayr-orchestration.test.ts` |

## Data and recovery invariants

- Cross-chain project IDs and conflict rejection: covered in
  `data/project-identity.test.ts`.
- Bendystraw HTTP/GraphQL failures, bounded pagination, mismatched shop rows,
  and partial-chain failure reporting: covered in `data/bendystraw.test.ts`.
- Review cancellation, unavailable reviewer, and mutation during review:
  covered in `transactions/review.test.ts`.
- Safe signature order and outer `execTransaction` encoding: covered in
  `transactions/safe.test.ts`; account checks, simulation failure, confirmed,
  reverted, and submitted-but-unconfirmed writes are covered in
  `transactions/safe-orchestration.test.ts`.
- Relayr deterministic scopes, paid-but-unknown outcomes, progress accounting,
  sanitized resumable snapshots, payment validation, polling terminal states,
  and no-repay resume behavior: covered in `transactions/relayr.test.ts` and
  `transactions/relayr-orchestration.test.ts`.

The remaining direct-burn **—** is intentional: the active UI exposes minting,
while burns happen through separately reviewed cash-out, loan, and reserved-split
paths. Adding a standalone burn transaction would be a product change, not a test
extraction. A selector-only row is not complete money-path coverage: promote it to
**E** by extracting a behavior-preserving pure builder where necessary and asserting
every decoded argument.
