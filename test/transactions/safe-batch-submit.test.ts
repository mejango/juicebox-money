import { zeroAddress, type Address, type Hex } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  account: undefined as Address | undefined,
  client: {
    getCode: vi.fn(),
    simulateCalls: vi.fn(),
    readContract: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
  },
  wallet: { signTypedData: vi.fn() },
  getAccount: vi.fn(),
  connectedWallet: vi.fn(),
  requireReview: vi.fn(),
  runAuthorityCalls: vi.fn(),
  readAuthorityIdentity: vi.fn(),
  readSafeNonce: vi.fn(),
  isSafeConnection: vi.fn(),
  waitForSafeExecutionHash: vi.fn(),
  waitForTrackedReceipt: vi.fn(),
  sendCalls: vi.fn(),
  simulate: vi.fn(),
}))

vi.mock('@wagmi/core', () => ({ getAccount: mocks.getAccount }))
vi.mock('wagmi/actions', () => ({
  getAccount: mocks.getAccount,
  sendCalls: mocks.sendCalls,
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: { tag: 'config' } }))
vi.mock('@/lib/wallet-core', () => ({
  publicClient: () => mocks.client,
  connectedWallet: mocks.connectedWallet,
}))
vi.mock('@/lib/authority', () => ({
  clientFor: () => mocks.client,
  runAuthorityCalls: mocks.runAuthorityCalls,
}))
vi.mock('@/lib/transaction-review', () => ({
  requireTransactionReview: mocks.requireReview,
  requireContractTransactionReview: mocks.requireReview,
}))
vi.mock('@/lib/cross-chain-authority', async original => ({
  ...(await original<typeof import('@/lib/cross-chain-authority')>()),
  readAuthorityIdentity: mocks.readAuthorityIdentity,
}))
vi.mock('@/lib/safe-reads', async original => ({
  ...(await original<typeof import('@/lib/safe-reads')>()),
  readBoundedSafeNonce: mocks.readSafeNonce,
}))
vi.mock('@/lib/safe-connector', async original => ({
  ...(await original<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: mocks.isSafeConnection,
  waitForSafeExecutionHash: mocks.waitForSafeExecutionHash,
}))
vi.mock('@/lib/receipt', () => ({ waitForTrackedReceipt: mocks.waitForTrackedReceipt }))
vi.mock('@/lib/transaction-simulation', () => ({
  TRANSACTION_SIMULATION_GAS: 10_000_000n,
  simulateStateChangingTransaction: mocks.simulate,
}))

import {
  buildStep,
  composeBatch,
  encodeMultiSend,
  MULTI_SEND_CALL_ONLY,
  packMultiSend,
  type BatchStep,
} from '@/lib/safe-batch'
import {
  authorityCallForStep,
  batchActionLabel,
  resolveSafeBatchRoute,
  submitSafeBatch,
} from '@/lib/safe-batch-submit'
import { safeTxHashOf } from '@/lib/safe'

const SAFE = '0x1111111111111111111111111111111111111111' as Address
const ALICE = '0x2222222222222222222222222222222222222222' as Address
const BOB = '0x3333333333333333333333333333333333333333' as Address
const HOOK = '0xB222Da5A71e8FB89a5A38b7c920EaB5DfbC74B91' as Address
const TERMINAL = '0x4a56AEf5b6A5b9742AbB02cA67C5a85ba183D901' as Address
const NATIVE = '0x000000000000000000000000000000000000EEEe' as Address
const REGISTRY = '0x72F55a54CD53410a5Ff175508a5A384227081788' as Address
const PROPOSAL = `0x${'ab'.repeat(32)}` as Hex
const EXECUTION = `0x${'cd'.repeat(32)}` as Hex
const SIGNATURE = `0x${'11'.repeat(65)}` as Hex

function safeIdentity(owners = [ALICE], threshold = 1) {
  return {
    kind: 'safe' as const,
    owners,
    threshold,
    ownersAreEoas: true,
    hasModules: false,
    proxyCodeHash: PROPOSAL,
    singleton: BOB,
    singletonCodeHash: PROPOSAL,
    version: '1.3.0',
    guard: zeroAddress,
    fallbackHandler: zeroAddress,
    fallbackHandlerCodeHash: null,
  }
}

function presetSteps(): BatchStep[] {
  return [
    buildStep({ kind: 'setHookFor', chainId: 1, projectId: 2, values: { hook: HOOK } }),
    buildStep({
      kind: 'setPoolFor',
      chainId: 1,
      projectId: 2,
      values: { fee: 10_000, tickSpacing: 200, twapWindow: 1800n, terminalToken: NATIVE },
    }),
    buildStep({ kind: 'setTerminalFor', chainId: 1, projectId: 2, values: { terminal: TERMINAL } }),
  ]
}

beforeEach(() => {
  mocks.account = ALICE
  mocks.getAccount.mockImplementation(() => ({ address: mocks.account, chainId: 1 }))
  mocks.connectedWallet.mockImplementation(async () => ({
    wallet: mocks.wallet,
    account: mocks.account,
  }))
  mocks.requireReview.mockResolvedValue(undefined)
  mocks.readAuthorityIdentity.mockResolvedValue(safeIdentity())
  mocks.readSafeNonce.mockResolvedValue(7n)
  mocks.isSafeConnection.mockReturnValue(false)
  mocks.client.getCode.mockResolvedValue('0x6000')
  mocks.client.simulateCalls.mockImplementation(async ({ calls }: { calls: unknown[] }) => ({
    results: calls.map(() => ({ status: 'success', data: '0x', gasUsed: 1n })),
  }))
  mocks.simulate.mockResolvedValue('0x')
  mocks.wallet.signTypedData.mockResolvedValue(SIGNATURE)
  mocks.waitForSafeExecutionHash.mockResolvedValue(EXECUTION)
  mocks.waitForTrackedReceipt.mockResolvedValue({ status: 'success' })
  mocks.sendCalls.mockResolvedValue({ id: PROPOSAL })
  mocks.runAuthorityCalls.mockImplementation(async ({ calls }: { calls: { data: Hex }[] }) => ({
    directResults: calls.map(call => `0x${call.data.slice(2, 10).padEnd(64, '0')}` as Hex),
    relayrGroups: 0,
    relayrResults: [],
    safeResults: [],
  }))
})

describe('batch route', () => {
  it('routes a Safe app connected as the authority to one MultiSend proposal', async () => {
    mocks.account = SAFE
    mocks.isSafeConnection.mockReturnValue(true)
    const route = await resolveSafeBatchRoute({ chainId: 1, authority: SAFE })
    expect(route).toEqual({ kind: 'safe-app', authorityKind: 'safe' })
    expect(batchActionLabel(route, 3)).toBe('Propose batch to Safe')
  })

  it('routes a Safe owner to an operation-1 SafeTx and refuses strangers', async () => {
    expect(await resolveSafeBatchRoute({ chainId: 1, authority: SAFE })).toEqual({
      kind: 'safe-owner',
      authorityKind: 'safe',
    })
    mocks.account = BOB
    const stranger = await resolveSafeBatchRoute({ chainId: 1, authority: SAFE })
    expect(stranger).toMatchObject({ kind: 'unavailable', authorityKind: 'safe' })
    expect(stranger.kind === 'unavailable' && stranger.reason).toMatch(/not a signer/)
  })

  it('routes the authority EOA to sequential sends and refuses another EOA', async () => {
    mocks.readAuthorityIdentity.mockResolvedValue({ kind: 'eoa' })
    const route = await resolveSafeBatchRoute({ chainId: 1, authority: ALICE })
    expect(route).toEqual({ kind: 'eoa', authorityKind: 'eoa' })
    expect(batchActionLabel(route, 3)).toBe('Send 3 transactions')
    expect(batchActionLabel(route, 1)).toBe('Send 1 transaction')
    mocks.account = BOB
    expect(await resolveSafeBatchRoute({ chainId: 1, authority: ALICE })).toMatchObject({
      kind: 'unavailable',
      reason: expect.stringMatching(/Switch to/),
    })
    mocks.readAuthorityIdentity.mockResolvedValue({ kind: 'contract' })
    expect(await resolveSafeBatchRoute({ chainId: 1, authority: ALICE })).toMatchObject({
      kind: 'unavailable',
      authorityKind: 'contract',
    })
  })
})

describe('Safe owner batch', () => {
  it('proposes one operation-1 MultiSendCallOnly SafeTx with the exact hash and body', async () => {
    const steps = presetSteps()
    const { calls } = composeBatch(steps)
    const data = encodeMultiSend(calls)
    const posted: Array<{ url: string; body: Record<string, unknown> }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (init?.method === 'POST') {
          posted.push({ url, body: JSON.parse(String(init.body)) })
          return new Response('{}', { status: 201 })
        }
        if (url.includes('multisig-transactions')) {
          return new Response(JSON.stringify({ results: [], next: null }), { status: 200 })
        }
        return new Response(JSON.stringify({ nonce: 7 }), { status: 200 })
      }),
    )
    const onProposed = vi.fn()

    const outcome = await submitSafeBatch({
      chainId: 1,
      authority: SAFE,
      steps,
      route: { kind: 'safe-owner', authorityKind: 'safe' },
      onProposed,
    })

    const expectedHash = safeTxHashOf(1, SAFE, {
      to: MULTI_SEND_CALL_ONLY,
      value: '0',
      data,
      operation: 1,
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      gasToken: zeroAddress,
      refundReceiver: zeroAddress,
      nonce: 7,
    })
    expect(posted).toHaveLength(1)
    expect(posted[0].url).toContain(`/api/v1/safes/${SAFE}/multisig-transactions/`)
    expect(posted[0].body).toMatchObject({
      to: MULTI_SEND_CALL_ONLY,
      value: '0',
      data,
      operation: 1,
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      gasToken: zeroAddress,
      refundReceiver: zeroAddress,
      nonce: '7',
      contractTransactionHash: expectedHash,
      sender: ALICE,
      signature: SIGNATURE,
    })
    expect(outcome).toEqual({
      kind: 'safe-owner',
      result: { chainId: 1, mode: 'service', status: 'queued', nonce: 7, safeTxHash: expectedHash },
    })
    expect(onProposed).toHaveBeenCalledWith(expectedHash)
    // The EIP-712 message signed carries operation 1, and the review showed the packed calls.
    expect(mocks.wallet.signTypedData).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ to: MULTI_SEND_CALL_ONLY, operation: 1, data }),
      }),
    )
    expect(mocks.requireReview).toHaveBeenCalledWith(
      expect.objectContaining({
        calls: [
          expect.objectContaining({
            to: MULTI_SEND_CALL_ONLY,
            data,
            functionName: 'multiSend',
            args: [packMultiSend(calls)],
            label: 'Batch (3 calls)',
          }),
        ],
      }),
    )
    // The sequence was simulated from the Safe before any signature.
    expect(mocks.client.simulateCalls).toHaveBeenCalledWith({ account: SAFE, calls })
    expect(mocks.client.getCode).toHaveBeenCalledWith({ address: MULTI_SEND_CALL_ONLY })
    expect(mocks.sendCalls).not.toHaveBeenCalled()
  })

  it('refuses a chain where MultiSendCallOnly has no code, before any signature', async () => {
    mocks.client.getCode.mockResolvedValue('0x')
    await expect(
      submitSafeBatch({
        chainId: 1,
        authority: SAFE,
        steps: presetSteps(),
        route: { kind: 'safe-owner', authorityKind: 'safe' },
      }),
    ).rejects.toThrow(/MultiSendCallOnly is not deployed on Ethereum/)
    expect(mocks.wallet.signTypedData).not.toHaveBeenCalled()
    expect(mocks.requireReview).not.toHaveBeenCalled()
  })

  it('stops on a failing sequence simulation and names the step', async () => {
    mocks.client.simulateCalls.mockResolvedValue({
      results: [
        { status: 'success', data: '0x', gasUsed: 1n },
        { status: 'failure', error: new Error('PoolAlreadySet()'), data: '0x', gasUsed: 1n },
        { status: 'success', data: '0x', gasUsed: 1n },
      ],
    })
    await expect(
      submitSafeBatch({
        chainId: 1,
        authority: SAFE,
        steps: presetSteps(),
        route: { kind: 'safe-owner', authorityKind: 'safe' },
      }),
    ).rejects.toThrow(/Register buyback pool cannot run on Ethereum: PoolAlreadySet/)
    expect(mocks.requireReview).not.toHaveBeenCalled()
  })

  it('falls back to per-call simulation, skipping steps that depend on an earlier one', async () => {
    mocks.client.simulateCalls.mockRejectedValue(new Error('Method not found'))
    mocks.client.getCode.mockResolvedValue('0x')
    await expect(
      submitSafeBatch({
        chainId: 1,
        authority: SAFE,
        steps: presetSteps(),
        route: { kind: 'safe-owner', authorityKind: 'safe' },
      }),
    ).rejects.toThrow(/MultiSendCallOnly/)
    const simulated = mocks.simulate.mock.calls.map(([, tx]) => tx.data.slice(0, 10))
    expect(simulated).toEqual(['0x779b0290', '0xf3e37d01'])
  })

  it('refuses a mis-ordered batch and a batch of nothing', async () => {
    const steps = presetSteps()
    await expect(
      submitSafeBatch({
        chainId: 1,
        authority: SAFE,
        steps: [steps[1], steps[0]],
        route: { kind: 'safe-owner', authorityKind: 'safe' },
      }),
    ).rejects.toThrow(/Set the buyback hook before/)
    await expect(
      submitSafeBatch({
        chainId: 1,
        authority: SAFE,
        steps: [],
        route: { kind: 'safe-owner', authorityKind: 'safe' },
      }),
    ).rejects.toThrow(/at least one step/)
    await expect(
      submitSafeBatch({
        chainId: 1,
        authority: SAFE,
        steps,
        route: { kind: 'unavailable', authorityKind: 'safe', reason: 'Not a signer.' },
      }),
    ).rejects.toThrow('Not a signer.')
    expect(mocks.client.simulateCalls).not.toHaveBeenCalled()
  })
})

