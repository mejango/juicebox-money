# Transaction coverage — Juicebox Money V6

This inventory tracks semantic coverage of wallet-affecting operations. The
contracts and canonical SDK ABIs are authoritative; Bendystraw is display and
discovery data only.

Legend:

- **E** — exact request or calldata encode/decode assertions
- **S** — canonical selector/ABI-shape assertion only
- **P** — pure planning/state-machine assertions
- **—** — no dedicated regression test yet

Each test file named for an action that a wallet write maps to carries the
action's marker in the title of a test that proves it, for example
`wallet-action:approve-an-erc-20` for "Approve an ERC-20". The
`transaction:check` entry in [TESTING.md](../TESTING.md) says which tests count,
and the check fails on a missing marker.

| User action | Contract function or authorization | Coverage | Test |
| --- | --- | :---: | --- |
| Launch a project | 721 deployer `launchProjectFor` | **E** | `contracts/launch.test.ts` |
| Launch linked chains | omnichain deployer `launchProjectFor` | **E** | `contracts/launch.test.ts` |
| Deploy a revnet | `REVDeployer.deployFor` | **E** | `contracts/launch.test.ts` |
| Create an Owner or Operator Safe during launch | Safe 1.4.1 factory `createProxyWithNonce`, exact signer/threshold/address binding, `aggregate3Value` with the authenticated launch, and independent direct-setup recovery | **P/E** | `contracts/launch-multisig.test.ts`, `transactions/launch-multisig-direct.test.ts`, `transactions/launch-relayr.test.ts`, `transactions/launch-session.test.ts` |
| Add shop tiers | Per-shop `JB721TiersHook.adjustTiers`, exact prices, local inventory/recipients, frozen tier IDs and batch recovery | **P/E** | `contracts/transaction-builders.test.ts`, `lib/shop-batch.test.ts`, `components/shop-batch-journeys.test.tsx` |
| Mint shop tiers without payment | `JB721TiersHook.mintFor` | **E** | `contracts/transaction-builders.test.ts`, `components/mint-shop-item-gas.test.tsx` |
| Replace shop item media | Per-shop `JB721TiersHook.setMetadata`, unchanged original metadata fields, live item identity and batch recovery | **P/E** | `contracts/transaction-builders.test.ts`, `lib/shop-batch.test.ts`, `components/shop-batch-journeys.test.tsx` |
| Deploy a project payer address | Raw `JBProjectPayerDeployer.deployProjectPayer` calls with explicit admin/beneficiary, linked project IDs, chosen funding chain and exact clone verification | **P/E** | `contracts/transaction-backlog.test.ts`, `transactions/payer-relayr.test.ts`, `components/extras-payer.test.tsx`, `components/write-flows.test.tsx` |
| Pay a project | `JBMultiTerminal.pay` | **E** | `contracts/transaction-builders.test.ts`, `components/reviewed-account-pay.test.tsx` |
| Swap for project tokens | Uniswap V4 Universal Router `execute` | **E** | `contracts/transaction-builders.test.ts` |
| Sign a swap authorization | Permit2 `PermitSingle` EIP-712 + Universal Router `PERMIT2_PERMIT` | **E** | `contracts/permit2-swap.test.ts`, `transactions/reviewed-permit2-signature.test.ts` |
| Swap project tokens | Uniswap V4 Universal Router `execute` | **E** | `contracts/transaction-builders.test.ts` |
| Add to treasury balance | `JBMultiTerminal.addToBalanceOf` | **E** | `contracts/transaction-builders.test.ts` |
| Approve an ERC-20 | `ERC20.approve` | **E** | `contracts/transaction-builders.test.ts`, `components/reviewed-account-pay.test.tsx`, `components/reviewed-account-holder.test.tsx` |
| Cash out project tokens | `JBMultiTerminal.cashOutTokensOf` | **E** | `contracts/cash-out.test.ts`, `components/write-flows.test.tsx`, `components/reviewed-account-holder.test.tsx` |
| Burn project tokens | active `JBController.burnTokensOf` | **E** | `contracts/burn-tokens.test.ts`, `components/reviewed-account-holder.test.tsx` |
| Redeem shop NFTs | `cashOutTokensOf` + 721 metadata | **E** | `contracts/transaction-backlog.test.ts`, `components/reviewed-account-shop.test.tsx` |
| Distribute payouts | Local terminal/token/decimals/limit/recipient `sendPayoutsOf` calls, frozen minimums and exact distribution event verification | **P/E** | `contracts/transaction-builders.test.ts`, `data/project-distributions.test.ts`, `components/distribution-batch.test.tsx`, `transactions/project-batch.test.ts` |
| Use surplus allowance | `JBMultiTerminal.useAllowanceOf` | **E** | `contracts/transaction-builders.test.ts` |
| Queue rulesets | `JBController.queueRulesetsOf` | **E** | `contracts/transaction-builders.test.ts` |
| Queue rulesets across selected mainnets | Per-chain controller/project configuration + one Relayr payment | **P/E** | `components/queue-ruleset-multichain.test.tsx`, `transactions/authority-gas.test.ts` |
| Edit split groups | `JBController.setSplitGroupsOf` | **E** | `contracts/transaction-builders.test.ts` |
| Edit reserved recipients across selected mainnets | Local ruleset IDs, locked rows, fallback checks, and frozen Relayr recovery | **P/E** | `components/edit-splits-multichain.test.tsx`, `components/edit-splits.test.ts` |
| Claim project-token credits | Local controller/token/credit balances in `claimTokensFor`, original holder beneficiary, and frozen batch recovery | **P/E** | `contracts/transaction-backlog.test.ts`, `transactions/project-token-batch.test.ts`, `components/project-token-batches.test.tsx` |
| Distribute reserved tokens | Local controller/ruleset/balance/recipient `sendReservedTokensToSplitsOf` calls, exact destination receipts and failed-distribution event checks | **P/E** | `contracts/transaction-backlog.test.ts`, `data/project-distributions.test.ts`, `components/distribution-batch.test.tsx`, `transactions/project-batch.test.ts` |
| Update project metadata | Per-destination `JBController.setUriOf`, metadata preservation, and frozen recovery | **P/E** | `contracts/manage.test.ts`, `components/metadata-editor.test.tsx` |
| Deploy project ERC-20 | `JBController.deployERC20For` | **E** | `contracts/manage.test.ts` |
| Rename project ERC-20 | `setTokenMetadataOf` | **E** | `contracts/transaction-backlog.test.ts` |
| Mint project tokens | active `mintTokensOf` | **E** | `contracts/transaction-backlog.test.ts` |
| Transfer project ownership | `JBProjects.transferFrom` | **E** | `contracts/transaction-backlog.test.ts` |
| Add or revoke permissions | `JBPermissions.setPermissionsFor` | **E** | `contracts/transaction-builders.test.ts` |
| Change owner/operator powers | controller/directory/terminal setters + `REVOwner.setOperatorOf` | **E** | `contracts/transaction-backlog.test.ts` |
| Register accounting tokens across chains | Local token addresses, project IDs, and decimals in `addAccountingContextsFor` | **P/E** | `components/power-accounting-multichain.test.tsx` |
| Configure buyback/router | registry setter/initializer calls | **E** | `contracts/transaction-backlog.test.ts` |
| Register buyback pool | `JBBuybackHookRegistry.setPoolFor` with the exact pool tuple and native sentinel | **E** | `contracts/transaction-backlog.test.ts`, `lib/safe-batch.test.ts` |
| Add Uniswap V4 liquidity as one Safe batch | ERC-20 `approve` → Permit2 `approve` → `modifyLiquidities` (30-day deadline, mint marked dependent) as one Safe-app `wallet_sendCalls` MultiSend proposal from AddLiquidityFlow, EditPositionPanel and MarketEditPanel | **E** | `transactions/liquidity-safe-batch.test.ts`, `transactions/safe-batch-submit.test.ts` |
| Submit a Safe operator batch | Ordered steps composed into one `MultiSendCallOnly.multiSend` operation-1 SafeTx (owner), one Safe-app `wallet_sendCalls` proposal, or sequential direct writes; sequence simulated first | **E** | `lib/safe-batch.test.ts`, `lib/safe-batch-presets.test.ts`, `transactions/safe-batch-submit.test.ts`, `components/safe-batch-tray.test.tsx` |
| Set project handle | ENS resolver `setText` + mainnet `JBProjectHandles.setEnsNamePartsFor` | **E** | `contracts/project-handles.test.ts` |
| Deploy same Safe on Ethereum | Safe proxy factory `createProxyWithNonce` after exact-address simulation | **P/E** | `data/cross-chain-authority.test.ts`, `transactions/safe-orchestration.test.ts` |
| Borrow or repay | `REVLoans.borrowFrom` / `repayLoan` | **E** | `contracts/transaction-builders.test.ts`, `components/reviewed-account-holder.test.tsx` |
| Auto-issue tokens | Every unlocked `REVOwner.autoIssueFor` stage/beneficiary allocation, with repeated-chain calls in later rounds and single-allocation rows sharing the same recovery aliases | **P/E** | `contracts/transaction-backlog.test.ts`, `transactions/project-token-batch.test.ts`, `components/project-token-batches.test.tsx`, `components/write-flows.test.tsx` |
| Prepare/move tokens cross-chain | terminal + sucker calls | **E** | `contracts/transaction-backlog.test.ts` |
| Claim bridged funds | sucker claim call | **E** | `contracts/transaction-backlog.test.ts` |
| Sync sucker accounting | sucker sync call | **E** | `contracts/transaction-backlog.test.ts` |
| Add Uniswap V4 liquidity | approvals + `modifyLiquidities` | **E** | `contracts/transaction-backlog.test.ts`, `components/reviewed-account-liquidity.test.tsx` |
| Authorize the Uniswap position manager | Permit2 `approve` | **E** | `contracts/transaction-backlog.test.ts` |
| Claim Uniswap V4 LP fees | zero-liquidity `modifyLiquidities` decrease + take: one position, or both sides of a market with one take | **E** | `contracts/transaction-backlog.test.ts`, `contracts/market-liquidity.test.ts`, `components/reviewed-account-liquidity.test.tsx` |
| Remove Uniswap V4 liquidity | `modifyLiquidities` burn + take with 95% floors | **E** | `contracts/transaction-backlog.test.ts` |
| Edit Uniswap V4 liquidity | `modifyLiquidities` increase + close, decrease + take, or burn + mint + close, sized from live holdings | **E** | `contracts/edit-liquidity.test.ts`, `components/reviewed-account-liquidity.test.tsx` |
| Make or edit a Uniswap V4 market | two single-sided `modifyLiquidities` mints spanning floor→ceiling; per-side increase / decrease / burn / re-mint under one settlement | **E** | `contracts/market-liquidity.test.ts`, `components/reviewed-account-liquidity.test.tsx` |
| Review a direct transaction | exact review payload | **P/E** | `transactions/review.test.ts` |
| Submit a reviewed direct write | reviewed-account check → review → chain/account check → simulate → exact simulated write | **P** | `transactions/contract-write.test.ts`, `transactions/use-safe-tx.test.ts` |
| Submit a one-chain project-owner/operator action | exact review → account/chain recheck → fresh simulation → direct receipt | **P/E** | transaction inventory + authority boundary |
| Propose/confirm/execute a Safe tx | EIP-712 + `execTransaction` | **P/E** | `transactions/safe.test.ts`, `transactions/safe-orchestration.test.ts` |
| Relay a multichain bundle | EIP-2771 + prepaid Relayr payment | **P/E** | `transactions/relayr.test.ts`, `transactions/relayr-orchestration.test.ts` |
| Launch across mainnets with one payment | Per-chain launch authorizations + one chosen-chain Relayr funding transaction | **P/E** | `transactions/launch-relayr.test.ts`, `transactions/launch-session.test.ts`, `contracts/launch.test.ts` |

