import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, stringToHex, zeroAddress, type Address, type Hex } from 'viem'
import { JBCoreContracts, jbContractAddress, type JBChainId } from '@bananapus/nana-sdk-core'
import { JB_PROJECT_PAYER_DEPLOYER, jbProjectPayerDeployerAbi } from '@bananapus/nana-sdk-core/v6'
import { RELAYR_NATIVE_TOKEN, RELAYR_PAYMENT_ADDRESS, RELAYR_PAYMENT_SELECTOR, RelayrPaymentRevertedError, relayrPaymentChains, relayrPaymentDetails, relayrSignedRequests, sentRelayrPayment, type RelayrEntry, type RelayrPaymentDetails, type RelayrQuote } from '@bananapus/nana-sdk-core/review/relayr'

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
  chainId: 1,
  connectorUid: 'wallet-a',
  safe: false,
  getTransaction: vi.fn(), getReceipt: vi.fn(), getBlock: vi.fn(), getCode: vi.fn(), readContract: vi.fn(),
  getBlockNumber: vi.fn(), getLogs: vi.fn(),
  waitReceipt: vi.fn(), waitSafe: vi.fn(), simulate: vi.fn(), send: vi.fn(), review: vi.fn(),
  post: vi.fn(), pay: vi.fn(), poll: vi.fn(), funding: vi.fn(), paymentSent: vi.fn(),
}))

vi.mock('@wagmi/core', () => ({ getAccount: () => ({ address: mocks.address, chainId: mocks.chainId, connector: { uid: mocks.connectorUid } }) }))
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
  connectedWallet: async (chain: number) => {
    mocks.chainId = chain
    return { account: mocks.address, wallet: { chain: { id: chain }, sendTransaction: (request: unknown) => mocks.send(chain, request) } }
  },
}))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => mocks.safe,
  waitForSafeExecutionHash: mocks.waitSafe,
}))
vi.mock('@bananapus/nana-sdk-core/review', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core/review')>()),
  simulateStateChangingTransaction: mocks.simulate,
}))
vi.mock('@/lib/transaction-review', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/transaction-review')>()),
  requireTransactionReview: mocks.review,
  requireFundingChainSelection: mocks.funding,
}))
vi.mock('@/lib/relayr', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/relayr')>()),
  relayrPostBundle: mocks.post, relayrPay: mocks.pay, relayrPoll: mocks.poll,
}))

import { buildPayerDeploymentReview, finishPayerDeployment, loadPayerDeployment, payerDeploymentRequest,
  payerDeploymentScope, runPayerDeployments, SAFE_PAYER_PENDING, verifyPayerDeployment, type PayerDeploymentSession } from '@/lib/payer-relayr'
import { isExpiredUnfundedRawQuote } from '@/lib/raw-relayr-lifecycle'
import { RelayrPaymentSubmittedError, relayrPay, relayrPoll } from '@/lib/relayr'
import { SAFE_EXEC_ABI } from '@bananapus/nana-sdk-core/safe-service'
import { SAFE_NONCE_GUIDANCE } from '@/lib/safe-connector'
import { clearViewAs, setViewAs } from '@/lib/viewAs'

/** A flow that never ends, for runs whose signal is not under test. */
const flow = new AbortController().signal

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
  return { bundle_uuid: BUNDLE, payment_info: relayrPaymentChains(entries.map(entry => entry.chain)).map(chain => ({ chain, amount: '1000',
    target: RELAYR_PAYMENT_ADDRESS, token: RELAYR_NATIVE_TOKEN, payment_deadline: deadline,
    calldata: `${RELAYR_PAYMENT_SELECTOR}${BUNDLE.replaceAll('-', '')}${'0'.repeat(32)}${deadline.toString(16).padStart(64, '0')}` as Hex })),
    transactions: entries.map((entry, index) => ({ request: entry,
      tx_uuid: `00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}` })),
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
  clearViewAs()
  mocks.connectorUid = 'wallet-a'
  mocks.address = ALICE
  mocks.chainId = 1
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
  mocks.getBlock.mockReset().mockImplementation(async (_chain: number, args?: { blockTag?: string }) => args?.blockTag === 'finalized'
    ? { number: 100n, hash: BLOCK, timestamp: BigInt(Math.floor(Date.now() / 1_000)) } : { hash: BLOCK })
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
  mocks.pay.mockReset().mockImplementation(async ({ payment, bundleUuid, reverify, onSending, onSent }: Parameters<typeof relayrPay>[0]) => {
    const details = relayrPaymentDetails(payment, { bundleUuid, destinationChainIds: review.calls.map(call => call.chainId) })
    await reverify?.()
    onSending?.(details)
    mocks.paymentSent()
    const payments = [sentRelayrPayment(details, PAYMENT_HASH)]
    onSent?.(payments)
    return { hash: PAYMENT_HASH, payments }
  })
  mocks.poll.mockReset().mockImplementation(async (...args: Parameters<typeof relayrPoll>) => {
    args[2]?.(records())
    return records()
  })
})

