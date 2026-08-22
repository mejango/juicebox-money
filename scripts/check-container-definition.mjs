import { existsSync, readFileSync } from 'node:fs'

const dockerfile = readFileSync('Dockerfile', 'utf8')
const dockerignore = readFileSync('.dockerignore', 'utf8')
const npmConfig = readFileSync('.npmrc', 'utf8')
const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
const release = readFileSync('.github/workflows/release-image.yml', 'utf8')
const productionStart = readFileSync('scripts/start-production.mjs', 'utf8')
const globalStyles = readFileSync('src/app/globals.css', 'utf8')

const checks = [
  [
    /^FROM node:26\.7\.0-bookworm-slim@sha256:cd565714d4da3e84bfd341e31448f81d47c6362198f152345297c9c1154e6341 AS base$/m,
    'the Node base image must be versioned and digest-pinned',
  ],
  [
    /^RUN npm install --global npm@12\.0\.1 --no-audit --no-fund$/m,
    'the container build must use the package-manager version pinned by package.json',
  ],
  [
    /^COPY package\.json package-lock\.json \.npmrc \.\/$/m,
    'the dependency stage must inherit the repository Node runtime policy',
  ],
  [
    /NODE_OPTIONS=--no-experimental-webstorage/,
    'the Node 26 server must not expose its experimental process-wide localStorage',
  ],
  [
    /ARG RAILWAY_GIT_COMMIT_SHA[\s\S]*NEXT_PUBLIC_VERSION=\$\{NEXT_PUBLIC_VERSION:-\$\{RAILWAY_GIT_COMMIT_SHA\}\}/,
    'Railway builds must derive NEXT_PUBLIC_VERSION from the deployed commit',
  ],
  [/output: 'standalone'/, 'Next must emit a standalone server'],
  [/^USER node$/m, 'the production container must run as non-root'],
  [/^HEALTHCHECK /m, 'the production container must define a healthcheck'],
  [/scripts\/start-production\.mjs/, 'startup must validate deployment config'],
  [/^\.env\*$/m, 'the Docker context must exclude every .env variant'],
  [/^\*$/m, 'the Docker context must default-deny build inputs'],
  [/^!src\/\*\*$/m, 'the Docker context must explicitly allow application source'],
  [/sbom: true/, 'the release must publish an SBOM'],
  [/provenance: mode=max/, 'the release must publish maximum provenance'],
  [/sha-\$\{\{ github\.sha \}\}/, 'the release image tag must include the commit SHA'],
  [/environment: production/, 'the release must require the production environment'],
  [/platforms: linux\/amd64,linux\/arm64/, 'the release must publish amd64 and arm64'],
  [/docker\/setup-qemu-action@[a-f0-9]{40}/, 'the release must use pinned QEMU'],
  [/container-smoke:/, 'CI must smoke-test the standalone container'],
  [/\.Config\.User.*node/, 'CI must verify the container runs as non-root'],
]

for (const [pattern, message] of checks) {
  const source = message.includes('Docker context')
    ? dockerignore
    : message.startsWith('CI')
      ? ci
      : message.includes('release') || message.includes('image tag')
      ? release
      : message.includes('Next')
        ? readFileSync('next.config.js', 'utf8')
        : dockerfile
  if (!pattern.test(source)) throw new Error(message)
}

const tailwindConfigPath = globalStyles.match(
  /^@config\s+["']\.\.\/\.\.\/([^"']+)["'];?$/m,
)?.[1]
if (
  !tailwindConfigPath ||
  !existsSync(tailwindConfigPath) ||
  !dockerignore.split(/\r?\n/u).includes(`!${tailwindConfigPath}`)
) {
  throw new Error(
    'the Docker context must include the Tailwind config referenced by the global stylesheet',
  )
}

if (
  !productionStart.includes('process.env.RAILWAY_GIT_COMMIT_SHA') ||
  !productionStart.includes('process.env.NEXT_PUBLIC_VERSION ||=')
) {
  throw new Error('runtime must recover the revision from Railway before validation')
}

if (
  !npmConfig.includes('node-options=--no-experimental-webstorage') ||
  !npmConfig.includes('strict-allow-scripts=true')
) {
  throw new Error(
    'local lifecycle scripts must disable Node Web Storage and reject unreviewed dependency scripts',
  )
}

for (const [label, workflow] of [
  ['CI', ci],
  ['release', release],
]) {
  for (const [pattern, requirement] of [
    [/--read-only/, 'use a read-only root filesystem'],
    [
      /--tmpfs \/app\/\.next\/cache:uid=1000,gid=1000/,
      'mount the Next cache as a tmpfs owned by the node user',
    ],
    [/--cap-drop ALL/, 'drop every Linux capability'],
    [/--security-opt no-new-privileges/, 'prevent privilege escalation'],
    [
      /--publish 127\.0\.0\.1:3000:3000/,
      'bind the smoke-test port to loopback only',
    ],
  ]) {
    if (!pattern.test(workflow)) {
      throw new Error(`${label} container smoke must ${requirement}`)
    }
  }

  for (const match of workflow.matchAll(
    /^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm,
  )) {
    if (!/@[a-f0-9]{40}$/.test(match[1])) {
      throw new Error(`${label} action is not commit-pinned: ${match[1]}`)
    }
  }
}

if (!/^permissions:\n  contents: read\n\nconcurrency:/m.test(release)) {
  throw new Error('release workflow permissions must default to read-only contents')
}
if (!/^  publish:\n[\s\S]*?^    needs: verify-build-and-smoke$/m.test(release)) {
  throw new Error('release publishing must depend on the completed verification job')
}
if (
  !/^  publish:\n[\s\S]*?^    permissions:\n      contents: read\n      packages: write\n      id-token: write$/m.test(
    release,
  )
) {
  throw new Error('only the publish job may receive package and OIDC permissions')
}
const verifyJob = release.match(
  /^  verify-build-and-smoke:\n([\s\S]*?)(?=^  publish:)/m,
)?.[1]
if (!verifyJob || /packages: write|id-token: write/.test(verifyJob)) {
  throw new Error('release verification must not receive publish credentials')
}

process.stdout.write('Container and release definitions are pinned and safe.\n')