| Resume a reviewed project batch | Frozen destination calls, serialized rounds, original hashes/proposals, and durable completion before clearing Relayr recovery | **P/E** | `transactions/project-batch.test.ts` |
| Retry or finalize pending gateway payments | Original tuple/memo/metadata commitment, live cooldown and failure state, exact gateway outcome events, zero-value calls and durable batches | **P/E** | `data/pending-payments.test.ts`, `transactions/project-batch.test.ts` |

## Data and recovery invariants

- Inline Safe creation freezes one signer policy and predicted address across
  the selected launch chains. Existing drafts retain their address-based
  authority, and disabled controls do not create a Safe. Relayr batches setup
  before the authenticated launch, including on one supported chain. Its
  quote and receipt bind the exact outer batch; nonce checks use the inner
  forwarder. Deployment simulation and receipt-block Safe state must match
  the saved policy before creation is accepted. Direct launches keep setup
  hashes and Safe proposals separate from project-launch progress, preserving
  an interrupted setup until its original transaction is recovered.
- Shop batches freeze each destination's project, hook, owner, pricing and
  item configuration. Additions retain exact prices, recipient/project/hook
  mappings and per-chain inventory; media replacement starts from the full
  original JSON and rejects changed item URIs. Review, stale-submit rejection,
  partial reload without files, original-account checks and nonfatal cache
  refresh failures are covered in `lib/shop-batch.test.ts` and
  `components/shop-batch-journeys.test.tsx`.