describe('payer deployment review and raw Relayr execution', () => {
  it('deploys on all four testnets using one raw bundle and one explicitly chosen testnet payment', async () => {
    const testnets = [11155111, 11155420, 84532, 421614]
    review = makeReview(testnets)
    mocks.funding.mockResolvedValue(84532)
    const result = await runPayerDeployments(review, vi.fn(), flow)
    expect(result.phase).toBe('complete')
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.post.mock.calls[0][0].map((entry: RelayrEntry) => entry.chain)).toEqual(testnets)
    expect(mocks.funding.mock.calls[0][0].map((option: { chainId: number }) => option.chainId)).toEqual(testnets)
    expect(mocks.pay.mock.calls[0][0].payment.chain).toBe(84532)
    expect(mocks.pay.mock.calls[0][0].destinationChainIds).toEqual(testnets)
    expect(mocks.paymentSent).toHaveBeenCalledTimes(1)
    expect(mocks.send).not.toHaveBeenCalled()
  })

  /** Relayr reports the bundle as `body` says, by default unpaid with every call pending. */
  function relayrReports(body: Record<string, unknown> = {}) {
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ bundle_uuid: BUNDLE, payment_received: false,
      transactions: records().map(({ status: _, ...record }) => ({ ...record, status: { state: 'Pending' } })), ...body }), { status: 200 }))
  }

  it('keeps the raw bundle without opening funding when testnet quotes offer only mainnet payments', async () => {
    review = makeReview([11155111, 11155420])
    relayrReports()
    mocks.post.mockImplementation(async (entries: RelayrEntry[]) => ({ ...quoteFor(entries),
      payment_info: quoteFor([{ ...entries[0], chain: 1 }]).payment_info,
    }))
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/network family/)
    expect(loadPayerDeployment(review.scope)?.phase).toBe('quoted')
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.funding).not.toHaveBeenCalled()
    expect(mocks.pay).not.toHaveBeenCalled()
  })

  it('does not release an apparently expired quote while canonical finalized time can still fund it', async () => {
    mocks.funding.mockRejectedValueOnce(new Error('Funding selection cancelled.'))
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/cancelled/)
    const saved = loadPayerDeployment(review.scope)!
    const chainTime = Math.floor(Date.now() / 1_000)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_601_000)
    mocks.getBlock.mockImplementation(async (_chain: number, args?: { blockTag?: string }) => args?.blockTag === 'finalized'
      ? { number: 100n, hash: BLOCK, timestamp: BigInt(chainTime) } : { hash: BLOCK })
    relayrReports()
    expect(await isExpiredUnfundedRawQuote(saved, [1, 10])).toBe(false)
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.pay).not.toHaveBeenCalled()
  })

  it('proves an expired unfunded quote releasable without publishing or paying again', async () => {
    mocks.funding.mockRejectedValueOnce(new Error('Funding selection cancelled.'))
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/cancelled/)
    const saved = loadPayerDeployment(review.scope)!
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_601_000)
    relayrReports()
    expect(await isExpiredUnfundedRawQuote(saved, [1, 10])).toBe(true)
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.pay).not.toHaveBeenCalled()
    expect(loadPayerDeployment(review.scope)?.phase).toBe('quoted')
  })

  it('quotes the same raw calls again once the saved unpaid quote can no longer be paid, after Relayr confirms none ran', async () => {
    mocks.funding.mockRejectedValueOnce(new Error('Funding selection cancelled.'))
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/cancelled/)
    expect(loadPayerDeployment(review.scope)?.phase).toBe('quoted')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_601_000)
    relayrReports()
    const result = await runPayerDeployments(loadPayerDeployment(review.scope)!, vi.fn(), flow)
    expect(result.phase).toBe('complete')
    expect(mocks.post).toHaveBeenCalledTimes(2)
    expect(mocks.post.mock.calls[1][0]).toEqual(mocks.post.mock.calls[0][0])
    expect(mocks.paymentSent).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(`https://api.relayr.ba5ed.com/v1/bundle/${BUNDLE}`, expect.objectContaining({ cache: 'no-store' }))
  })

  it.each<[string, Record<string, unknown>, string, string]>([
    ['reports a payment', { payment_received: true }, 'paid',
      'Relayr already reports a payment for this bundle. Do not pay again.'],
    ['does not say whether it was paid', { payment_received: null }, 'unknown',
      'Relayr has not said whether this bundle is paid. Do not pay again yet; check it later.'],
    ['reports a call running', { transactions: [{ tx_uuid: '00000000-0000-0000-0000-000000000001', status: { state: 'Included' } }] }, 'running',
      'Relayr reports a transaction of this bundle as running or run. Do not pay again.'],
    ['names another bundle', { bundle_uuid: '00000000-0000-0000-0000-000000000009' }, 'unknown',
      'Relayr has not said whether this bundle is paid. Do not pay again yet; check it later.'],
  ])('keeps an unpaid quote that can no longer be paid while Relayr %s, saying why', async (_, body, reason, message) => {
    mocks.funding.mockRejectedValueOnce(new Error('Funding selection cancelled.'))
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/cancelled/)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_601_000)
    relayrReports(body)
    await expect(runPayerDeployments(loadPayerDeployment(review.scope)!, vi.fn(), flow)).rejects.toMatchObject({
      name: 'RelayrPaymentRetryError', reason, message })
    expect(loadPayerDeployment(review.scope)?.phase).toBe('quoted')
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.paymentSent).not.toHaveBeenCalled()
  })

  it('uses each linked project ID and the explicit admin/beneficiary in raw factory calls with one chosen funding payment', async () => {
    const result = await runPayerDeployments(review, vi.fn(), flow)
    expect(result.phase).toBe('complete')
    expect(result.outcomes.map(outcome => outcome.payer)).toEqual([PAYER, PAYER])
    const entries = mocks.post.mock.calls[0][0] as RelayrEntry[]
    expect(entries).toHaveLength(2)
    entries.forEach((entry, index) => {
      expect(entry.target).toBe(JB_PROJECT_PAYER_DEPLOYER)
      const decoded = decodeFunctionData({ abi: jbProjectPayerDeployerAbi, data: entry.data })
      expect(decoded.args).toEqual([BigInt(projectId + index), BENEFICIARY, 'Treasury support', '0x', false, ADMIN])
    })
    expect(mocks.funding).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ chainId: 1 }), expect.objectContaining({ chainId: 10 })]), 1)
    expect(mocks.pay.mock.calls[0][0].payment.chain).toBe(10)
    expect(mocks.paymentSent).toHaveBeenCalledTimes(1)
    expect(mocks.send).not.toHaveBeenCalled()
    expect(loadPayerDeployment(review.scope)?.phase).toBe('complete')
  })

  it('keeps the original unpaid quote and frozen settings when funding selection is canceled', async () => {
    mocks.funding.mockRejectedValueOnce(new Error('Funding selection cancelled.'))
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/cancelled/)
    const saved = loadPayerDeployment(review.scope)!
    expect(saved.phase).toBe('quoted')
    expect(mocks.paymentSent).not.toHaveBeenCalled()
    const edited = { ...review, calls: [{ ...review.calls[0], memo: 'changed' }, review.calls[1]] }
    await expect(runPayerDeployments(edited, vi.fn(), flow)).rejects.toThrow(/previous payer deployment/)
    await runPayerDeployments(saved, vi.fn(), flow)
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.paymentSent).toHaveBeenCalledTimes(1)
  })

  it('never republishes a raw factory bundle when the original quote response was lost', async () => {
    mocks.post.mockRejectedValueOnce(new Error('Quote connection lost.'))
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/connection lost/)
    const saved = loadPayerDeployment(review.scope)!
    expect(saved.phase).toBe('publishing')
    await expect(runPayerDeployments(saved, vi.fn(), flow)).rejects.toThrow(/duplicate addresses/)
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
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/destination failed/)
    const saved = loadPayerDeployment(review.scope)!
    expect(saved.outcomes.map(outcome => outcome.state)).toEqual(['verified', 'ready'])
    expect(saved.paymentHash).toBe(PAYMENT_HASH)
    await runPayerDeployments(saved, vi.fn(), flow)
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.paymentSent).toHaveBeenCalledTimes(1)
    expect(loadPayerDeployment(review.scope)?.phase).toBe('complete')
  })

  it('persists the payment send window and never repays an ambiguous no-hash send', async () => {
    mocks.pay.mockImplementationOnce(async ({ payment, bundleUuid, onSending }: Parameters<typeof relayrPay>[0]) => {
      onSending?.(relayrPaymentDetails(payment, { bundleUuid, destinationChainIds: review.calls.map(call => call.chainId) }))
      expect(loadPayerDeployment(review.scope)?.phase).toBe('payment-sending')
      throw new Error('Wallet disconnected after send.')
    })
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/disconnected/)
    await runPayerDeployments(loadPayerDeployment(review.scope)!, vi.fn(), flow)
    expect(mocks.pay).toHaveBeenCalledTimes(1)
  })

  it('keeps a saved payment the chain shows to be another transaction pending, since raw calls carry no nonce or deadline to prove them dead', async () => {
    mocks.pay.mockImplementationOnce(async ({ payment, bundleUuid, destinationChainIds, onSending, onSent }: Parameters<typeof relayrPay>[0]) => {
      const details = relayrPaymentDetails(payment, { bundleUuid, destinationChainIds })
      onSending?.(details)
      onSent?.([sentRelayrPayment(details, PAYMENT_HASH)])
      throw new RelayrPaymentSubmittedError(PAYMENT_HASH, payment.chain)
    })
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toMatchObject({ name: 'RelayrPaymentSubmittedError' })
    const sent = loadPayerDeployment(review.scope)!.payments![0]
    // The SDK reads no signed request in them, so none can ever be dead.
    expect(relayrSignedRequests(loadPayerDeployment(review.scope)!.quote!.expectedTransactions!.map(binding => binding.entry))).toBeNull()
    // The funding chain holds a call to another contract under the saved hash.
    const transaction = mocks.getTransaction.getMockImplementation()!
    const receipt = mocks.getReceipt.getMockImplementation()!
    mocks.getTransaction.mockImplementation(async (chain: number, args: { hash: Hex }) => args.hash === PAYMENT_HASH
      ? { hash: PAYMENT_HASH, chainId: sent.chainId, from: ALICE, to: ADMIN, input: '0x', value: BigInt(sent.amount), blockHash: BLOCK, blockNumber: 100n }
      : transaction(chain, args))
    mocks.getReceipt.mockImplementation(async (chain: number, args: { hash: Hex }) => args.hash === PAYMENT_HASH
      ? { transactionHash: PAYMENT_HASH, to: ADMIN, blockHash: BLOCK, blockNumber: 100n, status: 'success' }
      : receipt(chain, args))
    for (let resume = 0; resume < 2; resume += 1) {
      await expect(runPayerDeployments(loadPayerDeployment(review.scope)!, vi.fn(), flow)).rejects.toMatchObject({ name: 'RelayrProofError' })
    }
    expect(loadPayerDeployment(review.scope)).toMatchObject({ phase: 'executing', payments: [expect.objectContaining({ hash: PAYMENT_HASH })] })
    expect(mocks.poll).not.toHaveBeenCalled()
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.pay).toHaveBeenCalledTimes(1)
  })

  it('stops before publication if browser storage cannot preserve the frozen review', async () => {
    storage.setItem.mockImplementation(() => { throw new Error('Storage blocked.') })
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/browser storage/)
    expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.paymentSent).not.toHaveBeenCalled()
  })

  it('refuses a quote that substituted another factory target', async () => {
    mocks.post.mockImplementationOnce(async (entries: RelayrEntry[]) => {
      const quote = quoteFor(entries)
      quote.expectedTransactions![0].entry = { ...entries[0], target: ADMIN }
      return quote
    })
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/changed a reviewed deployment/)
    expect(mocks.paymentSent).not.toHaveBeenCalled()
    expect(loadPayerDeployment(review.scope)?.phase).toBe('publishing')
  })

  it('keeps the returned payment hash in memory when its post-send storage write fails', async () => {
    const original = storage.setItem.getMockImplementation() as (key: string, value: string) => void
    storage.setItem.mockImplementation((key: string, value: string) => {
      if (key.includes('journal:') && JSON.parse(value).phase === 'executing') throw new Error('Storage filled up.')
      return original(key, value)
    })
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/browser storage/)
    const saved = loadPayerDeployment(review.scope)!
    expect(saved).toMatchObject({ phase: 'executing', paymentHash: PAYMENT_HASH })
    storage.setItem.mockImplementation(original)
    await runPayerDeployments(saved, vi.fn(), flow)
    expect(mocks.paymentSent).toHaveBeenCalledTimes(1)
    expect(mocks.pay).toHaveBeenCalledTimes(1)
  })

  it('keeps a saved deployment whose payment record is malformed pending', async () => {
    mocks.funding.mockRejectedValueOnce(new Error('Funding selection cancelled.'))
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/cancelled/)
    const key = `jb-payer-deploy-v1:journal:${review.id}`
    const saved = JSON.parse(window.localStorage.getItem(key)!)
    window.localStorage.setItem(key, JSON.stringify({ ...saved, payments: [{ hash: PAYMENT_HASH, chainId: 999 }] }))
    expect(() => loadPayerDeployment(review.scope)).toThrow('The saved payer payments are malformed. Keep it pending.')
  })

  it('uses a stable project action scope regardless of selection or input changes', () => {
    expect(payerDeploymentScope([[10, 84], [1, 42]])).toBe(payerDeploymentScope([[1, 42], [10, 84]]))
    expect(() => buildPayerDeploymentReview({ projects: [[1, 42]], selectedChainIds: [10], account: ALICE,
      beneficiary: BENEFICIARY, owner: ADMIN, memo: '', addToBalance: false })).toThrow(/linked project/)
  })

  it('blocks a stale quoted review after its original attempt was completed and archived', async () => {
    mocks.funding.mockRejectedValueOnce(new Error('Funding canceled.'))
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/canceled/)
    const stale = loadPayerDeployment(review.scope)!
    await runPayerDeployments(stale, vi.fn(), flow)
    await finishPayerDeployment(review.scope, review.id)
    await expect(runPayerDeployments(stale, vi.fn(), flow)).rejects.toThrow(/already completed/)
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.paymentSent).toHaveBeenCalledTimes(1)
  })

  it('finds an overlapping pending deployment through its selected project alias', async () => {
    review = makeReview([1])
    mocks.send.mockRejectedValueOnce(new Error('Wallet response lost.'))
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/response lost/)
    const overlapping = makeReview([1, 10])
    const update = vi.fn()
    await expect(runPayerDeployments(overlapping, update, flow)).rejects.toThrow(/previous payer deployment/)
    expect(loadPayerDeployment(overlapping.scope)?.id).toBe(review.id)
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: review.id }))
    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('locks shared destination projects even when discovery groups use different primary scopes', async () => {
    review = makeReview([1])
    let release!: (hash: Hex) => void
    mocks.send.mockImplementationOnce(() => new Promise<Hex>(resolve => { release = resolve }))
    const first = runPayerDeployments(review, vi.fn(), flow)
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1))
    await expect(runPayerDeployments(makeReview([1, 10]), vi.fn(), flow)).rejects.toThrow(/already being processed/)
    release(hashFor(1))
    await first
    expect(mocks.post).not.toHaveBeenCalled()
  })
})

