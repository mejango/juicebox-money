import { JBCoreContracts, NATIVE_TOKEN, USDC_ADDRESSES, jbContractAddress, jbControllerAbi, jbMultiTerminalAbi, jbTokensAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { RESERVED_TOKEN_SPLIT_GROUP_ID } from '@bananapus/nana-sdk-core/v6'
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, zeroAddress, type Abi, type Address, type TransactionReceipt } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ clientFor: vi.fn(), current: vi.fn(), contexts: vi.fn(), token: vi.fn(), permission: vi.fn(), identity: vi.fn() }))
vi.mock('@/lib/authority', () => ({ clientFor: mocks.clientFor }))
vi.mock('@/lib/cross-chain-authority', () => ({ readAuthorityIdentity: mocks.identity }))
vi.mock('@/lib/token-symbol', () => ({ tokenSymbol: async () => 'USDC' }))
vi.mock('@bananapus/nana-sdk-core/v6', async original => ({ ...await original<typeof import('@bananapus/nana-sdk-core/v6')>(), getCurrentRuleset: mocks.current, getAccountingContexts: mocks.contexts, getTokenAddress: mocks.token, hasPermissions: mocks.permission }))

import { distributionCall, distributionProjects, matchingPayoutToken, readPayoutOptions, reviewPayout, reviewReserved, reverifyDistribution, verifyDistributionCompletion } from '@/lib/project-distributions'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const OTHER = '0x2222222222222222222222222222222222222222' as Address
const RECIPIENT = '0x3333333333333333333333333333333333333333' as Address
const projects = [{ chainId: 1 as JBChainId, projectId: 17 }, { chainId: 8453 as JBChainId, projectId: 303 }]
const state = new Map<number, {
  owner: Address; id: number; cycle: number; ownerOnly: boolean; pending: bigint; balance: bigint; limit: bigint; used: bigint; quote: bigint; recipient: Address; registered: boolean
}>()
const reads = new Map<number, ReturnType<typeof vi.fn>>()
const simulations = new Map<number, ReturnType<typeof vi.fn>>()

function eventLog(abi: Abi, name: string, address: Address, args: Record<string, unknown>): TransactionReceipt['logs'][number] {
  const event = abi.find(item => item.type === 'event' && item.name === name)
  if (!event || event.type !== 'event') throw new Error(`Missing event ${name}`)
  const inputs = event.inputs.filter(input => !input.indexed)
  return { address, topics: encodeEventTopics({ abi: [event], eventName: name, args }), data: encodeAbiParameters(inputs, inputs.map(input => args[input.name!])) } as TransactionReceipt['logs'][number]
}
const receipt = (logs: TransactionReceipt['logs']) => ({ status: 'success', logs }) as TransactionReceipt

beforeEach(() => {
  state.clear(); reads.clear(); simulations.clear()
  mocks.identity.mockResolvedValue({ kind: 'eoa' })
  mocks.permission.mockResolvedValue(false)
  mocks.token.mockResolvedValue(OTHER)
  for (const project of projects) {
    const chain = project.chainId
    state.set(chain, { owner: ACCOUNT, id: chain === 1 ? 51 : 79, cycle: 6, ownerOnly: false, pending: 100n * 10n ** 18n, balance: 30_000_000n, limit: 100_000_000n, used: 3_000_000n, quote: 12_000_000n, recipient: RECIPIENT, registered: true })
    reads.set(chain, vi.fn(async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      const value = state.get(chain)!
      if (functionName === 'ownerOf') return value.owner
      if (functionName === 'controllerOf') return jbContractAddress['6'][JBCoreContracts.JBController][chain]
      if (functionName === 'terminalsOf') return value.registered ? [jbContractAddress['6'][JBCoreContracts.JBMultiTerminal][chain]] : []
      if (functionName === 'balanceOf') return value.balance
      if (functionName === 'pendingReservedTokenBalanceOf') { expect(args[0]).toBe(BigInt(project.projectId)); return value.pending }
      if (functionName === 'payoutLimitsOf') { expect(args[0]).toBe(BigInt(project.projectId)); expect(args[1]).toBe(BigInt(value.id)); return [{ amount: value.limit, currency: 2 }] }
      if (functionName === 'usedPayoutLimitOf') { expect(args[3]).toBe(BigInt(value.cycle)); return value.used }
      if (functionName === 'splitsOf') { expect(args[0]).toBe(BigInt(project.projectId)); expect(args[1]).toBe(BigInt(value.id)); return [{ percent: 500_000_000, projectId: 0n, beneficiary: value.recipient, lockedUntil: 0, hook: zeroAddress, preferAddToBalance: false }] }
      throw new Error(`Unexpected read ${functionName}`)
    }))
    simulations.set(chain, vi.fn(async () => encodeFunctionResult({ abi: jbMultiTerminalAbi, functionName: 'sendPayoutsOf', result: state.get(chain)!.quote })))
  }
  mocks.clientFor.mockImplementation(chain => ({ readContract: reads.get(chain), request: simulations.get(chain) }))
  mocks.current.mockImplementation(async (_client, { chainId }) => {
    const value = state.get(chainId)!
    return { ruleset: { id: value.id, cycleNumber: value.cycle }, metadata: { ownerMustSendPayouts: value.ownerOnly, holdFees: false } }
  })
  mocks.contexts.mockImplementation(async (_client, { chainId }) => [{ token: USDC_ADDRESSES[chainId as JBChainId], currency: 2, decimals: 6 }])
})

