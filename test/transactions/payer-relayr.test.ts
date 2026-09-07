import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, stringToHex, zeroAddress, type Address, type Hex } from 'viem'
import { JBCoreContracts, jbContractAddress, type JBChainId } from '@bananapus/nana-sdk-core'
import { JB_PROJECT_PAYER_DEPLOYER, jbProjectPayerDeployerAbi } from '@bananapus/nana-sdk-core/v6'
import type { RelayrEntry, RelayrQuote } from '@/lib/relayr'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const ADMIN = '0x2222222222222222222222222222222222222222' as Address
const BENEFICIARY = '0x3333333333333333333333333333333333333333' as Address
const PAYER = '0x4444444444444444444444444444444444444444' as Address
const IMPLEMENTATION = '0x5555555555555555555555555555555555555555' as Address
const EXECUTOR = '0x6666666666666666666666666666666666666666' as Address
const BLOCK = `0x${'ab'.repeat(32)}` as Hex
const PAYMENT_HASH = `0x${'cd'.repeat(32)}` as Hex
const SAFE_PROPOSAL = `0x${'ef'.repeat(32)}` as Hex
const BUNDLE = '12345678-1234-1234-1234-123456789abc'

const mocks = vi.hoisted(() => ({
  address: '' as Address,
  safe: false,
  getTransaction: vi.fn(), getReceipt: vi.fn(), getBlock: vi.fn(), getCode: vi.fn(), readContract: vi.fn(),
  getBlockNumber: vi.fn(), getLogs: vi.fn(),
  waitReceipt: vi.fn(), waitSafe: vi.fn(), simulate: vi.fn(), send: vi.fn(), review: vi.fn(),
  post: vi.fn(), pay: vi.fn(), poll: vi.fn(), funding: vi.fn(), paymentSent: vi.fn(),
}))

vi.mock('@wagmi/core', () => ({ getAccount: () => ({ address: mocks.address }) }))
vi.mock('@/providers/Providers', async () => {
  const chains = await import('viem/chains')
  return { wagmiConfig: {}, SUPPORTED_CHAINS: [chains.mainnet, chains.optimism, chains.base, chains.arbitrum,
    chains.sepolia, chains.optimismSepolia, chains.baseSepolia, chains.arbitrumSepolia] }
})
vi.mock('@/lib/wallet-core', () => ({
  publicClient: (chain: number) => ({
    readContract: (args: unknown) => mocks.readContract(chain, args),
    getTransaction: (args: unknown) => mocks.getTransaction(chain, args),
    getTransactionReceipt: (args: unknown) => mocks.getReceipt(chain, args),
    getBlock: (args: unknown) => mocks.getBlock(chain, args),
    getBlockNumber: () => mocks.getBlockNumber(chain),
    getLogs: (args: unknown) => mocks.getLogs(chain, args),
    getBytecode: (args: unknown) => mocks.getCode(chain, args),
    waitForTransactionReceipt: (args: unknown) => mocks.waitReceipt(chain, args),
  }),
  connectedWallet: async (chain: number) => ({ account: mocks.address,
    wallet: { sendTransaction: (request: unknown) => mocks.send(chain, request) } }),
}))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => mocks.safe,
  waitForSafeExecutionHash: mocks.waitSafe,
}))
vi.mock('@/lib/transaction-simulation', () => ({ simulateStateChangingTransaction: mocks.simulate, TRANSACTION_SIMULATION_GAS: 10_000_000n }))
vi.mock('@/lib/transaction-review', () => ({ requireTransactionReview: mocks.review, requireFundingChainSelection: mocks.funding }))
vi.mock('@/lib/relayr', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/relayr')>()),
  relayrPostBundle: mocks.post, relayrPay: mocks.pay, relayrPoll: mocks.poll,
}))

import { buildPayerDeploymentReview, finishPayerDeployment, loadPayerDeployment, payerDeploymentRequest,
  payerDeploymentScope, runPayerDeployments, verifyPayerDeployment, type PayerDeploymentSession } from '@/lib/payer-relayr'
import { RELAYR_NATIVE_TOKEN, RELAYR_PAYMENT_ADDRESS, RELAYR_PAYMENT_SELECTOR, relayrPay, relayrPoll } from '@/lib/relayr'
import { SAFE_EXEC_ABI } from '@/lib/safe'

