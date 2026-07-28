import type { Address, Hex } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  account: undefined as Address | undefined,
  client: {
    readContract: vi.fn(),
    simulateContract: vi.fn(),
    getBlock: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
  },
  wallet: { writeContract: vi.fn(), signTypedData: vi.fn() },
  getAccount: vi.fn(),
  connectedWallet: vi.fn(),
  requireReview: vi.fn(),
  requireContractReview: vi.fn(),
}))

vi.mock('@wagmi/core', () => ({ getAccount: mocks.getAccount }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/wallet-core', () => ({
  publicClient: () => mocks.client,
  connectedWallet: mocks.connectedWallet,
}))
vi.mock('@/lib/transaction-review', () => ({
  requireTransactionReview: mocks.requireReview,
  requireContractTransactionReview: mocks.requireContractReview,
}))

import {
  executeSafeTx,
  getSafeNextNonce,
  runSafeCalls,
  simulateSafeExecution,
  type SafeQueuedTx,
} from '@/lib/safe'
import { clearViewAs, setViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'

const SAFE = '0x1111111111111111111111111111111111111111' as Address
const ALICE = '0x2222222222222222222222222222222222222222' as Address
const BOB = '0x3333333333333333333333333333333333333333' as Address
const TARGET = '0x4444444444444444444444444444444444444444' as Address
const HASH = `0x${'ab'.repeat(32)}` as Hex

function queued(confirmations = [{ owner: ALICE }]): SafeQueuedTx {
  return {
    to: TARGET,
    value: '5',
    data: '0x1234',
    operation: 0,
    safeTxGas: '0',
    baseGas: '0',
    gasPrice: '0',
    gasToken: '0x0000000000000000000000000000000000000000',
    refundReceiver: '0x0000000000000000000000000000000000000000',
    nonce: 7,
    confirmations,
  }
}

beforeEach(() => {
  mocks.account = ALICE
  mocks.getAccount.mockImplementation(() => ({ address: mocks.account }))
  mocks.connectedWallet.mockResolvedValue({
    wallet: mocks.wallet,
    account: ALICE,
  })
  mocks.requireReview.mockResolvedValue(undefined)
  mocks.requireContractReview.mockResolvedValue(undefined)
  mocks.client.readContract.mockImplementation(async input => {
    if (input.functionName === 'getThreshold') return 1n
    if (input.functionName === 'getOwners') return [ALICE]
    if (input.functionName === 'nonce') return 7n
    if (input.functionName === 'approvedHashes') return 0n
    throw new Error(`Unexpected read ${input.functionName}`)
  })
  mocks.client.simulateContract.mockResolvedValue({ result: true })
  mocks.client.getBlock.mockResolvedValue({ baseFeePerGas: 2_000_000_000n })
  mocks.client.waitForTransactionReceipt.mockResolvedValue({ status: 'success' })
  mocks.wallet.writeContract.mockResolvedValue(HASH)
})

describe('Safe execution boundary', () => {
  it('refuses to run or execute Safe calls while view-as is active', async () => {
    setViewAs(BOB)
    try {
      await expect(
        runSafeCalls({ calls: [], signer: ALICE }),
      ).rejects.toThrow(VIEW_AS_WRITE_BLOCKED)
      await expect(executeSafeTx(1, SAFE, queued())).rejects.toThrow(
        VIEW_AS_WRITE_BLOCKED,
      )
      expect(mocks.wallet.writeContract).not.toHaveBeenCalled()
    } finally {
      clearViewAs()
    }
  })


  it('reviews the inner context, simulates, rechecks the account, and confirms', async () => {
    await expect(executeSafeTx(1, SAFE, queued())).resolves.toEqual({
      hash: HASH,
      status: 'confirmed',
    })

    expect(mocks.requireReview).toHaveBeenCalledWith(
      expect.objectContaining({
        authorization: expect.objectContaining({
          safe: SAFE,
          nonce: 7,
          destinationCall: expect.objectContaining({ to: TARGET, value: '5' }),
        }),
      }),
    )
    expect(mocks.client.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: SAFE,
        functionName: 'execTransaction',
        account: ALICE,
      }),
    )
    expect(mocks.wallet.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: SAFE,
        functionName: 'execTransaction',
        account: ALICE,
        type: 'eip1559',
        maxFeePerGas: 6_050_000_000n,
        maxPriorityFeePerGas: 50_000_000n,
      }),
    )
    expect(mocks.client.simulateContract.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.wallet.writeContract.mock.invocationCallOrder[0],
    )
  })

  it('refuses an exec simulation that does not return true', async () => {
    mocks.client.simulateContract.mockResolvedValueOnce({ result: false })

    await expect(executeSafeTx(1, SAFE, queued())).rejects.toThrow(
      /simulation reported.*fail/i,
    )
    expect(mocks.wallet.writeContract).not.toHaveBeenCalled()
  })

  it('keeps a submitted transaction non-terminal when receipt lookup fails', async () => {
    mocks.client.waitForTransactionReceipt.mockRejectedValueOnce(
      new Error('RPC unavailable'),
    )

    await expect(executeSafeTx(1, SAFE, queued())).resolves.toEqual({
      hash: HASH,
      status: 'submitted',
    })
  })

  it('distinguishes a proven onchain revert from receipt uncertainty', async () => {
    mocks.client.waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'reverted',
    })

    await expect(executeSafeTx(1, SAFE, queued())).rejects.toThrow(
      new RegExp(`reverted onchain.*${HASH}`, 'i'),
    )
  })

  it('rechecks the wallet account after simulation and before signing', async () => {
    mocks.client.simulateContract.mockImplementationOnce(async () => {
      mocks.account = BOB
      return { result: true }
    })

    await expect(executeSafeTx(1, SAFE, queued())).rejects.toThrow(
      /account changed/i,
    )
    expect(mocks.wallet.writeContract).not.toHaveBeenCalled()
  })

  it('requires enough usable approvals before simulation', async () => {
    mocks.client.readContract.mockImplementation(async input => {
      if (input.functionName === 'getThreshold') return 2n
      if (input.functionName === 'getOwners') return [ALICE, BOB]
      throw new Error(`Unexpected read ${input.functionName}`)
    })

    await expect(
      simulateSafeExecution(1, SAFE, queued(), ALICE),
    ).rejects.toThrow('1/2 usable signatures')
    expect(mocks.client.simulateContract).not.toHaveBeenCalled()
  })

  it('rejects a threshold-complete execution that simulates false', async () => {
    mocks.client.readContract.mockImplementation(async input => {
      if (input.functionName === 'getThreshold') return 2n
      if (input.functionName === 'getOwners') return [ALICE, BOB]
      throw new Error(`Unexpected read ${input.functionName}`)
    })
    mocks.client.simulateContract.mockResolvedValueOnce({ result: false })

    await expect(
      simulateSafeExecution(
        1,
        SAFE,
        queued([{ owner: ALICE }, { owner: BOB }]),
        ALICE,
      ),
    ).rejects.toThrow(/would not execute successfully/i)
  })
})

