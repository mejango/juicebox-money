# Manual bridge destination mint readiness

Parent plan: `/Users/jango/Documents/jb/v6/evm/.worktrees/sdk-sticky-adversarial-20261009/tasks/bridge-mint-readiness-20261009.md`.

## Plan refinement

- **Objective:** Block a new manual source prepare if its destination peer cannot mint the reviewed token count to the reviewed beneficiary; retain transport and claim recovery for existing transfers.
- **System fit:** `MoveCard` owns canonical sucker-pair discovery, `MoveFlow` freezes review inputs, the shared SDK owns controller resolution and mint simulation, and `useSafeTx` owns the final reverify boundary before wallet execution.
- **Reuse and simplicity:** Preserve the existing registry pair's remote address in the reviewed move, authenticate its exact reciprocal entry using `getV6SuckerPairs` on the reviewed destination project, and invoke `verifySuckerDestinationMint` at review and prepare reverify through one local orchestration helper. Add no local permission predicate or alternate transaction flow.
- **Evidence and unknowns:** SDK 2.26.0 lacks the new export; package integration awaits the parent-built preview. Existing pairs already carry remote addresses and destination IDs come from the verified chain/project map; the final SDK API explicitly requires callers to authenticate the exact reciprocal peer/project, so a destination registry check prevents an ambiguous same-chain group from probing another project's authority. Present readiness does not promise future finality.
- **Verification:** First run a failing rendered-flow regression for denied initial mint and revocation after review; assert exact destination inputs, then check focused flow tests, lint, and diff. Root owns preview installation and full builds.
- **Resource budget:** One existing component and one focused component test; agents own the other clients. No installs, builds, staging or commits. Replan if the SDK signature or route identity changes.

## Checklist

- [x] Demonstrate initial-denial and reverify-denial failures before implementation.
- [x] Preserve destination route identity and require shared mint readiness.
- [x] Run focused regressions and report package integration limits.

## Review

The initial three rendered regressions failed before implementation: denied mint still exposed Prepare, and neither preparation path invoked the destination verifier. A further destination-registry mismatch regression also failed before adding exact reciprocal authentication. After implementation, five component regressions cover registry mismatch, denial, exact frozen inputs, pre-wallet revocation/retry, successful prepare, and transport recovery after preparation. These plus transaction builder coverage pass (2 files, 22 tests). Focused ESLint and `git diff --check` pass. `tsc --noEmit --incremental false` reports only the absent `verifySuckerDestinationMint` export in installed SDK 2.26.0; full package integration remains with the parent preview/build gate. No install, build, commit or on-chain write was executed.

## Plan refinement

- **Objective:** Qualify the frozen Juicebox Money reconciliation against the physically installed SDK preview using the complete applicable application checks, production build, budgets and browser suite; preserve exact logs and distinguish preview evidence from published-package or deployment evidence.
- **System fit:** SDK packaging owns source provenance and installed shared runtime; app owners freeze readiness, wallet recovery and tests; this coordinator owns reproducible verification only. Parent owns publication equivalence, CI release decisions and commits. No financial or live wallet execution is authorized.
- **Reuse and simplicity:** Run existing package scripts and CI-prescribed checks with Node 26.7.0/npm 12.0.1 and installed package resolution. Reuse existing deterministic build fixture, browser ports, coverage floors and protocol artifacts; do not add source aliases, dependency workarounds, weakened thresholds or replacement test flows.
- **Evidence and unknowns:** Parent preview installation record supplies package provenance; its current replacement must finish before any long check. Recovery owner must explicitly freeze source. Browser ports 3100/4399 were free at inspection. Dockerfile npm ci still resolves the checked-in published package, so OCI compilation of this unpublished payload awaits a parent-approved preview-aware path or published equivalence.
- **Verification:** Record dependency/dead-code/audit/container/lint/types/source/protocol/schema/transaction gates, full coverage, deterministic production build, all unchanged bundle budgets and production Chromium journeys. Preserve first failures, coordinate narrow fixes with owners and rerun affected gates after the last relevant edit. Verify final workspace diff and package provenance without committing.
- **Resource budget:** Parent reserved heavy slot 1 for Juicebox; wait for source/package freezes and serialize its coverage/build/browser work. Independent light checks may run together. Notify parent before browser servers bind; retain unrelated services. Stop and replan for unexplained package drift, invalid protocol artifacts or a fix changing scope.

## Full verification checklist