- Shared project batches save every destination alias before signatures or
  wallet sends. They preserve every repeated-chain call in later rounds,
  recover paid bundles without reconstructing changed source state, keep
  direct/Safe hashes across reload, reject unknown sends and exact-receipt
  mismatches, and persist application completion before clearing Relayr's
  journal in `transactions/project-batch.test.ts`.
- Payout and reserved-token distribution reviews bind local controllers,
  terminals, accounting tokens/decimals, current rulesets, limits, balances,
  recipients and quote minimums. Recovery retains original calls when source
  state drifts. Successful receipts must also prove the intended distribution;
  recipient fallback failures, partial hook pulls and reserved hook burns
  remain unresolved in `data/project-distributions.test.ts` and
  `components/distribution-batch.test.tsx`.
- Holder claims preserve local ERC-20 availability, controller, full credit
  amount and holder beneficiary. Aggregate auto-issuance keeps all unlocked
  stage/beneficiary allocations and revalidates them before funding. Individual
  allocation rows use the same project aliases as aggregate issuance. Selected
  chain mappings, paused recovery and account changes are covered in
  `transactions/project-token-batch.test.ts` and
  `components/project-token-batches.test.tsx`.
- Payer deployment uses raw factory calldata because the explicit factory
  parameters define admin and beneficiary. Frozen mainnet bundles retain
  canceled funding, lost quote responses and partial results; direct/testnet
  and Safe execution keep original hashes/proposals. Canonical destination
  proofs bind the deployment event, clone implementation and intended payer
  configuration in `transactions/payer-relayr.test.ts`; selection, explicit
  admin/beneficiary review and saved-result UI are covered in
  `components/extras-payer.test.tsx`.