describe('direct and Safe payer recovery', () => {
  it('preserves a legacy direct testnet review and resumes receipts without cloning a successful earlier chain again', async () => {
    review = { ...makeReview([11155111, 11155420]), transport: 'direct' }
    mocks.waitReceipt.mockRejectedValueOnce(new Error('Receipt unavailable.'))
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/unavailable/)
    expect(mocks.send).toHaveBeenCalledTimes(1)
    const saved = loadPayerDeployment(review.scope)!
    expect(saved.outcomes[0]).toMatchObject({ state: 'submitted', hash: hashFor(11155111) })
    await runPayerDeployments(saved, vi.fn(), flow)
    expect(mocks.send.mock.calls.map(args => args[0])).toEqual([11155111, 11155420])
    expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.paymentSent).not.toHaveBeenCalled()
  })

  it('keeps an ambiguous direct send pending and never advances to another chain', async () => {
    review = { ...makeReview([11155111, 11155420]), transport: 'direct' }
    mocks.send.mockRejectedValueOnce(new Error('Wallet send response lost.'))
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/response lost/)
    const saved = loadPayerDeployment(review.scope)!
    expect(saved.outcomes[0].state).toBe('sending')
    await expect(runPayerDeployments(saved, vi.fn(), flow)).rejects.toThrow(/without returning a hash/)
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
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/browser storage/)
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
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/browser storage/)
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
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/verified successful receipt/)
    const failed = loadPayerDeployment(review.scope)!
    expect(failed.outcomes[0]).toMatchObject({ state: 'failed', failedHashes: [hashFor(1)] })
    mocks.getBlock.mockResolvedValueOnce({ hash: PAYMENT_HASH })
    await expect(runPayerDeployments(failed, vi.fn(), flow)).rejects.toThrow(/revert is no longer canonical/)
    expect(mocks.send).toHaveBeenCalledTimes(1)
    mocks.send.mockImplementationOnce(async () => { reverted = false; currentHash = PAYMENT_HASH; return currentHash })
    const result = await runPayerDeployments(failed, vi.fn(), flow)
    expect(result.phase).toBe('complete')
    expect(result.outcomes[0]).toMatchObject({ hash: PAYMENT_HASH, failedHashes: [hashFor(1)] })
    expect(mocks.send).toHaveBeenCalledTimes(2)
  })

  it('tracks a Safe proposal hash separately and proves its exact factory execution before advancing', async () => {
    mocks.safe = true
    review = makeReview([1, 10])
    mocks.waitSafe.mockRejectedValueOnce(new Error('Safe confirmation pending.'))
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/Safe confirmation pending/)
    const saved = loadPayerDeployment(review.scope)!
    expect(saved.transport).toBe('safe')
    expect(saved.outcomes[0]).toMatchObject({ state: 'submitted', safeProposalHash: SAFE_PROPOSAL })
    expect(mocks.waitReceipt).not.toHaveBeenCalled()
    await runPayerDeployments(saved, vi.fn(), flow)
    expect(mocks.send.mock.calls.map(args => args[0])).toEqual([1, 10])
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it("looks for a Safe deployment's execution for a minute with the flow's signal, and says it is still pending when the look ends", async () => {
    mocks.safe = true
    review = makeReview([1, 10])
    const page = new AbortController()
    mocks.waitSafe.mockRejectedValueOnce(new DOMException('Safe execution wait aborted', 'AbortError'))
    await expect(runPayerDeployments(review, vi.fn(), page.signal)).rejects.toThrow(SAFE_PAYER_PENDING)
    expect(mocks.waitSafe).toHaveBeenCalledWith(1, SAFE_PROPOSAL, { signal: page.signal, lookMs: 60_000 })
    expect(loadPayerDeployment(review.scope)!.outcomes[0]).toMatchObject({ state: 'submitted', safeProposalHash: SAFE_PROPOSAL })
    expect(mocks.waitReceipt).not.toHaveBeenCalled()
  })

  it('ends a Safe deployment wait with its flow, leaving the deployment submitted', async () => {
    mocks.safe = true
    review = makeReview([1, 10])
    const page = new AbortController()
    mocks.waitSafe.mockImplementationOnce(async () => {
      page.abort()
      throw new DOMException('Safe execution wait aborted', 'AbortError')
    })
    await expect(runPayerDeployments(review, vi.fn(), page.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(loadPayerDeployment(review.scope)!.outcomes[0]).toMatchObject({ state: 'submitted', safeProposalHash: SAFE_PROPOSAL })
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })

  it('rejects a Safe service mapping to an identical factory call from another Safe proposal', async () => {
    mocks.safe = true
    review = makeReview([1, 10])
    mocks.getReceipt.mockImplementationOnce(async (chain: number) => {
      const wrong = receipt(chain)
      wrong.logs.at(-1)!.topics[1] = PAYMENT_HASH
      return wrong
    })
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/exact original Safe payer proposal/)
    expect(mocks.send).toHaveBeenCalledTimes(1)
    const saved = loadPayerDeployment(review.scope)!
    expect(saved.outcomes[0]).toMatchObject({ state: 'submitted', safeProposalHash: SAFE_PROPOSAL })
    await runPayerDeployments(saved, vi.fn(), flow)
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
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/does not host/)
    const saved = loadPayerDeployment(review.scope)!
    expect(saved.outcomes[0]).toMatchObject({ state: 'submitted', safeProposalHash: SAFE_PROPOSAL, fromBlock: '100' })
    expect(mocks.waitReceipt).not.toHaveBeenCalled()
    mocks.getBlockNumber.mockResolvedValue(200n)
    mocks.getLogs.mockResolvedValue([{
      address: ALICE, data: `0x${'00'.repeat(32)}`, transactionHash: hashFor(11155420),
      topics: [keccak256(stringToHex('ExecutionSuccess(bytes32,uint256)')), SAFE_PROPOSAL],
    }])
    const completed = await runPayerDeployments(saved, vi.fn(), flow)
    expect(completed.phase).toBe('complete')
    expect(completed.outcomes[0]).toMatchObject({ state: 'verified', hash: hashFor(11155420), safeProposalHash: SAFE_PROPOSAL, fromBlock: '100' })
    expect(mocks.getLogs).toHaveBeenLastCalledWith(11155420, { address: ALICE, fromBlock: 100n, toBlock: 200n })
    expect(mocks.waitSafe).toHaveBeenCalledTimes(1)
    expect(mocks.send).toHaveBeenCalledTimes(1)
  })

  it('reviews every direct deployment once with the fixed gas it sends', async () => {
    review = { ...makeReview([11155111, 11155420]), transport: 'direct' }
    const result = await runPayerDeployments(review, vi.fn(), flow)
    expect(result.phase).toBe('complete')
    expect(mocks.review).toHaveBeenCalledTimes(1)
    const reviewed = mocks.review.mock.calls[0][0]
    expect(reviewed.kind).toBe('transaction')
    expect(reviewed.calls).toEqual(review.calls.map(call =>
      expect.objectContaining({ chainId: call.chainId, to: JB_PROJECT_PAYER_DEPLOYER, data: call.data, gas: 1_000_000n })))
    expect(mocks.send.mock.calls.map(([chain, request]) => [chain, request.gas])).toEqual([
      [11155111, 1_000_000n],
      [11155420, 1_000_000n],
    ])
  })

  it('reviews each deployment a resumed attempt sends, with its fixed gas', async () => {
    review = { ...makeReview([11155111, 11155420]), transport: 'direct' }
    mocks.waitReceipt.mockRejectedValueOnce(new Error('Receipt unavailable.'))
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/unavailable/)
    expect(mocks.review).toHaveBeenCalledTimes(1)
    await runPayerDeployments(loadPayerDeployment(review.scope)!, vi.fn(), flow)
    expect(mocks.review).toHaveBeenCalledTimes(2)
    expect(mocks.review.mock.calls[1][0]).toMatchObject({
      title: 'Review payer deployment',
      calls: [expect.objectContaining({ chainId: 11155420, data: review.calls[1].data, gas: 1_000_000n })],
    })
    expect(mocks.send.mock.calls.map(([chain, request]) => [chain, request.gas])).toEqual([
      [11155111, 1_000_000n],
      [11155420, 1_000_000n],
    ])
  })

  it('proposes every Safe deployment after one review with Safe gas 0', async () => {
    mocks.safe = true
    review = makeReview([1, 10])
    await runPayerDeployments(review, vi.fn(), flow)
    expect(mocks.review).toHaveBeenCalledTimes(1)
    const reviewed = mocks.review.mock.calls[0][0]
    expect(reviewed).toMatchObject({ kind: 'transaction', confirmLabel: 'Agree & continue to Safe' })
    expect(reviewed.description.endsWith(` ${SAFE_NONCE_GUIDANCE}`)).toBe(true)
    for (const call of reviewed.calls) {
      expect(call.safeTxGas).toBe(0n)
      expect(call).not.toHaveProperty('gas')
    }
    // A Safe app signs the sent gas as safeTxGas.
    expect(mocks.send.mock.calls.map(([, request]) => request.gas)).toEqual([0n, 0n])
  })

  it('shows a relayed bundle’s raw calls without a gas the wallet never sends', async () => {
    await runPayerDeployments(review, vi.fn(), flow)
    const reviewed = mocks.review.mock.calls[0][0]
    expect(reviewed.kind).toBe('authorization')
    for (const call of reviewed.calls) {
      expect(call).not.toHaveProperty('gas')
      expect(call).not.toHaveProperty('safeTxGas')
    }
  })

  it('requires the reviewed wallet to remain connected before saving or sending', async () => {
    mocks.review.mockImplementationOnce(async () => { mocks.address = ADMIN })
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/wallet that reviewed/)
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
    await runPayerDeployments(review, vi.fn(), flow)
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
    await runPayerDeployments(old, vi.fn(), flow)
    await finishPayerDeployment(old.scope, old.id)
    review = makeReview([1])
    await runPayerDeployments(review, vi.fn(), flow)
    await expect(finishPayerDeployment(old.scope, old.id)).rejects.toThrow(/Resolve the existing/)
    expect(loadPayerDeployment(old.scope)?.id).toBe(review.id)
    expect(loadPayerDeployment(old.scope)?.archived).not.toBe(true)
  })

  it('rebuilds the exact deployment request from the frozen settings', () => {
    expect(payerDeploymentRequest(review.calls[1])).toMatchObject({ address: JB_PROJECT_PAYER_DEPLOYER,
      chainId: 10, args: [BigInt(projectId + 1), BENEFICIARY, 'Treasury support', '0x', false, ADMIN] })
  })
})

