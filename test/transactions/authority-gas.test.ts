import type { Address, Hex } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  account: undefined as Address | undefined,
  client: {
    call: vi.fn(),
    request: vi.fn(),
    estimateGas: vi.fn(),
    readContract: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
  },
  wallet: { signTypedData: vi.fn(), sendTransaction: vi.fn() },
  getAccount: vi.fn(),
  connectedWallet: vi.fn(),
  requireReview: vi.fn(),
  runSafeCalls: vi.fn(),
  findPendingSafeCall: vi.fn(),
  readAuthorityIdentity: vi.fn(),
  readMatchingAuthorityIdentities: vi.fn(),
  isSafeConnection: vi.fn(),
  waitForSafeExecutionHash: vi.fn(),
}))

vi.mock('@wagmi/core', () => ({
  getAccount: mocks.getAccount,
  getPublicClient: () => mocks.client,
}))
vi.mock('@/providers/Providers', () => ({
  wagmiConfig: {},
  SUPPORTED_CHAINS: [
    { id: 1, name: 'Ethereum' },
    { id: 10, name: 'Optimism' },
  ],
}))
vi.mock('@/lib/wallet-core', () => ({
  publicClient: () => mocks.client,
  connectedWallet: mocks.connectedWallet,
}))
vi.mock('@/lib/transaction-review', () => ({
  requireTransactionReview: mocks.requireReview,
}))
vi.mock('@/lib/safe', () => ({
  canonicalSafeTxHash: () => HASH,
  findPendingSafeCall: mocks.findPendingSafeCall,
  runSafeCalls: mocks.runSafeCalls,
}))
vi.mock('@/lib/cross-chain-authority', () => ({
  readAuthorityIdentity: mocks.readAuthorityIdentity,
  readMatchingAuthorityIdentities: mocks.readMatchingAuthorityIdentities,
}))
vi.mock('@/lib/safe-connector', () => ({
  isSafeConnection: mocks.isSafeConnection,
  SAFE_NONCE_GUIDANCE: 'Choose the correct Safe nonce.',
  waitForSafeExecutionHash: mocks.waitForSafeExecutionHash,
}))

import { runAuthorityCalls, type AuthorityCall } from '@/lib/authority'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const TARGET = '0x3333333333333333333333333333333333333333' as Address
const SAFE = '0x4444444444444444444444444444444444444444' as Address
const HASH = `0x${'ab'.repeat(32)}` as Hex
const DESTINATION_HASH = `0x${'cd'.repeat(32)}` as Hex
const BUNDLE_UUID = '01234567-89ab-cdef-0123-456789abcdef'
const TX_UUIDS = [
  'fedcba98-7654-3210-fedc-ba9876543210',
  'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
]
const PAYMENT_ADDRESS = '0x1c05f7841379d4393574c0ffa17908ec40ffd97d' as Address
const NATIVE_TOKEN = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as Address
const PAYMENT_DEADLINE = 4_000_000_000
const PAYMENT_CALLDATA = `0x103903a7${BUNDLE_UUID.replaceAll('-', '').padEnd(64, '0')}${BigInt(PAYMENT_DEADLINE).toString(16).padStart(64, '0')}` as Hex
const PAYMENT_RUNTIME = '0x608060405260043610156010575f80fd5b5f3560e01c63103903a7146022575f80fd5b604036600319011260ef576004356fffffffffffffffffffffffffffffffff19811680910360ef5760243564ffffffffff811680910360ef5780421160ce575f341560c6575b5f8080809373755ff2f75a0a586ecfa2b9a3c959cb662458a1053491f11560bb5760407fb96b060a9c075a83da0cf1f9405deeb5df21df681a762de16c3d5eaf99531cd8918151903482526020820152a2005b6040513d5f823e3d90fd5b506108fc6068565b90630f01bd8760e21b5f5260045260245264ffffffffff421660445260645ffd5b5f80fdfea26469706673582212206ea0d2ba1e0cb26cc9293b24f1a7aecc1de7e328ca83d6b3bf5382ac44c7390064736f6c634300081a0033' as Hex

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

