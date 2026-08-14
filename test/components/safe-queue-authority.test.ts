import {
  jbContractAddress,
  RevnetCoreContracts,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import { keccak256, stringToHex, type Address, type Hex } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readContract: vi.fn(),
  readDirectEnsProjectRecord: vi.fn(),
  readDirectEnsText: vi.fn(),
  readBoundedProjectHandle: vi.fn(),
  readMatchingAuthorityIdentities: vi.fn(),
  simulateStateChangingTransaction: vi.fn(),
  getTransaction: vi.fn(),
  getTransactionReceipt: vi.fn(),
  readSafeNonce: vi.fn(),
}))

vi.mock('@/lib/authority', () => ({
  clientFor: () => ({
    readContract: mocks.readContract,
    getTransaction: mocks.getTransaction,
    getTransactionReceipt: mocks.getTransactionReceipt,
  }),
}))
vi.mock('@/lib/project-handles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/project-handles')>()),
  readDirectEnsProjectRecord: mocks.readDirectEnsProjectRecord,
  readDirectEnsText: mocks.readDirectEnsText,
  readBoundedProjectHandle: mocks.readBoundedProjectHandle,
}))
vi.mock('@/lib/cross-chain-authority', () => ({
  readMatchingAuthorityIdentities: mocks.readMatchingAuthorityIdentities,
}))
vi.mock('@/lib/transaction-simulation', () => ({
  simulateStateChangingTransaction: mocks.simulateStateChangingTransaction,
  TRANSACTION_SIMULATION_GAS: 10_000_000n,
}))
vi.mock('@/lib/safe-reads', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/safe-reads')>()),
  readBoundedSafeNonce: mocks.readSafeNonce,
}))

import {
  assertQueuedProjectHandleContext,
  assertSafeProjectAuthority,
  verifyRelayrSafeBatchLanding,
  type SafeQueueChain,
} from '@/components/project/SafeQueueCard'
import {
  PROJECT_HANDLES_ADDRESS,
  PROJECT_HANDLE_RESOLVER_WRITE_GAS,
  PROJECT_HANDLE_WRITE_GAS,
  buildSetEnsProjectRecordCall,
  buildSetProjectHandleCall,
} from '@/lib/project-handles'
import { safeExecRelayrEntry, type SafeQueuedTx } from '@/lib/safe'

const SAFE = '0x1111111111111111111111111111111111111111' as Address
const OTHER = '0x2222222222222222222222222222222222222222' as Address
const RESOLVER = '0x3333333333333333333333333333333333333333' as Address
const CHAIN_ID = 1 as JBChainId
const DESTINATION_HASH = `0x${'ab'.repeat(32)}` as Hex
const SAFE_TX_HASH = `0x${'cd'.repeat(32)}` as Hex
const TX_UUID = 'fedcba98-7654-3210-fedc-ba9876543210'
const EXECUTION_SUCCESS_TOPIC = keccak256(
  stringToHex('ExecutionSuccess(bytes32,uint256)'),
)

function queued(to: Address, data: Hex): SafeQueuedTx {
  return {
    to,
    value: '0',
    data,
    operation: 0,
    safeTxGas: '0',
    baseGas: '0',
    gasPrice: '0',
    gasToken: '0x0000000000000000000000000000000000000000',
    refundReceiver: '0x0000000000000000000000000000000000000000',
    nonce: 1,
  }
}

beforeEach(() => {
  mocks.readMatchingAuthorityIdentities.mockResolvedValue({ matches: true })
  mocks.readDirectEnsProjectRecord.mockResolvedValue({
    resolver: RESOLVER,
    controller: SAFE,
    textRecord: '10:42',
  })
  mocks.readDirectEnsText.mockResolvedValue('10:42')
  mocks.readBoundedProjectHandle.mockResolvedValue('design.juicebox')
  mocks.simulateStateChangingTransaction.mockResolvedValue('0x')
  mocks.getTransaction.mockResolvedValue({
    to: SAFE,
    value: 5n,
    input: '0x1234',
  })
  mocks.getTransactionReceipt.mockResolvedValue({
    status: 'success',
    transactionHash: DESTINATION_HASH,
    logs: [
      {
        address: SAFE,
        topics: [EXECUTION_SUCCESS_TOPIC, SAFE_TX_HASH],
        data: `0x${'00'.repeat(32)}`,
      },
    ],
  })
  mocks.readSafeNonce.mockResolvedValue(2n)
})

