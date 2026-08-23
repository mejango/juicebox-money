# Deployment

Juicebox Money ships as one portable Next standalone OCI image. It does not
require Vercel or another vendor-specific runtime. The image is built from an
exact Node 26.7.0 base image digest, installs the exact npm 12.0.1 toolchain,
disables Node's experimental process-wide Web Storage on the server, and runs
as the non-root `node` user.

The platform decision and alternatives are recorded in
[`docs/adr/0001-application-platform.md`](docs/adr/0001-application-platform.md).

## Railway branch environments

Use the repository `railway.json` for both Railway services:

| Git branch | Railway environment | Public origin |
| --- | --- | --- |
| `dev` | dev | `https://dev.juicebox.money` |
| `main` | production | `https://juicebox.money` |

Connect dev to `dev` and production to `main`, enable automatic deploys
only after CI succeeds, and disable overlap so an older build cannot replace a
newer commit. Set `NEXT_PUBLIC_SITE_URL` to the matching origin. Do not
configure `NEXT_PUBLIC_VERSION` in Railway: the Dockerfile consumes Railway's
automatically injected `RAILWAY_GIT_COMMIT_SHA` and exposes it to the
application as `NEXT_PUBLIC_VERSION`. Keep all other public build values and
every runtime secret environment-scoped. The dev environment is for active feature integration;
a production-candidate staging environment may be added separately later. Promote reviewed work by
merging `dev` into `main`, never by pointing production at `dev`.

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
| `NEXT_PUBLIC_VERSION` | build | Optional non-Railway override for the commit SHA shown by the app/health endpoint; Railway derives it automatically |

Copy `.env.example` for local names, but inject real values through the
deployment platform. `.env*` files are excluded from both git and the Docker
build context. `npm run env:check:all` validates a deployment environment
without printing its values.

## Build and smoke locally

```sh
docker build -t juicebox-money:local \
  --build-arg NEXT_PUBLIC_SITE_URL=https://juicebox.money \
  --build-arg NEXT_PUBLIC_BENDYSTRAW_URL=https://bendystraw.up.railway.app \
  --build-arg NEXT_PUBLIC_TESTNET_BENDYSTRAW_URL=https://testnet.bendystraw.xyz \
  --build-arg NEXT_PUBLIC_PARA_API_KEY=PUBLIC_KEY \
  --build-arg NEXT_PUBLIC_PARA_ENV=PROD \
  --build-arg NEXT_PUBLIC_VERSION=$(git rev-parse HEAD) .

docker run --rm \
  --read-only \
  --tmpfs /app/.next/cache:uid=1000,gid=1000 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --publish 127.0.0.1:3000:3000 \
  juicebox-money:local
curl --fail http://127.0.0.1:3000/api/healthz
```

Run `npm run check:deploy` with the intended environment before publishing.
The CI container job independently builds the Dockerfile, verifies readiness,
and verifies that the runtime user is non-root. CI and release both exercise
the same least-privilege shape: a read-only root filesystem, a writable Next
cache tmpfs owned by Node's UID/GID 1000, no Linux capabilities, no privilege
escalation, and a host port bound only to loopback.

## Juicebox Center safety

Juicebox Money is a credential-free Juicebox Center client. It imports
`@bananapus/nana-sdk-core/jbcenter`, calls `pinJson`, `pinImage`, and `pinMedia`
directly from the browser, and reads immutable content through
`https://juicebox.center/ipfs/:cid`. Read-only RPC also uses the SDK's
EIP-1193 provider. Browsers supply the production `Origin`; server-rendered
reads set that same fixed origin. Center owns origin policy, quotas, upload and
RPC limits, provider credentials, and redundant pinning.

Do not add a Center API key to `NEXT_PUBLIC_*`, reintroduce provider secrets, or
proxy these requests through a webclient API route. Server-side clients may use
a Center API key, but a browser key cannot be secret. Local development can run
the rest of the app normally; exercising live pinning requires an origin trusted
by Center.

JBM still validates form inputs before upload and requires CIDv0 for store-item
metadata because the 721 hook stores its sha2-256 digest as `bytes32`. Center is
the resource/security boundary; JBM's checks are user-facing validation.

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