describe('paying a reverted payer quote again', () => {
  const SECOND_PAYMENT = `0x${'5c'.repeat(32)}` as Hex

  /** relayrPay that sends the payment and reports it reverted onchain. */
  const revertingPay = async ({ payment, bundleUuid, destinationChainIds, sent = [], onSending, onSent }: Parameters<typeof relayrPay>[0]) => {
    const details = relayrPaymentDetails(payment, { bundleUuid, destinationChainIds })
    onSending?.(details)
    mocks.paymentSent()
    onSent?.([...sent, sentRelayrPayment(details, PAYMENT_HASH)])
    throw new RelayrPaymentRevertedError('The Relayr funding transaction reverted onchain.', PAYMENT_HASH, payment.chain)
  }

  it('pays the same quote again on the same chain, naming every payment it sent', async () => {
    mocks.pay.mockImplementationOnce(revertingPay)
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow('The Relayr funding transaction reverted onchain.')
    const reverted = loadPayerDeployment(review.scope)!
    expect(reverted).toMatchObject({ phase: 'payment-reverted', paymentHash: PAYMENT_HASH,
      payments: [expect.objectContaining({ hash: PAYMENT_HASH, chainId: 10, bundleUuid: BUNDLE })] })
    const pay = mocks.pay.getMockImplementation()!
    let held: PayerDeploymentSession | null = null
    mocks.pay.mockImplementationOnce(async (options: Parameters<typeof relayrPay>[0]) => pay({ ...options,
      onSending: (details: RelayrPaymentDetails) => { options.onSending?.(details); held = loadPayerDeployment(review.scope) } }))
    const result = await runPayerDeployments(reverted, vi.fn(), flow)
    expect(result.phase).toBe('complete')
    expect(held).toMatchObject({ phase: 'payment-sending', payments: [expect.objectContaining({ hash: PAYMENT_HASH })] })
    expect(held!.paymentHash).toBeUndefined()
    expect(mocks.post).toHaveBeenCalledTimes(1)
    expect(mocks.funding).toHaveBeenCalledTimes(1)
    expect(mocks.pay).toHaveBeenCalledTimes(2)
    expect(mocks.pay.mock.calls[1][0]).toMatchObject({ payment: { chain: 10 }, bundleUuid: BUNDLE,
      sent: [expect.objectContaining({ hash: PAYMENT_HASH })] })
  })

  it('keeps a saved quote pending whose payment names a deadline its calldata does not pay until', async () => {
    mocks.pay.mockImplementationOnce(revertingPay)
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/reverted onchain/)
    const key = `jb-payer-deploy-v1:journal:${review.id}`
    const saved = JSON.parse(window.localStorage.getItem(key)!)
    window.localStorage.setItem(key, JSON.stringify({ ...saved, payments: [{ ...saved.payments[0], deadline: '1' }] }))
    expect(() => loadPayerDeployment(review.scope)).toThrow('The saved payer payments are malformed. Keep it pending.')
  })

  it('proves a quote another payment funded after its own payment reverted, and never pays it again', async () => {
    mocks.pay.mockImplementationOnce(revertingPay)
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/reverted onchain/)
    // Another payment funded the bundle, and Relayr ran it.
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ bundle_uuid: BUNDLE,
      payment_received: true, transactions: records() }), { status: 200 }))
    await expect(runPayerDeployments(loadPayerDeployment(review.scope)!, vi.fn(), flow)).resolves.toMatchObject({ phase: 'complete' })
    expect(mocks.pay).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(`https://api.relayr.ba5ed.com/v1/bundle/${BUNDLE}`, expect.objectContaining({ cache: 'no-store' }))
  })

  describe('once its quote expired (ruling R104)', () => {
    const WAITING = 'This Relayr quote expired after its payment reverted. A new quote needs its deadline final onchain and Relayr to report nothing ran; try again in a few minutes.'

    /**
     * The payment reverts, and its quote's deadline passes on the clock and,
     * `finalizedPast` seconds later, at the finalized block. Relayr reports
     * the bundle unpaid with every call pending.
     */
    async function expired(finalizedPast = 1) {
      mocks.pay.mockImplementationOnce(revertingPay)
      await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/reverted onchain/)
      const sent = loadPayerDeployment(review.scope)!.payments![0]
      const transaction = mocks.getTransaction.getMockImplementation()!
      const receipt = mocks.getReceipt.getMockImplementation()!
      mocks.getTransaction.mockImplementation(async (chain: number, args: { hash: Hex }) => args.hash === PAYMENT_HASH
        ? { hash: PAYMENT_HASH, chainId: 10, from: ALICE, to: sent.target, input: sent.calldata, value: BigInt(sent.amount),
          blockHash: BLOCK, blockNumber: 100n }
        : transaction(chain, args))
      mocks.getReceipt.mockImplementation(async (chain: number, args: { hash: Hex }) => args.hash === PAYMENT_HASH
        ? { transactionHash: PAYMENT_HASH, to: sent.target, blockHash: BLOCK, blockNumber: 100n, status: 'reverted' }
        : receipt(chain, args))
      vi.spyOn(Date, 'now').mockReturnValue((Number(sent.deadline) + 1) * 1_000)
      mocks.getBlock.mockImplementation(async (_chain: number, args?: { blockTag?: string }) => args?.blockTag === 'finalized'
        ? { number: 100n, hash: BLOCK, timestamp: BigInt(Number(sent.deadline) + finalizedPast) }
        : { hash: BLOCK })
      vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ bundle_uuid: BUNDLE, payment_received: false,
        transactions: records().map(({ status: _, ...record }) => ({ ...record, status: { state: 'Pending' } })) }), { status: 200 }))
    }

    it('quotes the same raw calls again once nothing can fund the reverted quote', async () => {
      await expired()
      await expect(runPayerDeployments(loadPayerDeployment(review.scope)!, vi.fn(), flow)).resolves.toMatchObject({ phase: 'complete' })
      expect(mocks.post).toHaveBeenCalledTimes(2)
      expect(mocks.post.mock.calls[1][0]).toEqual(mocks.post.mock.calls[0][0])
      expect(mocks.funding).toHaveBeenCalledTimes(2)
      expect(mocks.pay.mock.calls[1][0].sent).toEqual([])
    })

    it('keeps the quote when its saved options are not a list', async () => {
      await expired()
      const key = `jb-payer-deploy-v1:journal:${review.id}`
      const saved = JSON.parse(window.localStorage.getItem(key)!)
      window.localStorage.setItem(key, JSON.stringify({ ...saved, quote: { ...saved.quote, payment_info: {} } }))
      await expect(runPayerDeployments(loadPayerDeployment(review.scope)!, vi.fn(), flow)).rejects.toThrow(WAITING)
      expect(mocks.post).toHaveBeenCalledTimes(1)
      expect(mocks.pay).toHaveBeenCalledTimes(1)
    })

    it('keeps the quote while its deadline is not past the finalized block', async () => {
      await expired(0)
      await expect(runPayerDeployments(loadPayerDeployment(review.scope)!, vi.fn(), flow)).rejects.toThrow(WAITING)
      expect(loadPayerDeployment(review.scope)).toMatchObject({ phase: 'payment-reverted',
        payments: [expect.objectContaining({ hash: PAYMENT_HASH })] })
      expect(mocks.post).toHaveBeenCalledTimes(1)
      expect(mocks.pay).toHaveBeenCalledTimes(1)
    })
  })

  it('keeps a declined retry on the retry rule, never back to a fresh choice', async () => {
    mocks.pay.mockImplementationOnce(revertingPay)
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toThrow(/reverted onchain/)
    mocks.pay.mockImplementationOnce(async ({ payment, bundleUuid, destinationChainIds, onSending }: Parameters<typeof relayrPay>[0]) => {
      onSending?.(relayrPaymentDetails(payment, { bundleUuid, destinationChainIds }))
      throw Object.assign(new Error('User rejected'), { code: 4001 })
    })
    await expect(runPayerDeployments(loadPayerDeployment(review.scope)!, vi.fn(), flow)).rejects.toThrow('User rejected')
    expect(loadPayerDeployment(review.scope)).toMatchObject({ phase: 'payment-reverted',
      payments: [expect.objectContaining({ hash: PAYMENT_HASH })] })
    expect(mocks.funding).toHaveBeenCalledTimes(1)
  })

  it('finds a payment that reverted while the app was away, and pays again only on the retry rule', async () => {
    mocks.pay.mockImplementationOnce(async ({ payment, bundleUuid, destinationChainIds, onSending, onSent }: Parameters<typeof relayrPay>[0]) => {
      const details = relayrPaymentDetails(payment, { bundleUuid, destinationChainIds })
      onSending?.(details)
      onSent?.([sentRelayrPayment(details, PAYMENT_HASH)])
      throw new RelayrPaymentSubmittedError(PAYMENT_HASH, payment.chain)
    })
    await expect(runPayerDeployments(review, vi.fn(), flow)).rejects.toMatchObject({ name: 'RelayrPaymentSubmittedError' })
    expect(loadPayerDeployment(review.scope)?.phase).toBe('executing')
    // The funding chain holds the reviewed payment, reverted.
    const sent = loadPayerDeployment(review.scope)!.payments![0]
    const transaction = mocks.getTransaction.getMockImplementation()!
    const receipt = mocks.getReceipt.getMockImplementation()!
    const payment = { hash: PAYMENT_HASH, chainId: 10, from: ALICE, to: sent.target, input: sent.calldata, value: BigInt(sent.amount),
      blockHash: BLOCK, blockNumber: 100n }
    mocks.getTransaction.mockImplementation(async (chain: number, args: { hash: Hex }) => args.hash === PAYMENT_HASH ? payment : transaction(chain, args))
    mocks.getReceipt.mockImplementation(async (chain: number, args: { hash: Hex }) => args.hash === PAYMENT_HASH
      ? { transactionHash: PAYMENT_HASH, to: sent.target, blockHash: BLOCK, blockNumber: 100n, status: 'reverted' }
      : receipt(chain, args))
    await expect(runPayerDeployments(loadPayerDeployment(review.scope)!, vi.fn(), flow)).rejects.toMatchObject({ name: 'RelayrPaymentRevertedError' })
    expect(loadPayerDeployment(review.scope)?.phase).toBe('payment-reverted')
    expect(mocks.poll).not.toHaveBeenCalled()
    mocks.pay.mockImplementationOnce(async ({ payment: option, bundleUuid, destinationChainIds, sent: previous = [], onSending, onSent }: Parameters<typeof relayrPay>[0]) => {
      const details = relayrPaymentDetails(option, { bundleUuid, destinationChainIds })
      onSending?.(details)
      const payments = [...previous, sentRelayrPayment(details, SECOND_PAYMENT)]
      onSent?.(payments)
      return { hash: SECOND_PAYMENT, payments }
    })
    await expect(runPayerDeployments(loadPayerDeployment(review.scope)!, vi.fn(), flow)).resolves.toMatchObject({ phase: 'complete' })
    expect(mocks.pay.mock.calls[1][0].sent).toEqual([expect.objectContaining({ hash: PAYMENT_HASH })])
  })
})