describe('selected destination distributions', () => {
  it('only preselects verified native/USDC mappings and rejects conflicting linked project IDs', () => {
    expect(matchingPayoutToken(NATIVE_TOKEN, 1, 8453)).toBe(NATIVE_TOKEN)
    expect(matchingPayoutToken(USDC_ADDRESSES[1], 1, 8453)).toBe(USDC_ADDRESSES[8453])
    expect(matchingPayoutToken(OTHER, 1, 8453)).toBeNull()
    expect(distributionProjects(1, 17, [[8453, 303]])).toEqual(projects)
    expect(() => distributionProjects(1, 17, [[1, 303]])).toThrow('Conflicting')
  })

  it('wallet-action:distribute-payouts reads each payout token, ruleset, cycle and balance from its own deployment and encodes six-decimal units', async () => {
    for (const project of projects) {
      const options = await readPayoutOptions(project)
      expect(options.contexts[0]).toMatchObject({ decimals: 6, token: USDC_ADDRESSES[project.chainId], balance: 30_000_000n, limits: [{ remaining: 97_000_000n }] })
      const review = await reviewPayout(project, USDC_ADDRESSES[project.chainId], 12_000_000n, 2, ACCOUNT)
      expect(review).toMatchObject({ quote: 12_000_000n, min: 12_000_000n })
      const call = distributionCall(review)
      expect(call.target).toBe(options.terminal)
      expect(decodeFunctionData({ abi: jbMultiTerminalAbi, data: call.data }).args).toEqual([BigInt(project.projectId), USDC_ADDRESSES[project.chainId], 12_000_000n, 2n, 12_000_000n])
      expect(simulations.get(project.chainId)).toHaveBeenCalledWith(expect.objectContaining({ method: 'eth_call' }))
    }
  })

  it('requires a registered terminal and a live payout permission when owner-only distribution is enabled', async () => {
    const value = state.get(8453)!
    value.registered = false
    await expect(readPayoutOptions(projects[1])).rejects.toThrow('terminal')
    value.registered = true; value.owner = OTHER; value.ownerOnly = true
    await expect(reviewPayout(projects[1], USDC_ADDRESSES[8453], 12_000_000n, 2, ACCOUNT)).rejects.toThrow('authorized payout operator')
    mocks.permission.mockResolvedValue(true)
    await expect(reviewPayout(projects[1], USDC_ADDRESSES[8453], 12_000_000n, 2, ACCOUNT)).resolves.toMatchObject({ authority: ACCOUNT })
    mocks.permission.mockResolvedValue(false)
    mocks.identity.mockResolvedValue({ kind: 'safe', owners: [ACCOUNT] })
    await expect(reviewPayout(projects[1], USDC_ADDRESSES[8453], 12_000_000n, 2, ACCOUNT)).resolves.toMatchObject({ authority: OTHER })
  })

  it('freezes the reviewed minimum and revalidates recipients, current ruleset, remaining limit and quote', async () => {
    const review = await reviewPayout(projects[1], USDC_ADDRESSES[8453], 12_000_000n, 2, ACCOUNT)
    const originalData = distributionCall(review).data
    const value = state.get(8453)!
    value.recipient = OTHER
    await expect(reverifyDistribution(review, ACCOUNT)).rejects.toThrow('recipients changed')
    value.recipient = RECIPIENT; value.id++
    await expect(reverifyDistribution(review, ACCOUNT)).rejects.toThrow('rules')
    value.id--; value.used = 99_000_000n
    await expect(reverifyDistribution(review, ACCOUNT)).rejects.toThrow('remaining payout limit')
    value.used = 3_000_000n; value.quote = 11_000_000n
    await expect(reverifyDistribution(review, ACCOUNT)).rejects.toThrow('minimum')
    expect(distributionCall(review).data).toBe(originalData)
  })

  it('allows only the reviewed 1% minimum when a payout needs currency conversion', async () => {
    mocks.contexts.mockImplementation(async (_client, { chainId }) => [{ token: USDC_ADDRESSES[chainId as JBChainId], currency: 9, decimals: 6 }])
    const review = await reviewPayout(projects[1], USDC_ADDRESSES[8453], 12_000_000n, 2, ACCOUNT)
    expect(review.min).toBe(11_880_000n)
    state.get(8453)!.quote = 11_900_000n
    await expect(reverifyDistribution(review, ACCOUNT)).resolves.toBeUndefined()
    expect(distributionCall(review).data).toBe(distributionCall({ ...review, min: 11_880_000n }).data)
  })

  it('wallet-action:distribute-reserved-tokens distributes each reserved balance using that chain’s controller, current ruleset and recipients', async () => {
    for (const project of projects) {
      const review = await reviewReserved(project, ACCOUNT)
      expect(review.current.ruleset.id).toBe(state.get(project.chainId)!.id)
      const call = distributionCall(review)
      expect(call.target).toBe(jbContractAddress['6'][JBCoreContracts.JBController][project.chainId])
      expect(decodeFunctionData({ abi: jbControllerAbi, data: call.data }).args).toEqual([BigInt(project.projectId)])
      expect(reads.get(project.chainId)).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'splitsOf', args: [BigInt(project.projectId), BigInt(review.current.ruleset.id), RESERVED_TOKEN_SPLIT_GROUP_ID] }))
    }
  })

  it('blocks fresh reserved submissions when the pending amount or recipient set drifts', async () => {
    const review = await reviewReserved(projects[1], ACCOUNT)
    state.get(8453)!.pending += 1n
    await expect(reverifyDistribution(review, ACCOUNT)).rejects.toThrow('pending reserved amount changed')
    state.get(8453)!.pending = review.pending
    state.get(8453)!.recipient = OTHER
    await expect(reverifyDistribution(review, ACCOUNT)).rejects.toThrow('recipients changed')
  })

  // The SDK's tests prove each receipt rule; these prove this app hands it the
  // reviewed distribution: its splits, ruleset, owner, sender and amounts.
  const payoutReceipt = async () => {
    const review = await reviewPayout(projects[1], USDC_ADDRESSES[8453], 12_000_000n, 2, ACCOUNT)
    const split = eventLog(jbMultiTerminalAbi, 'SendPayoutToSplit', review.terminal, { projectId: 303n, rulesetId: 79n, group: BigInt(USDC_ADDRESSES[8453]), split: review.splits[0], amount: 6_000_000n, netAmount: 5_850_000n, caller: ACCOUNT })
    const total = eventLog(jbMultiTerminalAbi, 'SendPayouts', review.terminal, { rulesetId: 79n, rulesetCycleNumber: 6n, projectId: 303n, projectOwner: ACCOUNT, amount: 12_000_000n, amountPaidOut: 12_000_000n, fee: 300_000n, netLeftoverPayoutAmount: 5_850_000n, caller: ACCOUNT })
    return { review, split, total }
  }
  const reservedReceipt = async () => {
    const review = await reviewReserved(projects[1], ACCOUNT)
    const split = eventLog(jbControllerAbi, 'SendReservedTokensToSplit', review.controller, { projectId: 303n, rulesetId: 79n, groupId: RESERVED_TOKEN_SPLIT_GROUP_ID, split: review.splits[0], tokenCount: review.pending / 2n, caller: ACCOUNT })
    const total = eventLog(jbControllerAbi, 'SendReservedTokensToSplits', review.controller, { rulesetId: 79n, rulesetCycleNumber: 6n, projectId: 303n, owner: ACCOUNT, tokenCount: review.pending, leftoverAmount: review.pending / 2n, caller: ACCOUNT })
    return { review, split, total }
  }

  it('proves a payout from its receipt, and refuses one missing a split’s event', async () => {
    const { review, split, total } = await payoutReceipt()
    expect(() => verifyDistributionCompletion(review, receipt([split, total]))).not.toThrow()
    expect(() => verifyDistributionCompletion(review, receipt([total]))).toThrow("Base: Project 303's payouts")
    expect(() => verifyDistributionCompletion(review, receipt([total]))).toThrow('the receipt pays 0 splits, not the reviewed 1')
    expect(() => verifyDistributionCompletion(review, receipt([]))).toThrow('0 SendPayouts events')
  })

  it('refuses a payout receipt with a recipient failure or a log of the terminal it cannot read', async () => {
    const { review, split, total } = await payoutReceipt()
    const failed = eventLog(jbMultiTerminalAbi, 'PayoutReverted', review.terminal, { projectId: 303n, split: review.splits[0], amount: 6_000_000n, reason: '0x', caller: ACCOUNT })
    expect(() => verifyDistributionCompletion(review, receipt([failed, split, total]))).toThrow('a recipient failed (PayoutReverted)')
    // Another contract's failure is not this distribution's.
    expect(() => verifyDistributionCompletion(review, receipt([{ ...failed, address: OTHER }, split, total]))).not.toThrow()
    const unreadable = { ...total, topics: [`0x${'99'.repeat(32)}`] } as TransactionReceipt['logs'][number]
    expect(() => verifyDistributionCompletion(review, receipt([unreadable, split, total]))).toThrow('its ABI cannot read')
  })

  it('detects hook underconsumption, including fee-free partial pulls smaller than the ordinary fee', async () => {
    const { review, total } = await payoutReceipt()
    review.hookFeeless[OTHER.toLowerCase()] = true
    const hooked = { ...review, splits: [{ ...review.splits[0], hook: OTHER }] }
    const partial = eventLog(jbMultiTerminalAbi, 'SendPayoutToSplit', review.terminal, { projectId: 303n, rulesetId: 79n, group: BigInt(USDC_ADDRESSES[8453]), split: hooked.splits[0], amount: 6_000_000n, netAmount: 5_990_000n, caller: ACCOUNT })
    expect(() => verifyDistributionCompletion(hooked, receipt([partial, total]))).toThrow('received 5,990,000 of its 6,000,000')
  })

  it('proves reserved tokens from their receipt, and refuses one missing a split’s event, a failure or an unconsumed burn', async () => {
    const { review, split, total } = await reservedReceipt()
    expect(() => verifyDistributionCompletion(review, receipt([split, total]))).not.toThrow()
    expect(() => verifyDistributionCompletion(review, receipt([total]))).toThrow('the receipt sends to 0 splits, not the reviewed 1')
    const failed = eventLog(jbControllerAbi, 'ReservedDistributionReverted', review.controller, { projectId: 303n, split: review.splits[0], tokenCount: review.pending / 2n, reason: '0x', caller: ACCOUNT })
    expect(() => verifyDistributionCompletion(review, receipt([split, total, failed]))).toThrow('a recipient failed (ReservedDistributionReverted)')
    const burned = eventLog(jbTokensAbi, 'Burn', jbContractAddress['6'][JBCoreContracts.JBTokens][8453], { holder: review.controller, projectId: 303n, count: 1n, creditBalance: 0n, tokenBalance: 0n, caller: review.controller })
    expect(() => verifyDistributionCompletion(review, receipt([burned, split, total]))).toThrow('a hook did not take its share')
  })
})
