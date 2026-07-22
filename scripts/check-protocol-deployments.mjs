import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const fixturePath = resolve('test/fixtures/protocol-deployments.v6.json')
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
const addressPattern = /^0x[0-9a-f]{40}$/

if (fixture.format !== 'juicebox-v6-app-deployments-1') {
  throw new Error(`Unsupported deployment fixture format in ${fixturePath}`)
}

for (const [name, address] of Object.entries(fixture.deployments)) {
  if (!addressPattern.test(address)) {
    throw new Error(`Invalid pinned address for ${name}: ${address}`)
  }
}

const chainFamilies = [
  ['1', '10', '8453', '42161'],
  ['11155111', '11155420', '84532', '421614'],
]
const expectedPairChains = chainFamilies.flat().sort()
const actualPairChains = Object.keys(fixture.suckerDeployerPairs ?? {}).sort()
if (JSON.stringify(actualPairChains) !== JSON.stringify(expectedPairChains)) {
  throw new Error(
    `Sucker deployer local chains: expected ${expectedPairChains.join(',')}, got ${actualPairChains.join(',')}`,
  )
}
let suckerPairCount = 0
let suckerArtifactCount = 0
for (const family of chainFamilies) {
  for (const localChainId of family) {
    const pairs = fixture.suckerDeployerPairs?.[localChainId]
    const expectedRemotes = family
      .filter(chainId => chainId !== localChainId)
      .sort()
    const actualRemotes = Object.keys(pairs ?? {}).sort()
    if (JSON.stringify(actualRemotes) !== JSON.stringify(expectedRemotes)) {
      throw new Error(
        `Sucker deployer peers for ${localChainId}: expected ${expectedRemotes.join(',')}, got ${actualRemotes.join(',')}`,
      )
    }
    for (const remoteChainId of expectedRemotes) {
      const pair = pairs[remoteChainId]
      if (!pair.ccip || typeof pair.ccip !== 'object') {
        throw new Error(`Missing CCIP deployer for ${localChainId} -> ${remoteChainId}`)
      }
      if (!Object.hasOwn(pair, 'native')) {
        throw new Error(
          `Native deployer availability is not explicit for ${localChainId} -> ${remoteChainId}`,
        )
      }
      for (const [bridge, deployment] of Object.entries(pair)) {
        if (bridge !== 'ccip' && bridge !== 'native') {
          throw new Error(
            `Unknown sucker bridge ${bridge} for ${localChainId} -> ${remoteChainId}`,
          )
        }
        if (deployment === null) continue
        if (
          !/^[A-Za-z0-9_]+$/.test(deployment.artifact) ||
          !addressPattern.test(deployment.address)
        ) {
          throw new Error(
            `Invalid ${bridge} sucker artifact for ${localChainId} -> ${remoteChainId}`,
          )
        }
        suckerArtifactCount += 1
      }
      suckerPairCount += 1
    }
  }
}

const deploymentsRoot = process.env.PROTOCOL_DEPLOYMENTS_DIR
if (!deploymentsRoot) {
  process.stdout.write(
    `Pinned ${Object.keys(fixture.deployments).length} app-used deployments on ${Object.keys(fixture.chains).length} chains plus ${suckerArtifactCount} deployer artifacts across ${suckerPairCount} directed sucker pairs from deploy-all-v6 ${fixture.source.commit}.\n`,
  )
  process.stdout.write(
    'Set PROTOCOL_DEPLOYMENTS_DIR to a deploy-all-v6 checkout to verify every artifact.\n',
  )
  process.exit(0)
}

const root = resolve(deploymentsRoot)
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim()
if (commit !== fixture.source.commit) {
  throw new Error(
    `deploy-all-v6 is at ${commit}; fixture requires ${fixture.source.commit}`,
  )
}

let checked = 0
for (const [chainId, alias] of Object.entries(fixture.chains)) {
  const chainOverrides = fixture.overrides[chainId] ?? {}
  for (const [name, commonAddress] of Object.entries(fixture.deployments)) {
    const expected = Object.hasOwn(chainOverrides, name)
      ? chainOverrides[name]
      : commonAddress
    const artifactPath = join(root, 'deployments', alias, `${name}.json`)
    const actual = existsSync(artifactPath)
      ? JSON.parse(readFileSync(artifactPath, 'utf8')).address?.toLowerCase()
      : null
    if (actual !== expected) {
      throw new Error(
        `${name} on chain ${chainId}: fixture=${expected}, artifact=${actual}`,
      )
    }
    checked += 1
  }
}

for (const [localChainId, pairs] of Object.entries(
  fixture.suckerDeployerPairs,
)) {
  const alias = fixture.chains[localChainId]
  for (const [remoteChainId, pair] of Object.entries(pairs)) {
    for (const [bridge, deployment] of Object.entries(pair)) {
      if (deployment === null) continue
      const artifactPath = join(
        root,
        'deployments',
        alias,
        `${deployment.artifact}.json`,
      )
      const actual = existsSync(artifactPath)
        ? JSON.parse(readFileSync(artifactPath, 'utf8')).address?.toLowerCase()
        : null
      if (actual !== deployment.address) {
        throw new Error(
          `${bridge} sucker deployer ${localChainId} -> ${remoteChainId} (${deployment.artifact}): fixture=${deployment.address}, artifact=${actual}`,
        )
      }
      checked += 1
    }
  }
}

process.stdout.write(
  `Verified ${checked} app deployment entries against deploy-all-v6 ${commit}.\n`,
)
