import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, encodeFunctionResult, type Address, type Hex } from 'viem'
import { CREATE_BATCH_ABI, SAFE_CREATE_ABI, SAFE_FACTORY, SAFE_SINGLETON, MULTICALL3, buildSafeInitializer, predictSafeAddress, type SafeDeploymentPlan } from '@bananapus/nana-sdk-core/safe'
import { createSimpleProjectStage, DEFAULT_STORE_FLAGS, type LaunchPlan } from '@/lib/launch'
import { LAUNCH_SESSION_KEY, loadLaunchSession, saveLaunchSession, type LaunchSession } from '@/lib/launch-session'
import { prepareLaunchMultisigs, retireLaunchMultisigSetup, setupAttemptOf } from '@/lib/launch-multisig-direct'
import { savedAttempts } from '@/lib/write-holds'
import safeFixture from '../fixtures/safe-1.4.1.json'
import { registerReviewHandler, type ReviewModel } from '@bananapus/nana-sdk-core/review'

// The app's review, as core asks it: `mocks.review` rejecting is a cancel.
beforeAll(() => {
  registerReviewHandler(async prompt => {
    try {
      await mocks.review(prompt.model)
      return prompt.confirmation
    } catch {
      return null
    }
  })
})
/** The one review core asked for. */
const reviewed = () => mocks.review.mock.calls[0][0] as ReviewModel