function chain(isRevnet: boolean): SafeQueueChain {
  return {
    chainId: CHAIN_ID,
    name: 'Ethereum',
    projectId: 42,
    isRevnet,
    handleTuples: [{ chainId: CHAIN_ID, projectId: 42 }],
  }
}

describe('Safe queue project authority', () => {
  it('requires the Safe to remain the live project NFT owner', async () => {
    mocks.readContract.mockResolvedValueOnce(SAFE)
    await expect(assertSafeProjectAuthority(chain(false), SAFE)).resolves.toBeUndefined()

    mocks.readContract.mockResolvedValueOnce(OTHER)
    await expect(assertSafeProjectAuthority(chain(false), SAFE)).rejects.toThrow(
      /no longer the project owner/i,
    )
  })

  it('requires canonical REVOwner custody and a live operator grant', async () => {
    const revOwner = jbContractAddress['6'][RevnetCoreContracts.REVOwner][
      CHAIN_ID
    ] as Address
    mocks.readContract
      .mockResolvedValueOnce(revOwner)
      .mockResolvedValueOnce(true)
    await expect(assertSafeProjectAuthority(chain(true), SAFE)).resolves.toBeUndefined()

    mocks.readContract
      .mockResolvedValueOnce(revOwner)
      .mockResolvedValueOnce(false)
    await expect(assertSafeProjectAuthority(chain(true), SAFE)).rejects.toThrow(
      /no longer the revnet operator/i,
    )
  })

  it('re-simulates a canonical queued ENS record from the Safe on Ethereum', async () => {
    const call = buildSetEnsProjectRecordCall({
      resolver: RESOLVER,
      ensName: 'design.juicebox.eth',
      chainId: 10,
      projectId: 42,
    })
    mocks.readContract
      .mockResolvedValueOnce(SAFE)
      .mockResolvedValueOnce(RESOLVER)

    await expect(
      assertQueuedProjectHandleContext(
        1,
        SAFE,
        queued(call.target, call.data),
        [{ chainId: 10, projectId: 42 }],
      ),
    ).resolves.toBe(true)
    expect(mocks.simulateStateChangingTransaction).toHaveBeenCalledWith(
      expect.anything(),
      {
        from: SAFE,
        to: RESOLVER,
        data: call.data,
        gas: PROJECT_HANDLE_RESOLVER_WRITE_GAS,
      },
    )

    mocks.readContract
      .mockResolvedValueOnce(SAFE)
      .mockResolvedValueOnce(OTHER)
    await expect(
      assertQueuedProjectHandleContext(
        1,
        SAFE,
        queued(call.target, call.data),
        [{ chainId: 10, projectId: 42 }],
      ),
    ).rejects.toThrow(/resolver changed/i)
  })

  it('binds queued handle calldata to its encoded L2 authority and ENS record', async () => {
    const call = buildSetProjectHandleCall({
      chainId: 10,
      projectId: 42,
      parts: ['juicebox', 'design'],
    })
    mocks.readContract.mockResolvedValueOnce(SAFE)

    await expect(
      assertQueuedProjectHandleContext(
        1,
        SAFE,
        queued(call.target, call.data),
        [{ chainId: 10, projectId: 42 }],
      ),
    ).resolves.toBe(true)
    expect(mocks.readMatchingAuthorityIdentities).toHaveBeenCalled()
    expect(mocks.readDirectEnsProjectRecord).toHaveBeenCalledWith(
      expect.anything(),
      'design.juicebox.eth',
    )
    expect(mocks.simulateStateChangingTransaction).toHaveBeenCalledWith(
      expect.anything(),
      {
        from: SAFE,
        to: PROJECT_HANDLES_ADDRESS,
        data: call.data,
        gas: PROJECT_HANDLE_WRITE_GAS,
      },
    )

    mocks.readContract.mockResolvedValueOnce(OTHER)
    await expect(
      assertQueuedProjectHandleContext(
        1,
        SAFE,
        queued(call.target, call.data),
        [{ chainId: 10, projectId: 42 }],
      ),
    ).rejects.toThrow(/no longer the owner/i)
  })

  it('rejects handle calldata on another queue chain and before oversized decode', async () => {
    const call = buildSetProjectHandleCall({
      chainId: 10,
      projectId: 42,
      parts: ['juicebox', 'design'],
    })
    await expect(
      assertQueuedProjectHandleContext(
        10,
        SAFE,
        queued(call.target, call.data),
        [{ chainId: 10, projectId: 42 }],
      ),
    ).rejects.toThrow(/must execute on Ethereum/i)
    await expect(
      assertQueuedProjectHandleContext(
        1,
        SAFE,
        queued(PROJECT_HANDLES_ADDRESS, `0x${'00'.repeat(4_097)}` as Hex),
        [{ chainId: 10, projectId: 42 }],
      ),
    ).rejects.toThrow(/malformed or too large/i)
    expect(mocks.readContract).not.toHaveBeenCalled()
  })

  it('rejects queued handle calls with Safe gas reimbursement fields', async () => {
    const call = buildSetProjectHandleCall({
      chainId: 10,
      projectId: 42,
      parts: ['juicebox', 'design'],
    })
    await expect(
      assertQueuedProjectHandleContext(
        1,
        SAFE,
        { ...queued(call.target, call.data), gasPrice: '1' },
        [{ chainId: 10, projectId: 42 }],
      ),
    ).rejects.toThrow(/without gas reimbursement/i)
    expect(mocks.readContract).not.toHaveBeenCalled()
  })

  it('does not expose another project controlled by the same Safe', async () => {
    const call = buildSetProjectHandleCall({
      chainId: 10,
      projectId: 43,
      parts: ['juicebox', 'other'],
    })
    await expect(
      assertQueuedProjectHandleContext(
        1,
        SAFE,
        queued(call.target, call.data),
        [{ chainId: 10, projectId: 42 }],
      ),
    ).rejects.toThrow(/belongs to another project/i)
    expect(mocks.readContract).not.toHaveBeenCalled()
    expect(mocks.simulateStateChangingTransaction).not.toHaveBeenCalled()
  })
})