let review: PayerDeploymentSession
let projectId = 100
let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn>; removeItem: ReturnType<typeof vi.fn> }
const hashFor = (chain: number) => `0x${chain.toString(16).padStart(64, '0')}` as Hex
const directoryFor = (chain: number) => jbContractAddress['6'][JBCoreContracts.JBDirectory][chain as JBChainId]

function makeReview(chains = [1, 10]) {
  return buildPayerDeploymentReview({
    projects: chains.map((chain, index) => [chain, projectId + index] as const), selectedChainIds: chains,
    account: ALICE, owner: ADMIN, beneficiary: BENEFICIARY, memo: 'Treasury support', addToBalance: false,
  })
}

function quoteFor(entries: RelayrEntry[]): RelayrQuote {
  const deadline = Math.floor(Date.now() / 1_000) + 3_600
  return { bundle_uuid: BUNDLE, payment_info: [1, 10].map(chain => ({ chain, amount: '1000',
    target: RELAYR_PAYMENT_ADDRESS, token: RELAYR_NATIVE_TOKEN, payment_deadline: deadline,
    calldata: `${RELAYR_PAYMENT_SELECTOR}${BUNDLE.replaceAll('-', '')}${'0'.repeat(32)}${deadline.toString(16).padStart(64, '0')}` as Hex })),
    expectedTransactions: entries.map((entry, index) => ({ chain: entry.chain, entry,
      txUuid: `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}` })),
  }
}