const mocks = vi.hoisted(() => ({
  /** The plan's Safes, for the chain mock's setup call. */
  plan: (): SafeDeploymentPlan[] | undefined => undefined,
  account: vi.fn(), receipt: vi.fn(), review: vi.fn(), preflight: vi.fn(), verifyCreated: vi.fn(),
  verifySafe: vi.fn(), simulate: vi.fn(), estimateGas: vi.fn(), safe: vi.fn(), safeHash: vi.fn(), execution: vi.fn(), viewAs: vi.fn(),
  /** What reaches the wallet through core's reviewed send. */
  write: vi.fn(), switchChain: vi.fn(),
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@wagmi/core', async () => {
  const { publicClient } = await import('@/lib/wallet-core')
  return {
    getAccount: mocks.account, waitForTransactionReceipt: mocks.receipt,
    getPublicClient: (_config: unknown, { chainId }: { chainId: number }) => publicClient(chainId as never),
    getWalletClient: async () => (await import('../support/viem-wallet')).viemWallet(tx => mocks.write(tx), () => mocks.account()?.chainId),
    switchChain: (_config: unknown, { chainId }: { chainId: number }) => mocks.switchChain(chainId),
  }
})
vi.mock('@/lib/wallet-core', async () => {
  const { buildSafeDeploymentTx } = await import('@bananapus/nana-sdk-core/safe')
  const { encodeFunctionData, TransactionNotFoundError } = await import('viem')
  const MINED = `0x${'90'.repeat(32)}` as Hex
  /** The chain the SDK's hold reads: every transaction the flow's receipt mock knows is mined at block 90, sent as the setup call. */
  const mined = async (hash: Hex) => {
    // A receipt the flow's mock can't give is a node that can't answer (unknown, never "not found").
    const receipt = await Promise.resolve(mocks.receipt({}, { chainId: 8453, hash })) as { status: string } | undefined
    if (!receipt) throw new TransactionNotFoundError({ hash })
    const call = buildSafeDeploymentTx(8453, mocks.plan()!)
    return { receipt, call: { to: call.address, data: encodeFunctionData(call) } }
  }
  return { publicClient: () => ({
    estimateGas: mocks.estimateGas,
    getChainId: async () => 8453,
    getBlockNumber: async () => 100n,
    getTransactionCount: async () => 4,
    getBlock: async ({ blockNumber }: { blockNumber?: bigint } = {}) => ({ number: blockNumber ?? 100n, hash: blockNumber === 90n ? MINED : `0x${'f1'.repeat(32)}`, timestamp: 1n }),
    getTransaction: async ({ hash }: { hash: Hex }) => {
      const { call } = await mined(hash)
      return { hash, chainId: 8453, from: '0x1111111111111111111111111111111111111111', to: call.to, input: call.data, value: 0n, nonce: 3, blockNumber: 90n, blockHash: MINED, transactionIndex: 0 }
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const { receipt, call } = await mined(hash)
      return { logs: [], ...receipt, transactionHash: hash, from: '0x1111111111111111111111111111111111111111', to: call.to, blockNumber: 90n, blockHash: MINED, transactionIndex: 0 }
    },
    // Core's own receipt wait reads the flow's receipt mock too.
    waitForTransactionReceipt: ({ hash }: { hash: Hex }) => mocks.receipt({}, { chainId: 8453, hash }),
    // Core's simulation passes; a Safe's nonce reads 0.
    request: async ({ method }: { method: string }) => method === 'eth_call' ? `0x${'0'.repeat(64)}` : null,
  }) }
})
vi.mock('@/lib/viewAs', () => ({
  assertNoViewAs: mocks.viewAs,
  // Viewing as another account is what makes `mocks.viewAs` throw.
  getViewAs: () => { try { mocks.viewAs(); return null } catch { return '0x2222222222222222222222222222222222222222' } },
  VIEW_AS_WRITE_BLOCKED: 'View-as is read-only',
}))
vi.mock('@bananapus/nana-sdk-core/review', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core/review')>()),
  simulateStateChangingTransaction: mocks.simulate,
}))
vi.mock('@/lib/safe-connector', () => ({ isSafeConnection: mocks.safe, SAFE_NONCE_GUIDANCE: 'Choose the Safe nonce.', waitForSafeExecutionHash: mocks.safeHash, readSafeAppExecution: mocks.execution, SAFE_PROPOSAL_UNCONFIRMED: 'Safe execution is not confirmed.' }))
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
mocks.plan = () => plan.multisigs

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
    chainId: CHAIN, salt: SALT, plan, account: ACCOUNT, onProgress: vi.fn(), onSetup: vi.fn(),
    signal: new AbortController().signal,
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
  mocks.account.mockReturnValue({ address: ACCOUNT, chainId: CHAIN, connector: { uid: 'wallet-1' } })
  mocks.verifySafe.mockResolvedValue(false)
  mocks.simulate.mockResolvedValue(simulation())
  mocks.estimateGas.mockResolvedValue(500_000n)
  mocks.write.mockResolvedValue(HASH)
  mocks.switchChain.mockResolvedValue(undefined)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ count: 0, next: null, previous: null, results: [] }))))
  mocks.safe.mockReturnValue(false)
  mocks.receipt.mockResolvedValue({ status: 'success', blockNumber: 123n })
  mocks.safeHash.mockResolvedValue(EXECUTION)
  mocks.execution.mockResolvedValue({ status: 'success' })
  seed()
})

