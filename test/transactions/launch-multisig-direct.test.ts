import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, encodeFunctionResult, type Address, type Hex } from 'viem'
import { CREATE_BATCH_ABI, SAFE_CREATE_ABI, SAFE_FACTORY, SAFE_SINGLETON, MULTICALL3, buildSafeInitializer, predictSafeAddress, type SafeDeploymentPlan } from '@bananapus/nana-sdk-core/safe'
import { createSimpleProjectStage, DEFAULT_STORE_FLAGS, type LaunchPlan } from '@/lib/launch'
import { LAUNCH_SESSION_KEY, loadLaunchSession, saveLaunchSession, type LaunchSession } from '@/lib/launch-session'
import { prepareLaunchMultisigs, recoverLaunchMultisigSetup } from '@/lib/launch-multisig-direct'
import safeFixture from '../fixtures/safe-1.4.1.json'

const mocks = vi.hoisted(() => ({
  account: vi.fn(), receipt: vi.fn(), review: vi.fn(), preflight: vi.fn(), verifyCreated: vi.fn(),
  verifySafe: vi.fn(), simulate: vi.fn(), estimateGas: vi.fn(), safe: vi.fn(), safeHash: vi.fn(),
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@wagmi/core', () => ({ getAccount: mocks.account, waitForTransactionReceipt: mocks.receipt }))
vi.mock('@/lib/wallet-core', () => ({ publicClient: () => ({ estimateGas: mocks.estimateGas }) }))
vi.mock('@/lib/transaction-review', () => ({ requireContractTransactionReview: mocks.review }))
vi.mock('@/lib/viewAs', () => ({ assertNoViewAs: vi.fn() }))
vi.mock('@/lib/transaction-simulation', () => ({ simulateStateChangingTransaction: mocks.simulate, TRANSACTION_SIMULATION_GAS: 10_000_000n }))
vi.mock('@/lib/safe-connector', () => ({ isSafeConnection: mocks.safe, waitForSafeExecutionHash: mocks.safeHash }))
vi.mock('@/lib/launch-multisig', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/launch-multisig')>(),
  checkLaunchMultisigs: mocks.preflight,
  verifyCreatedLaunchMultisigs: mocks.verifyCreated,
}))
vi.mock('@bananapus/nana-sdk-core/safe', async importOriginal => ({
  ...await importOriginal<typeof import('@bananapus/nana-sdk-core/safe')>(), verifySafeDeployments: mocks.verifySafe,
}))

const ACCOUNT: Address = '0x1111111111111111111111111111111111111111'
const OTHER: Address = '0x2222222222222222222222222222222222222222'
const SALT = `0x${'ab'.repeat(32)}` as Hex
const HASH = `0x${'12'.repeat(32)}` as Hex
const EXECUTION = `0x${'34'.repeat(32)}` as Hex
const CHAIN = 8453
const policy = { owners: [ACCOUNT, OTHER], threshold: 2, saltNonce: SALT, proxyCreationCode: safeFixture.contracts.proxy.creationCode as Hex }
const safe: SafeDeploymentPlan = { ...policy, address: predictSafeAddress(policy) }
const store: LaunchPlan['store'] = { name: 'Test', symbol: 'TEST', currency: 'eth', ...DEFAULT_STORE_FLAGS, items: [] }
const plan: LaunchPlan = {
  accounting: { tokens: ['eth'], custom: null }, issuanceBase: null, flavor: 'project', projectName: 'Test',
  operator: null, owner: safe.address, ticker: '', stages: [createSimpleProjectStage()], afterMode: 'wait',
  approvalDeadline: 'none', approvalCustomAddress: null, allowAnyToken: true, chains: [CHAIN], linkChains: false,
  bridge: 'ccip', store, multisigs: [safe],
}

let storage: {
  getItem: ReturnType<typeof vi.fn<(key: string) => string | null>>
  setItem: ReturnType<typeof vi.fn<(key: string, value: string) => void>>
  removeItem: ReturnType<typeof vi.fn<(key: string) => void>>
}
function seed(overrides: Partial<LaunchSession> = {}) {
  const value: LaunchSession = {
    transport: 'direct', account: ACCOUNT, salt: SALT, projectUri: 'ipfs://test', store, plans: { [CHAIN]: plan },
    chains: [CHAIN], statuses: { [CHAIN]: { phase: 'pending' } }, createdAt: 1, ...overrides,
  }
  expect(saveLaunchSession(value)).toBe(true)
  return value
}
function setup() { return loadLaunchSession({ strict: true })!.statuses[CHAIN].multisigSetup }
function options() {
  return {
    chainId: CHAIN, salt: SALT, plan, account: ACCOUNT, switchChain: vi.fn().mockResolvedValue(undefined),
    writeContract: vi.fn().mockResolvedValue(HASH), onProgress: vi.fn(), onSetup: vi.fn(),
  }
}
function simulation(success = true, address = safe.address) {
  return encodeFunctionResult({ abi: CREATE_BATCH_ABI, functionName: 'aggregate3Value', result: [{
    success, returnData: success ? encodeFunctionResult({ abi: SAFE_CREATE_ABI, functionName: 'createProxyWithNonce', result: address }) : '0x',
  }] })
}

beforeEach(() => {
  vi.resetAllMocks()
  const data = new Map<string, string>()
  storage = {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { data.set(key, value) }),
    removeItem: vi.fn((key: string) => { data.delete(key) }),
  }
  vi.stubGlobal('window', { localStorage: storage })
  vi.stubGlobal('navigator', {})
  mocks.account.mockReturnValue({ address: ACCOUNT })
  mocks.verifySafe.mockResolvedValue(false)
  mocks.simulate.mockResolvedValue(simulation())
  mocks.estimateGas.mockResolvedValue(500_000n)
  mocks.safe.mockReturnValue(false)
  mocks.receipt.mockResolvedValue({ status: 'success', blockNumber: 123n })
  mocks.safeHash.mockResolvedValue(EXECUTION)
  seed()
})

