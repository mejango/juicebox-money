import {
  encodeFunctionData,
  keccak256,
  stringToHex,
  zeroAddress,
  type Abi,
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
    estimateGas: vi.fn(),
    getBlock: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    getCode: vi.fn(),
    getTransaction: vi.fn(),
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
  prepareDeployment: vi.fn(),
  simulateStateChangingTransaction: vi.fn(),
  safe: false,
  waitSafe: vi.fn(),
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
vi.mock('@bananapus/nana-sdk-core/safe', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core/safe')>()),
  readBoundedSafeNonce: mocks.readSafeNonce,
  readBoundedSafeApprovedHash: mocks.readSafeApprovedHash,
  prepareSafeSameAddressDeployment: mocks.prepareDeployment,
  readAuthorityIdentity: mocks.readAuthorityIdentity,
}))
vi.mock('@/lib/cross-chain-authority', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/cross-chain-authority')>()),
  readMatchingAuthorityIdentities: mocks.readMatchingAuthorityIdentities,
}))
vi.mock('@bananapus/nana-sdk-core/review', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core/review')>()),
  simulateStateChangingTransaction: mocks.simulateStateChangingTransaction,
}))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => mocks.safe,
  waitForSafeExecutionHash: mocks.waitSafe,
}))

import {
  confirmSafeTx,
  executeSafeTx,
  deploySafeSameAddress,
  getSafeNextNonce,
  readSafeQueue,
  runSafeCalls,
  simulateSafeExecution,
  SAFE_EXECUTION_WRITE_GAS,
} from '@/lib/safe'
import { SAFE_NONCE_GUIDANCE } from '@/lib/safe-connector'
import {
  canonicalSafeTxHash,
  SAFE_EXEC_ABI,
  safeProposalFor,
  safeTransactionHash,
  type SafeQueuedTransaction,
} from '@bananapus/nana-sdk-core/safe-service'
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
const EXECUTION_FAILURE_TOPIC = keccak256(
  stringToHex('ExecutionFailure(bytes32,uint256)'),
)

function safeIdentity(owners = [ALICE], threshold = 1) {
  return {
    kind: 'safe' as const,
    owners,
    threshold,
    ownersAreEoas: true,
    hasModules: false,
    modules: [],
    proxyCodeHash: HASH,
    singleton: SINGLETON,
    singletonCodeHash: HASH,
    version: '1.3.0',
    guard: '0x0000000000000000000000000000000000000000' as Address,
    fallbackHandler: '0x0000000000000000000000000000000000000000' as Address,
    fallbackHandlerCodeHash: null,
  }
}

const success = (hash: Hex) => ({
  address: SAFE,
  topics: [EXECUTION_SUCCESS_TOPIC, hash],
  data: `0x${'00'.repeat(32)}` as Hex,
})
const failure = (hash: Hex) => ({
  address: SAFE,
  topics: [EXECUTION_FAILURE_TOPIC, hash],
  data: `0x${'00'.repeat(32)}` as Hex,
})