describe('direct launch Safe setup', () => {
  it('wallet-action:create-an-owner-or-operator-safe-during-launch reviews, simulates and writes the exact SDK factory batch, then verifies the receipt block independently of project launch', async () => {
    const args = options()
    mocks.write.mockImplementation(async () => {
      expect(setup()).toEqual({ phase: 'signing' })
      return HASH
    })
    await prepareLaunchMultisigs(args)
    const callData = encodeFunctionData({ abi: SAFE_CREATE_ABI, functionName: 'createProxyWithNonce', args: [SAFE_SINGLETON, buildSafeInitializer(policy), BigInt(SALT)] })
    const expected = { chainId: CHAIN, address: MULTICALL3, abi: CREATE_BATCH_ABI, functionName: 'aggregate3Value', args: [[{ target: SAFE_FACTORY, allowFailure: true, value: 0n, callData }]], value: 0n } as const
    const data = encodeFunctionData(expected)
    expect(mocks.review).toHaveBeenCalledOnce()
    expect(reviewed()).toMatchObject({ title: 'Review Safe creation', description: expect.stringContaining('2 of 2 approvals') })
    expect(reviewed().calls).toMatchObject([{ chainId: CHAIN, from: ACCOUNT, to: MULTICALL3, data, value: 0n }])
    expect(mocks.simulate).toHaveBeenCalledWith(expect.anything(), { from: ACCOUNT, to: MULTICALL3, data, value: 0n })
    // The exact reviewed bytes reach the wallet.
    expect(mocks.write).toHaveBeenCalledOnce()
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ to: MULTICALL3, data, value: 0n }))
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
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.review).not.toHaveBeenCalled()
  })

  it('does nothing for legacy plans with no Safe setup', async () => {
    const args = { ...options(), plan: { ...plan, multisigs: undefined } }
    storage.getItem.mockImplementation(() => { throw new Error('unavailable') })
    await prepareLaunchMultisigs(args)
    expect(mocks.write).not.toHaveBeenCalled()
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
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.review).not.toHaveBeenCalled()
  })

  it('holds an ambiguous wallet submission: the next run shows the SDK hold, never a second send', async () => {
    const args = options()
    mocks.write.mockRejectedValue(new Error('Connection lost'))
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow('Connection lost')
    expect(setup()).toEqual({ phase: 'signing' })
    await expect(prepareLaunchMultisigs(args)).rejects.toMatchObject({ name: 'SavedAttemptShownError' })
    expect(mocks.write).toHaveBeenCalledOnce()
  })

  it('holds a wallet reply that is no transaction hash, and reads no receipt for it', async () => {
    const args = options()
    mocks.write.mockResolvedValue('0x1234')
    // Held as sent, unverified: the site's refusal of the reply is its cause.
    const held = await prepareLaunchMultisigs(args).catch((error: Error & { cause?: Error }) => error)
    expect(held).toMatchObject({ name: 'ReviewedReceiptUnverifiedError' })
    expect((held as { cause?: Error }).cause?.message).toMatch(/transaction identity/)
    expect(setup()).toEqual({ phase: 'signing' })
    expect(mocks.receipt).not.toHaveBeenCalled()
    await expect(prepareLaunchMultisigs(args)).rejects.toMatchObject({ name: 'SavedAttemptShownError' })
    expect(mocks.write).toHaveBeenCalledOnce()
  })

  it('does not recreate a previously completed Safe that can no longer be verified', async () => {
    seed({ statuses: { [CHAIN]: { phase: 'failed', multisigSetup: { phase: 'done', txHash: HASH } } } })
    const args = options()
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow('previously created Safe could not be verified')
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('does not mark review cancellation as an ambiguous signature', async () => {
    mocks.review.mockRejectedValue(new Error('Review closed'))
    const args = options()
    await expect(prepareLaunchMultisigs(args)).rejects.toMatchObject({ name: 'TransactionReviewCancelledError' })
    // Nothing reached the wallet boundary, so nothing is journaled as signing.
    expect(setup()?.phase).not.toBe('signing')
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('allows a retry after an explicit nested wallet rejection', async () => {
    const args = options()
    mocks.write.mockRejectedValueOnce({ cause: { code: 4001 } })
    await expect(prepareLaunchMultisigs(args)).rejects.toBeDefined()
    expect(setup()).toEqual({ phase: 'failed' })
    await prepareLaunchMultisigs(args)
    expect(mocks.write).toHaveBeenCalledTimes(2)
  })

  it('fails closed before submitting if the signing journal cannot be stored', async () => {
    const args = options()
    mocks.estimateGas.mockImplementation(async () => {
      storage.setItem.mockImplementation(() => { throw new Error('quota') })
      return 1n
    })
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow('could not be saved')
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('retains an ambiguous signing marker when persisting the returned hash fails', async () => {
    const args = options()
    mocks.write.mockImplementation(async () => {
      storage.setItem.mockImplementation(() => { throw new Error('quota') })
      return HASH
    })
    // The site's failed record never changes what was sent: the SDK settles it, and the
    // flow stops at its own next record, the setup still marked signing for recovery.
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow('could not be saved')
    expect(setup()).toEqual({ phase: 'signing' })
    expect(mocks.write).toHaveBeenCalledOnce()
  })

  it('blocks account drift during simulation before signing', async () => {
    const args = options()
    mocks.estimateGas.mockImplementation(async () => { mocks.account.mockReturnValue({ address: OTHER }); return 1n })
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow(/account changed/i)
    expect(mocks.write).not.toHaveBeenCalled()
    expect(setup()?.phase).not.toBe('signing')
  })

  it('blocks an execution route change before crossing the signing boundary', async () => {
    const args = options()
    mocks.estimateGas.mockImplementation(async () => { mocks.safe.mockReturnValue(true); return 1n })
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow(/wallet.*changed/i)
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('accepts a replacement same-account connector across asynchronous setup checks before review', async () => {
    const args = options()
    mocks.preflight.mockImplementation(async () => {
      mocks.account.mockReturnValue({ address: ACCOUNT, chainId: CHAIN, connector: { uid: 'wallet-2' } })
    })
    await expect(prepareLaunchMultisigs(args)).resolves.toBeUndefined()
    expect(mocks.write).toHaveBeenCalledOnce()
  })

  it('rechecks the account after persisting the signing marker', async () => {
    const args = options()
    args.onSetup.mockImplementation(value => {
      if (value.phase === 'signing') mocks.account.mockReturnValue({ address: OTHER })
    })
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow(/account changed/i)
    expect(mocks.write).not.toHaveBeenCalled()
    expect(setup()).toEqual({ phase: 'failed' })
  })

  it('rechecks the exact pinned plan after review', async () => {
    const args = options()
    mocks.review.mockImplementation(async () => { seed({ plans: { [CHAIN]: { ...plan, ticker: 'EDITED' } } }) })
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow('saved Safe or launch account changed')
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it.each(['different address', 'missing result', 'malformed address', 'failed factory'] as const)('rejects simulation with %s', async kind => {
    if (kind === 'different address') mocks.simulate.mockResolvedValue(simulation(true, OTHER))
    if (kind === 'missing result') mocks.simulate.mockResolvedValue(encodeFunctionResult({ abi: CREATE_BATCH_ABI, functionName: 'aggregate3Value', result: [] }))
    if (kind === 'malformed address') mocks.simulate.mockResolvedValue(encodeFunctionResult({ abi: CREATE_BATCH_ABI, functionName: 'aggregate3Value', result: [{ success: true, returnData: '0x' }] }))
    if (kind === 'failed factory') { mocks.simulate.mockResolvedValue(simulation(false)); mocks.verifySafe.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('Safe missing')) }
    const args = options()
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow()
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('accepts a failed optional factory call only after verifying the exact existing Safe', async () => {
    mocks.simulate.mockResolvedValue(simulation(false))
    mocks.verifySafe.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await prepareLaunchMultisigs(options())
    expect(mocks.verifySafe).toHaveBeenLastCalledWith(expect.anything(), [safe])
  })

  it('resumes an existing setup transaction without submitting another', async () => {
    seed({ statuses: { [CHAIN]: { phase: 'failed', multisigSetup: { phase: 'confirming', txHash: HASH } } } })
    const args = options()
    await prepareLaunchMultisigs(args)
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.receipt).toHaveBeenCalledWith({}, { chainId: CHAIN, hash: HASH })
    expect(setup()).toEqual({ phase: 'done', txHash: HASH })
  })

  it('keeps a setup success the SDK settled confirming when a later read disagrees, never failed or sent again', async () => {
    seed({ statuses: { [CHAIN]: { phase: 'failed', multisigSetup: { phase: 'confirming', settled: true, txHash: HASH } } } })
    mocks.receipt.mockResolvedValueOnce({ status: 'reverted', blockNumber: 123n })
    const args = options()
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow('still confirming')
    expect(mocks.write).not.toHaveBeenCalled()
    expect(setup()).toEqual({ phase: 'confirming', settled: true, txHash: HASH })
  })

  it('permits retry after proving the earlier project launch reverted and verifying its existing Safe', async () => {
    seed({ statuses: { [CHAIN]: { phase: 'failed', txHash: EXECUTION, multisigSetup: { phase: 'done', txHash: HASH } } } })
    mocks.receipt.mockResolvedValueOnce({ status: 'reverted', blockNumber: 124n })
    mocks.verifySafe.mockResolvedValue(true)
    const args = options()
    await prepareLaunchMultisigs(args)
    expect(mocks.receipt).toHaveBeenCalledWith({}, { chainId: CHAIN, hash: EXECUTION })
    expect(mocks.write).not.toHaveBeenCalled()
    expect(loadLaunchSession()!.statuses[CHAIN]).toEqual({ phase: 'failed', txHash: EXECUTION, multisigSetup: { phase: 'done' } })
  })

  it('does not trust a failed label when the earlier project launch actually succeeded', async () => {
    seed({ statuses: { [CHAIN]: { phase: 'failed', txHash: EXECUTION, multisigSetup: { phase: 'done', txHash: HASH } } } })
    const args = options()
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow('did not revert')
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.verifySafe).not.toHaveBeenCalled()
  })

  it('keeps the submitted hash when receipt tracking is temporarily unavailable', async () => {
    // Core's own wait sees the receipt; the hold's own read then can't, so the setup is still confirming.
    mocks.receipt.mockResolvedValueOnce({ status: 'success', blockNumber: 123n }).mockRejectedValue(new Error('RPC unavailable'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const args = options()
      // The run follows it for two minutes, showing it as confirming, before it hands it back.
      const refused = expect(prepareLaunchMultisigs(args)).rejects.toThrow('Confirming your transaction.')
      await vi.advanceTimersByTimeAsync(121_000)
      await refused
      expect(args.onProgress).toHaveBeenCalledWith('Confirming Safe creation')
    } finally {
      vi.useRealTimers()
    }
    expect(setup()).toEqual({ phase: 'confirming', txHash: HASH })
    expect(mocks.verifyCreated).not.toHaveBeenCalled()
  })

  it('follows a setup still confirming until its receipt reads, then completes it', async () => {
    mocks.receipt.mockResolvedValueOnce({ status: 'success', blockNumber: 123n })
      .mockRejectedValueOnce(new Error('RPC unavailable'))
      .mockResolvedValue({ status: 'success', blockNumber: 123n })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const run = prepareLaunchMultisigs(options())
      await vi.advanceTimersByTimeAsync(30_000)
      await run
    } finally {
      vi.useRealTimers()
    }
    expect(setup()).toEqual({ phase: 'done', txHash: HASH })
    expect(mocks.write).toHaveBeenCalledOnce()
  })

  it('records a reverted setup separately and permits a new setup attempt', async () => {
    // Every read of the first setup sees its revert.
    mocks.receipt.mockResolvedValue({ status: 'reverted', blockNumber: 123n })
    const args = options()
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow('reverted')
    mocks.receipt.mockResolvedValue({ status: 'success', blockNumber: 123n })
    expect(loadLaunchSession()!.statuses[CHAIN]).toEqual({ phase: 'pending', multisigSetup: { phase: 'failed', txHash: HASH } })
    await prepareLaunchMultisigs(args)
    expect(mocks.write).toHaveBeenCalledTimes(2)
  })

  it('does not mark setup complete when receipt-block Safe verification fails', async () => {
    mocks.verifyCreated.mockRejectedValue(new Error('Wrong Safe policy'))
    await expect(prepareLaunchMultisigs(options())).rejects.toThrow('Wrong Safe policy')
    expect(setup()).toEqual({ phase: 'confirming', txHash: HASH })
  })

  it('tracks a Safe proposal separately and receipt-polls only the execution hash', async () => {
    mocks.safe.mockReturnValue(true)
    const args = options()
    mocks.write.mockImplementation(async () => { expect(setup()).toEqual({ phase: 'signing', safe: true }); return HASH })
    mocks.safeHash.mockImplementation(async () => { expect(setup()).toEqual({ phase: 'confirming', safe: true, txHash: HASH, safeProposalHash: HASH }); return EXECUTION })
    await prepareLaunchMultisigs(args)
    expect(mocks.safeHash).toHaveBeenCalledWith(CHAIN, HASH, { signal: args.signal })
    expect(mocks.receipt).toHaveBeenCalledWith({}, { chainId: CHAIN, hash: EXECUTION })
    expect(setup()).toEqual({ phase: 'done', txHash: EXECUTION })
  })

  it('wallet-action:create-an-owner-or-operator-safe-during-launch proposes Safe creation through a Safe app with gas 0 and reviews it as Safe gas 0', async () => {
    mocks.safe.mockReturnValue(true)
    const args = options()
    await prepareLaunchMultisigs(args)
    expect(reviewed()).toMatchObject({
      title: 'Review Safe creation',
      description: expect.stringMatching(/2 of 2 approvals[\s\S]*\n\nChoose the Safe nonce\.$/),
      confirmLabel: 'Agree & continue to Safe',
    })
    expect(reviewed().calls).toMatchObject([{ to: MULTICALL3, from: ACCOUNT, safeTxGas: 0n }])
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ to: MULTICALL3, gas: 0n }))
  })

  it.each([
    ['a saved Safe proposal', { phase: 'confirming' as const, safe: true as const, txHash: HASH, safeProposalHash: HASH }],
    ['a legacy Safe execution with missing proposal evidence', { phase: 'confirming' as const, safe: true as const, txHash: EXECUTION }],
  ])('recovers %s through the SDK first: shown as held, never proposed again', async (_kind, multisigSetup) => {
    seed({ statuses: { [CHAIN]: { phase: 'pending', multisigSetup } } })
    const args = options()
    await expect(prepareLaunchMultisigs(args)).rejects.toMatchObject({ name: 'SavedAttemptShownError' })
    expect(mocks.write).not.toHaveBeenCalled()
    expect(mocks.preflight).not.toHaveBeenCalled()
    expect(setup()).toEqual(multisigSetup)
  })

  it('keeps Safe proposal recovery data when execution tracking fails', async () => {
    mocks.safe.mockReturnValue(true)
    mocks.safeHash.mockRejectedValue(new Error('Service unavailable'))
    await expect(prepareLaunchMultisigs(options())).rejects.toThrow('Service unavailable')
    expect(setup()).toEqual({ phase: 'confirming', safe: true, txHash: HASH, safeProposalHash: HASH })
    expect(mocks.receipt).not.toHaveBeenCalled()
  })

  it("lets the launch lock go when the page's signal ends the wait for the Safe, keeping the proposal", async () => {
    let held = false
    // The launch's own lock; the SDK's hold takes its own locks here too.
    const request = vi.fn(async (name: string, _options, action) => {
      if (name !== 'jbm-launch') return action({ name })
      held = true
      try { return await action({ name: 'jbm-launch' }) } finally { held = false }
    })
    vi.stubGlobal('navigator', { locks: { request } })
    mocks.safe.mockReturnValue(true)
    const page = new AbortController()
    mocks.safeHash.mockImplementation((_chainId: number, _hash: Hex, { signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Safe execution wait aborted', 'AbortError')), { once: true })
      }))
    const preparing = prepareLaunchMultisigs({ ...options(), signal: page.signal })
    await vi.waitFor(() => expect(mocks.safeHash).toHaveBeenCalledOnce())
    expect(held).toBe(true)

    page.abort()
    await expect(preparing).rejects.toMatchObject({ name: 'AbortError' })
    expect(held).toBe(false)
    expect(setup()).toEqual({ phase: 'confirming', safe: true, txHash: HASH, safeProposalHash: HASH })
    expect(mocks.receipt).not.toHaveBeenCalled()
  })


  it.each(['chain', 'disconnected', 'view-as'] as const)('blocks %s drift caused by the persisted signing callback', async kind => {
    const args = options()
    args.onSetup.mockImplementation(value => {
      if (value.phase !== 'signing') return
      if (kind === 'view-as') mocks.viewAs.mockImplementation(() => { throw new Error('View-as is read-only') })
      else mocks.account.mockReturnValue({ address: kind === 'disconnected' ? undefined : ACCOUNT, chainId: kind === 'chain' ? 1 : CHAIN, connector: { uid: 'wallet-1' } })
    })
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow(kind === 'view-as' ? /View-as/ : /(?:wallet|account) changed/i)
    expect(mocks.write).not.toHaveBeenCalled()
    expect(setup()).toEqual({ phase: 'failed' })
  })

  it.each(['reverted', 'unproven'] as const)('retains a Safe %s execution across reload: the SDK shows it, with no other wallet call', async status => {
    mocks.safe.mockReturnValue(true)
    mocks.receipt.mockResolvedValue({ status: status === 'reverted' ? 'reverted' : 'success', blockNumber: 123n })
    mocks.execution.mockResolvedValue({ status })
    const args = options()
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow('not confirmed')
    expect(setup()).toEqual({ phase: 'confirming', safe: true, txHash: EXECUTION, safeProposalHash: HASH })
    const resumed = options()
    await expect(prepareLaunchMultisigs(resumed)).rejects.toMatchObject({ name: 'SavedAttemptShownError' })
    // Only the first run's proposal reached the wallet.
    expect(mocks.write).toHaveBeenCalledTimes(1)
    expect(mocks.verifyCreated).not.toHaveBeenCalled()
  })

  it('retains an at-once Safe reply whose outer execution reverted', async () => {
    mocks.safe.mockReturnValue(true)
    mocks.safeHash.mockResolvedValue(HASH)
    mocks.receipt.mockResolvedValue({ status: 'reverted', blockNumber: 123n })
    mocks.execution.mockResolvedValue({ status: 'reverted' })
    const args = options()
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow('not confirmed')
    await expect(prepareLaunchMultisigs(args)).rejects.toMatchObject({ name: 'SavedAttemptShownError' })
    expect(mocks.write).toHaveBeenCalledTimes(1)
    expect(setup()).toEqual({ phase: 'confirming', safe: true, txHash: HASH, safeProposalHash: HASH })
  })

  it("keeps a Safe setup the app saw fail inside the Safe held until the SDK settles it: no second proposal before then", async () => {
    mocks.safe.mockReturnValue(true)
    mocks.execution.mockResolvedValueOnce({ status: 'failed' })
    const args = options()
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow('failed inside the Safe')
    expect(setup()).toEqual({ phase: 'failed', txHash: EXECUTION })
    await expect(prepareLaunchMultisigs(args)).rejects.toMatchObject({ name: 'WriteHeldError' })
    expect(mocks.write).toHaveBeenCalledTimes(1)
    expect(mocks.execution).toHaveBeenCalledWith(expect.objectContaining({
      safe: ACCOUNT, proposalHash: HASH, batch: false,
      calls: [expect.objectContaining({ to: MULTICALL3, value: 0n })],
    }))
  })

  it('blocks concurrent setup in another tab', async () => {
    const request = vi.fn(async (_name, _options, action) => action(null))
    vi.stubGlobal('navigator', { locks: { request } })
    const args = options()
    await expect(prepareLaunchMultisigs(args)).rejects.toThrow('Another tab')
    expect(request).toHaveBeenCalledWith('jbm-launch', { ifAvailable: true }, expect.any(Function))
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('completes setup while holding the acquired launch lock', async () => {
    let held = false
    const request = vi.fn(async (_name, _options, action) => {
      held = true
      try { return await action({ name: 'jbm-launch' }) } finally { held = false }
    })
    vi.stubGlobal('navigator', { locks: { request } })
    const args = options()
    mocks.write.mockImplementation(async () => { expect(held).toBe(true); return HASH })
    await prepareLaunchMultisigs(args)
    expect(held).toBe(false)
    expect(setup()?.phase).toBe('done')
  })
})

describe('interrupted setup recovery', () => {
  const client = async () => (await import('@/lib/wallet-core')).publicClient(CHAIN) as never

  it("gives a setup an earlier release left signing the SDK's check: only the user's check retires it, then a new setup is sent", async () => {
    seed({ statuses: { [CHAIN]: { phase: 'failed', multisigSetup: { phase: 'signing' } } } })
    const shown = await prepareLaunchMultisigs(options()).catch(error => error)
    expect(shown).toMatchObject({ name: 'SavedAttemptShownError' })
    const outcome = await savedAttempts.recover(shown.attempt, await client())
    expect(outcome.status).toBe('check')
    if (outcome.status !== 'check') return
    await expect(savedAttempts.retire(shown.attempt, { by: 'check', outcome })).resolves.toMatchObject({ retired: true })
    await retireLaunchMultisigSetup(CHAIN, SALT)
    expect(setup()).toEqual({ phase: 'failed' })
    const args = options()
    await prepareLaunchMultisigs(args)
    expect(mocks.write).toHaveBeenCalledOnce()
    expect(setup()?.phase).toBe('done')
  })

  it("keeps a confirming setup whose transaction this node can't show held by the SDK, never a dead end or a second send", async () => {
    mocks.receipt.mockRejectedValue(new Error('RPC unavailable'))
    seed({ statuses: { [CHAIN]: { phase: 'failed', multisigSetup: { phase: 'confirming', txHash: HASH } } } })
    const attempt = setupAttemptOf(CHAIN, SALT, ACCOUNT, plan, { phase: 'confirming', txHash: HASH })
    const outcome = await savedAttempts.recover(attempt, await client())
    // Its saved hash is adopted into the hold, which follows it and offers its exit when due.
    expect(outcome.status).toBe('held')
    const args = options()
    await expect(prepareLaunchMultisigs(args)).rejects.toMatchObject({ name: 'SavedAttemptShownError' })
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('refuses a stale check once another tab completed the setup', async () => {
    seed({ statuses: { [CHAIN]: { phase: 'failed', multisigSetup: { phase: 'signing' } } } })
    const attempt = setupAttemptOf(CHAIN, SALT, ACCOUNT, plan, { phase: 'signing' })
    const outcome = await savedAttempts.recover(attempt, await client())
    expect(outcome.status).toBe('check')
    if (outcome.status !== 'check') return
    seed({ statuses: { [CHAIN]: { phase: 'failed', multisigSetup: { phase: 'done', txHash: HASH } } } })
    await expect(savedAttempts.retire(attempt, { by: 'check', outcome })).resolves.toMatchObject({ retired: false })
    expect(setup()).toEqual({ phase: 'done', txHash: HASH })
  })

  it('fails closed when the retirement cannot be persisted', async () => {
    seed({ statuses: { [CHAIN]: { phase: 'failed', multisigSetup: { phase: 'signing' } } } })
    storage.setItem.mockImplementation(() => { throw new Error('quota') })
    await expect(retireLaunchMultisigSetup(CHAIN, SALT)).rejects.toThrow('could not be saved')
    expect(setup()).toEqual({ phase: 'signing' })
  })
})