- [x] Confirm package provenance, pinned tools and owner source freeze.
- [x] Run static/dependency/schema/protocol/transaction checks with saved logs.
- [x] Run complete unit coverage and production build.
- [x] Check client budgets and production Chromium journeys; independently qualify the measured cap adjustment.
- [x] Record exact results, remaining release limits and final diff status.

## Full verification progress

Previously qualified physically installed SDK: `2.27.0-preview.adversarial.9ee3da134017`, source commit `a4022589502dada1507c1b40be7e9c13308bc630`, source digest `9ee3da13401741294223a507feaad88fead30fb35371d32992b9231125d1e027`. Snapshot and installation proofs are saved under `/private/tmp/jbm-adversarial-gates-20261009/`; manifest and lock hashes remain unchanged. Gates use Node 26.7.0/npm 12.0.1, CI mode and real installed package resolution. Production/test source freeze digest before complete coverage: `84c8aaa214a8adc01009f54191bd69ba6c9d9c65ed879257f4e11582a3d63b9f` (643 files).

Static results: full ESLint, dead-code, source invariants, transaction inventory, container definition, protocol artifacts (252 entries and eight chain rollout records), offline registry and both live schemas (38 GraphQL documents), and production audit pass. Existing audited Para exceptions remain unchanged. Initial audit/schema sandbox failures are preserved; network-enabled retries passed. The first full typecheck caught generic hash inference in two new submission callbacks and one widened test literal; the owners added explicit `Hex` callback types and preserved the literal. The exact full `ts:check`, scoped lint, and 134 affected tests then passed without caller casts.

`deps:check` records the expected mismatch between the installed explicit prerelease and unchanged published 2.26.0 manifest requirement; it is not reported green. Published-package adoption/equivalence remains a release gate. The separate OCI build/smoke would run a fresh `npm ci` against that published lock, so it remains pending, as does `env:check:all` against the intended release configuration. No deployment or release configuration was invented for this preview.

## Plan refinement

- **Objective:** Resolve only the measured Create and aggregate bundle-cap overages while preserving the artifact that passed all 2,970 unit tests and 66 production browser journeys; prove added cost before changing any limit.
- **System fit:** Application imports and emitted chunks own client delivery cost; SDK owns the new persistence/proof/deadline logic. Independent review verifies necessary versus accidental imports, this coordinator records exact before/after bytes, and parent authorizes only minimal measured cap changes. No wallet authority, financial behavior or lazy-loading requirement changes.
- **Reuse and simplicity:** Reuse the unchanged deterministic build and budget scripts. Preserve the candidate `.next`; create one isolated source archive at baseline commit `d2adfb452449de3ea42ef99efbe099fb8cde6872`, clone the current physical dependency graph, and replace only its SDK directory with the preserved official 2.26.0 package. Prefer a simple import correction if review finds accidental cost; otherwise round only the two measured caps.
- **Evidence and unknowns:** Candidate exact bytes are home 450,926, Create 523,352 and aggregate 2,602,920. Both new readiness/recovery modules remain lazy; all existing lazy checks pass. Historical baseline logs/config/toolchain and 2,387 non-SDK manifests match, but their old artifact lacks complete source/dependency/effective-environment fingerprints. A single fresh baseline closes that evidence gap.
- **Verification:** Verify isolated baseline manifest/lock/config equality, physical package resolution and copied non-SDK file hashes, record source/package/environment fingerprints, then run the same build and unchanged budget measurement. Independently review module attribution and byte deltas before any minimal cap edit; rerun budget, scoped lint and source checks afterward. Budget-only comments/limits do not change the browser artifact or require repeating the completed full suites.
- **Resource budget:** Use the released heavy slot 1 for one bounded baseline build; no installs, source aliases, commits or candidate rebuild. Keep ports and output trees isolated. Stop and replan if the baseline source/config/graph differs unexpectedly or a real eager dependency regression appears. Required workspace resources remain `/Users/jango/Documents/jb/v6/evm/AGENTS.md`, `workflow/ponytail/SKILL.md`, `workflow/ponytail/README.md`, `docs/PLAN_REFINEMENT.md`, relevant `tasks/lessons.md` and the archived descendant `AGENTS.md`.

## Historical preview qualification: 9ee3da134017

Full unit coverage passed **2,970 tests in 215 files**, with no skipped cases and every floor intact: statements **63.98%**, branches **56.78%**, functions **59.69%**, lines **65.97%**. The changed `useSafeTx` owner measures 95.26% statements, 92.04% branches, 92.53% functions and 96.87% lines. The exact production build passed in 141.5 seconds; all **66 Chromium journeys** passed in 136.8 seconds under CI flaky-test enforcement. The initial build attempt was blocked before compilation by sandbox loopback permission; its log is preserved alongside the successful authorized attempt.