beforeEach(() => {
  mocks.account = ALICE
  mocks.getAccount.mockImplementation(() => ({
    address: mocks.account,
    chainId: 1,
  }))
  mocks.connectedWallet.mockResolvedValue({
    wallet: mocks.wallet,
    account: ALICE,
  })
  mocks.requireReview.mockResolvedValue(undefined)
  mocks.readAuthorityIdentity.mockResolvedValue({ kind: 'eoa' })
  mocks.isSafeConnection.mockReturnValue(false)
  mocks.findPendingSafeCall.mockResolvedValue(null)
  mocks.waitForSafeExecutionHash.mockResolvedValue(DESTINATION_HASH)
  mocks.readMatchingAuthorityIdentities.mockResolvedValue({
    source: { kind: 'eoa' },
    destination: { kind: 'eoa' },
    matches: true,
  })
  mocks.client.call.mockResolvedValue({ data: '0x' })
  mocks.client.request.mockImplementation(async ({ method }) => {
    if (method === 'eth_getCode') return PAYMENT_RUNTIME
    if (method === 'eth_call') return '0x'
    throw new Error(`Unexpected RPC method ${method}`)
  })
  mocks.client.readContract.mockImplementation(async input => {
    if (input.functionName === 'eip712Domain') {
      return ['0x0f', 'JBForwarder', '1', 1n, TARGET, '0x00', []]
    }
    if (input.functionName === 'nonces') return 4n
    throw new Error(`Unexpected read ${input.functionName}`)
  })
  mocks.client.waitForTransactionReceipt.mockResolvedValue({ status: 'success' })
  mocks.wallet.signTypedData.mockResolvedValue(`0x${'11'.repeat(65)}`)
  mocks.wallet.sendTransaction.mockResolvedValue(HASH)
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/v1/bundle/prepaid') && init?.method === 'POST') {
      return response({
        bundle_uuid: BUNDLE_UUID,
        payment_info: [
          {
            chain: 1,
            amount: '100',
            calldata: PAYMENT_CALLDATA,
            target: PAYMENT_ADDRESS,
            token: NATIVE_TOKEN,
            payment_deadline: PAYMENT_DEADLINE,
          },
        ],
        transactions: [],
        txn_uuids: TX_UUIDS,
      })
    }
    if (url.endsWith(`/v1/bundle/${BUNDLE_UUID}`)) {
      return response({
        transactions: [
          { chain: 1, status: { state: 'success', data: { hash: DESTINATION_HASH } } },
          { chain: 10, status: { state: 'success', data: { hash: DESTINATION_HASH } } },
        ],
      })
    }
    throw new Error(`Unexpected request: ${url}`)
  })
})

