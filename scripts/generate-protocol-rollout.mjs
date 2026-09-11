import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { executedDeploymentAddress } from './lib/protocol-rollout-artifacts.mjs'

// Only canonical executed deployment records enable a chain. Proposal output is
// deliberately not an input: after execution the same command updates the app.
const root = resolve(process.env.PROTOCOL_DEPLOYMENTS_DIR ?? '../../deploy-all-v6')
const chainNames = { 1: 'ethereum', 10: 'optimism', 8453: 'base', 42161: 'arbitrum', 11155111: 'sepolia', 11155420: 'optimism_sepolia', 84532: 'base_sepolia', 421614: 'arbitrum_sepolia' }
const names = ['JBDirectory', 'JBBuybackHook', 'JBBuybackHookRegistry', 'JBRouterTerminal', 'JBRouterTerminalRegistry', 'JBRouterTerminalGateway', 'JBRatioPriceFeed']
const read = (chain, name) => {
  const path = join(root, 'deployments', chain, `${name}.json`)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}
const chains = {}
let gatewayAbi
for (const [id, alias] of Object.entries(chainNames)) {
  const contracts = {}
  for (const name of names) contracts[name] = executedDeploymentAddress(read(alias, name), id, name)
  const history = {}
  for (const name of ['JBBuybackHook', 'JBRouterTerminal']) {
    history[name] = {
      previous: executedDeploymentAddress(read(alias, `${name}_deprecated1`), id, name) ?? (!contracts.JBRouterTerminalGateway ? contracts[name] : null),
      v1: executedDeploymentAddress(read(alias, `${name}_deprecated`), id, name),
    }
  }
  chains[id] = { alias, contracts, history }
  gatewayAbi ??= read(alias, 'JBRouterTerminalGateway')?.abi
}
if (!gatewayAbi) throw new Error('No executed gateway artifact found; use the canonical rollout deployment checkout.')
const source = { repository: 'deploy-all-v6', commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() }
const snapshot = { source, chains }
const abiNames = new Set(['ROUTER', 'pendingCallCount', 'pendingCallCommitmentOf', 'pendingCallFailureOf', 'processPendingCall', 'processPendingCallWithGas', 'finalizePendingCall', 'finalizePendingCallWithGas'])
const abi = gatewayAbi.filter(item => (item.type === 'function' && abiNames.has(item.name)) || (item.type === 'event' && item.name.startsWith('JBRouterTerminalGateway_')))
const outputs = {
  'src/lib/protocol-rollout.json': `${JSON.stringify(snapshot, null, 2)}\n`,
  'src/lib/router-gateway-abi.ts': `// Generated from an executed JBRouterTerminalGateway artifact by scripts/generate-protocol-rollout.mjs.\nexport const routerGatewayAbi = ${JSON.stringify(abi, null, 2)} as const\n`,
}
const fixturePath = 'test/fixtures/protocol-deployments.v6.json'
if (existsSync(fixturePath)) {
  let fixtureText = readFileSync(fixturePath, 'utf8')
  const fixture = JSON.parse(fixtureText)
  fixture.source = source
  fixture.overrides = {}
  for (const name of new Set([...Object.keys(fixture.deployments), ...names])) {
    const addresses = Object.fromEntries(Object.entries(chainNames).map(([id, alias]) => [id, executedDeploymentAddress(read(alias, name), id, name)]))
    const common = Object.values(addresses).find(Boolean)
    if (!common) throw new Error(`No canonical deployment for fixture contract ${name}`)
    fixture.deployments[name] = common
    for (const [id, address] of Object.entries(addresses)) {
      if (address === common) continue
      fixture.overrides[id] ??= {}
      fixture.overrides[id][name] = address
    }
  }
  // Only these sections are generated here. Preserve chain ordering and the
  // independently maintained sucker-deployer rows exactly as written.
  for (const name of ['source', 'deployments', 'overrides']) {
    const section = new RegExp(`^  "${name}": (?:\\{\\}|\\{\\n[\\s\\S]*?^  \\})`, 'gm')
    if ([...fixtureText.matchAll(section)].length !== 1) throw new Error(`Expected one fixture section: ${name}`)
    const value = JSON.stringify(fixture[name], null, 2).replaceAll('\n', '\n  ')
    fixtureText = fixtureText.replace(section, () => `  "${name}": ${value}`)
  }
  if (JSON.stringify(JSON.parse(fixtureText)) !== JSON.stringify(fixture)) throw new Error('Fixture serialization changed deployment data.')
  outputs[fixturePath] = fixtureText
}
for (const [path, data] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== data) throw new Error(`Stale generated rollout file: ${path}`)
  } else writeFileSync(path, data)
}
console.log(`Verified rollout records for ${Object.keys(chains).length} chains at ${source.commit}.`)