it('shared raw lifecycle rechecks the owner before publishing and again before funding', async () => {
  const { runRawRelayrLifecycle } = await import('@/lib/raw-relayr-lifecycle')
  review = makeReview()
  const reverify = vi.fn().mockResolvedValue(undefined)
  mocks.post.mockImplementation(async (entries: RelayrEntry[]) => {
    expect(reverify).toHaveBeenCalledTimes(1)
    return quoteFor(entries)
  })
  mocks.paymentSent.mockImplementation(() => { expect(reverify).toHaveBeenCalledTimes(2) })
  await runRawRelayrLifecycle({ session: review,
    entries: review.calls.map(call => ({ chain: call.chainId, target: JB_PROJECT_PAYER_DEPLOYER, data: call.data, value: '0' })),
    saveState: vi.fn(), assertAccount: vi.fn(), reverify,
  })
  expect(reverify).toHaveBeenCalledTimes(2)
  expect(mocks.paymentSent).toHaveBeenCalledOnce()
})


describe('payer final wallet context', () => {
  for (const viaSafe of [false, true]) {
    it.each(['account', 'chain', 'connector', 'view-as', 'route'] as const)(`restores the ready intent after %s changes in ${viaSafe ? 'Safe' : 'direct'} persistence`, async drift => {
      mocks.safe = viaSafe
      review = makeReview([1])
      let changed = false
      const update = (session: PayerDeploymentSession) => {
        if (changed || session.outcomes[0].state !== 'sending') return
        changed = true
        if (drift === 'account') mocks.address = ADMIN
        if (drift === 'chain') mocks.chainId = 10
        if (drift === 'connector') mocks.connectorUid = 'wallet-b'
        if (drift === 'view-as') setViewAs(ADMIN)
        if (drift === 'route') mocks.safe = !viaSafe
      }
      try {
        await expect(runPayerDeployments(review, update, flow)).rejects.toThrow()
        expect(changed).toBe(true)
        expect(mocks.send).not.toHaveBeenCalled()
        const saved = loadPayerDeployment(review.scope)!
        expect(saved.outcomes[0].state).toBe('ready')
        mocks.address = ALICE; mocks.chainId = 1; mocks.connectorUid = 'wallet-a'; mocks.safe = viaSafe; clearViewAs()
        await expect(runPayerDeployments(saved, vi.fn(), flow)).resolves.toMatchObject({ phase: 'complete' })
        expect(mocks.send).toHaveBeenCalledExactlyOnceWith(1, expect.objectContaining({ chain: { id: 1 } }))
      } finally { clearViewAs() }
    })
  }
})
