# Deployment

Juicebox Money ships as one portable Next standalone OCI image. It does not
require Vercel or another vendor-specific runtime. The image is built from an
exact Node 26.5.0 base image digest, installs the exact npm 12.0.1 toolchain,
disables Node's experimental process-wide Web Storage on the server, and runs
as the non-root `node` user.

The platform decision and alternatives are recorded in
[`docs/adr/0001-application-platform.md`](docs/adr/0001-application-platform.md).

## Railway branch environments

Use the repository `railway.json` for both Railway services:

| Git branch | Railway environment | Public origin |
| --- | --- | --- |
| `staging` | staging | `https://staging.juicebox.money` |
| `main` | production | `https://juicebox.money` |

Connect staging to `staging` and production to `main`, enable automatic deploys
only after CI succeeds, and disable overlap so an older build cannot replace a
newer commit. Set `NEXT_PUBLIC_SITE_URL` to the matching origin and
`NEXT_PUBLIC_VERSION=${{RAILWAY_GIT_COMMIT_SHA}}` in both environments. Keep
all other public build values and every runtime secret environment-scoped.
Promote by merging `staging` into `main`, never by pointing production at
`staging`.

## Configuration contract

`NEXT_PUBLIC_*` values are public and embedded at image build time. Changing
one requires a new image. Runtime secrets must never be passed as Docker build
arguments or repository variables.

| Variable | Phase | Requirement |
| --- | --- | --- |
| `NEXT_PUBLIC_SITE_URL` | build | Canonical HTTPS origin for the selected environment |
| `NEXT_PUBLIC_BENDYSTRAW_URL` | build | Absolute HTTPS base URL; `/graphql` is appended automatically |
| `NEXT_PUBLIC_TESTNET_BENDYSTRAW_URL` | build | Absolute HTTPS testnet base URL; `/graphql` is appended automatically |
| `NEXT_PUBLIC_PARA_API_KEY` | build | Public Para application key |
| `NEXT_PUBLIC_PARA_ENV` | build | Para application environment; normally `PROD` |
| `NEXT_PUBLIC_DWELLIR_API_KEY` | build | Public browser RPC key; apply strict provider quotas |
| `NEXT_PUBLIC_VERSION` | build | Commit SHA shown by the app/health endpoint |
| `IPFS_PINNING_ENABLED` | runtime | Explicit `false` by default |
| `IPFS_PINNING_EDGE_PROTECTED` | runtime | Must be `true` when pinning is enabled |
| `IPFS_PINNING_INGRESS_TOKEN` | runtime | Random 32+ character secret required only when pinning is enabled |
| `FILEBASE_IPFS_RPC_TOKEN` | runtime | Secret Filebase RPC bearer token; required only for pinning |
| `PINATA_JWT` | runtime | Secret Pinata JWT; required only for redundant pinning |

Copy `.env.example` for local names, but inject real values through the
deployment platform. `.env*` files are excluded from both git and the Docker
build context. `npm run env:check:all` validates a deployment environment
without printing its values.

## Build and smoke locally

```sh
docker build -t juicebox-money:local \
  --build-arg NEXT_PUBLIC_SITE_URL=https://juicebox.money \
  --build-arg NEXT_PUBLIC_BENDYSTRAW_URL=https://bendystraw.xyz \
  --build-arg NEXT_PUBLIC_TESTNET_BENDYSTRAW_URL=https://testnet.bendystraw.xyz \
  --build-arg NEXT_PUBLIC_PARA_API_KEY=PUBLIC_KEY \
  --build-arg NEXT_PUBLIC_PARA_ENV=PROD \
  --build-arg NEXT_PUBLIC_DWELLIR_API_KEY=PUBLIC_KEY \
  --build-arg NEXT_PUBLIC_VERSION=$(git rev-parse HEAD) .

docker run --rm \
  --read-only \
  --tmpfs /app/.next/cache:uid=1000,gid=1000 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --publish 127.0.0.1:3000:3000 \
  --env IPFS_PINNING_ENABLED=false \
  juicebox-money:local
curl --fail http://127.0.0.1:3000/api/healthz
```

Run `npm run check:deploy` with the intended environment before publishing.
The CI container job independently builds the Dockerfile, verifies readiness,
and verifies that the runtime user is non-root. CI and release both exercise
the same least-privilege shape: a read-only root filesystem, a writable Next
cache tmpfs owned by Node's UID/GID 1000, no Linux capabilities, no privilege
escalation, and a host port bound only to loopback.

## IPFS safety

Secret-backed pin routes are unavailable unless the operator explicitly
enables them, acknowledges external edge protection, and configures a random
32+ character ingress token. The browser must never receive that token. Before
enabling, configure the trusted CDN/ingress to:

1. strip every client-supplied `x-juicebox-pinning-ingress-token` header;
2. authenticate or rate-limit the caller with per-IP, per-account, global
   request, and byte quotas for every `/api/ipfs/pin-*` route;
3. inject that header with `IPFS_PINNING_INGRESS_TOKEN` only after the policy
   passes;
4. use provider credentials scoped to this application and a bounded quota;
5. alert on rejected requests, provider quota consumption, and 5xx rates; and
6. rotate the ingress and provider credentials if either boundary may leak.

Every pin route performs a constant-time comparison against the injected
header before parsing the request body. Application size/type limits and
upstream timeouts are defense in depth, not a replacement for distributed rate
limiting. Browser `Origin` headers are not authorization. Keep pinning disabled
if the ingress cannot provide this boundary. The read-only IPFS proxy decodes
canonical CID multibase/version/codec/multihash data before accepting a path,
caps responses, prevents MIME sniffing, and sandboxes or downloads active
content. Store-item metadata additionally requires CIDv0 because the 721 hook
stores its sha2-256 digest as `bytes32`.

## GHCR release and rollback

Set the public build values above as GitHub repository variables. A `v*` tag or
manual **Release OCI image** run repeats the complete test gate with read-only
repository permissions, validates configuration, and smoke-tests a
single-platform standalone candidate. Only then does the separate publish job
request approval through the GitHub `production` environment and receive GHCR
write/OIDC permissions to publish one amd64/arm64 manifest:

```text
ghcr.io/bananapus/juicebox-money:sha-<40-character-commit>
```

The release includes an SBOM and maximum BuildKit provenance. Deploy by digest
(`ghcr.io/bananapus/juicebox-money@sha256:...`), not by a mutable tag. Record
the digest with the environment change. Rollback means redeploying the prior
known-good digest with its matching runtime configuration, then waiting for
`/api/healthz` before restoring traffic. Never rebuild an old commit and call
that a rollback.

The same image supports mainnet and testnet chains. Creation presents an
explicit Production/Testnets choice, and indexed reads select the matching
Bendystraw endpoint from each operation's chain ID.