- Cross-chain project IDs and conflict rejection: covered in
  `data/project-identity.test.ts`.
- Bendystraw HTTP/GraphQL failures, bounded pagination, mismatched shop rows,
  and partial-chain failure reporting: covered in `data/bendystraw.test.ts`.
- Review cancellation, unavailable reviewer, and mutation during review:
  covered in `transactions/review.test.ts`. A closed review or fee picker is
  reported as itself, never as a wallet cancel, in `errors.test.ts`.
- Safe signature order and outer `execTransaction` encoding: covered in
  `transactions/safe.test.ts`; account checks, simulation failure, confirmed,
  reverted, and submitted-but-unconfirmed writes are covered in
  `transactions/safe-orchestration.test.ts`. Safe-app authority calls wait for
  the proposal's execution hash before receipt and postcondition checks in
  `transactions/authority-gas.test.ts`.
- A Safe connection is the Safe app connector (id `safe`) or Safe{Wallet} over
  WalletConnect (peer origin `https://app.safe.global`), which proposes the
  same way; a wallet whose name merely contains "safe" sends as itself.
  Screens re-render once the peer is read, the newest read wins, and a re-read
  keeps the previous answer. The execution wait also reads the chain, so an
  execution hash Safe{Wallet} returns directly is taken as the execution
  (`safe-connector.test.ts`).
- Reviewed gas is sent gas: direct authority calls review the gas limit they
  send and Safe-app calls review the `safeTxGas` it becomes
  (`transactions/authority-gas.test.ts`); Safe signatures review the exact
  signed `safeTxGas`, and Safe executions, hash approvals and same-address
  deployments measure their gas before the review and send exactly it
  (`transactions/safe-orchestration.test.ts`). Payer deployments review the
  fixed 1,000,000 gas they send (`transactions/payer-relayr.test.ts`). Every
  single-call Safe-app send uses gas 0 and reviews Safe gas 0, including
  launch Safe creation, the direct launch and free mints
  (`transactions/launch-multisig-direct.test.ts`,
  `components/create-launch-gas.test.ts`,
  `components/mint-shop-item-gas.test.tsx`); a `wallet_sendCalls` batch
  proposal carries no gas, so Safe chooses its own. The review shows both,
  warning on a nonzero `safeTxGas`, and says the wallet shows the gas limit
  unless every call fixes one, in `components/transaction-review-gas.test.tsx`.
  A call's nested calls render under "Calls it makes, in order", or inside a
  MultiSend's `transactions` argument, once
  (`components/transaction-review-nested.test.tsx`).