describe('Relayr Safe destination proof', () => {
  const entry = safeExecRelayrEntry(
    CHAIN_ID,
    SAFE,
    queued(OTHER, '0x1234'),
  )
  const record = {
    tx_uuid: TX_UUID,
    request: {
      chain: 1,
      target: SAFE,
      data: entry.data,
      value: entry.value,
      virtual_nonce: 0,
    },
    status: { state: 'success', data: { hash: DESTINATION_HASH } },
  }
  const proof = {
    chainId: 1,
    safe: SAFE,
    nonce: 1,
    safeTxHash: SAFE_TX_HASH,
    txUuid: TX_UUID,
  }

  const recordFor = (expected: typeof entry) => ({
    tx_uuid: TX_UUID,
    request: {
      chain: expected.chain,
      target: expected.target,
      data: expected.data,
      value: expected.value,
      virtual_nonce: expected.virtual_nonce ?? 0,
    },
    status: { state: 'success', data: { hash: DESTINATION_HASH } },
  })

  it('binds a Relayr success row to the exact outer call and Safe success event', async () => {
    mocks.getTransaction.mockResolvedValueOnce({
      to: SAFE,
      value: 0n,
      input: entry.data,
    })
    await expect(
      verifyRelayrSafeBatchLanding(SAFE, [record], [entry], [proof]),
    ).resolves.toBeUndefined()
    expect(mocks.getTransaction).toHaveBeenCalledWith({
      hash: DESTINATION_HASH,
    })
    expect(mocks.readSafeNonce).toHaveBeenCalledWith(expect.anything(), SAFE)
  })

  it('keeps the paid bundle unresolved when calldata or the Safe event differs', async () => {
    mocks.getTransaction.mockResolvedValueOnce({
      to: SAFE,
      value: 0n,
      input: '0x5678',
    })
    await expect(
      verifyRelayrSafeBatchLanding(SAFE, [record], [entry], [proof]),
    ).rejects.toThrow(/exact Safe execution/i)

    mocks.getTransactionReceipt.mockResolvedValueOnce({
      status: 'success',
      transactionHash: DESTINATION_HASH,
      logs: [],
    })
    await expect(
      verifyRelayrSafeBatchLanding(SAFE, [record], [entry], [proof]),
    ).rejects.toThrow(/exact Safe execution/i)
  })

  it('accepts the Safe 1.3 non-indexed ExecutionSuccess layout', async () => {
    mocks.getTransaction.mockResolvedValueOnce({
      to: SAFE,
      value: 0n,
      input: entry.data,
    })
    mocks.getTransactionReceipt.mockResolvedValueOnce({
      status: 'success',
      transactionHash: DESTINATION_HASH,
      logs: [
        {
          address: SAFE,
          topics: [EXECUTION_SUCCESS_TOPIC],
          data: `${SAFE_TX_HASH}${'00'.repeat(32)}`,
        },
      ],
    })
    await expect(
      verifyRelayrSafeBatchLanding(SAFE, [record], [entry], [proof]),
    ).resolves.toBeUndefined()
  })

  it('rejects a nonzero Safe reimbursement payment in the success event', async () => {
    mocks.getTransaction.mockResolvedValueOnce({
      to: SAFE,
      value: 0n,
      input: entry.data,
    })
    mocks.getTransactionReceipt.mockResolvedValueOnce({
      status: 'success',
      transactionHash: DESTINATION_HASH,
      logs: [
        {
          address: SAFE,
          topics: [EXECUTION_SUCCESS_TOPIC, SAFE_TX_HASH],
          data: `0x${'00'.repeat(31)}01`,
        },
      ],
    })
    await expect(
      verifyRelayrSafeBatchLanding(SAFE, [record], [entry], [proof]),
    ).rejects.toThrow(/exact Safe execution/i)
  })

  it('requires the executed resolver to return the exact ENS record', async () => {
    const call = buildSetEnsProjectRecordCall({
      resolver: RESOLVER,
      ensName: 'design.juicebox.eth',
      chainId: 10,
      projectId: 42,
    })
    const resolverEntry = safeExecRelayrEntry(
      CHAIN_ID,
      SAFE,
      queued(call.target, call.data),
    )
    mocks.getTransaction.mockResolvedValue({
      to: SAFE,
      value: 0n,
      input: resolverEntry.data,
    })
    mocks.readContract
      .mockResolvedValueOnce(SAFE)
      .mockResolvedValueOnce(RESOLVER)

    await expect(
      verifyRelayrSafeBatchLanding(
        SAFE,
        [recordFor(resolverEntry)],
        [resolverEntry],
        [proof],
      ),
    ).resolves.toBeUndefined()

    mocks.readDirectEnsText.mockResolvedValueOnce('10:999')
    mocks.readContract
      .mockResolvedValueOnce(SAFE)
      .mockResolvedValueOnce(RESOLVER)
    await expect(
      verifyRelayrSafeBatchLanding(
        SAFE,
        [recordFor(resolverEntry)],
        [resolverEntry],
        [proof],
      ),
    ).rejects.toThrow(/does not return juicebox=10:42/i)
  })

  it('requires handleOf to verify the executed Handles claim', async () => {
    const call = buildSetProjectHandleCall({
      chainId: 10,
      projectId: 42,
      parts: ['juicebox', 'design'],
    })
    const handleEntry = safeExecRelayrEntry(
      CHAIN_ID,
      SAFE,
      queued(call.target, call.data),
    )
    mocks.getTransaction.mockResolvedValue({
      to: SAFE,
      value: 0n,
      input: handleEntry.data,
    })
    mocks.readContract.mockResolvedValueOnce(SAFE)

    await expect(
      verifyRelayrSafeBatchLanding(
        SAFE,
        [recordFor(handleEntry)],
        [handleEntry],
        [proof],
      ),
    ).resolves.toBeUndefined()
    expect(mocks.readBoundedProjectHandle).toHaveBeenCalledWith(
      expect.anything(),
      { chainId: 10, projectId: 42, setter: SAFE },
    )
  })
})
