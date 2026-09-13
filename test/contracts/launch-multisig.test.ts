import {
  CREATE_BATCH_ABI,
  MULTICALL3,
  SAFE_CREATE_ABI,
  SAFE_FACTORY,
  SAFE_FALLBACK,
  SAFE_SINGLETON,
  predictSafeAddress,
  type SafeDeploymentPlan,
} from '@bananapus/nana-sdk-core/safe'
import {
  concatHex,
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  getAddress,
  keccak256,
  parseAbi,
  stringToHex,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { describe, expect, it, vi } from 'vitest'
import fixture from '../fixtures/safe-1.4.1.json'
import { createSimpleProjectStage, DEFAULT_STORE_FLAGS, type LaunchPlan } from '@/lib/launch'
import {
  bundleLaunchMultisigs,
  canRelayrCreateFromAccount,
  checkLaunchMultisigs,
  launchMultisigReview,
  resolveLaunchMultisig,
  unbundleLaunchMultisigs,
  validateAuthorityPolicy,
  validateLaunchMultisigs,
  verifyCreatedLaunchMultisigs,
  verifyLaunchMultisigSimulation,
} from '@/lib/launch-multisig'
import type { RelayrEntry } from '@/lib/relayr'

const OWNERS: Address[] = [
  '0x0000000000000000000000000000000000000002',
  '0x0000000000000000000000000000000000000003',
  '0x0000000000000000000000000000000000000004',
]
const SALT = toHex(42n, { size: 32 })
const POLICY = {
  owners: OWNERS,
  threshold: 2,
  saltNonce: keccak256(concatHex([SALT, stringToHex('owner')])),
  proxyCreationCode: fixture.contracts.proxy.creationCode as Hex,
}
const SAFE: SafeDeploymentPlan = { ...POLICY, address: predictSafeAddress(POLICY) }
const FORWARDED_LAUNCH: RelayrEntry = {
  chain: 1,
  target: '0x5555555555555555555555555555555555555555',
  data: '0xabcdef123456',
  value: '123456789',
  virtual_nonce: 7,
}
const READ_ABI = parseAbi([
  'function masterCopy() view returns (address)',
  'function VERSION() view returns (string)',
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function getModulesPaginated(address start,uint256 pageSize) view returns (address[],address)',
])
const SENTINEL = toHex(1n, { size: 20 })
const GUARD_SLOT = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8'
const FALLBACK_SLOT = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5'

function launchPlan(overrides: Partial<LaunchPlan> = {}): LaunchPlan {
  return {
    multisigs: [SAFE],
    accounting: { tokens: ['eth'], custom: null },
    issuanceBase: null,
    flavor: 'project',
    projectName: 'Safe-owned project',
    operator: null,
    ticker: 'SAFE',
    stages: [createSimpleProjectStage()],
    afterMode: 'cycle',
    approvalDeadline: 'none',
    approvalCustomAddress: null,
    allowAnyToken: false,
    owner: SAFE.address,
    chains: [1, 10],
    linkChains: false,
    bridge: 'ccip',
    store: { name: 'Store', symbol: 'SAFE', currency: 'eth', ...DEFAULT_STORE_FLAGS, items: [] },
    ...overrides,
  }
}

/** Model the official deployed Safe artifacts at the RPC boundary, without mocking the SDK. */
function rpc(deployed = false) {
  const codes = new Map<string, Hex | undefined>([
    [MULTICALL3, '0x6000'],
    [SAFE_FACTORY, fixture.contracts.factory.runtime as Hex],
    [SAFE_SINGLETON, fixture.contracts.singleton.runtime as Hex],
    [SAFE_FALLBACK, fixture.contracts.fallback.runtime as Hex],
    [SAFE.address, deployed ? fixture.contracts.proxy.runtime as Hex : undefined],
  ])
  const storage = new Map<string, Hex | undefined>([
    [toHex(0n, { size: 32 }), toHex(BigInt(SAFE_SINGLETON), { size: 32 })],
    [GUARD_SLOT, toHex(0n, { size: 32 })],
    [FALLBACK_SLOT, toHex(BigInt(SAFE_FALLBACK), { size: 32 })],
  ])
  const responses: Record<string, Hex> = {
    masterCopy: encodeFunctionResult({ abi: READ_ABI, functionName: 'masterCopy', result: SAFE_SINGLETON }),
    VERSION: encodeFunctionResult({ abi: READ_ABI, functionName: 'VERSION', result: '1.4.1' }),
    getThreshold: encodeFunctionResult({ abi: READ_ABI, functionName: 'getThreshold', result: 2n }),
    getOwners: encodeFunctionResult({ abi: READ_ABI, functionName: 'getOwners', result: OWNERS }),
    getModulesPaginated: encodeFunctionResult({ abi: READ_ABI, functionName: 'getModulesPaginated', result: [[], SENTINEL] }),
  }
  const getCode = vi.fn(async ({ address }: { address: Address; blockNumber?: bigint }) => codes.get(address))
  const getStorageAt = vi.fn(async ({ slot }: { address: Address; slot: Hex; blockNumber?: bigint }) => storage.get(slot))
  const readContract = vi.fn(async () => POLICY.proxyCreationCode)
  const request = vi.fn(async ({ params }: { method: string; params: readonly [{ to: Address; data: Hex; gas: Hex }, string] }) => {
    const { functionName } = decodeFunctionData({ abi: READ_ABI, data: params[0].data })
    return responses[functionName]
  })
  return {
    codes, storage, responses, getCode, getStorageAt, readContract, request,
    client: { getCode, getStorageAt, readContract, request } as unknown as PublicClient,
  }
}

function resolve(clients: PublicClient[], overrides: Partial<Parameters<typeof resolveLaunchMultisig>[0]> = {}) {
  return resolveLaunchMultisig({ owners: OWNERS, threshold: 2, role: 'owner', salt: SALT, clients, ...overrides })
}

function simulation(success: boolean, returnData: Hex = toHex(BigInt(SAFE.address), { size: 32 }), launchSuccess = true) {
  return encodeFunctionResult({
    abi: CREATE_BATCH_ABI,
    functionName: 'aggregate3Value',
    result: [{ success, returnData }, { success: launchSuccess, returnData: '0x' }],
  })
}

describe('inline Safe launch account transport', () => {
  it('allows Relayr only after checking the account is an ordinary EOA on every selected chain', async () => {
    const chains = [rpc(), rpc()]
    chains[0].codes.set(OWNERS[0], '0x')
    await expect(canRelayrCreateFromAccount(OWNERS[0], chains.map(chain => chain.client))).resolves.toBe(true)
    for (const chain of chains) {
      expect(chain.getCode).toHaveBeenCalledExactlyOnceWith({ address: OWNERS[0] })
      expect(chain.readContract).not.toHaveBeenCalled()
    }
  })

  it.each([
    { kind: 'contract wallet', index: 0, code: fixture.contracts.proxy.runtime as Hex },
    { kind: 'contract wallet', index: 1, code: fixture.contracts.proxy.runtime as Hex },
    { kind: 'EIP-7702 delegated EOA', index: 0, code: concatHex(['0xef0100', FORWARDED_LAUNCH.target]) },
    { kind: 'EIP-7702 delegated EOA', index: 1, code: concatHex(['0xef0100', FORWARDED_LAUNCH.target]) },
  ])('uses direct setup for a $kind on selected chain $index', async ({ index, code }) => {
    const chains = [rpc(), rpc()]
    chains[index].codes.set(OWNERS[0], code)
    await expect(canRelayrCreateFromAccount(OWNERS[0], chains.map(chain => chain.client))).resolves.toBe(false)
    for (const chain of chains) expect(chain.getCode).toHaveBeenCalledExactlyOnceWith({ address: OWNERS[0] })
  })

  it('does not authorize Relayr without a selected network', async () => {
    await expect(canRelayrCreateFromAccount(OWNERS[0], [])).resolves.toBe(false)
  })

  it('propagates a partial-chain RPC failure instead of assuming the account has no code', async () => {
    const offline = rpc()
    offline.getCode.mockRejectedValue(new Error('Account code unavailable'))
    await expect(canRelayrCreateFromAccount(OWNERS[0], [rpc().client, offline.client])).rejects.toThrow('Account code unavailable')
  })
})

describe('inline launch authority policy', () => {
  it.each([2, 20])('accepts the UI boundary of %i unique signers', count => {
    const owners = Array.from({ length: count }, (_, i) => toHex(i + 2, { size: 20 }))
    expect(validateAuthorityPolicy(owners, count)).toBe(true)
  })

  it.each([
    null,
    [],
    [OWNERS[0]],
    Array.from({ length: 21 }, (_, i) => toHex(i + 2, { size: 20 })),
    ['not an address', OWNERS[0]],
    [zeroAddress, OWNERS[0]],
    [SENTINEL, OWNERS[0]],
    [OWNERS[0], OWNERS[0]],
    ['0x000000000000000000000000000000000000dEaD', '0x000000000000000000000000000000000000dead'],
  ].map(owners => ({ owners })))('rejects malformed, forbidden, duplicate or oversized signer sets: %j', ({ owners }) => {
    expect(validateAuthorityPolicy(owners as string[], 1)).toBe(false)
  })

  it.each([0, -1, 4, 1.5, NaN, Infinity])('rejects an invalid threshold %s', threshold => {
    expect(validateAuthorityPolicy(OWNERS, threshold)).toBe(false)
  })

  it('normalizes the form’s whitespace and mixed-case input while preserving signer order', async () => {
    const input = [' 0xaAaaaaaaAAAaaAaaAAaAaAAAaaaAaAaAAAAaaaAa ', OWNERS[1], OWNERS[0]]
    expect(validateAuthorityPolicy(input, 2)).toBe(true)
    const plan = await resolve([rpc().client], { owners: input })
    expect(plan.owners).toEqual([getAddress(input[0].trim()), OWNERS[1], OWNERS[0]])
    expect(input[0]).toMatch(/^ /)
    expect(plan.address).not.toBe((await resolve([rpc().client], { owners: [...input].reverse() })).address)
  })

  it('uses a role-specific salt and one identical policy across every selected chain', async () => {
    const first = rpc()
    const second = rpc()
    const owner = await resolve([first.client, second.client])
    const operator = await resolve([rpc().client], { role: 'operator' })
    expect(owner).toEqual(SAFE)
    expect(operator.saltNonce).toBe(keccak256(concatHex([SALT, stringToHex('operator')])))
    expect(operator.address).not.toBe(owner.address)
    for (const chain of [first, second]) {
      expect(chain.getCode).toHaveBeenCalledWith({ address: MULTICALL3 })
      expect(chain.readContract).toHaveBeenCalledWith({ address: SAFE_FACTORY, abi: SAFE_CREATE_ABI, functionName: 'proxyCreationCode' })
    }
  })

  it.each([undefined, '0x' as Hex])('requires creation batch support on every selected network: %s', async code => {
    const unsupported = rpc()
    unsupported.codes.set(MULTICALL3, code)
    await expect(resolve([rpc().client, unsupported.client])).rejects.toThrow('Safe creation is unavailable')
    expect(unsupported.readContract).not.toHaveBeenCalled()
  })

  it.each([SAFE_FACTORY, SAFE_SINGLETON, SAFE_FALLBACK])('rejects changed canonical bytecode at %s', async address => {
    const chain = rpc()
    chain.codes.set(address, '0x6000')
    await expect(resolve([rpc().client, chain.client])).rejects.toThrow('canonical Safe 1.4.1')
    expect(chain.readContract).not.toHaveBeenCalled()
  })

  it('rejects inconsistent chain creation code, no chains, and an unavailable RPC', async () => {
    const other = rpc()
    other.readContract.mockResolvedValue('0x6001')
    await expect(resolve([rpc().client, other.client])).rejects.toThrow()
    await expect(resolve([])).rejects.toThrow()
    const offline = rpc()
    offline.getCode.mockRejectedValue(new Error('RPC offline'))
    await expect(resolve([offline.client])).rejects.toThrow('RPC offline')
  })
})

describe('saved launch authority binding', () => {
  it('requires the Safe to own a project or operate a revnet, independently of the other role', () => {
    expect(() => validateLaunchMultisigs(launchPlan({ operator: OWNERS[0] }))).not.toThrow()
    expect(() => validateLaunchMultisigs(launchPlan({ flavor: 'revnet', operator: SAFE.address, owner: OWNERS[0] }))).not.toThrow()
    expect(() => validateLaunchMultisigs(launchPlan({ owner: OWNERS[0], operator: SAFE.address }))).toThrow('does not match the launch authority')
    expect(() => validateLaunchMultisigs(launchPlan({ flavor: 'revnet', operator: OWNERS[0] }))).toThrow('does not match the launch authority')
    expect(() => validateLaunchMultisigs(launchPlan({ owner: null }))).toThrow('does not match the launch authority')
  })

  it.each([
    { address: OWNERS[0] },
    { threshold: 1 },
    { owners: [...OWNERS].reverse() },
    { saltNonce: toHex(43n, { size: 32 }) },
    { proxyCreationCode: '0x6000' as Hex },
  ])('rejects a saved policy whose deterministic address no longer matches: %j', changes => {
    expect(() => validateLaunchMultisigs(launchPlan({ multisigs: [{ ...SAFE, ...changes }] }))).toThrow()
  })

  it('caps the launch at one Safe and keeps legacy launches valid', () => {
    expect(() => validateLaunchMultisigs(launchPlan({ multisigs: [SAFE, SAFE] }))).toThrow('invalid Safe deployment plan')
    expect(() => validateLaunchMultisigs(launchPlan({ multisigs: null as unknown as SafeDeploymentPlan[] }))).toThrow('invalid Safe deployment plan')
    expect(() => validateLaunchMultisigs(launchPlan({ multisigs: undefined }))).not.toThrow()
    expect(() => validateLaunchMultisigs(launchPlan({ multisigs: [] }))).not.toThrow()
  })

  it('reviews the role, address, complete signer set, and approval policy', () => {
    expect(launchMultisigReview(launchPlan())).toBe(`Create Owner Safe ${SAFE.address} with 2 of 3 approvals. Signers: ${OWNERS.join(', ')}.`)
    expect(launchMultisigReview(launchPlan({ flavor: 'revnet', operator: SAFE.address }))).toContain('Create Operator Safe')
    expect(launchMultisigReview(launchPlan({ multisigs: undefined }))).toBe('')
  })
})

describe('Safe deployment preflight and receipt verification', () => {
  it('allows absent Safes before submission but requires deployment after inclusion', async () => {
    const chain = rpc()
    await expect(checkLaunchMultisigs(chain.client, launchPlan())).resolves.toBeUndefined()
    await expect(verifyCreatedLaunchMultisigs(chain.client, launchPlan(), 99n)).rejects.toThrow('does not match its reviewed owners and policy')
  })

  it('rejects a changed factory creation code, a missing batch contract, and existing authority drift', async () => {
    const changed = rpc()
    changed.readContract.mockResolvedValue('0x6000')
    await expect(checkLaunchMultisigs(changed.client, launchPlan())).rejects.toThrow('saved Safe creation code changed')
    const noBatch = rpc()
    noBatch.codes.delete(MULTICALL3)
    await expect(checkLaunchMultisigs(noBatch.client, launchPlan())).rejects.toThrow('unavailable')
    const drift = rpc(true)
    drift.responses.getThreshold = toHex(1n, { size: 32 })
    await expect(checkLaunchMultisigs(drift.client, launchPlan())).rejects.toThrow('does not match its reviewed owners and policy')
  })

  it('pins every code, storage, and bounded raw Safe read to the receipt block', async () => {
    const chain = rpc(true)
    await expect(verifyCreatedLaunchMultisigs(chain.client, launchPlan(), 99n)).resolves.toBeUndefined()
    expect(chain.getCode.mock.calls).toHaveLength(3)
    expect(chain.getStorageAt.mock.calls).toHaveLength(3)
    expect(chain.request.mock.calls).toHaveLength(5)
    for (const [args] of chain.getCode.mock.calls) expect(args.blockNumber).toBe(99n)
    for (const [args] of chain.getStorageAt.mock.calls) {
      expect(args.address).toBe(SAFE.address)
      expect(args.blockNumber).toBe(99n)
    }
    for (const [args] of chain.request.mock.calls) {
      expect(args.method).toBe('eth_call')
      expect(args.params[0].to).toBe(SAFE.address)
      expect(BigInt(args.params[0].gas)).toBeGreaterThan(0n)
      expect(args.params[1]).toBe('0x63')
    }
  })

  it.each(['owners', 'guard', 'modules', 'singleton', 'proxy'])('rejects a deployed Safe with changed %s', async change => {
    const chain = rpc(true)
    if (change === 'owners') chain.responses.getOwners = encodeFunctionResult({ abi: READ_ABI, functionName: 'getOwners', result: [OWNERS[0], OWNERS[1], FORWARDED_LAUNCH.target] })
    if (change === 'guard') chain.storage.set(GUARD_SLOT, toHex(BigInt(OWNERS[0]), { size: 32 }))
    if (change === 'modules') chain.responses.getModulesPaginated = encodeFunctionResult({ abi: READ_ABI, functionName: 'getModulesPaginated', result: [[OWNERS[0]], SENTINEL] })
    if (change === 'singleton') chain.storage.set(toHex(0n, { size: 32 }), toHex(BigInt(OWNERS[0]), { size: 32 }))
    if (change === 'proxy') chain.codes.set(SAFE.address, '0x6000')
    await expect(verifyCreatedLaunchMultisigs(chain.client, launchPlan(), 99n)).rejects.toThrow('does not match its reviewed owners and policy')
  })

  it('performs no Safe RPC calls for legacy launches', async () => {
    const chain = rpc()
    const legacy = launchPlan({ multisigs: undefined })
    await checkLaunchMultisigs(chain.client, legacy)
    await verifyCreatedLaunchMultisigs(chain.client, legacy)
    await verifyLaunchMultisigSimulation(chain.client, legacy)
    expect(chain.getCode).not.toHaveBeenCalled()
    expect(chain.request).not.toHaveBeenCalled()
    expect(chain.readContract).not.toHaveBeenCalled()
  })
})

describe('authenticated Relayr launch batching', () => {
  it('places an idempotent, zero-value factory call before the exact mandatory forwarded launch', () => {
    const bundled = bundleLaunchMultisigs(FORWARDED_LAUNCH, launchPlan())
    expect(bundled).toMatchObject({ chain: 1, target: MULTICALL3, value: '123456789', virtual_nonce: 7 })
    expect(bundled.data.slice(0, 10)).toBe('0x174dea71')
    const { args: [calls] } = decodeFunctionData({ abi: CREATE_BATCH_ABI, data: bundled.data })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ target: SAFE_FACTORY, allowFailure: true, value: 0n })
    expect(calls[0].callData.slice(0, 10)).toBe('0x1688f0b9')
    const factory = decodeFunctionData({ abi: SAFE_CREATE_ABI, data: calls[0].callData })
    expect(factory.functionName).toBe('createProxyWithNonce')
    if (factory.functionName !== 'createProxyWithNonce') throw new Error('Unexpected factory call')
    expect(factory.args[0]).toBe(SAFE_SINGLETON)
    expect(factory.args[2]).toBe(BigInt(SAFE.saltNonce))
    const initializer = decodeFunctionData({ abi: SAFE_CREATE_ABI, data: factory.args[1] })
    expect(initializer.functionName).toBe('setup')
    expect(initializer.args).toEqual([OWNERS, 2n, zeroAddress, '0x', SAFE_FALLBACK, zeroAddress, 0n, zeroAddress])
    expect(calls[1]).toEqual({ target: FORWARDED_LAUNCH.target, allowFailure: false, value: 123456789n, callData: FORWARDED_LAUNCH.data })
    const create2Salt = keccak256(concatHex([keccak256(factory.args[1]), SAFE.saltNonce]))
    const initCodeHash = keccak256(concatHex([fixture.contracts.proxy.creationCode as Hex, toHex(BigInt(SAFE_SINGLETON), { size: 32 })]))
    const create2Hash = keccak256(concatHex(['0xff', SAFE_FACTORY, create2Salt, initCodeHash]))
    expect(SAFE.address).toBe(getAddress(`0x${create2Hash.slice(-40)}`))
    expect(unbundleLaunchMultisigs(bundled, launchPlan())).toEqual(FORWARDED_LAUNCH)
  })

  it.each(['target', 'value', 'factory', 'initializer', 'order', 'optional launch', 'extra call'])('rejects tampering with the batch %s', change => {
    const bundled = bundleLaunchMultisigs(FORWARDED_LAUNCH, launchPlan())
    if (change === 'target') bundled.target = OWNERS[0]
    else if (change === 'value') bundled.value = '123456790'
    else {
      const { args: [decoded] } = decodeFunctionData({ abi: CREATE_BATCH_ABI, data: bundled.data })
      const calls = decoded.map(call => ({ ...call }))
      if (change === 'factory') calls[0].target = OWNERS[0]
      if (change === 'initializer') calls[0].callData = '0x12345678'
      if (change === 'order') calls.reverse()
      if (change === 'optional launch') calls[1].allowFailure = true
      if (change === 'extra call') calls.push({ ...calls[1] })
      bundled.data = encodeFunctionData({ abi: CREATE_BATCH_ABI, functionName: 'aggregate3Value', args: [calls] })
    }
    expect(() => unbundleLaunchMultisigs(bundled, launchPlan())).toThrow()
  })

  it('preserves unbatched legacy entries exactly', () => {
    const legacy = launchPlan({ multisigs: undefined })
    expect(bundleLaunchMultisigs(FORWARDED_LAUNCH, legacy)).toEqual(FORWARDED_LAUNCH)
    expect(unbundleLaunchMultisigs(FORWARDED_LAUNCH, legacy)).toEqual(FORWARDED_LAUNCH)
  })

  it('requires the simulated factory to return the reviewed Safe address', async () => {
    const chain = rpc()
    await expect(verifyLaunchMultisigSimulation(chain.client, launchPlan(), simulation(true))).resolves.toBeUndefined()
    expect(chain.getCode).not.toHaveBeenCalled()
    await expect(verifyLaunchMultisigSimulation(chain.client, launchPlan(), simulation(true, toHex(BigInt(OWNERS[0]), { size: 32 })))).rejects.toThrow('different Safe address')
  })

  it('accepts a failed factory call only after verifying the already deployed Safe policy', async () => {
    const absent = rpc()
    await expect(verifyLaunchMultisigSimulation(absent.client, launchPlan(), simulation(false, '0x'))).rejects.toThrow('does not match its reviewed owners and policy')
    const existing = rpc(true)
    await expect(verifyLaunchMultisigSimulation(existing.client, launchPlan(), simulation(false, '0x'))).resolves.toBeUndefined()
    expect(existing.request).toHaveBeenCalledTimes(5)
    existing.responses.getThreshold = toHex(1n, { size: 32 })
    await expect(verifyLaunchMultisigSimulation(existing.client, launchPlan(), simulation(false, '0x'))).rejects.toThrow('does not match its reviewed owners and policy')
  })

  it('rejects missing or incomplete simulation output and a reverted forwarded launch', async () => {
    const chain = rpc()
    await expect(verifyLaunchMultisigSimulation(chain.client, launchPlan())).rejects.toThrow('no results')
    await expect(verifyLaunchMultisigSimulation(chain.client, launchPlan(), '0x')).rejects.toThrow()
    const incomplete = encodeFunctionResult({ abi: CREATE_BATCH_ABI, functionName: 'aggregate3Value', result: [{ success: true, returnData: toHex(BigInt(SAFE.address), { size: 32 }) }] })
    await expect(verifyLaunchMultisigSimulation(chain.client, launchPlan(), incomplete)).rejects.toThrow('every required call')
    await expect(verifyLaunchMultisigSimulation(chain.client, launchPlan(), simulation(true, toHex(BigInt(SAFE.address), { size: 32 }), false))).rejects.toThrow('every required call')
  })
})
