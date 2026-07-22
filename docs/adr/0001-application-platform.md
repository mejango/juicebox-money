# ADR 0001: Retain Next.js as the application platform

- Status: Accepted
- Date: 2026-07-22

## Context

Before this decision the application contained roughly 43,400 production
lines, 74 TSX/JSX files, 32 files importing Next APIs, 68 client components,
14 server-only modules, and 15 API routes. It relies on App Router server
rendering, streamed project metadata, route status/metadata, server-side data
caching, image/font optimization, and same-origin APIs for indexed data and
IPFS operations. Wallet state remains client-side.

Next 14 was no longer an acceptable pre-production baseline. Its maintenance
window and dependency graph were behind current stable releases, but replacing
the framework would also rewrite active security and transaction boundaries.

## Options considered

1. Keep Next 14. Lowest immediate change, but poor support horizon and no
   sustainable deployment artifact.
2. Upgrade to current stable Next and emit its standalone server. This retains
   one deployable service and the existing SSR/API/cache model.
3. Move the UI to Vite/React Router and the API routes to Hono or another Node
   service. This offers a smaller frontend toolchain, but creates two build and
   deployment surfaces, rewrites every server route and server component, and
   loses Next's integrated cache, metadata, image, and font behavior.
4. Replace React as well. No current performance or maintainability evidence
   justifies rewriting 74 established component surfaces and the wallet SDK
   integration.

## Decision

Use Next 16.2 with React 18 and webpack, packaged as a standalone OCI service.
React 19 remains a separate migration so framework, wallet, and renderer
changes do not land as one unreviewable step. Webpack remains explicit because
Para's maintained packages still publish optional integrations that require
narrow compile-time aliases.

Use Para 3's focused wagmi connector with EIP-6963/injected wallet discovery.
The embedded-auth modal and its Tailwind 4 stylesheet load only after a user
requests sign-in. Para's client and focused connector are also constructed only
after that action (or when restoring a prior Para session), so anonymous visits
perform no wallet-network requests. This removed the all-wallet connector
bundle while retaining embedded and browser-wallet behavior.

## Consequences

- The application stays a single service with portable Node semantics rather
  than depending on one hosting vendor.
- The OCI image runs non-root, validates configuration before startup, and
  exposes `/api/healthz`.
- Current initial JavaScript and lazy wallet styling are enforced by build
  budgets and browser tests.
- A Vite/API split should be reconsidered only if server functionality becomes
  independently scaled, most server components disappear, or measured Next
  runtime cost exceeds the cost of operating two services.