One isolated baseline build at `d2adfb452449de3ea42ef99efbe099fb8cde6872` used preserved official SDK 2.26.0 and the same Node/npm/environment/configuration. All ten configuration and manifest files match; a full content/symlink inventory proves **114,824 non-SDK entries match**, including nested SDK dependencies, digest `cb7e502eb14fbea6e77a52325a5e96c8a65e18313f6f524c3d0211e8c2f4757f`. That baseline passed its production build and original budgets. Exact fresh baseline → candidate gzip bytes are home **450,900 → 450,926**, project **172,571 → 172,588**, Create **521,768 → 523,352**, and aggregate **2,599,261 → 2,602,920**.

Independent emitted-module review found no redundant new eager import: the recovery journal/proof module and mint verifier remain lazy, while required submission-persistence and authenticated deadline checks extend an existing eager SDK chunk. Parent authorized only the measured, independently reviewed adjustment: Create **512 KiB** and aggregate **2,542 KiB**, the smallest whole-KiB limits that pass (936 B and 88 B headroom). Every other cap and lazy assertion is unchanged. The same candidate artifact now passes the budget gate; scoped budget lint, source invariants and whitespace checks pass. No application/test runtime source changed after the passing complete suites and build, so those suites were not repeated for the comments/limits edit.

Final provenance verification compared all **771 installed SDK artifact files** byte-for-byte against the final tarball; the checked-in manifest/lock hashes remain unchanged. Served build ID is `build-TfctsWXpff2fKS`; 564 server/static files have digest `b7557c67472f722f17049026818160f031e71b6794bf82e4b3e3e0d76dadbf6d`. Exact commands, environment, timestamps, exits, initial failures, coverage, package/source proofs, baseline comparison and final results are retained under `/private/tmp/jbm-adversarial-gates-20261009/`, summarized by `qualification.json`.

These results qualify the historical **9ee3da134017 preview** application only. The expected prerelease-versus-published-lock dependency failure remains recorded; official package adoption/equivalence, the fresh-install OCI build/smoke, and intended release-environment validation remain release gates. No application commit, push, merge, publishing, deployment or live wallet write occurred in this verification task.

## Plan refinement

- **Objective:** Requalify Juicebox against the upcoming reviewed SDK artifact after the shared stale-candidate cache repair; retain all prior evidence without implying that it qualifies changed runtime bytes.
- **System fit:** The SDK owner repairs and freezes the shared cache rule, packaging owns the new physical artifact, and this coordinator reruns the existing app acceptance checks after installation. Application source is frozen; publication, official-lock adoption and release authority remain with the parent.
- **Reuse and simplicity:** Preserve the passing 9ee3da134017 production artifact and exact official 2.26.0 baseline, then reuse the existing pinned gate runner and unchanged tests. No app edits, dependency aliases, repeated baseline build or alternate recovery logic are planned.
- **Evidence and unknowns:** The parent reports a stale unreadable hash-repair candidate can overwrite another candidate's trusted in-memory hash, while the durable guard held. Prior 2,970-unit/66-browser evidence is historical until the reviewed replacement is physically installed and fingerprinted; its byte impact is unknown.
- **Verification:** Verify the replacement package and source freeze, then rerun appropriate complete unit coverage, production build, Chromium journeys and exact bundle budgets against the installed replacement. Preserve first failures and compare any changed bundle bytes to the already qualified baseline before considering a minimal measured cap adjustment.
- **Resource budget:** Hold both heavy slots until the parent reports SDK refreeze and installation; do not repeat checks early. Reuse slot 1 serially for JBM and confirm ports 3100/4399 before browser startup. No commits, pushes, publication, deployment or wallet writes.

## Replacement artifact status

- [x] Preserve the 9ee3da134017 `.next` artifact at `/private/tmp/jbm-adversarial-artifact-9ee3da134017` (build ID `build-TfctsWXpff2fKS`), its qualification logs and the exact official 2.26.0 baseline.
- [x] Mark prior qualification historical pending the parent-authorized SDK cache repair.
- [x] Receive reviewed SDK refreeze and physical replacement installation.
- [x] Verify replacement identity, rerun applicable final app gates and record current qualification.

The parent authorized final qualification on installed `2.27.0-preview.adversarial.4006a0bca708`, SDK source `930f89f2f2cd06afaced3d5fddfd466b29edd24e`. After all appropriate checks and independent budget review pass, parent now authorizes a local commit of this task's client changes; no push, publication, merge or deployment. Existing official 2.26 baseline evidence remains authoritative and will not be rebuilt. New logs are isolated at `/private/tmp/jbm-adversarial-gates-4006a0bca708/`.

