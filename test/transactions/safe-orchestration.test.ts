import {
  keccak256,
  stringToHex,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  account: undefined as Address | undefined,
  client: {
    readContract: vi.fn(),
    simulateContract: vi.fn(),
    estimateContractGas: vi.fn(),
    getBlock: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    getBytecode: vi.fn(),
  },
  wallet: { writeContract: vi.fn(), signTypedData: vi.fn() },
  getAccount: vi.fn(),
  connectedWallet: vi.fn(),
  requireReview: vi.fn(),
  requireContractReview: vi.fn(),
  readSafeThreshold: vi.fn(),
  readSafeOwners: vi.fn(),
  readSafeNonce: vi.fn(),
  readSafeApprovedHash: vi.fn(),
  readAuthorityIdentity: vi.fn(),
  readMatchingAuthorityIdentities: vi.fn(),
  isDeployableSafeAuthority: vi.fn(),
  safeCreationMatchesAuthorityIdentity: vi.fn(),
  simulateStateChangingTransaction: vi.fn(),
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
vi.mock('@/lib/safe-reads', () => ({
  readBoundedSafeThreshold: mocks.readSafeThreshold,
  readBoundedSafeOwners: mocks.readSafeOwners,
  readBoundedSafeNonce: mocks.readSafeNonce,
  readBoundedSafeApprovedHash: mocks.readSafeApprovedHash,
}))
vi.mock('@/lib/cross-chain-authority', () => ({
  readAuthorityIdentity: mocks.readAuthorityIdentity,
  readMatchingAuthorityIdentities: mocks.readMatchingAuthorityIdentities,
  isDeployableSafeAuthority: mocks.isDeployableSafeAuthority,
  safeCreationMatchesAuthorityIdentity: mocks.safeCreationMatchesAuthorityIdentity,
}))
vi.mock('@/lib/transaction-simulation', () => ({
  TRANSACTION_SIMULATION_GAS: 10_000_000n,
  simulateStateChangingTransaction: mocks.simulateStateChangingTransaction,
}))

import {
  canonicalSafeTxHash,
  executeSafeTx,
  deploySafeSameAddress,
  findPendingSafeCall,
  getSafeNextNonce,
  runSafeCalls,
  simulateSafeExecution,
  type SafeQueuedTx,
  SAFE_EXECUTION_WRITE_GAS,
} from '@/lib/safe'
import { clearViewAs, setViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'

const SAFE = '0x1111111111111111111111111111111111111111' as Address
const ALICE = '0x2222222222222222222222222222222222222222' as Address
const BOB = '0x3333333333333333333333333333333333333333' as Address
const TARGET = '0x4444444444444444444444444444444444444444' as Address
const FACTORY = '0x5555555555555555555555555555555555555555' as Address
const SINGLETON = '0x6666666666666666666666666666666666666666' as Address
const HASH = `0x${'ab'.repeat(32)}` as Hex
const TRUE_RESULT = `0x${'0'.repeat(63)}1` as Hex
const EXECUTION_SUCCESS_TOPIC = keccak256(
  stringToHex('ExecutionSuccess(bytes32,uint256)'),
)

function safeIdentity(owners = [ALICE], threshold = 1) {
  return {
    kind: 'safe' as const,
    owners,
    threshold,
    ownersAreEoas: true,
    hasModules: false,
    proxyCodeHash: HASH,
    singleton: SINGLETON,
    singletonCodeHash: HASH,
    version: '1.3.0',
    guard: '0x0000000000000000000000000000000000000000' as Address,
    fallbackHandler: '0x0000000000000000000000000000000000000000' as Address,
    fallbackHandlerCodeHash: null,
  }
}

function queued(
  confirmations: SafeQueuedTx['confirmations'] = [{ owner: ALICE }],
): SafeQueuedTx {
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
  mocks.readSafeThreshold.mockResolvedValue(1n)
  mocks.readSafeOwners.mockResolvedValue([ALICE])
  mocks.readSafeNonce.mockResolvedValue(7n)
  mocks.readSafeApprovedHash.mockResolvedValue(1n)
  mocks.readAuthorityIdentity.mockImplementation(async () =>
    safeIdentity(
      await mocks.readSafeOwners(),
      Number(await mocks.readSafeThreshold()),
    ),
  )
  mocks.readMatchingAuthorityIdentities.mockResolvedValue({
    source: safeIdentity(),
    destination: safeIdentity(),
    matches: true,
  })
  mocks.isDeployableSafeAuthority.mockImplementation(
    identity => identity?.kind === 'safe',
  )
  mocks.safeCreationMatchesAuthorityIdentity.mockReturnValue(true)
  mocks.simulateStateChangingTransaction.mockResolvedValue(TRUE_RESULT)
  mocks.client.readContract.mockImplementation(async input => {
    if (input.functionName === 'approvedHashes') return 0n
    throw new Error(`Unexpected read ${input.functionName}`)
  })
  mocks.client.simulateContract.mockResolvedValue({ result: true })
  mocks.client.estimateContractGas.mockResolvedValue(100_000n)
  mocks.client.getBlock.mockResolvedValue({ baseFeePerGas: 2_000_000_000n })
  mocks.client.waitForTransactionReceipt.mockImplementation(async () => {
    const write = mocks.wallet.writeContract.mock.calls.at(-1)?.[0]
    if (write?.functionName !== 'execTransaction') {
      return { status: 'success', logs: [] }
    }
    const args = write.args as readonly unknown[]
    const executed: SafeQueuedTx = {
      to: args[0] as Address,
      value: String(args[1]),
      data: args[2] as Hex,
      operation: Number(args[3]),
      safeTxGas: String(args[4]),
      baseGas: String(args[5]),
      gasPrice: String(args[6]),
      gasToken: args[7] as Address,
      refundReceiver: args[8] as Address,
      nonce: 7,
    }
    return {
      status: 'success',
      logs: [
        {
          address: SAFE,
          topics: [
            EXECUTION_SUCCESS_TOPIC,
            canonicalSafeTxHash(1, SAFE, executed),
          ],
          data: `0x${'00'.repeat(32)}`,
        },
      ],
    }
  })
  mocks.client.getBytecode.mockImplementation(
    async ({ address }: { address: Address }) =>
      address === SAFE
        ? mocks.wallet.writeContract.mock.calls.length
          ? ('0x6000' as Hex)
          : undefined
        : address === ALICE || address === BOB
          ? undefined
          : ('0x6000' as Hex),
  )
  mocks.wallet.writeContract.mockResolvedValue(HASH)
})

describe('Safe execution boundary', () => {
  it('rejects an owner-shaped spoof contract before Safe review or writes', async () => {
    mocks.readAuthorityIdentity.mockResolvedValueOnce({ kind: 'contract' })

    await expect(executeSafeTx(1, SAFE, queued())).rejects.toThrow(
      /Could not verify this Safe onchain/,
    )
    expect(mocks.requireReview).not.toHaveBeenCalled()
    expect(mocks.wallet.writeContract).not.toHaveBeenCalled()
  })

  it('rejects module-enabled Safes instead of trusting a boolean fingerprint', async () => {
    mocks.readAuthorityIdentity.mockResolvedValue({
      ...safeIdentity(),
      hasModules: true,
    })

    await expect(executeSafeTx(1, SAFE, queued())).rejects.toThrow(
      /enabled modules are not supported/i,
    )
    expect(mocks.requireReview).not.toHaveBeenCalled()
    expect(mocks.wallet.writeContract).not.toHaveBeenCalled()
  })

  it('proves the destination code and CREATE2 result before replaying a Safe', async () => {
    let identityRead = 0
    mocks.readAuthorityIdentity.mockImplementation(async () =>
      ++identityRead % 2 === 1 ? safeIdentity() : { kind: 'eoa' },
    )
    mocks.simulateStateChangingTransaction.mockResolvedValueOnce(
      `0x${'0'.repeat(24)}${SAFE.slice(2)}` as Hex,
    )
    const reverifyAuthority = vi.fn().mockResolvedValue(undefined)

    await expect(
      deploySafeSameAddress(
        1,
        {
          factory: FACTORY,
          singleton: SINGLETON,
          initializer: '0x1234',
          saltNonce: 7n,
        },
        SAFE,
        { sourceChainId: 10, reverifyAuthority },
      ),
    ).resolves.toBe(HASH)

    expect(mocks.simulateStateChangingTransaction).toHaveBeenCalledWith(
      mocks.client,
      expect.objectContaining({
        to: FACTORY,
        gas: 3_000_000n,
      }),
    )
    expect(reverifyAuthority).toHaveBeenCalled()
    expect(mocks.wallet.writeContract).toHaveBeenCalled()
  })

  it('does not write when Safe replay predicts another address', async () => {
    let identityRead = 0
    mocks.readAuthorityIdentity.mockImplementation(async () =>
      ++identityRead % 2 === 1 ? safeIdentity() : { kind: 'eoa' },
    )
    mocks.simulateStateChangingTransaction.mockResolvedValueOnce(
      `0x${'0'.repeat(24)}${TARGET.slice(2)}` as Hex,
    )

    await expect(
      deploySafeSameAddress(
        1,
        {
          factory: FACTORY,
          singleton: SINGLETON,
          initializer: '0x1234',
          saltNonce: 7n,
        },
        SAFE,
        {
          sourceChainId: 10,
          reverifyAuthority: vi.fn().mockResolvedValue(undefined),
        },
      ),
    ).rejects.toThrow(/would deploy.*not the expected project authority/i)
    expect(mocks.wallet.writeContract).not.toHaveBeenCalled()
  })

  it('rejects destination contract owners before irreversible Safe deployment', async () => {
    let identityRead = 0
    mocks.readAuthorityIdentity.mockImplementation(async () =>
      ++identityRead % 2 === 1 ? safeIdentity() : { kind: 'eoa' },
    )
    mocks.client.getBytecode.mockImplementation(
      async ({ address }: { address: Address }) =>
        address === ALICE || address === FACTORY || address === SINGLETON
          ? ('0x6000' as Hex)
          : undefined,
    )

    await expect(
      deploySafeSameAddress(
        1,
        {
          factory: FACTORY,
          singleton: SINGLETON,
          initializer: '0x1234',
          saltNonce: 7n,
        },
        SAFE,
        {
          sourceChainId: 10,
          reverifyAuthority: vi.fn().mockResolvedValue(undefined),
        },
      ),
    ).rejects.toThrow(/owner is a contract on the destination chain/i)
    expect(mocks.simulateStateChangingTransaction).not.toHaveBeenCalled()
    expect(mocks.wallet.writeContract).not.toHaveBeenCalled()
  })

  it('rejects a destination fallback handler with different runtime code', async () => {
    const source = {
      ...safeIdentity(),
      fallbackHandler: TARGET,
      fallbackHandlerCodeHash: keccak256('0x6000'),
    }
    let identityRead = 0
    mocks.readAuthorityIdentity.mockImplementation(async () =>
      ++identityRead % 2 === 1 ? source : { kind: 'eoa' },
    )
    mocks.client.getBytecode.mockImplementation(
      async ({ address }: { address: Address }) =>
        address === ALICE || address === SAFE
          ? undefined
          : address === TARGET
            ? ('0x6001' as Hex)
            : ('0x6000' as Hex),
    )

    await expect(
      deploySafeSameAddress(
        1,
        {
          factory: FACTORY,
          singleton: SINGLETON,
          initializer: '0x1234',
          saltNonce: 7n,
        },
        SAFE,
        {
          sourceChainId: 10,
          reverifyAuthority: vi.fn().mockResolvedValue(undefined),
        },
      ),
    ).rejects.toThrow(/fallback handler bytecode does not match/i)
    expect(mocks.simulateStateChangingTransaction).not.toHaveBeenCalled()
    expect(mocks.wallet.writeContract).not.toHaveBeenCalled()
  })

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
    expect(mocks.simulateStateChangingTransaction).toHaveBeenCalledWith(
      mocks.client,
      expect.objectContaining({
        from: ALICE,
        to: SAFE,
        gas: SAFE_EXECUTION_WRITE_GAS,
      }),
    )
    expect(mocks.wallet.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: SAFE,
        functionName: 'execTransaction',
        account: ALICE,
        gas: SAFE_EXECUTION_WRITE_GAS,
        type: 'eip1559',
        maxFeePerGas: 6_050_000_000n,
        maxPriorityFeePerGas: 50_000_000n,
      }),
    )
    expect(mocks.simulateStateChangingTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.wallet.writeContract.mock.invocationCallOrder[0],
    )
  })

  it('rejects an outer-success receipt without exact Safe ExecutionSuccess', async () => {
    mocks.client.waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'success',
      logs: [],
    })

    await expect(executeSafeTx(1, SAFE, queued())).rejects.toThrow(
      /inner call did not execute successfully/i,
    )
  })

  it('refuses an exec simulation that does not return true', async () => {
    mocks.simulateStateChangingTransaction.mockResolvedValueOnce(
      `0x${'0'.repeat(64)}` as Hex,
    )

    await expect(executeSafeTx(1, SAFE, queued())).rejects.toThrow(
      /simulation reported.*fail/i,
    )
    expect(mocks.wallet.writeContract).not.toHaveBeenCalled()
  })

  it('rejects a service hash that does not match the exact queued fields', async () => {
    await expect(
      executeSafeTx(1, SAFE, { ...queued(), safeTxHash: HASH }),
    ).rejects.toThrow(/hash does not match its exact fields/i)
    expect(mocks.requireReview).not.toHaveBeenCalled()
    expect(mocks.simulateStateChangingTransaction).not.toHaveBeenCalled()
  })

  it('aborts when the canonical Safe identity changes before the write', async () => {
    mocks.readAuthorityIdentity
      .mockResolvedValueOnce(safeIdentity())
      .mockResolvedValueOnce(safeIdentity())
      .mockResolvedValueOnce({ kind: 'contract' })

    await expect(executeSafeTx(1, SAFE, queued())).rejects.toThrow(
      /Could not verify this Safe onchain/,
    )
    expect(mocks.simulateStateChangingTransaction).toHaveBeenCalled()
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
    mocks.simulateStateChangingTransaction.mockImplementationOnce(async () => {
      mocks.account = BOB
      return TRUE_RESULT
    })

    await expect(executeSafeTx(1, SAFE, queued())).rejects.toThrow(
      /account changed/i,
    )
    expect(mocks.wallet.writeContract).not.toHaveBeenCalled()
  })

  it('binds the reviewed sender to the account used for simulation and send', async () => {
    let checks = 0
    const reverifyAuthority = vi.fn(async () => {
      checks += 1
      if (checks === 2) mocks.account = BOB
    })

    await expect(
      executeSafeTx(1, SAFE, queued(), reverifyAuthority),
    ).rejects.toThrow(/account changed/i)
    expect(mocks.requireReview).not.toHaveBeenCalled()
    expect(mocks.simulateStateChangingTransaction).not.toHaveBeenCalled()
    expect(mocks.wallet.writeContract).not.toHaveBeenCalled()
  })

  it('reads Safe policy after the final slow authority recheck', async () => {
    let checks = 0
    const reverifyAuthority = vi.fn(async () => {
      checks += 1
      if (checks === 4) {
        mocks.readAuthorityIdentity.mockResolvedValue({ kind: 'contract' })
      }
    })

    await expect(
      executeSafeTx(1, SAFE, queued(), reverifyAuthority),
    ).rejects.toThrow(/Could not verify this Safe onchain/i)
    expect(mocks.simulateStateChangingTransaction).toHaveBeenCalled()
    expect(mocks.wallet.writeContract).not.toHaveBeenCalled()
  })

  it('requires enough usable approvals before simulation', async () => {
    mocks.readSafeThreshold.mockResolvedValue(2n)
    mocks.readSafeOwners.mockResolvedValue([ALICE, BOB])

    await expect(
      simulateSafeExecution(1, SAFE, queued()),
    ).rejects.toThrow('1/2 current-owner signatures')
    expect(mocks.simulateStateChangingTransaction).not.toHaveBeenCalled()
  })

  it('rejects a threshold-complete execution that simulates false', async () => {
    mocks.readSafeThreshold.mockResolvedValue(2n)
    mocks.readSafeOwners.mockResolvedValue([ALICE, BOB])
    mocks.simulateStateChangingTransaction.mockResolvedValueOnce(
      `0x${'0'.repeat(64)}` as Hex,
    )

    await expect(
      simulateSafeExecution(
        1,
        SAFE,
        queued([{ owner: ALICE }, { owner: BOB }]),
      ),
    ).rejects.toThrow(/would not execute successfully/i)
    expect(mocks.simulateStateChangingTransaction).toHaveBeenCalledWith(
      mocks.client,
      expect.objectContaining({ from: zeroAddress }),
    )
  })

  it('rejects a service prevalidated signature without a live approvedHash', async () => {
    mocks.readSafeApprovedHash.mockResolvedValueOnce(0n)

    await expect(simulateSafeExecution(1, SAFE, queued())).rejects.toThrow(
      /approval.*no longer active onchain/i,
    )
    expect(mocks.simulateStateChangingTransaction).not.toHaveBeenCalled()
  })

  it('rejects an explicit v=1 self-owner signature without approvedHash', async () => {
    mocks.readSafeOwners.mockResolvedValue([SAFE])
    mocks.readSafeApprovedHash.mockResolvedValueOnce(0n)
    const prevalidated = `0x${SAFE.slice(2).padStart(64, '0')}${'0'.repeat(64)}01` as Hex

    await expect(
      simulateSafeExecution(
        1,
        SAFE,
        queued([{ owner: SAFE, signature: prevalidated }]),
      ),
    ).rejects.toThrow(/approval.*no longer active onchain/i)
    expect(mocks.simulateStateChangingTransaction).not.toHaveBeenCalled()
  })
})