describe('Authority gas estimation reaches the signed Relayr request', () => {
  it('routes a matching delegated EOA project-handle claim as a direct EOA call', async () => {
    const delegated = {
      kind: 'delegated-eoa' as const,
      delegation: TARGET,
    }
    mocks.readAuthorityIdentity.mockResolvedValue(delegated)
    mocks.readMatchingAuthorityIdentities.mockResolvedValue({
      source: { kind: 'eoa' },
      destination: delegated,
      matches: true,
    })

    const result = await runAuthorityCalls({
      calls: [
        {
          chainId: 1,
          detectionChainId: 10,
          authority: ALICE,
          target: TARGET,
          data: '0x1234',
        },
      ],
    })

    expect(result.directResults).toEqual([HASH])
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ account: ALICE, to: TARGET, data: '0x1234' }),
    )
    expect(mocks.runSafeCalls).not.toHaveBeenCalled()
  })

  it('never treats a source-chain Safe as an EOA when its destination proxy is missing', async () => {
    mocks.readMatchingAuthorityIdentities.mockResolvedValue({
      source: {
        kind: 'safe',
        threshold: 2,
        owners: [ALICE],
        hasModules: false,
      },
      destination: { kind: 'eoa' },
      matches: false,
    })

    await expect(
      runAuthorityCalls({
        calls: [
          {
            chainId: 1,
            detectionChainId: 10,
            authority: SAFE,
            target: TARGET,
            data: '0x1234',
          },
        ],
      }),
    ).rejects.toThrow(
      /Safe on OP Mainnet.*not deployed on Ethereum.*Deploy same Safe on Ethereum.*project handle editor/,
    )
    expect(mocks.requireReview).not.toHaveBeenCalled()
    expect(mocks.client.request).not.toHaveBeenCalled()
  })

  it('rejects a source Safe whose mainnet address is a delegated EOA', async () => {
    mocks.readAuthorityIdentity.mockResolvedValue({
      kind: 'delegated-eoa',
      delegation: TARGET,
    })
    mocks.readMatchingAuthorityIdentities.mockResolvedValue({
      source: {
        kind: 'safe',
        threshold: 1,
        owners: [ALICE],
        hasModules: false,
      },
      destination: { kind: 'delegated-eoa', delegation: TARGET },
      matches: false,
    })

    await expect(
      runAuthorityCalls({
        calls: [
          {
            chainId: 1,
            detectionChainId: 10,
            authority: SAFE,
            target: TARGET,
            data: '0x1234',
          },
        ],
      }),
    ).rejects.toThrow(/Safe on OP Mainnet.*occupied by an EIP-7702 delegated EOA/i)
    expect(mocks.requireReview).not.toHaveBeenCalled()
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
    expect(mocks.runSafeCalls).not.toHaveBeenCalled()
  })

  it('detects on the project chain but queues the Safe call on mainnet', async () => {
    mocks.readAuthorityIdentity.mockResolvedValue({
      kind: 'safe',
      threshold: 2,
      owners: [ALICE],
    })
    mocks.runSafeCalls.mockResolvedValue([])
    mocks.client.estimateGas.mockResolvedValue(21_000n)
    mocks.readMatchingAuthorityIdentities.mockResolvedValue({
      source: {
        kind: 'safe',
        threshold: 2,
        owners: [ALICE],
        hasModules: false,
      },
      destination: {
        kind: 'safe',
        threshold: 2,
        owners: [ALICE],
        hasModules: false,
      },
      matches: true,
    })

    await runAuthorityCalls({
      calls: [
        {
          chainId: 1,
          detectionChainId: 10,
          authority: SAFE,
          target: TARGET,
          data: '0x1234',
        },
      ],
    })

    // Safe dispatch is determined on the call chain; detectionChainId is
    // verified independently by the fail-closed identity parity read.
    expect(mocks.readAuthorityIdentity).toHaveBeenCalledWith(
      mocks.client,
      SAFE,
    )
    expect(mocks.runSafeCalls).toHaveBeenCalledWith(
      expect.objectContaining({
        signer: ALICE,
        calls: [
          expect.objectContaining({
            chainId: 1,
            safe: SAFE,
            target: TARGET,
            data: '0x1234',
          }),
        ],
      }),
    )
    expect(mocks.connectedWallet).not.toHaveBeenCalled()
  })

  it('rejects divergent cross-chain Safe control before review', async () => {
    mocks.readAuthorityIdentity.mockResolvedValue({
      kind: 'safe',
      threshold: 1,
      owners: [ALICE],
    })
    mocks.readMatchingAuthorityIdentities.mockResolvedValue({
      source: {
        kind: 'safe',
        threshold: 2,
        owners: [ALICE, TARGET],
        hasModules: false,
      },
      destination: {
        kind: 'safe',
        threshold: 1,
        owners: [ALICE],
        hasModules: false,
      },
      matches: false,
    })

    await expect(
      runAuthorityCalls({
        calls: [
          {
            chainId: 1,
            detectionChainId: 10,
            authority: SAFE,
            target: TARGET,
            data: '0x1234',
          },
        ],
      }),
    ).rejects.toThrow(/do not have the same current owners, threshold/)
    expect(mocks.requireReview).not.toHaveBeenCalled()
  })

  it('tracks a Safe app proposal through execution before returning success', async () => {
    mocks.account = SAFE
    mocks.isSafeConnection.mockReturnValue(true)
    mocks.readAuthorityIdentity.mockResolvedValue({
      kind: 'safe',
      threshold: 2,
      owners: [ALICE],
    })
    mocks.readMatchingAuthorityIdentities.mockResolvedValue({
      source: {
        kind: 'safe',
        threshold: 2,
        owners: [ALICE],
        hasModules: false,
      },
      destination: {
        kind: 'safe',
        threshold: 2,
        owners: [ALICE],
        hasModules: false,
      },
      matches: true,
    })
    mocks.connectedWallet.mockResolvedValueOnce({
      wallet: mocks.wallet,
      account: SAFE,
    })
    mocks.client.estimateGas.mockResolvedValue(21_000n)

    const result = await runAuthorityCalls({
      calls: [
        {
          chainId: 1,
          detectionChainId: 10,
          authority: SAFE,
          target: TARGET,
          data: '0x1234',
        },
      ],
    })

    expect(mocks.runSafeCalls).not.toHaveBeenCalled()
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ account: SAFE, to: TARGET, data: '0x1234' }),
    )
    expect(mocks.waitForSafeExecutionHash).toHaveBeenCalledWith(
      1,
      HASH,
    )
    expect(result.directResults).toEqual([DESTINATION_HASH])
  })

  it('reuses an exact pending Safe app proposal without sending a duplicate', async () => {
    mocks.account = SAFE
    mocks.isSafeConnection.mockReturnValue(true)
    mocks.readAuthorityIdentity.mockResolvedValue({
      kind: 'safe',
      threshold: 2,
      owners: [ALICE],
    })
    mocks.findPendingSafeCall.mockResolvedValue({
      to: TARGET,
      value: '0',
      data: '0x1234',
      operation: 0,
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      gasToken: '0x0000000000000000000000000000000000000000',
      refundReceiver: '0x0000000000000000000000000000000000000000',
      nonce: 7,
    })

    const result = await runAuthorityCalls({
      calls: [
        {
          chainId: 1,
          authority: SAFE,
          target: TARGET,
          data: '0x1234',
        },
      ],
    })

    expect(result.safeResults).toEqual([
      expect.objectContaining({ status: 'queued', nonce: 7, safeTxHash: HASH }),
    ])
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
    expect(mocks.waitForSafeExecutionHash).not.toHaveBeenCalled()
  })

  it('rejects an owner-shaped spoof contract before Safe authorization', async () => {
    mocks.readAuthorityIdentity.mockResolvedValue({ kind: 'contract' })

    await expect(
      runAuthorityCalls({
        calls: [
          {
            chainId: 1,
            authority: SAFE,
            target: TARGET,
            data: '0x1234',
          },
        ],
      }),
    ).rejects.toThrow(/unsupported contract.*canonical Safe/i)

    expect(mocks.runSafeCalls).not.toHaveBeenCalled()
    expect(mocks.requireReview).not.toHaveBeenCalled()
    expect(mocks.wallet.sendTransaction).not.toHaveBeenCalled()
  })

  it('signs each ForwardRequest with the measured 2x estimate, not the 500k fallback', async () => {
    // A forwarded call that needs more than the 500k fallback: the OZ
    // forwarder caps the inner call at request.gas and reverts execute() when
    // the inner call runs out — AFTER the user paid Relayr for the bundle.
    mocks.client.estimateGas
      .mockResolvedValueOnce(800_000n) // chain 1 destination estimate
      .mockResolvedValueOnce(600_000n) // chain 10 destination estimate
      .mockResolvedValue(21_000n)

    const calls: AuthorityCall[] = [
      { chainId: 1, authority: ALICE, target: TARGET, data: '0x1234' },
      { chainId: 10, authority: ALICE, target: TARGET, data: '0x5678' },
    ]
    const result = await runAuthorityCalls({ calls })

    expect(result.relayrGroups).toBe(1)
    expect(mocks.client.request).toHaveBeenCalledWith({
      method: 'eth_call',
      params: [
        expect.objectContaining({
          from: ALICE,
          gas: '0x989680',
          to: TARGET,
        }),
        'latest',
      ],
    })
    expect(mocks.wallet.signTypedData).toHaveBeenCalledTimes(2)
    const signedGas = mocks.wallet.signTypedData.mock.calls.map(
      ([{ message }]) => message.gas,
    )
    expect(signedGas).toEqual([1_600_000n, 1_200_000n])
  })

  it('sends the measured gas, not the builder cap the wallet would reserve', async () => {
    // A wallet reserves gas * maxFeePerGas up front, so sending a 1M-gas
    // simulation cap demands ~0.003 ETH on Ethereum for a handle claim that
    // burns a fraction of it — funded accounts were rejected before signing.
    mocks.client.estimateGas.mockResolvedValue(120_000n)

    const calls: AuthorityCall[] = [
      {
        chainId: 1,
        authority: ALICE,
        target: TARGET,
        data: '0x1234',
        gas: 1_000_000n,
      },
    ]
    await runAuthorityCalls({ calls })

    expect(mocks.client.request).toHaveBeenCalledWith(
      expect.objectContaining({
        params: [expect.objectContaining({ gas: '0xf4240' }), 'latest'],
      }),
    )
    // Estimation stays bounded by the reviewed cap.
    expect(mocks.client.estimateGas).toHaveBeenCalledWith(
      expect.objectContaining({ gas: 1_000_000n }),
    )
    expect(mocks.wallet.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ gas: 240_000n }),
    )
  })

  it('never sends more than the builder cap', async () => {
    mocks.client.estimateGas.mockResolvedValue(900_000n)

    await runAuthorityCalls({
      calls: [
        {
          chainId: 1,
          authority: ALICE,
          target: TARGET,
          data: '0x1234',
          gas: 1_000_000n,
        },
      ],
    })

    expect(mocks.wallet.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ gas: 1_000_000n }),
    )
  })

  it('keeps the builder cap when the node cannot estimate', async () => {
    mocks.client.estimateGas.mockRejectedValue(new Error('cannot estimate'))

    await runAuthorityCalls({
      calls: [
        {
          chainId: 1,
          authority: ALICE,
          target: TARGET,
          data: '0x1234',
          gas: 1_000_000n,
        },
      ],
    })

    expect(mocks.wallet.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ gas: 1_000_000n }),
    )
  })

  it('falls back to 500k only when estimation itself fails', async () => {
    mocks.client.estimateGas
      .mockRejectedValueOnce(new Error('cannot estimate'))
      .mockRejectedValueOnce(new Error('cannot estimate'))
      .mockResolvedValue(21_000n)

    const calls: AuthorityCall[] = [
      { chainId: 1, authority: ALICE, target: TARGET, data: '0x1234' },
      { chainId: 10, authority: ALICE, target: TARGET, data: '0x5678' },
    ]
    await runAuthorityCalls({ calls })

    const signedGas = mocks.wallet.signTypedData.mock.calls.map(
      ([{ message }]) => message.gas,
    )
    expect(signedGas).toEqual([500_000n, 500_000n])
  })
})