function records() {
  return review.calls.map((call, index) => ({
    tx_uuid: `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
    request: { chain: call.chainId, target: JB_PROJECT_PAYER_DEPLOYER, data: call.data, value: '0', virtual_nonce: 0 },
    status: { state: 'success', data: { hash: hashFor(call.chainId) } },
  }))
}

function receipt(chain: number) {
  const call = review.calls.find(call => call.chainId === chain)!
  const event = jbProjectPayerDeployerAbi.find(item => item.type === 'event')!
  return { status: 'success', transactionHash: hashFor(chain), blockHash: BLOCK, blockNumber: 100n,
    logs: [{ address: JB_PROJECT_PAYER_DEPLOYER,
      topics: encodeEventTopics({ abi: jbProjectPayerDeployerAbi, eventName: 'DeployProjectPayer', args: { projectPayer: PAYER } }),
      data: encodeAbiParameters(event.inputs.filter(input => !input.indexed), [BigInt(call.projectId), call.beneficiary, call.memo,
        '0x', call.addToBalance, directoryFor(chain), call.owner, review.transport === 'relayr' ? EXECUTOR : ALICE]),
    }, ...(review.transport === 'safe' ? [{ address: ALICE,
      topics: [keccak256(stringToHex('ExecutionSuccess(bytes32,uint256)')), SAFE_PROPOSAL],
      data: `0x${'00'.repeat(32)}` as Hex,
    }] : [])],
  }
}

beforeEach(() => {
  projectId += 10
  mocks.address = ALICE
  mocks.safe = false
  const values = new Map<string, string>()
  storage = { getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value) }), removeItem: vi.fn((key: string) => { values.delete(key) }) }
  vi.stubGlobal('window', { localStorage: storage })
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}) } })
  review = makeReview()
  mocks.readContract.mockReset().mockImplementation(async (chain: number, args: { functionName: string }) =>
    args.functionName === 'DIRECTORY' ? directoryFor(chain) : args.functionName === 'IMPLEMENTATION' ? IMPLEMENTATION : ALICE)
  mocks.getTransaction.mockReset().mockImplementation(async (chain: number) => {
    const call = review.calls.find(call => call.chainId === chain)!
    return { hash: hashFor(chain), chainId: chain, blockHash: BLOCK, blockNumber: 100n, value: 0n,
      from: review.transport === 'direct' ? ALICE : EXECUTOR,
      to: review.transport === 'safe' ? ALICE : JB_PROJECT_PAYER_DEPLOYER,
      input: review.transport === 'safe' ? encodeFunctionData({ abi: SAFE_EXEC_ABI, functionName: 'execTransaction',
        args: [JB_PROJECT_PAYER_DEPLOYER, 0n, call.data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'] }) : call.data,
    }
  })
  mocks.getReceipt.mockReset().mockImplementation(async (chain: number) => receipt(chain))
  mocks.getBlock.mockReset().mockResolvedValue({ hash: BLOCK })
  mocks.getBlockNumber.mockReset().mockResolvedValue(100n)
  mocks.getLogs.mockReset().mockResolvedValue([])
  mocks.getCode.mockReset().mockResolvedValue(`0x363d3d373d3d3d363d73${IMPLEMENTATION.slice(2)}5af43d82803e903d91602b57fd5bf3`)
  mocks.waitReceipt.mockReset().mockResolvedValue(undefined)
  mocks.waitSafe.mockReset().mockImplementation(async (chain: number) => hashFor(chain))
  mocks.simulate.mockReset().mockResolvedValue(encodeAbiParameters([{ type: 'address' }], [PAYER]))
  mocks.review.mockReset().mockResolvedValue(undefined)
  mocks.funding.mockReset().mockResolvedValue(10)
  mocks.send.mockReset().mockImplementation(async (chain: number) => mocks.safe ? SAFE_PROPOSAL : hashFor(chain))
  mocks.post.mockReset().mockImplementation(async (entries: RelayrEntry[]) => quoteFor(entries))
  mocks.pay.mockReset().mockImplementation(async (...args: Parameters<typeof relayrPay>) => {
    await args[4]?.()
    args[5]?.()
    mocks.paymentSent()
    args[3]?.(PAYMENT_HASH)
    return PAYMENT_HASH
  })
  mocks.poll.mockReset().mockImplementation(async (...args: Parameters<typeof relayrPoll>) => {
    args[2]?.(records())
    return records()
  })
})

describe('payer deployment review and raw Relayr execution', () => {
  it('uses each linked project ID and the explicit admin/beneficiary in raw factory calls with one chosen funding payment', async () => {
    const result = await runPayerDeployments(review, vi.fn())
    expect(result.phase).toBe('complete')
    expect(result.outcomes.map(outcome => outcome.payer)).toEqual([PAYER, PAYER])
    const entries = mocks.post.mock.calls[0][0] as RelayrEntry[]
    expect(entries).toHaveLength(2)
    entries.forEach((entry, index) => {
      expect(entry.target).toBe(JB_PROJECT_PAYER_DEPLOYER)
      const decoded = decodeFunctionData({ abi: jbProjectPayerDeployerAbi, data: entry.data })
      expect(decoded.args).toEqual([BigInt(projectId + index), BENEFICIARY, 'Treasury support', '0x', false, ADMIN])
    })
    expect(mocks.funding).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ chainId: 1 }), expect.objectContaining({ chainId: 10 })]))
    expect(mocks.pay.mock.calls[0][0].chain).toBe(10)
    expect(mocks.paymentSent).toHaveBeenCalledTimes(1)
    expect(mocks.send).not.toHaveBeenCalled()
    expect(loadPayerDeployment(review.scope)?.phase).toBe('complete')
  })

  it('keeps the original unpaid quote and frozen settings when funding selection is canceled', async () => {
    mocks.funding.mockRejectedValueOnce(new Error('Funding selection cancelled.'))
    await expect(runPayerDeployments(review, vi.fn())).rejects.toThrow(/cancelled/)
    const saved = loadPayerDeployment(review.scope)!
    expect(saved.phase).toBe('quoted')
    expect(mocks.paymentSent).not.toHaveBeenCalled()
    const edited = { ...review, calls: [{ ...review.calls[0], memo: 'changed' }, review.calls[1]] }
    await expect(runPayerDeployments(edited, vi.fn())).rejects.toThrow(/previous payer deployment/)
    await runPayerDeployments(saved, vi.fn())
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.paymentSent).toHaveBeenCalledTimes(1)
  })

  it('never republishes a raw factory bundle when the original quote response was lost', async () => {
    mocks.post.mockRejectedValueOnce(new Error('Quote connection lost.'))
    await expect(runPayerDeployments(review, vi.fn())).rejects.toThrow(/connection lost/)
    const saved = loadPayerDeployment(review.scope)!
    expect(saved.phase).toBe('publishing')
    await expect(runPayerDeployments(saved, vi.fn())).rejects.toThrow(/duplicate addresses/)
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.paymentSent).not.toHaveBeenCalled()
  })

  it('retains verified partial results and only checks the original paid bundle on recovery', async () => {
    mocks.poll.mockImplementationOnce(async (...args: Parameters<typeof relayrPoll>) => {
      const partial = records()
      partial[1].status = { state: 'failed', data: { hash: '' as Hex } }
      args[2]?.(partial)
      throw new Error('One destination failed.')
    })
    await expect(runPayerDeployments(review, vi.fn())).rejects.toThrow(/destination failed/)
    const saved = loadPayerDeployment(review.scope)!
    expect(saved.outcomes.map(outcome => outcome.state)).toEqual(['verified', 'ready'])
    expect(saved.paymentHash).toBe(PAYMENT_HASH)
    await runPayerDeployments(saved, vi.fn())
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.paymentSent).toHaveBeenCalledTimes(1)
    expect(loadPayerDeployment(review.scope)?.phase).toBe('complete')
  })

  it('persists the payment send window and never repays an ambiguous no-hash send', async () => {
    mocks.pay.mockImplementationOnce(async (...args: Parameters<typeof relayrPay>) => {
      args[5]?.()
      expect(loadPayerDeployment(review.scope)?.phase).toBe('payment-sending')
      throw new Error('Wallet disconnected after send.')
    })
    await expect(runPayerDeployments(review, vi.fn())).rejects.toThrow(/disconnected/)
    await runPayerDeployments(loadPayerDeployment(review.scope)!, vi.fn())
    expect(mocks.pay).toHaveBeenCalledTimes(1)
  })

  it('stops before publication if browser storage cannot preserve the frozen review', async () => {
    storage.setItem.mockImplementation(() => { throw new Error('Storage blocked.') })
    await expect(runPayerDeployments(review, vi.fn())).rejects.toThrow(/browser storage/)
    expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.paymentSent).not.toHaveBeenCalled()
  })

  it('refuses a quote that substituted another factory target', async () => {
    mocks.post.mockImplementationOnce(async (entries: RelayrEntry[]) => {
      const quote = quoteFor(entries)
      quote.expectedTransactions![0].entry = { ...entries[0], target: ADMIN }
      return quote
    })
    await expect(runPayerDeployments(review, vi.fn())).rejects.toThrow(/changed a reviewed deployment/)
    expect(mocks.paymentSent).not.toHaveBeenCalled()
    expect(loadPayerDeployment(review.scope)?.phase).toBe('publishing')
  })

  it('keeps the returned payment hash in memory when its post-send storage write fails', async () => {
    const original = storage.setItem.getMockImplementation() as (key: string, value: string) => void
    storage.setItem.mockImplementation((key: string, value: string) => {
      if (key.includes('journal:') && JSON.parse(value).phase === 'executing') throw new Error('Storage filled up.')
      return original(key, value)
    })
    await expect(runPayerDeployments(review, vi.fn())).rejects.toThrow(/browser storage/)
    const saved = loadPayerDeployment(review.scope)!
    expect(saved).toMatchObject({ phase: 'executing', paymentHash: PAYMENT_HASH })
    storage.setItem.mockImplementation(original)
    await runPayerDeployments(saved, vi.fn())
    expect(mocks.paymentSent).toHaveBeenCalledTimes(1)
    expect(mocks.pay).toHaveBeenCalledTimes(1)
  })

  it('uses a stable project action scope regardless of selection or input changes', () => {
    expect(payerDeploymentScope([[10, 84], [1, 42]])).toBe(payerDeploymentScope([[1, 42], [10, 84]]))
    expect(() => buildPayerDeploymentReview({ projects: [[1, 42]], selectedChainIds: [10], account: ALICE,
      beneficiary: BENEFICIARY, owner: ADMIN, memo: '', addToBalance: false })).toThrow(/linked project/)
  })

  it('blocks a stale quoted review after its original attempt was completed and archived', async () => {
    mocks.funding.mockRejectedValueOnce(new Error('Funding canceled.'))
    await expect(runPayerDeployments(review, vi.fn())).rejects.toThrow(/canceled/)
    const stale = loadPayerDeployment(review.scope)!
    await runPayerDeployments(stale, vi.fn())
    await finishPayerDeployment(review.scope, review.id)
    await expect(runPayerDeployments(stale, vi.fn())).rejects.toThrow(/already completed/)
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.paymentSent).toHaveBeenCalledTimes(1)
  })

  it('finds an overlapping pending deployment through its selected project alias', async () => {
    review = makeReview([1])
    mocks.send.mockRejectedValueOnce(new Error('Wallet response lost.'))
    await expect(runPayerDeployments(review, vi.fn())).rejects.toThrow(/response lost/)
    const overlapping = makeReview([1, 10])
    const update = vi.fn()
    await expect(runPayerDeployments(overlapping, update)).rejects.toThrow(/previous payer deployment/)
    expect(loadPayerDeployment(overlapping.scope)?.id).toBe(review.id)
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: review.id }))
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('locks shared destination projects even when discovery groups use different primary scopes', async () => {
    review = makeReview([1])
    let release!: (hash: Hex) => void
    mocks.send.mockImplementationOnce(() => new Promise<Hex>(resolve => { release = resolve }))
    const first = runPayerDeployments(review, vi.fn())
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1))
    await expect(runPayerDeployments(makeReview([1, 10]), vi.fn())).rejects.toThrow(/already being processed/)
    release(hashFor(1))
    await first
    expect(mocks.post).not.toHaveBeenCalled()
  })
})

describe('direct and Safe payer recovery', () => {
  it('uses direct sequential calls on testnets, and resumes receipts without cloning a successful earlier chain again', async () => {
    review = makeReview([11155111, 11155420])
    mocks.waitReceipt.mockRejectedValueOnce(new Error('Receipt unavailable.'))
    await expect(runPayerDeployments(review, vi.fn())).rejects.toThrow(/unavailable/)
    expect(mocks.send).toHaveBeenCalledTimes(1)
    const saved = loadPayerDeployment(review.scope)!
    expect(saved.outcomes[0]).toMatchObject({ state: 'submitted', hash: hashFor(11155111) })
    await runPayerDeployments(saved, vi.fn())
    expect(mocks.send.mock.calls.map(args => args[0])).toEqual([11155111, 11155420])
    expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.paymentSent).not.toHaveBeenCalled()
  })

  it('keeps an ambiguous direct send pending and never advances to another chain', async () => {
    review = makeReview([11155111, 11155420])
    mocks.send.mockRejectedValueOnce(new Error('Wallet send response lost.'))
    await expect(runPayerDeployments(review, vi.fn())).rejects.toThrow(/response lost/)
    const saved = loadPayerDeployment(review.scope)!
    expect(saved.outcomes[0].state).toBe('sending')
    await expect(runPayerDeployments(saved, vi.fn())).rejects.toThrow(/without returning a hash/)
    expect(mocks.send).toHaveBeenCalledTimes(1)
    await expect(finishPayerDeployment(review.scope, review.id)).rejects.toThrow(/Resolve the existing/)
  })

  it('does not open the direct wallet if the send journal cannot be saved', async () => {
    review = makeReview([1])
    const original = storage.setItem.getMockImplementation() as (key: string, value: string) => void
    storage.setItem.mockImplementation((key: string, value: string) => {
      if (key.includes('journal:') && JSON.parse(value).outcomes[0].state === 'sending') throw new Error('Storage blocked.')
      original(key, value)
    })
    await expect(runPayerDeployments(review, vi.fn())).rejects.toThrow(/browser storage/)
    expect(mocks.send).not.toHaveBeenCalled()
    expect(loadPayerDeployment(review.scope)?.outcomes[0].state).toBe('ready')
  })

  it('keeps the direct attempt retryable when alias verification fails before opening the wallet', async () => {
    review = makeReview([1])
    let failAliases = false
    const original = storage.setItem.getMockImplementation() as (key: string, value: string) => void
    storage.setItem.mockImplementation((key: string, value: string) => {
      if (key.includes('alias:') && failAliases) throw new Error('Alias storage blocked.')
      original(key, value)
    })
    mocks.simulate.mockImplementationOnce(async () => {
      failAliases = true
      return encodeAbiParameters([{ type: 'address' }], [PAYER])
    })
    await expect(runPayerDeployments(review, vi.fn())).rejects.toThrow(/browser storage/)
    expect(mocks.send).not.toHaveBeenCalled()
    expect(loadPayerDeployment(review.scope)?.outcomes[0].state).toBe('ready')
  })

  it('rechecks a canonical direct revert before a reviewed retry and keeps its failed transaction history', async () => {
    review = makeReview([1])
    const originalTransaction = await mocks.getTransaction(1)
    let reverted = true
    let currentHash = hashFor(1)
    mocks.getTransaction.mockImplementation(async () => ({ ...originalTransaction, hash: currentHash }))
    mocks.getReceipt.mockImplementation(async () => ({ ...receipt(1), transactionHash: currentHash, status: reverted ? 'reverted' : 'success' }))
    await expect(runPayerDeployments(review, vi.fn())).rejects.toThrow(/verified successful receipt/)
    const failed = loadPayerDeployment(review.scope)!
    expect(failed.outcomes[0]).toMatchObject({ state: 'failed', failedHashes: [hashFor(1)] })
    mocks.getBlock.mockResolvedValueOnce({ hash: PAYMENT_HASH })
    await expect(runPayerDeployments(failed, vi.fn())).rejects.toThrow(/revert is no longer canonical/)
    expect(mocks.send).toHaveBeenCalledTimes(1)
    mocks.send.mockImplementationOnce(async () => { reverted = false; currentHash = PAYMENT_HASH; return currentHash })
    const result = await runPayerDeployments(failed, vi.fn())
    expect(result.phase).toBe('complete')
    expect(result.outcomes[0]).toMatchObject({ hash: PAYMENT_HASH, failedHashes: [hashFor(1)] })
    expect(mocks.send).toHaveBeenCalledTimes(2)
  })

  it('tracks a Safe proposal hash separately and proves its exact factory execution before advancing', async () => {
    mocks.safe = true
    review = makeReview([1, 10])
    mocks.waitSafe.mockRejectedValueOnce(new Error('Safe confirmation pending.'))
    await expect(runPayerDeployments(review, vi.fn())).rejects.toThrow(/Safe confirmation pending/)
    const saved = loadPayerDeployment(review.scope)!
    expect(saved.transport).toBe('safe')
    expect(saved.outcomes[0]).toMatchObject({ state: 'submitted', safeProposalHash: SAFE_PROPOSAL })
    expect(mocks.waitReceipt).not.toHaveBeenCalled()
    await runPayerDeployments(saved, vi.fn())
    expect(mocks.send.mock.calls.map(args => args[0])).toEqual([1, 10])
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('rejects a Safe service mapping to an identical factory call from another Safe proposal', async () => {
    mocks.safe = true
    review = makeReview([1, 10])
    mocks.getReceipt.mockImplementationOnce(async (chain: number) => {
      const wrong = receipt(chain)
      wrong.logs.at(-1)!.topics[1] = PAYMENT_HASH
      return wrong
    })
    await expect(runPayerDeployments(review, vi.fn())).rejects.toThrow(/exact original Safe payer proposal/)
    expect(mocks.send).toHaveBeenCalledTimes(1)
    const saved = loadPayerDeployment(review.scope)!
    expect(saved.outcomes[0]).toMatchObject({ state: 'submitted', safeProposalHash: SAFE_PROPOSAL })
    await runPayerDeployments(saved, vi.fn())
    expect(mocks.send.mock.calls.map(args => args[0])).toEqual([1, 10])
  })

  it('recovers an executed Safe payer on an unhosted chain using its saved block floor and exact success log', async () => {
    mocks.safe = true
    review = makeReview([11155420])
    mocks.send.mockImplementationOnce(async () => {
      expect(loadPayerDeployment(review.scope)?.outcomes[0]).toMatchObject({ state: 'sending', fromBlock: '100' })
      return SAFE_PROPOSAL
    })
    mocks.waitSafe.mockRejectedValue(new Error('Safe does not host a transaction service on this chain.'))
    await expect(runPayerDeployments(review, vi.fn())).rejects.toThrow(/does not host/)
    const saved = loadPayerDeployment(review.scope)!
    expect(saved.outcomes[0]).toMatchObject({ state: 'submitted', safeProposalHash: SAFE_PROPOSAL, fromBlock: '100' })
    expect(mocks.waitReceipt).not.toHaveBeenCalled()
    mocks.getBlockNumber.mockResolvedValue(200n)
    mocks.getLogs.mockResolvedValue([{
      address: ALICE, data: `0x${'00'.repeat(32)}`, transactionHash: hashFor(11155420),
      topics: [keccak256(stringToHex('ExecutionSuccess(bytes32,uint256)')), SAFE_PROPOSAL],
    }])
    const completed = await runPayerDeployments(saved, vi.fn())
    expect(completed.phase).toBe('complete')
    expect(completed.outcomes[0]).toMatchObject({ state: 'verified', hash: hashFor(11155420), safeProposalHash: SAFE_PROPOSAL, fromBlock: '100' })
    expect(mocks.getLogs).toHaveBeenLastCalledWith(11155420, { address: ALICE, fromBlock: 100n, toBlock: 200n })
    expect(mocks.waitSafe).toHaveBeenCalledTimes(1)
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })

  it('requires the reviewed wallet to remain connected before saving or sending', async () => {
    mocks.review.mockImplementationOnce(async () => { mocks.address = ADMIN })
    await expect(runPayerDeployments(review, vi.fn())).rejects.toThrow(/wallet that reviewed/)
    expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })
})

describe('exact payer destination proof', () => {
  it('rejects altered calldata, foreign deployment logs, and noncanonical receipts', async () => {
    const transaction = await mocks.getTransaction(1)
    mocks.getTransaction.mockResolvedValueOnce({ ...transaction, input: '0x1234' })
    await expect(verifyPayerDeployment(review.calls[0], hashFor(1))).rejects.toThrow(/reviewed factory call/)
    const wrongEmitter = receipt(1)
    wrongEmitter.logs[0].address = ADMIN
    mocks.getReceipt.mockResolvedValueOnce(wrongEmitter)
    await expect(verifyPayerDeployment(review.calls[0], hashFor(1))).rejects.toThrow(/exact payer deployment event/)
    mocks.getBlock.mockResolvedValueOnce({ hash: PAYMENT_HASH })
    await expect(verifyPayerDeployment(review.calls[0], hashFor(1))).rejects.toThrow(/no longer canonical/)
  })

  it('rejects an event for another beneficiary and a wrong clone implementation', async () => {
    const wrong = receipt(1)
    const event = jbProjectPayerDeployerAbi.find(item => item.type === 'event')!
    wrong.logs[0].data = encodeAbiParameters(event.inputs.filter(input => !input.indexed), [BigInt(projectId), ADMIN,
      'Treasury support', '0x', false, directoryFor(1), ADMIN, EXECUTOR])
    mocks.getReceipt.mockResolvedValueOnce(wrong)
    await expect(verifyPayerDeployment(review.calls[0], hashFor(1))).rejects.toThrow(/exact payer deployment event/)
    mocks.getCode.mockResolvedValueOnce('0x1234')
    await expect(verifyPayerDeployment(review.calls[0], hashFor(1))).rejects.toThrow(/expected clone/)
  })

  it('archives a complete attempt only after rechecking every original deployment', async () => {
    await runPayerDeployments(review, vi.fn())
    mocks.getBlock.mockResolvedValueOnce({ hash: PAYMENT_HASH })
    await expect(finishPayerDeployment(review.scope, review.id)).rejects.toThrow(/no longer canonical/)
    expect(loadPayerDeployment(review.scope)).not.toBeNull()
    await finishPayerDeployment(review.scope, review.id)
    expect(loadPayerDeployment(review.scope)).toBeNull()
    expect(storage.setItem).toHaveBeenCalledWith(expect.stringContaining('journal:'), expect.stringContaining('\"archived\":true'))
  })

  it('does not let stale completed UI archive a newer attempt that replaced the project aliases', async () => {
    review = makeReview([1])
    const old = review
    await runPayerDeployments(old, vi.fn())
    await finishPayerDeployment(old.scope, old.id)
    review = makeReview([1])
    await runPayerDeployments(review, vi.fn())
    await expect(finishPayerDeployment(old.scope, old.id)).rejects.toThrow(/Resolve the existing/)
    expect(loadPayerDeployment(old.scope)?.id).toBe(review.id)
    expect(loadPayerDeployment(old.scope)?.archived).not.toBe(true)
  })

  it('rebuilds the exact deployment request from the frozen settings', () => {
    expect(payerDeploymentRequest(review.calls[1])).toMatchObject({ address: JB_PROJECT_PAYER_DEPLOYER,
      chainId: 10, args: [BigInt(projectId + 1), BENEFICIARY, 'Treasury support', '0x', false, ADMIN] })
  })
})