describe('Safe retry and terminal-state orchestration', () => {
  it('deduplicates concurrent nonce reads and falls back to onchain truth', async () => {
    let resolveNonce!: (value: bigint) => void
    mocks.readSafeNonce.mockImplementationOnce(
      () => new Promise<bigint>(resolve => (resolveNonce = resolve)),
    )

    const first = getSafeNextNonce(1, SAFE)
    const second = getSafeNextNonce(1, SAFE)
    expect(second).toBe(first)
    await vi.waitFor(() => expect(resolveNonce).toBeTypeOf('function'))
    resolveNonce(12n)
    await expect(first).resolves.toBe(12)
    expect(mocks.readSafeNonce).toHaveBeenCalledTimes(1)
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
    mocks.readSafeThreshold.mockResolvedValue(2n)
    mocks.readSafeOwners.mockResolvedValue([ALICE, BOB])
    mocks.readSafeApprovedHash.mockImplementation(
      async (_client, _safe, owner) => (owner === ALICE ? 1n : 0n),
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
          },
        ],
      }),
    ).resolves.toEqual([
      expect.objectContaining({ status: 'waiting', mode: 'onchain' }),
    ])
    expect(mocks.wallet.writeContract).not.toHaveBeenCalled()
  })
  it('gives each call in a batch its own nonce on the no-service path', async () => {
    // The onchain nonce only advances at EXECUTION, so approving two calls
    // against the same nonce would waste one of them.
    mocks.readSafeThreshold.mockResolvedValue(2n)
    mocks.readSafeOwners.mockResolvedValue([ALICE, BOB])
    mocks.readSafeApprovedHash.mockImplementation(
      async (_client, _safe, owner) => (owner === ALICE ? 1n : 0n),
    )

    const results = await runSafeCalls({
      signer: ALICE,
      calls: [
        { chainId: 999 as never, safe: SAFE, target: TARGET, data: '0x1234' },
        { chainId: 999 as never, safe: SAFE, target: TARGET, data: '0x5678' },
      ],
    })

    expect(results.map(row => row.nonce)).toEqual([7, 8])
  })

  it('paginates the hosted queue before deciding an exact proposal is absent', async () => {
    const previousFetch = globalThis.fetch
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      ...queued(),
      value: '0',
      data: '0xaaaa' as Hex,
      nonce: 7 + index,
    }))
    const exact = {
      ...queued(),
      value: '0',
      data: '0xbeef' as Hex,
      nonce: 57,
    }
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (!url.includes('multisig-transactions')) {
        return new Response(JSON.stringify({ nonce: 7 }), { status: 200 })
      }
      if (url.includes('offset=0')) {
        return new Response(
          JSON.stringify({ results: firstPage, next: 'page-2' }),
          { status: 200 },
        )
      }
      if (url.includes('offset=50')) {
        return new Response(JSON.stringify({ results: [exact], next: null }), {
          status: 200,
        })
      }
      throw new Error(`Unexpected Safe request ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(
        findPendingSafeCall(1, SAFE, {
          target: TARGET,
          data: '0xbeef',
          value: 0n,
        }),
      ).resolves.toMatchObject({ nonce: 57, data: '0xbeef' })
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes('offset=50')),
      ).toBe(true)
    } finally {
      vi.stubGlobal('fetch', previousFetch)
    }
  })
})