describe('direct launch Safe setup', () => {
  it('reviews, simulates and writes the exact SDK factory batch, then verifies the receipt block independently of project launch', async () => {
    const args = options()
    args.writeContract.mockImplementation(async () => {
      expect(setup()).toEqual({ phase: 'signing' })
      return HASH
    })
    await prepareLaunchMultisigs(args)
    const callData = encodeFunctionData({ abi: SAFE_CREATE_ABI, functionName: 'createProxyWithNonce', args: [SAFE_SINGLETON, buildSafeInitializer(policy), BigInt(SALT)] })
    const expected = { chainId: CHAIN, address: MULTICALL3, abi: CREATE_BATCH_ABI, functionName: 'aggregate3Value', args: [[{ target: SAFE_FACTORY, allowFailure: true, value: 0n, callData }]], value: 0n } as const
    expect(mocks.review).toHaveBeenCalledWith({ ...expected, account: ACCOUNT }, expect.objectContaining({ title: 'Review Safe creation', description: expect.stringContaining('2 of 2 approvals') }))
    expect(mocks.simulate).toHaveBeenCalledWith(expect.anything(), { from: ACCOUNT, to: MULTICALL3, data: encodeFunctionData(expected), value: 0n })
    expect(args.writeContract).toHaveBeenCalledWith({ ...expected, account: ACCOUNT, gas: 1_000_000n })
    expect(args.switchChain).toHaveBeenCalledWith(CHAIN)
    expect(mocks.receipt).toHaveBeenCalledWith({}, { chainId: CHAIN, hash: HASH })
    expect(mocks.verifyCreated).toHaveBeenCalledWith(expect.anything(), plan, 123n)
    expect(loadLaunchSession()!.statuses[CHAIN]).toEqual({ phase: 'pending', multisigSetup: { phase: 'done', txHash: HASH } })
  })

  it('skips already deployed and fully verified Safes without asking the wallet', async () => {
    mocks.verifySafe.mockResolvedValue(true)
    const args = options()
    await prepareLaunchMultisigs(args)
    expect(setup()).toEqual({ phase: 'done' })
    expect(mocks.verifySafe).toHaveBeenCalledWith(expect.anything(), [safe], { allowMissing: true })
    expect(args.writeContract).not.toHaveBeenCalled()
    expect(mocks.review).not.toHaveBeenCalled()
  })

  it('does nothing for legacy plans with no Safe setup', async () => {
    const args = { ...options(), plan: { ...plan, multisigs: undefined } }
    storage.getItem.mockImplementation(() => { throw new Error('unavailable') })
    await prepareLaunchMultisigs(args)
    expect(args.writeContract).not.toHaveBeenCalled()
  })

  it.each(['absent', 'salt', 'account', 'plan', 'relayr', 'launched', 'uncertain'] as const)('blocks a %s saved session before wallet interaction', async kind => {
    const session = loadLaunchSession()!
    if (kind === 'absent') storage.removeItem(LAUNCH_SESSION_KEY)
    if (kind === 'salt') { storage.removeItem(LAUNCH_SESSION_KEY); seed({ salt: HASH }) }
    if (kind === 'account') seed({ account: OTHER })
    if (kind === 'plan') seed({ plans: { [CHAIN]: { ...plan, ticker: 'CHANGED' } } })
    if (kind === 'relayr') seed({ transport: 'relayr' })
    if (kind === 'launched') seed({ statuses: { [CHAIN]: { phase: 'done', projectId: 10 } } })
    if (kind === 'uncertain') seed({ statuses: { [CHAIN]: { ...session.statuses[CHAIN], phase: 'signing' } } })
    const args = options()
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow()
    expect(args.writeContract).not.toHaveBeenCalled()
    expect(mocks.review).not.toHaveBeenCalled()
  })

  it('does not retry an ambiguous wallet submission until its hash is recovered', async () => {
    const args = options()
    args.writeContract.mockRejectedValue(new Error('Connection lost'))
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow('Connection lost')
    expect(setup()).toEqual({ phase: 'signing' })
    await expect(prepareLaunchMultisigs(options())).rejects.toThrow('may already have been submitted')
  })

  it('requires recovery when a wallet returns a malformed hash after submission', async () => {
    const args = options()
    args.writeContract.mockResolvedValue('0x1234')
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow('no valid Safe setup hash')
    expect(setup()).toEqual({ phase: 'signing' })
    expect(mocks.receipt).not.toHaveBeenCalled()
  })

  it('does not recreate a previously completed Safe that can no longer be verified', async () => {
    seed({ statuses: { [CHAIN]: { phase: 'failed', multisigSetup: { phase: 'done', txHash: HASH } } } })
    const args = options()
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow('previously created Safe could not be verified')
    expect(args.writeContract).not.toHaveBeenCalled()
  })

  it('does not mark review cancellation as an ambiguous signature', async () => {
    mocks.review.mockRejectedValue(new Error('Review closed'))
    const args = options()
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow('Review closed')
    expect(setup()).toEqual({ phase: 'failed' })
    expect(args.writeContract).not.toHaveBeenCalled()
  })

  it('allows a retry after an explicit nested wallet rejection', async () => {
    const args = options()
    args.writeContract.mockRejectedValueOnce({ cause: { code: 4001 } })
    await expect(prepareLaunchMultisigs(args)).rejects.toBeDefined()
    expect(setup()).toEqual({ phase: 'failed' })
    await prepareLaunchMultisigs(args)
    expect(args.writeContract).toHaveBeenCalledTimes(2)
  })

  it('fails closed before submitting if the signing journal cannot be stored', async () => {
    const args = options()
    mocks.estimateGas.mockImplementation(async () => {
      storage.setItem.mockImplementation(() => { throw new Error('quota') })
      return 1n
    })
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow('could not be saved')
    expect(args.writeContract).not.toHaveBeenCalled()
  })

  it('retains an ambiguous signing marker when persisting the returned hash fails', async () => {
    const args = options()
    args.writeContract.mockImplementation(async () => {
      storage.setItem.mockImplementation(() => { throw new Error('quota') })
      return HASH
    })
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow('could not be saved')
    expect(setup()).toEqual({ phase: 'signing' })
    expect(mocks.receipt).not.toHaveBeenCalled()
  })

  it.each(['switch', 'simulate'] as const)('blocks account drift during %s before signing', async where => {
    const args = options()
    const drift = async () => { mocks.account.mockReturnValue({ address: OTHER }); return 1n }
    if (where === 'switch') args.switchChain.mockImplementation(drift)
    else mocks.estimateGas.mockImplementation(drift)
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow('Connected account changed')
    expect(args.writeContract).not.toHaveBeenCalled()
    expect(setup()?.phase).toBe('failed')
  })

  it('blocks a wallet connector change before crossing the signing boundary', async () => {
    const args = options()
    mocks.estimateGas.mockImplementation(async () => { mocks.safe.mockReturnValue(true); return 1n })
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow('Connected wallet changed')
    expect(args.writeContract).not.toHaveBeenCalled()
  })

  it('rechecks the account after persisting the signing marker', async () => {
    const args = options()
    args.onSetup.mockImplementation(value => {
      if (value.phase === 'signing') mocks.account.mockReturnValue({ address: OTHER })
    })
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow('Connected account changed')
    expect(args.writeContract).not.toHaveBeenCalled()
    expect(setup()).toEqual({ phase: 'failed' })
  })

  it('rechecks the exact pinned plan after review', async () => {
    const args = options()
    mocks.review.mockImplementation(async () => { seed({ plans: { [CHAIN]: { ...plan, ticker: 'EDITED' } } }) })
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow('saved Safe or launch account changed')
    expect(args.writeContract).not.toHaveBeenCalled()
  })

  it.each(['different address', 'missing result', 'malformed address', 'failed factory'] as const)('rejects simulation with %s', async kind => {
    if (kind === 'different address') mocks.simulate.mockResolvedValue(simulation(true, OTHER))
    if (kind === 'missing result') mocks.simulate.mockResolvedValue(encodeFunctionResult({ abi: CREATE_BATCH_ABI, functionName: 'aggregate3Value', result: [] }))
    if (kind === 'malformed address') mocks.simulate.mockResolvedValue(encodeFunctionResult({ abi: CREATE_BATCH_ABI, functionName: 'aggregate3Value', result: [{ success: true, returnData: '0x' }] }))
    if (kind === 'failed factory') { mocks.simulate.mockResolvedValue(simulation(false)); mocks.verifySafe.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('Safe missing')) }
    const args = options()
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow()
    expect(args.writeContract).not.toHaveBeenCalled()
  })

  it('accepts a failed optional factory call only after verifying the exact existing Safe', async () => {
    mocks.simulate.mockResolvedValue(simulation(false))
    mocks.verifySafe.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await prepareLaunchMultisigs(options())
    expect(mocks.verifySafe).toHaveBeenLastCalledWith(expect.anything(), [safe])
  })

  it('bounds gas headroom by the simulation ceiling', async () => {
    mocks.estimateGas.mockResolvedValue(6_000_000n)
    const args = options()
    await prepareLaunchMultisigs(args)
    expect(args.writeContract).toHaveBeenCalledWith(expect.objectContaining({ gas: 10_000_000n }))
  })

  it('resumes an existing setup transaction without submitting another', async () => {
    seed({ statuses: { [CHAIN]: { phase: 'failed', multisigSetup: { phase: 'confirming', txHash: HASH } } } })
    const args = options()
    await prepareLaunchMultisigs(args)
    expect(args.writeContract).not.toHaveBeenCalled()
    expect(mocks.receipt).toHaveBeenCalledWith({}, { chainId: CHAIN, hash: HASH })
    expect(setup()).toEqual({ phase: 'done', txHash: HASH })
  })

  it('permits retry after proving the earlier project launch reverted and verifying its existing Safe', async () => {
    seed({ statuses: { [CHAIN]: { phase: 'failed', txHash: EXECUTION, multisigSetup: { phase: 'done', txHash: HASH } } } })
    mocks.receipt.mockResolvedValueOnce({ status: 'reverted', blockNumber: 124n })
    mocks.verifySafe.mockResolvedValue(true)
    const args = options()
    await prepareLaunchMultisigs(args)
    expect(mocks.receipt).toHaveBeenCalledWith({}, { chainId: CHAIN, hash: EXECUTION })
    expect(args.writeContract).not.toHaveBeenCalled()
    expect(loadLaunchSession()!.statuses[CHAIN]).toEqual({ phase: 'failed', txHash: EXECUTION, multisigSetup: { phase: 'done' } })
  })

  it('does not trust a failed label when the earlier project launch actually succeeded', async () => {
    seed({ statuses: { [CHAIN]: { phase: 'failed', txHash: EXECUTION, multisigSetup: { phase: 'done', txHash: HASH } } } })
    const args = options()
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow('did not revert')
    expect(args.writeContract).not.toHaveBeenCalled()
    expect(mocks.verifySafe).not.toHaveBeenCalled()
  })

  it('keeps the submitted hash when receipt tracking is temporarily unavailable', async () => {
    mocks.receipt.mockRejectedValue(new Error('RPC unavailable'))
    await expect(prepareLaunchMultisigs(options())).rejects.toThrow('RPC unavailable')
    expect(setup()).toEqual({ phase: 'confirming', txHash: HASH })
    expect(mocks.verifyCreated).not.toHaveBeenCalled()
  })

  it('records a reverted setup separately and permits a new setup attempt', async () => {
    mocks.receipt.mockResolvedValueOnce({ status: 'reverted', blockNumber: 123n })
    const args = options()
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow('reverted')
    expect(loadLaunchSession()!.statuses[CHAIN]).toEqual({ phase: 'pending', multisigSetup: { phase: 'failed', txHash: HASH } })
    await prepareLaunchMultisigs(args)
    expect(args.writeContract).toHaveBeenCalledTimes(2)
  })

  it('does not mark setup complete when receipt-block Safe verification fails', async () => {
    mocks.verifyCreated.mockRejectedValue(new Error('Wrong Safe policy'))
    await expect(prepareLaunchMultisigs(options())).rejects.toThrow('Wrong Safe policy')
    expect(setup()).toEqual({ phase: 'confirming', txHash: HASH })
  })

  it('tracks a Safe proposal separately and receipt-polls only the execution hash', async () => {
    mocks.safe.mockReturnValue(true)
    const args = options()
    args.writeContract.mockImplementation(async () => { expect(setup()).toEqual({ phase: 'signing', safe: true }); return HASH })
    mocks.safeHash.mockImplementation(async () => { expect(setup()).toEqual({ phase: 'confirming', safe: true, txHash: HASH, safeProposalHash: HASH }); return EXECUTION })
    await prepareLaunchMultisigs(args)
    expect(mocks.safeHash).toHaveBeenCalledWith(CHAIN, HASH)
    expect(mocks.receipt).toHaveBeenCalledWith({}, { chainId: CHAIN, hash: EXECUTION })
    expect(setup()).toEqual({ phase: 'done', txHash: EXECUTION })
  })

  it('resumes a saved Safe proposal even when the current wallet is no longer Safe', async () => {
    seed({ statuses: { [CHAIN]: { phase: 'pending', multisigSetup: { phase: 'confirming', safe: true, txHash: HASH, safeProposalHash: HASH } } } })
    const args = options()
    await prepareLaunchMultisigs(args)
    expect(mocks.safeHash).toHaveBeenCalledWith(CHAIN, HASH)
    expect(mocks.receipt).toHaveBeenCalledWith({}, { chainId: CHAIN, hash: EXECUTION })
    expect(args.writeContract).not.toHaveBeenCalled()
  })

  it('keeps Safe proposal recovery data when execution tracking fails', async () => {
    mocks.safe.mockReturnValue(true)
    mocks.safeHash.mockRejectedValue(new Error('Service unavailable'))
    await expect(prepareLaunchMultisigs(options())).rejects.toThrow('Service unavailable')
    expect(setup()).toEqual({ phase: 'confirming', safe: true, txHash: HASH, safeProposalHash: HASH })
    expect(mocks.receipt).not.toHaveBeenCalled()
  })

  it('blocks concurrent setup in another tab', async () => {
    const request = vi.fn(async (_name, _options, action) => action(null))
    vi.stubGlobal('navigator', { locks: { request } })
    const args = options()
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow('Another tab')
    expect(request).toHaveBeenCalledWith('jbm-launch', { ifAvailable: true }, expect.any(Function))
    expect(args.writeContract).not.toHaveBeenCalled()
  })

  it('completes setup while holding the acquired launch lock', async () => {
    let held = false
    const request = vi.fn(async (_name, _options, action) => {
      held = true
      try { return await action({ name: 'jbm-launch' }) } finally { held = false }
    })
    vi.stubGlobal('navigator', { locks: { request } })
    const args = options()
    args.writeContract.mockImplementation(async () => { expect(held).toBe(true); return HASH })
    await prepareLaunchMultisigs(args)
    expect(held).toBe(false)
    expect(setup()?.phase).toBe('done')
  })
})

