# Testing and CI

This repository treats the deployed Juicebox V6 contracts as the source of
truth. The SDK is the application-facing contract adapter, and Bendystraw is a
derived, eventually consistent index. A fixture from Bendystraw must never
override an ABI, deployment address, onchain quote, owner, permission, or
transaction simulation.

## Local commands

```sh
cp .env.example .env.local
npm ci
npm run dev # http://localhost:3001
npm run deps:check
npm run audit:prod
npm run container:check
npm run lint
npm run ts:check
npm run env:check:all
npm run protocol:check
npm run transaction:check
npm test
npm run test:coverage
npm run test:browser:install
npm run build:browser
npm run budget
npm run test:browser
npm run check:deploy
```

The checked-in local defaults use real Bendystraw mainnet and testnet data, Para beta, and
`https://dev.juicebox.center` for RPC reads and IPFS writes. No provider credential or Center API
key is required.

Use the Node version pinned in `.nvmrc`; local, CI, and the production image run
on Node 26.7 with npm 12.0.1.
TypeScript 7 supplies the `tsc` binary through the `@typescript/native` npm
alias. The `typescript` package name intentionally points at Microsoft's
TypeScript 6 compatibility package so Next and typescript-eslint can keep using
the compiler API that TypeScript 7.0 does not yet expose; `tsc6` is also
available for tooling diagnostics.
`npm run check` runs the complete required sequence after Chromium has been
installed once. Unit tests use Node only and must not require a wallet, RPC
endpoint, Bendystraw, IPFS, Safe, Relayr, or any other network service. Mock
responses belong at the boundary and should include timeouts, malformed
responses, stale data, and partial-chain failures. The global unit-test setup
rejects every unexpected `fetch`, `XMLHttpRequest`, `WebSocket`, and
`EventSource`; a test must install an explicit local mock for each transport it
exercises.

`npm run deps:check` validates the complete production dependency graph after
the exact lockfile install, rejecting missing or incompatible runtime peers
before build or release. Platform-specific optional development fallbacks are
not part of the published runtime graph.

`protocol:check` validates the committed deployment fixture schema. Set
`PROTOCOL_DEPLOYMENTS_DIR=/path/to/deploy-all-v6` to additionally compare every
app-used deployment artifact against deploy-all-v6 commit
`316e9d4d3f9e1c5b41a5df7c0ad6183abbeccc7f`. The fixture was read from that
commit's `deployments/<chain-alias>/<contract>.json` artifacts, independently
of the SDK. The gate covers 25 canonical contracts on all eight chains plus 36
pair-specific CCIP/native sucker-deployer artifacts across the 24 directed
pairs in the production and testnet four-chain families (236 checked entries in
all). Unit tests compare the SDK address books, `addrOf`, and
`parseSuckerDeployerConfig` output against those artifacts, including explicit
native-bridge and OP Sepolia deployment absences.
Pull-request CI checks out that exact deploy-all-v6 commit independently and
enables the full artifact comparison; it does not trust the fixture alone.

## What belongs in each layer

- `test/contracts/` pins transaction selectors, tuple order, deployment
  addresses, currency/decimal handling, rounding, and calldata round-trips.
- `test/data/` treats Bendystraw payloads as hostile input and checks pagination,
  caps, chain/project identity, partial availability, and fail-closed behavior.
- `test/transactions/` checks the review/signing boundary, the shared direct
  write pipeline used by `useSafeTx`, project creation, and add-shop submission,
  and the Safe/Relayr state machines. A submitted-but-unconfirmed transaction
  is not a safe retry.
- `test/components/` exercises component orchestration around high-risk writes:
  frozen reviews, account drift, immediate onchain re-reads, debounced amounts,
  and exact requests passed into the safe transaction boundary.
- [`test/TRANSACTION_COVERAGE.md`](test/TRANSACTION_COVERAGE.md) is the safety
  inventory. Every new wallet write must add or update a row and should have an
  exact ABI round-trip test before it is considered covered.
- `transaction:check` parses every production TypeScript file and compares all
  `useSafeTx`, authority, reviewed direct-write, and raw wallet API call sites
  against `test/transaction-sites.json`. A new or moved write fails CI until its
  reviewed boundary and transaction-coverage action are explicitly inventoried.
  Each of the 26 current `useSafeTx.send` sites has its own stable action record;
  the gate requires one record per send, exact request/calldata coverage, and a
  dedicated test reference beyond the shared wrapper test.

Coverage includes every production `src/**/*.{ts,tsx}` file; only declaration
files are excluded. The 22 test files currently run 182 tests. Component
write-flow, rich-content XSS, and IPFS-boundary tests put the measured
all-source baseline at 12.23% statements, 9.07% branches, 10.00% functions,
and 12.72% lines. CI floors are ratcheted to 10.4/8.0/9.1/10.9 respectively,
while strong
per-file floors protect the three component write flows plus the deeply tested
contract, review, Safe, and Relayr boundaries. Coverage is diagnostic, not the
definition of transaction safety: a high line percentage can still miss one
wrong beneficiary or decimal. CI therefore combines full-denominator coverage
with the per-send semantic inventory.

## Contract-facing test rules

For every transaction, assert as applicable:

1. canonical chain and deployed target address;
2. canonical four-byte selector and ABI tuple order;
3. exact native value, token, amount, currency, and decimals;
4. every beneficiary, owner, operator, spender, hook, and project ID;
5. conservative integer rounding and a non-zero slippage floor;
6. encode/decode round-trip through the SDK ABI;
7. stale indexer data cannot authorize or redirect the write;
8. review, simulation, and account/chain checks happen before signing;
9. reverted and confirmation-unknown receipts remain distinguishable.