- One review per batch: a project batch or payer deployment shows one
  safety-check review of every exact call, and the direct and Safe-app sends
  it covered are not reviewed again. A resumed batch, or a connection that
  changed after the review, reviews each send; relayed ForwardRequests,
  Relayr payments and Safe signatures keep their own reviews
  (`transactions/authority-gas.test.ts`, `transactions/project-batch.test.ts`,
  `transactions/payer-relayr.test.ts`).
- Relayr deterministic scopes, paid-but-unknown outcomes, progress accounting,
  sanitized resumable snapshots, payment validation, polling terminal states,
  and no-repay resume behavior: covered in `transactions/relayr.test.ts` and
  `transactions/relayr-orchestration.test.ts`. Quotes bind each posted call to
  the quoted ID whose record carries its exact request, with records exactly
  the quoted IDs and the bundle read echoing its ID
  (`transactions/relayr-quote-binding.test.ts`). A payment is proven from the
  chain under the hash it was mined: sender, payment contract, calldata, value,
  chain and canonical block, and the session saves it as relayrPaymentDetails
  authenticated it.
- Funding-chain selection is quote-bound and confirmed by the person. It
  preselects the wallet's chain from before any switch when quoted, else a
  lone quote, else nothing. Published authorizations
  survive cancelled funding and unknown quote responses; payment intent is
  persisted before the wallet sends. Canonical destination verification,
  ineligible-bundle rejection, single-chain direct execution, and unpaid recovery revalidation are
  covered in `transactions/relayr-orchestration.test.ts`,
  `transactions/authority-gas.test.ts`, and the funding-chain-selection suites.
- Multichain ruleset changes preserve unedited peer settings and revalidate
  complete source configurations around signing and payment. Frozen unpaid
  reviews and paid partial bundles recover from every selected project's chain
  in `components/queue-ruleset-multichain.test.tsx`.
- Safe queue funding and partial recovery preserve the first executable nonce
  per chain and require canonical Safe execution proof. Quote replacement,
  unsupported-chain sequencing, and interrupted payments are covered in
  `components/safe-queue-relayr.test.tsx` and
  `components/safe-queue-authority.test.ts`.
- One-chain project-owner/operator management calls are reviewed and submitted
  directly; Safe-owned calls remain in the Safe path. Creation also uses Relayr
  on one supported chain when it can combine a new Safe with the launch.
- Safe operator batches are per-chain trays of builder-backed steps. A Safe
  owner signs ONE operation-1 `MultiSendCallOnly` SafeTx whose hash, POST body
  and pending-queue match carry `operation: 1`; the Safe app receives one
  `wallet_sendCalls` proposal tracked to its execution hash; an EOA sends each
  step through `runAuthorityCalls` in order. The whole sequence is simulated
  from the authority (`eth_simulateV1`, falling back to per-call `eth_call`
  for steps without an in-batch dependency) before review, dependency order
  is never silently fixed, and `MultiSendCallOnly` code is required on the
  chain. Covered in `transactions/safe-batch-submit.test.ts` and
  `components/safe-batch-tray.test.tsx`. The LP flows reuse the Safe-app
  proposal for their approval-then-mint plans under a Safe connection only;
  every other connection keeps one reviewed `useSafeTx` send per step
  (`transactions/liquidity-safe-batch.test.ts`). MoveFlow stays sequential
  because its final call's value is read from the bridge after the prepare
  receipt.
- Multichain mainnet creation signs one launch request per chain and funds one
  Relayr quote on the selected payment chain. Frozen launch configuration,
  estimated deployment gas, current creation fees, canonical destination
  receipts, original-wallet identity, and saved-bundle recovery are covered in
  `transactions/launch-relayr.test.ts`. Supported mainnet and testnet families
  can use Relayr; single-chain launches without a new Safe, Safe-wallet
  launches, and saved direct sessions retain the direct path. These
  deterministic checks do not establish successful live Relayr execution.

Standalone burns use the project’s freshly read active controller and recheck the
holder’s total balance immediately before the reviewed write. A selector-only row
is not complete money-path coverage: every decoded argument must be asserted.