describe('Safe retry and terminal-state orchestration', () => {
  it('deduplicates concurrent nonce reads and falls back to onchain truth', async () => {
    let resolveNonce!: (value: bigint) => void
    mocks.client.readContract.mockImplementationOnce(
      () => new Promise<bigint>(resolve => (resolveNonce = resolve)),
    )

    const first = getSafeNextNonce(1, SAFE)
    const second = getSafeNextNonce(1, SAFE)
    expect(second).toBe(first)
    await vi.waitFor(() => expect(resolveNonce).toBeTypeOf('function'))
    resolveNonce(12n)
    await expect(first).resolves.toBe(12)
    expect(mocks.client.readContract).toHaveBeenCalledTimes(1)
  })

  it('stops after an unconfirmed onchain approval instead of executing again', async () => {
    mocks.client.waitForTransactionReceipt.mockRejectedValueOnce(
      new Error('receipt unavailable'),
    )

    await expect(
      runSafeCalls({
        signer: ALICE,
        calls: [
          {
            chainId: 999 as never,
            safe: SAFE,
            target: TARGET,
            data: '0x1234',
            value: 5n,
          },
        ],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        status: 'submitted',
        mode: 'onchain',
        transactionHash: HASH,
      }),
    ])
    expect(mocks.wallet.writeContract).toHaveBeenCalledTimes(1)
  })

  it('waits without writing while onchain approvals remain below threshold', async () => {
    mocks.client.readContract.mockImplementation(async input => {
      if (input.functionName === 'getThreshold') return 2n
      if (input.functionName === 'getOwners') return [ALICE, BOB]
      if (input.functionName === 'nonce') return 7n
      if (input.functionName === 'approvedHashes') {
        return input.args?.[0] === ALICE ? 1n : 0n
      }
      throw new Error(`Unexpected read ${input.functionName}`)
    })

    await expect(
      runSafeCalls({
        signer: ALICE,
        calls: [
          {
            chainId: 999 as never,
            safe: SAFE,
            target: TARGET,
            data: '0x1234',
          },
        ],
      }),
    ).resolves.toEqual([
      expect.objectContaining({ status: 'waiting', mode: 'onchain' }),
    ])
    expect(mocks.wallet.writeContract).not.toHaveBeenCalled()
  })
})