describe('Safe app batch', () => {
  it('reviews the calls, sends one wallet_sendCalls batch and tracks the proposal to execution', async () => {
    mocks.account = SAFE
    mocks.isSafeConnection.mockReturnValue(true)
    const steps = presetSteps()
    const { calls } = composeBatch(steps)
    const onProposed = vi.fn()

    const outcome = await submitSafeBatch({
      chainId: 1,
      authority: SAFE,
      steps,
      route: { kind: 'safe-app', authorityKind: 'safe' },
      onProposed,
    })

    expect(mocks.requireReview).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        title: 'Review batch on Ethereum',
        confirmLabel: 'Agree & propose to Safe',
        calls: steps.map(step =>
          expect.objectContaining({
            chainId: 1,
            from: SAFE,
            to: step.to,
            data: step.data,
            functionName: step.functionName,
          }),
        ),
      }),
    )
    expect(mocks.connectedWallet).toHaveBeenCalledWith(1, expect.objectContaining({ expected: SAFE }))
    expect(mocks.sendCalls).toHaveBeenCalledExactlyOnceWith(
      { tag: 'config' },
      { chainId: 1, calls },
    )
    expect(onProposed).toHaveBeenCalledWith(PROPOSAL)
    expect(mocks.waitForSafeExecutionHash).toHaveBeenCalledWith(1, PROPOSAL)
    expect(mocks.waitForTrackedReceipt).toHaveBeenCalledWith(mocks.client, EXECUTION)
    expect(outcome).toEqual({ kind: 'safe-app', safeTxHash: PROPOSAL, executionHash: EXECUTION })
    expect(mocks.wallet.signTypedData).not.toHaveBeenCalled()
  })

  it('does not send when the review is refused or the wallet returns no hash', async () => {
    mocks.account = SAFE
    mocks.isSafeConnection.mockReturnValue(true)
    mocks.requireReview.mockRejectedValueOnce(new Error('Review cancelled.'))
    await expect(
      submitSafeBatch({
        chainId: 1,
        authority: SAFE,
        steps: presetSteps(),
        route: { kind: 'safe-app', authorityKind: 'safe' },
      }),
    ).rejects.toThrow('Review cancelled.')
    expect(mocks.sendCalls).not.toHaveBeenCalled()

    mocks.sendCalls.mockResolvedValueOnce({ id: 'not-a-hash' })
    await expect(
      submitSafeBatch({
        chainId: 1,
        authority: SAFE,
        steps: presetSteps(),
        route: { kind: 'safe-app', authorityKind: 'safe' },
      }),
    ).rejects.toThrow(/did not return a proposal hash/)
    expect(mocks.waitForSafeExecutionHash).not.toHaveBeenCalled()
  })
})

