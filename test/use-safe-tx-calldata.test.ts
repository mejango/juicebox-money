/**
 * The exact bytes useSafeTx hands the wallet for a payment, a cash out and a
 * loan, saved to test/fixtures/use-safe-tx-calldata.json. The reviewed-send
 * path that replaces useSafeTx must send these same bytes
 * (test/reviewed-action.test.ts), so the baseline outlives useSafeTx.
 */

import { QueryClient } from '@tanstack/react-query'
import { createElement, createRef, forwardRef, useImperativeHandle } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { encodeFunctionData, type Address, type Hex } from 'viem'
import { buildBorrowTx, buildCashOutTx, buildPayTx } from '@bananapus/nana-sdk-core/v6'
import { describe, expect, it, vi } from 'vitest'

const displayQueries = new QueryClient()
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => displayQueries,
}))

const ALICE = '0x1111111111111111111111111111111111111111' as Address

const mocks = vi.hoisted(() => ({
  publicClient: {
    simulateContract: vi.fn(async (request: Record<string, unknown>) => ({ request })),
    estimateContractGas: vi.fn(async () => 100_000n),
    getTransaction: vi.fn(),
    getChainId: vi.fn(async () => 10),
    getBlockNumber: vi.fn(async () => 100n),
    getTransactionCount: vi.fn(async () => 3),
  },
  writeContract: vi.fn(),
}))

vi.mock('@wagmi/core', () => ({
  getAccount: () => ({ address: '0x1111111111111111111111111111111111111111', chainId: 10 }),
}))
vi.mock('wagmi', () => ({
  usePublicClient: () => mocks.publicClient,
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ data: undefined, isError: false }),
  useWriteContract: () => ({ writeContractAsync: mocks.writeContract }),
}))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ isConnected: true, address: '0x1111111111111111111111111111111111111111', isCenterWallet: false }),
}))
vi.mock('@/lib/transaction-review', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/transaction-review')>()),
  requestContractTransactionReview: vi.fn(async () => true),
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => false,
  useSafeConnection: () => false,
  findPendingSafeAppProposal: vi.fn(),
}))

import { useSafeTx, type TxRequest } from '@/hooks/useSafeTx'

type SafeTxValue = ReturnType<typeof useSafeTx>
const Harness = forwardRef<SafeTxValue>(function Harness(_, ref) {
  const value = useSafeTx(10)
  useImperativeHandle(ref, () => value, [value])
  return null
})

const TERMINAL = '0x2db6d704058e552defe415753465df8df0361846' as Address
const TOKEN = '0x000000000000000000000000000000000000EEEe' as Address

/** The three actions, as their flows build them. */
const REQUESTS: Record<string, TxRequest> = {
  pay: buildPayTx({
    chainId: 10, terminal: TERMINAL, projectId: 4n, token: TOKEN, amount: 10n ** 16n,
    beneficiary: ALICE, minReturnedTokens: 7n, memo: 'gm', metadata: '0x',
  }) as TxRequest,
  cashOut: buildCashOutTx({
    chainId: 10, terminal: TERMINAL, holder: ALICE, projectId: 4n, cashOutCount: 10n ** 18n,
    tokenToReclaim: TOKEN, minTokensReclaimed: 5n, beneficiary: ALICE, metadata: '0x',
  }) as TxRequest,
  loan: buildBorrowTx({
    chainId: 10, revnetId: 4n, token: TOKEN, minBorrowAmount: 9n, collateralCount: 10n ** 18n,
    beneficiary: ALICE, prepaidFeePercent: 25n, holder: ALICE,
  }) as TxRequest,
}

describe('useSafeTx calldata baseline', () => {
  it('records the exact bytes it sends for a payment, a cash out and a loan', async () => {
    const sent: Record<string, { chainId: number; to: Address; data: Hex; value: string }> = {}
    for (const [name, request] of Object.entries(REQUESTS)) {
      mocks.writeContract.mockReset()
      mocks.writeContract.mockResolvedValue(`0x${'ab'.repeat(32)}`)
      const ref = createRef<SafeTxValue>()
      let renderer!: TestRenderer.ReactTestRenderer
      await act(async () => {
        renderer = TestRenderer.create(createElement(Harness, { ref }))
      })
      await act(async () => {
        await ref.current!.send(request, { reviewedAccount: ALICE })
      })
      expect(mocks.writeContract).toHaveBeenCalledTimes(1)
      const written = mocks.writeContract.mock.calls[0][0] as TxRequest
      sent[name] = {
        chainId: request.chainId,
        to: written.address,
        data: encodeFunctionData({ abi: written.abi, functionName: written.functionName, args: written.args } as never),
        value: String(written.value ?? 0n),
      }
      await act(async () => renderer.unmount())
    }
    await expect(`${JSON.stringify(sent, null, 2)}\n`).toMatchFileSnapshot('fixtures/use-safe-tx-calldata.json')
  })
})