function queued(
  confirmations: SafeQueuedTransaction['confirmations'] = [{ owner: ALICE }],
): SafeQueuedTransaction {
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
  mocks.simulateStateChangingTransaction.mockResolvedValue(TRUE_RESULT)
  mocks.client.readContract.mockImplementation(async input => {
    if (input.functionName === 'approvedHashes') return 0n
    throw new Error(`Unexpected read ${input.functionName}`)
  })
  mocks.client.simulateContract.mockResolvedValue({ result: true })
  mocks.client.estimateContractGas.mockResolvedValue(100_000n)
  // Without a measurement the reviewed and sent gas is the write's cap.
  mocks.client.estimateGas.mockReset().mockRejectedValue(new Error('cannot estimate'))
  mocks.safe = false
  mocks.waitSafe.mockReset()
  mocks.client.getBlock.mockResolvedValue({ baseFeePerGas: 2_000_000_000n })
  mocks.client.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => {
    const write = mocks.wallet.writeContract.mock.calls.at(-1)?.[0]
    if (write?.functionName !== 'execTransaction') {
      return { status: 'success', transactionHash: hash, logs: [] }
    }
    const args = write.args as readonly unknown[]
    const executed: SafeQueuedTransaction = {
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
      transactionHash: hash,
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
  // The deployed Safe has code once the wallet has sent its deployment.
  mocks.client.getCode.mockImplementation(async ({ address }: { address: Address }) =>
    address === SAFE && mocks.wallet.writeContract.mock.calls.length
      ? ('0x6000' as Hex)
      : undefined,
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

  it('signs for module-enabled Safes and rejects a module set that changes mid-flow', async () => {
    mocks.readAuthorityIdentity.mockResolvedValue({
      ...safeIdentity(),
      hasModules: true,
      modules: [BOB],
    })
    await expect(executeSafeTx(1, SAFE, queued())).resolves.toBeDefined()

    let reads = 0
    mocks.readAuthorityIdentity.mockImplementation(async () => ({
      ...safeIdentity(),
      hasModules: true,
      modules: ++reads === 1 ? [BOB] : [BOB, FACTORY],
    }))
    await expect(simulateSafeExecution(1, SAFE, queued())).rejects.toThrow(
      /policy or nonce changed/i,
    )
  })

  it('fails closed when the module set is too large to snapshot', async () => {
    mocks.readAuthorityIdentity.mockResolvedValue({
      ...safeIdentity(),
      hasModules: true,
      modules: null,
    })

    await expect(executeSafeTx(1, SAFE, queued())).rejects.toThrow(
      /Could not verify this Safe onchain/,
    )
    expect(mocks.requireReview).not.toHaveBeenCalled()
    expect(mocks.wallet.writeContract).not.toHaveBeenCalled()
  })

  describe('same-address Safe deployment', () => {
    // The SDK proves the deployment itself (its tests cover each refusal);
    // these prove this app sends only what it proved, and names each refusal.
    const CANONICAL_FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67' as Address
    const CANONICAL_SINGLETON = '0x41675C099F32341bf84BFc5382aF534df5C7461a' as Address
    const creation = {
      factory: CANONICAL_FACTORY,
      singleton: CANONICAL_SINGLETON,
      initializer: '0x1234' as Hex,
      saltNonce: 7n,
    }
    const call = {
      target: CANONICAL_FACTORY,
      data: '0xabcd' as Hex,
      abi: [],
      functionName: 'createProxyWithNonce' as const,
      args: [CANONICAL_SINGLETON, '0x1234' as Hex, 7n] as const,
    }
    const deploy = (reverifyAuthority = vi.fn().mockResolvedValue(undefined)) =>
      deploySafeSameAddress(1, creation, SAFE, { sourceChainId: 10, reverifyAuthority })

    beforeEach(() => {
      mocks.prepareDeployment.mockResolvedValue({ valid: true, call, source: safeIdentity() })
    })

    it('reviews and sends exactly the factory call the SDK proved, proving it again first', async () => {
      const reverifyAuthority = vi.fn().mockResolvedValue(undefined)

      await expect(deploy(reverifyAuthority)).resolves.toBe(HASH)

      expect(mocks.prepareDeployment).toHaveBeenCalledWith({
        sourceClient: mocks.client,
        destinationClient: mocks.client,
        creation,
        safe: SAFE,
        from: ALICE,
      })
      // Once before the review, and again before the wallet sends.
      expect(mocks.prepareDeployment.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(reverifyAuthority).toHaveBeenCalled()
      // The node could not measure, so the cap is both reviewed and sent.
      expect(mocks.requireContractReview).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: 'createProxyWithNonce', gas: 3_000_000n }),
        expect.objectContaining({ label: 'Deploy Safe on this chain' }),
      )
      expect(mocks.wallet.writeContract).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          address: CANONICAL_FACTORY,
          functionName: 'createProxyWithNonce',
          args: call.args,
          gas: 3_000_000n,
        }),
      )
      expect(mocks.readMatchingAuthorityIdentities).toHaveBeenCalledWith(
        expect.objectContaining({ authority: SAFE }),
      )
    })

    it.each([
      ['address-occupied', /already has code on this chain/],
      ['contract-owner', /owner is a contract on the destination chain/],
      ['fallback-handler-mismatch', /fallback handler bytecode does not match/],
      ['delegated-fallback-handler', /fallback handler bytecode does not match/],
      ['factory-mismatch', /factory or singleton bytecode does not match/],
      ['singleton-unavailable', /factory or singleton bytecode does not match/],
      ['setup-library-mismatch', /SafeToL2Setup library is missing or altered/],
      ['unexpected-address', /would not deploy/],
      ['simulation-failed', /would not deploy/],
      ['initializer-policy-mismatch', /no longer eligible for same-address deployment/],
      ['not-a-safe', /no longer eligible for same-address deployment/],
      ['rpc-error', /Could not verify this Safe onchain/],
    ] as const)('names the SDK refusal %s and sends nothing', async (reason, message) => {
      mocks.prepareDeployment.mockResolvedValue({ valid: false, reason })

      await expect(deploy()).rejects.toThrow(message)
      expect(mocks.requireContractReview).not.toHaveBeenCalled()
      expect(mocks.wallet.writeContract).not.toHaveBeenCalled()
    })

    it("deploys a Safe that Safe 1.3.0's EIP-155 factory made, as the SDK proves it", async () => {
      const eip155 = { ...creation, factory: '0xC22834581EbC8527d974F8a1c97E1bEA4EF910BC' as Address }

      await expect(
        deploySafeSameAddress(1, eip155, SAFE, {
          sourceChainId: 10,
          reverifyAuthority: vi.fn().mockResolvedValue(undefined),
        }),
      ).resolves.toBe(HASH)
      expect(mocks.prepareDeployment).toHaveBeenCalledWith(
        expect.objectContaining({ creation: eip155, safe: SAFE }),
      )
    })

    it('refuses a wallet that does not sign for the source Safe', async () => {
      mocks.prepareDeployment.mockResolvedValue({ valid: true, call, source: safeIdentity([BOB]) })

      await expect(deploy()).rejects.toThrow(`Switch to a current signer of ${SAFE}.`)
      expect(mocks.wallet.writeContract).not.toHaveBeenCalled()
    })

    it('sends nothing when the source policy changes before the wallet sends', async () => {
      mocks.prepareDeployment
        .mockResolvedValueOnce({ valid: true, call, source: safeIdentity() })
        .mockResolvedValue({ valid: true, call, source: safeIdentity([ALICE, BOB], 2) })

      await expect(deploy()).rejects.toThrow(/policy or nonce changed/i)
      expect(mocks.wallet.writeContract).not.toHaveBeenCalled()
    })

    it('does not report a deployment whose Safe does not match the source', async () => {
      mocks.readMatchingAuthorityIdentities.mockResolvedValue({
        source: safeIdentity(),
        destination: safeIdentity([BOB]),
        matches: false,
      })

      await expect(deploy()).rejects.toThrow(/does not match the live source Safe/)
    })
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

  it('measures the gas before the review and sends exactly the reviewed gas', async () => {
    mocks.client.estimateGas.mockResolvedValue(150_000n)

    await executeSafeTx(1, SAFE, queued())

    expect(mocks.client.estimateGas).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ account: ALICE, to: SAFE, gas: SAFE_EXECUTION_WRITE_GAS }),
    )
    expect(mocks.client.estimateGas.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.requireReview.mock.invocationCallOrder[0],
    )
    const [call] = mocks.requireReview.mock.calls[0][0].calls
    expect(call).toMatchObject({ to: SAFE, functionName: 'execTransaction', gas: 300_000n })
    expect(call).not.toHaveProperty('safeTxGas')
    expect(mocks.wallet.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'execTransaction', gas: call.gas }),
    )
  })

  /** The connected Safe app's own execTransaction of the call its wallet was asked to send, or of `data` instead. */
  function connectedSafeRan(data?: Hex) {
    mocks.client.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => {
      const sent = mocks.wallet.writeContract.mock.calls[0][0] as {
        address: Address; abi: Abi; functionName: string; args: readonly unknown[]
      }
      return {
        hash,
        from: BOB,
        to: ALICE,
        input: encodeFunctionData({
          abi: SAFE_EXEC_ABI,
          functionName: 'execTransaction',
          args: [sent.address, 0n, data ?? encodeFunctionData(sent), 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'],
        }),
      }
    })
  }
  /** The connected Safe app executed its proposal at once: its own event, for a safeTxHash it never returned, and the queued Safe's. */
  function executedAtOnce() {
    mocks.client.waitForTransactionReceipt.mockImplementationOnce(async ({ hash }: { hash: Hex }) => ({
      status: 'success',
      transactionHash: hash,
      logs: [
        { address: ALICE, topics: [EXECUTION_SUCCESS_TOPIC, `0x${'ee'.repeat(32)}`], data: `0x${'00'.repeat(32)}` },
        success(canonicalSafeTxHash(1, SAFE, queued())),
      ],
    }))
  }

  it('proposes through a Safe app with gas 0 and reviews it as Safe gas 0', async () => {
    mocks.safe = true
    mocks.waitSafe.mockResolvedValue(HASH)
    executedAtOnce()
    connectedSafeRan()

    await expect(executeSafeTx(1, SAFE, queued())).resolves.toEqual({ hash: HASH, status: 'confirmed' })

    const review = mocks.requireReview.mock.calls[0][0]
    expect(review.confirmLabel).toBe('Agree & continue to Safe')
    expect(review.description.endsWith(` ${SAFE_NONCE_GUIDANCE}`)).toBe(true)
    expect(review.calls).toEqual([expect.objectContaining({ to: SAFE, safeTxGas: 0n })])
    expect(review.calls[0]).not.toHaveProperty('gas')
    expect(mocks.client.estimateGas).not.toHaveBeenCalled()
    expect(mocks.wallet.writeContract).toHaveBeenCalledWith(expect.objectContaining({ gas: 0n }))
    expect(mocks.waitSafe).toHaveBeenCalledWith(1, HASH)
  })

  it('does not confirm a proposal Safe{Wallet} executed at once when the execution ran another call', async () => {
    mocks.safe = true
    mocks.waitSafe.mockResolvedValue(HASH)
    executedAtOnce()
    connectedSafeRan('0xdeadbeef')

    await expect(executeSafeTx(1, SAFE, queued())).rejects.toThrow(
      'Safe proposal submitted, but confirmation is unavailable. Check Safe before taking another action.',
    )
    expect(mocks.client.getTransaction).toHaveBeenCalledWith({ hash: HASH })
  })

  it('fails a Safe app approval whose execution logged ExecutionFailure', async () => {
    const proposal = `0x${'cd'.repeat(32)}` as Hex
    const execution = `0x${'ef'.repeat(32)}` as Hex
    mocks.safe = true
    // A 2-of-2 Safe, so the connected owner approves rather than executes.
    mocks.readSafeThreshold.mockResolvedValue(2n)
    mocks.readSafeOwners.mockResolvedValue([ALICE, BOB])
    mocks.readSafeApprovedHash.mockResolvedValue(0n)
    mocks.wallet.writeContract.mockResolvedValue(proposal)
    mocks.waitSafe.mockResolvedValue(execution)
    mocks.client.waitForTransactionReceipt.mockResolvedValue({
      status: 'success',
      transactionHash: execution,
      // The connected Safe ran the approval with a nonzero safeTxGas, and the call failed inside it.
      logs: [{ address: ALICE, topics: [EXECUTION_FAILURE_TOPIC, proposal], data: `0x${'00'.repeat(32)}` }],
    })

    await expect(
      runSafeCalls({
        signer: ALICE,
        calls: [{ chainId: 999 as never, safe: SAFE, target: TARGET, data: '0x1234' }],
      }),
    ).rejects.toThrow(/approveHash reverted after Safe execution/)
    expect(mocks.wallet.writeContract).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ functionName: 'approveHash', gas: 0n }),
    )
    expect(mocks.waitSafe).toHaveBeenCalledWith(999, proposal)
  })

  it.each([
    ['Safe 1.4, hash indexed', (hash: Hex) => ({ topics: [EXECUTION_FAILURE_TOPIC, hash], data: `0x${'00'.repeat(32)}` as Hex })],
    ['Safe 1.3, hash in data', (hash: Hex) => ({ topics: [EXECUTION_FAILURE_TOPIC], data: `${hash}${'00'.repeat(32)}` as Hex })],
  ] as const)('does not fail a Safe app approval for another proposal\'s ExecutionFailure (%s)', async (_, failure) => {
    const proposal = `0x${'cd'.repeat(32)}` as Hex
    const other = `0x${'ce'.repeat(32)}` as Hex
    const execution = `0x${'ef'.repeat(32)}` as Hex
    mocks.safe = true
    // A 2-of-2 Safe: the approval is the whole send, and the run then waits for Bob.
    mocks.readSafeThreshold.mockResolvedValue(2n)
    mocks.readSafeOwners.mockResolvedValue([ALICE, BOB])
    mocks.readSafeApprovedHash.mockResolvedValue(0n)
    mocks.wallet.writeContract.mockResolvedValueOnce(proposal)
    mocks.waitSafe.mockResolvedValueOnce(execution)
    // The same execution also ran another of the connected Safe's proposals,
    // which failed, while this proposal succeeded.
    mocks.client.waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'success',
      transactionHash: execution,
      logs: [
        { address: ALICE, ...failure(other) },
        { address: ALICE, topics: [EXECUTION_SUCCESS_TOPIC, proposal], data: `0x${'00'.repeat(32)}` as Hex },
      ],
    })

    await expect(
      runSafeCalls({
        signer: ALICE,
        calls: [{ chainId: 999 as never, safe: SAFE, target: TARGET, data: '0x1234' }],
      }),
    ).resolves.toEqual([expect.objectContaining({ mode: 'onchain', status: 'waiting' })])
    expect(mocks.wallet.writeContract).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ functionName: 'approveHash' }),
    )
  })

  it("refuses to sign, simulate or execute a transaction that pays a gas refund", async () => {
    const refund = { ...queued(), gasPrice: '1' }
    for (const run of [
      () => executeSafeTx(1, SAFE, refund),
      () => simulateSafeExecution(1, SAFE, refund),
      () => confirmSafeTx(1, SAFE, refund, ALICE),
    ]) {
      await expect(run()).rejects.toThrow(
        new Error("This transaction pays a gas refund, so it can't be executed here."),
      )
    }
    expect(mocks.requireReview).not.toHaveBeenCalled()
    expect(mocks.wallet.signTypedData).not.toHaveBeenCalled()
    expect(mocks.wallet.writeContract).not.toHaveBeenCalled()
  })

  it.each([
    ['logs ExecutionSuccess for it twice', (hash: Hex) => [success(hash), success(hash)]],
    ['logs both ExecutionSuccess and ExecutionFailure for it', (hash: Hex) => [success(hash), failure(hash)]],
    ['logs ExecutionSuccess only for another Safe transaction', () => [success(`0x${'ef'.repeat(32)}` as Hex)]],
  ] as const)('does not confirm an execution whose receipt %s', async (_, logs) => {
    mocks.client.waitForTransactionReceipt.mockResolvedValueOnce({
      status: 'success',
      transactionHash: HASH,
      logs: logs(canonicalSafeTxHash(1, SAFE, queued())),
    })

    await expect(executeSafeTx(1, SAFE, queued())).rejects.toThrow(
      /inner call did not execute successfully/i,
    )
  })

  it('does not send when the connection changed after the review', async () => {
    mocks.requireReview.mockImplementationOnce(async () => { mocks.safe = true })

    await expect(executeSafeTx(1, SAFE, queued())).rejects.toThrow(/Connected wallet changed/)
    expect(mocks.wallet.writeContract).not.toHaveBeenCalled()
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
    ).rejects.toThrow(/does not match its fields/i)
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
  it('deduplicates concurrent onchain nonce reads', async () => {
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
    mocks.readSafeThreshold.mockResolvedValue(2n)
    mocks.readSafeOwners.mockResolvedValue([ALICE, BOB])
    mocks.readSafeApprovedHash.mockResolvedValue(0n)
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
    expect(mocks.wallet.writeContract).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ functionName: 'approveHash' }),
    )
  })

  it('lets the owner who completes the threshold execute without approving first', async () => {
    mocks.readSafeThreshold.mockResolvedValue(2n)
    mocks.readSafeOwners.mockResolvedValue([ALICE, BOB])
    mocks.readSafeApprovedHash.mockImplementation(
      async (_client, _safe, owner) => (owner === BOB ? 1n : 0n),
    )
    const executed = safeProposalFor({ to: TARGET, data: '0x1234' }, 7)
    mocks.client.waitForTransactionReceipt.mockImplementationOnce(async ({ hash }: { hash: Hex }) => ({
      status: 'success',
      transactionHash: hash,
      logs: [success(safeTransactionHash(999, SAFE, executed))],
    }))

    await expect(
      runSafeCalls({
        signer: ALICE,
        calls: [{ chainId: 999 as never, safe: SAFE, target: TARGET, data: '0x1234' }],
      }),
    ).resolves.toEqual([
      expect.objectContaining({ mode: 'onchain', status: 'executed', transactionHash: HASH }),
    ])
    // Safe counts the executing owner as a signature: no approveHash first.
    expect(mocks.wallet.writeContract).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ functionName: 'execTransaction' }),
    )
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

  it('reviews the exact safeTxGas a co-signature commits to', async () => {
    const previousFetch = globalThis.fetch
    const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    mocks.wallet.signTypedData.mockResolvedValue(`0x${'11'.repeat(65)}`)
    try {
      await confirmSafeTx(1, SAFE, { ...queued([]), safeTxGas: '150000' }, ALICE)
      const review = mocks.requireReview.mock.calls[0][0]
      expect(review).toMatchObject({ kind: 'authorization' })
      expect(review.calls).toEqual([
        expect.objectContaining({ to: TARGET, safeTxGas: 150_000n }),
      ])
      expect(mocks.wallet.signTypedData).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.objectContaining({ safeTxGas: 150_000n }) }),
      )
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/confirmations/'),
        expect.objectContaining({ method: 'POST' }),
      )
    } finally {
      vi.stubGlobal('fetch', previousFetch)
    }
  })

  it("reads the whole hosted queue from the Safe's onchain nonce", async () => {
    const previousFetch = globalThis.fetch
    const row = (nonce: number, data: Hex) => {
      const tx = { ...queued(), value: '0', data, nonce }
      return { ...tx, safe: SAFE, safeTxHash: safeTransactionHash(1, SAFE, tx) }
    }
    const firstPage = Array.from({ length: 50 }, (_, index) => row(7 + index, '0xaaaa'))
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (!url.includes(`/api/v1/safes/${SAFE}/multisig-transactions/`) || !url.includes('nonce__gte=7')) {
        throw new Error(`Unexpected Safe request ${url}`)
      }
      if (url.includes('offset=0')) {
        return new Response(JSON.stringify({ results: firstPage, next: 'page-2' }), { status: 200 })
      }
      if (url.includes('offset=50')) {
        return new Response(JSON.stringify({ results: [row(57, '0xbeef')], next: null }), { status: 200 })
      }
      throw new Error(`Unexpected Safe request ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const { nonce, pending } = await readSafeQueue(1, SAFE)
      expect(nonce).toBe(7)
      expect(pending).toHaveLength(51)
      expect(pending.at(-1)).toMatchObject({ nonce: 57, data: '0xbeef' })
    } finally {
      vi.stubGlobal('fetch', previousFetch)
    }
  })
})