describe('interrupted setup recovery', () => {
  it.each([false, true])('restores the original hash with Safe proposal marker %s', async isSafe => {
    seed({ statuses: { [CHAIN]: { phase: 'failed', multisigSetup: { phase: 'signing', ...(isSafe ? { safe: true as const } : {}) } } } })
    await recoverLaunchMultisigSetup(CHAIN, SALT, HASH)
    expect(setup()).toEqual({ phase: 'confirming', txHash: HASH, ...(isSafe ? { safe: true, safeProposalHash: HASH } : {}) })
  })

  it('permits retry only after the user explicitly confirms no setup was submitted', async () => {
    seed({ statuses: { [CHAIN]: { phase: 'failed', multisigSetup: { phase: 'signing' } } } })
    await recoverLaunchMultisigSetup(CHAIN, SALT)
    expect(setup()).toEqual({ phase: 'failed' })
    await prepareLaunchMultisigs(options())
    expect(setup()?.phase).toBe('done')
  })

  it('rejects malformed recovery hashes without changing the marker', async () => {
    seed({ statuses: { [CHAIN]: { phase: 'failed', multisigSetup: { phase: 'signing' } } } })
    await expect(recoverLaunchMultisigSetup(CHAIN, SALT, '0x1234')).rejects.toThrow('valid transaction')
    expect(setup()).toEqual({ phase: 'signing' })
  })

  it('cannot overwrite a submitted setup or another saved launch', async () => {
    await expect(recoverLaunchMultisigSetup(CHAIN, HASH, HASH)).rejects.toThrow('saved launch changed')
    seed({ statuses: { [CHAIN]: { phase: 'failed', multisigSetup: { phase: 'confirming', txHash: HASH } } } })
    await expect(recoverLaunchMultisigSetup(CHAIN, SALT, EXECUTION)).rejects.toThrow('no interrupted')
    expect(setup()).toEqual({ phase: 'confirming', txHash: HASH })
  })

  it('fails closed when recovered progress cannot be persisted', async () => {
    seed({ statuses: { [CHAIN]: { phase: 'failed', multisigSetup: { phase: 'signing' } } } })
    storage.setItem.mockImplementation(() => { throw new Error('quota') })
    await expect(recoverLaunchMultisigSetup(CHAIN, SALT, HASH)).rejects.toThrow('could not be saved')
    expect(setup()).toEqual({ phase: 'signing' })
  })
})