## Final preview qualification: 4006a0bca708

The reviewed cache-repair artifact is `2.27.0-preview.adversarial.4006a0bca708`, source commit `930f89f2f2cd06afaced3d5fddfd466b29edd24e`, source digest `4006a0bca708ba4929942a7b62b48e566a44ba347db0f002661712af513df4b9`, tar SHA256 `7107a0ff2af3b373d5c7708468651090a165deb254a8f93071488d2fafba8116`. All **771 installed package files** match that tar before and after qualification. Manifest and lock hashes remain unchanged. No source aliases were used.

Fresh pinned Node 26.7.0/npm 12.0.1 verification passes full lint, typecheck, dead-code, source invariants, protocol, transaction inventory, container definition, production audit and live/offline schema checks. Complete coverage passes **2,970 tests in 215 files** (104.5 seconds), with statements **63.98%**, branches **56.79%**, functions **59.69%**, lines **65.97%** and all floors intact. The fresh deterministic production build passes in **110.6 seconds**, including its clean TypeScript check; all **66 production Chromium journeys** pass in **87.5 seconds**, with no skipped, flaky or retried cases. Heavy slot 1 was released immediately afterward.

The preserved exact official 2.26 baseline was reused. Baseline → final gzip bytes are home **450,900 → 450,924** (+24), project **172,571 → 172,586** (+15), Create **521,768 → 523,350** (+1,582), and aggregate **2,599,261 → 2,602,943** (+3,682). Independent review confirms both preview builds emit 188 chunks; the final cache repair adds 29 B to lazy recovery chunk 8747 while other changes net −6 B, only **23 B overall** since preview 9ee3. Recovery remains absent from initial route assets, every lazy assertion passes, and no dependencies or eager imports were added. Existing **512 KiB Create / 2,542 KiB aggregate** caps remain the smallest whole-KiB limits that pass, with **938 B / 65 B** headroom. Only measurement comments were refreshed; budget, source and scoped lint checks passed afterward.

The 643-file source freeze digest is `7cb0d936a27c42d0111e350c55d42c434e964fac0913173427a63ea7cd2f7cf3`; only those budget measurement comments changed after the complete runtime checks. All 564 served server/static files match their pre-browser hashes, digest `b1dda45bc72c7aa2d01274a65b44a6dbe81651f20a074481a0882824146a18b5`, build ID `build-TfctsWXpff2fKS`. Independent app review, including a separate mint-modal review, found no blocker. Exact commands, environments, durations, results and proofs are in `/private/tmp/jbm-adversarial-gates-4006a0bca708/qualification.json`.

The expected `deps:check` failure explicitly identifies the prerelease installed against the unchanged official 2.26.0 requirement. This qualifies the installed preview only: published-package adoption/equivalence and locked dependency validation, fresh-install OCI build/smoke, and intended release-environment checks remain required. The parent authorized a local task-only commit after these checks; no push, publication, merge, deployment or wallet write is authorized.

## Official 2.27.0 adoption

Published core 2.27.0 is now pinned at registry integrity `sha512-fVGeoj2OE1iVIIZmvFY6aQUtZKlydnJkxulreKM3wIYLm7I+rXnSdsIwqRXf5VnRUyLOCWc7NuIyKGxk8jp+wA==`; its tarball SHA256 is `e2f6c0f992a9e788e0752f1589fe7471543192d485a95837d52b34e5778f6812`. All 770 installed package files match the official archive, whose 769 compiled/public payload files match the reviewed 4006 preview. The package and lock diff changes only core's exact version, URL and integrity, and normalized non-core manifest/lock hashes remain unchanged.

A physical npm 12 clean install and the complete consumer release gates pass: dependency graph, dead-code, production audit, container definition, lint, types, source rules, pinned protocol deployments, live/offline schemas, transaction inventory, deployment environment, **2,970 covered unit tests**, deterministic production build, bundle/lazy-load budgets and **66 Chromium journeys**. A separate clean Docker build passes its environment guard, and the standalone image answers `/api/healthz` as the non-root `node` user with a read-only root filesystem, all capabilities dropped and `no-new-privileges`. This closes the preview's package, clean-install, OCI and environment qualifications. PR #119's exact pushed SHA and its independent Linux jobs remain the final client evidence; no merge, tag, deployment or contract action is part of this adoption.