describe('EOA batch', () => {
  it('sends each step through the reviewed authority path in order', async () => {
    mocks.readAuthorityIdentity.mockResolvedValue({ kind: 'eoa' })
    const steps = presetSteps()
    const onStep = vi.fn()
    const outcome = await submitSafeBatch({
      chainId: 1,
      authority: ALICE,
      steps,
      route: { kind: 'eoa', authorityKind: 'eoa' },
      onStep,
    })
    expect(onStep.mock.calls.map(([index]) => index)).toEqual([0, 1, 2])
    expect(mocks.runAuthorityCalls).toHaveBeenCalledTimes(3)
    const sent = mocks.runAuthorityCalls.mock.calls.map(([input]) => input.calls)
    expect(sent.map(calls => calls.length)).toEqual([1, 1, 1])
    expect(sent.map(([call]) => [call.authority, call.target, call.data])).toEqual(
      steps.map(step => [ALICE, step.to, step.data]),
    )
    expect(outcome.kind).toBe('eoa')
    expect(outcome.kind === 'eoa' && outcome.hashes).toHaveLength(3)
    expect(mocks.client.simulateCalls).not.toHaveBeenCalled()
    expect(mocks.sendCalls).not.toHaveBeenCalled()
  })

  it('rebuilds every step through its audited builder and rejects drift', () => {
    const steps = presetSteps()
    for (const step of steps) {
      const call = authorityCallForStep(step, ALICE)
      expect(call).toMatchObject({
        chainId: 1,
        authority: ALICE,
        target: step.to,
        data: step.data,
        label: step.label,
      })
    }
    expect(authorityCallForStep(steps[1], ALICE).gas).toBe(300_000n)
    expect(authorityCallForStep(steps[1], ALICE).target).toBe(REGISTRY)
    const drifted = { ...steps[0], data: '0x779b0290' as Hex }
    expect(() => authorityCallForStep(drifted, ALICE)).toThrow(/no longer matches its builder/)
    const twap = buildStep({
      kind: 'setTwapWindowOf',
      chainId: 1,
      projectId: 2,
      values: { hook: HOOK, terminalToken: NATIVE, twapWindow: 900n },
    })
    expect(authorityCallForStep(twap, ALICE)).toMatchObject({ target: HOOK, gas: 150_000n })
    const operator = buildStep({
      kind: 'setOperatorOf',
      chainId: 1,
      projectId: 2,
      values: { operator: BOB },
    })
    expect(authorityCallForStep(operator, ALICE)).toMatchObject({
      functionName: 'setOperatorOf',
      args: [2n, BOB],
    })
  })
})