When the SDK and Bendystraw disagree, add a contract-derived regression fixture
and fix the Bendystraw assumption. Do not update a contract expectation merely to
match indexed data.

## Build budgets

`scripts/check-client-budgets.mjs` reads Next's production app manifest and
measures each compressed asset as the browser receives it. The initial limits
are deliberately just above the audited baseline:

| Surface | Gzip budget |
| --- | ---: |
| Home route, including shared layout | 340 KiB |
| Project route, including shared layout | 570 KiB |
| Create route, including shared layout | 465 KiB |
| All client JavaScript | 1500 KiB |
| Largest individual JavaScript chunk | 450 KiB |
| All compiled CSS | 32 KiB |

The audited build measured 305.9 KiB home, 518.5 KiB project, 421.7 KiB create,
1402.4 KiB aggregate JavaScript, a 410.4 KiB largest chunk, and 28.4 KiB CSS
(all gzip). Para's connector, client, modal, and styles load only after sign-in;
the budget gate asserts the wallet runtime/styles exist but are absent from all
initial routes, and Playwright rejects anonymous wallet traffic. Versus the
pre-upgrade routes, eager JavaScript fell roughly 61% on home, 43% on project,
and 49% on create. Aggregate emitted JavaScript fell about 36% and the largest
chunk about 27% from the initial upgraded build. Budgets prevent
regressions; they are not performance goals. Do not raise one without before/
after measurements and a user-visible tradeoff.

## Browser, visual, accessibility, and performance tests

Playwright runs 12 production cases: `/create`, `/`, and `/eth:1` in Chromium
at 320, 390, 768, and 1280 pixels. `build:browser` starts a strict fixture on a
fresh ephemeral port, exercises the real homepage data functions, proves that
populated V6 trending, legacy trending, and recent-activity responses survive
application mapping, runs the production build, then rejects any unknown build
request or missing expected GraphQL operation before stopping the fixture. The
compiled application keeps a separate runtime fixture origin, so Playwright
always starts with fresh request counters.

The runtime fixture accepts only seven exact GraphQL documents with their exact
variable envelopes and only the expected JSON-RPC 2.0 envelopes on the four
production-chain paths. Its 17 required ABI read shapes validate chain,
address, function, and decoded arguments, including Viem's Multicall3 envelope.
It serves a populated V6 card, legacy card, activity row, two participants, one
revnet project, and
contract-derived V6 reads. Global teardown requires every expected GraphQL and
ABI read, at least one `eth_call` and Multicall3 batch, and zero unknown
documents, variables, methods, routes, contract calls, or arguments. The
browser context independently blocks every non-local HTTP and WebSocket request
and asserts that the app attempted none. Service workers remain disabled. No
production service, wallet, API key, or secret is used.

Each route must return the security headers from `next.config.js`, render one
visible main surface and heading, avoid document-level horizontal overflow,
expose a visible keyboard focus indicator, raise no page errors, and pass axe's
WCAG 2 A/AA and 2.1 A/AA rules with zero color-contrast findings. There is no
brand-palette or structural accessibility exemption. Failure screenshots,
videos, traces, and the HTML report are written under `test-results/` and
`playwright-report/`.

The home case requires populated V6 and legacy project cards plus a populated
activity row. The project case proves its responsive tab contract (Activity at
phone width, Overview above 600 px), indexed holder count, and hydrated USDC
payment surface with an active ruleset and listed V6 terminal, then traverses
Activity, Overview, Terms, Owners, Shop, Extras, and Operator. The create case
switches through simple, custom, and revnet flavors, then traverses every revnet
wizard step through the signed-out launch boundary. Every reached surface is
checked for document overflow, keyboard-visible focus, zero Axe color-contrast
findings, and zero serious or critical Axe findings. Connected-wallet
transaction signing remains covered below the browser layer; Firefox, WebKit,
visual snapshots, and Lighthouse are the next browser-layer additions.

CI retries may collect a second trace for diagnosis, but `failOnFlakyTests`
makes any pass-on-retry fail the job instead of masking nondeterministic shape
or safety behavior.

## CI behavior

`.github/workflows/ci.yml` uses Ubuntu 24.04, locked npm dependencies, read-only
repository permissions, concurrency cancellation, and job timeouts. It gates pull requests
on high or critical production dependency advisories, pinned contract deployments, the
reviewed transaction-site inventory, lint, strict TypeScript, deterministic unit
tests with coverage, a production build, compressed client budgets, and the
Chromium browser invariants. Every reusable action is pinned to a full commit
SHA, and both repository checkouts disable persisted credentials. CI uploads
unit coverage plus browser reports and failure diagnostics for 14 days. A
parallel job builds the digest-pinned standalone image, drops every Linux
capability, prevents privilege escalation, mounts only the Node-owned Next
cache as writable tmpfs, starts with a read-only root as the non-root user, and
waits for readiness through a loopback-only host binding. The release workflow
repeats that exact runtime smoke and all gates in a read-only verification job.
Only the dependent publish job receives GHCR write and OIDC permissions and the
production-environment approval; it publishes only a commit-SHA GHCR tag with
an SBOM and maximum provenance. No secrets are exposed and no test reaches live
protocol infrastructure. The audit
step reports lower-severity production advisories for remediation tracking but
stops CI and release on every high or critical finding for explicit review; it
never applies automatic or force upgrades.

Dependabot groups npm, action, and base-image minor/patch updates, while major
updates open separately so support and security migrations stay visible and
receive an isolated full-gate review.
