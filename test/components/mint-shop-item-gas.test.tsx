import type { ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { encodeFunctionData, toEventSelector, zeroAddress, type Abi, type Address, type Hex } from 'viem'
import { SAFE_EXEC_ABI } from '@bananapus/nana-sdk-core/safe-service'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  safe: false,
  review: vi.fn(),
  write: vi.fn(),
  waitSafe: vi.fn(),
  receipt: vi.fn(),
  shop: vi.fn(),
  client: { readContract: vi.fn(), simulateContract: vi.fn(), estimateContractGas: vi.fn(), getTransaction: vi.fn() },
}))

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const HOOK = '0x2222222222222222222222222222222222222222' as Address
const STORE = '0x3333333333333333333333333333333333333333' as Address
const PROPOSAL = `0x${'ab'.repeat(32)}` as Hex
const EXECUTION_FAILURE = toEventSelector('ExecutionFailure(bytes32,uint256)')
const EXECUTION_SUCCESS = toEventSelector('ExecutionSuccess(bytes32,uint256)')
/** The safeTxHash the Safe's own event names, which a wallet that executed at once never returns. */
const SAFE_TX = `0x${'ef'.repeat(32)}` as Hex

vi.mock('wagmi', () => ({
  useConfig: () => ({}),
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: mocks.write }),
}))
vi.mock('wagmi/actions', () => ({
  getAccount: () => ({ address: ACCOUNT, chainId: 1 }),
  getPublicClient: () => mocks.client,
}))
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn().mockResolvedValue(undefined) }),
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {}, SUPPORTED_CHAINS: [] }))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ isConnected: true, address: ACCOUNT, openSignIn: vi.fn() }),
}))
vi.mock('@/components/ui/ModalShell', () => ({
  ModalShell: ({ children, footer }: { children: ReactNode; footer: ReactNode }) => (
    <div>{children}{footer}</div>
  ),
}))
vi.mock('@/components/ui/TxConfirmDialog', () => ({
  TxConfirmDialog: ({ onConfirm, title, error }: { onConfirm: () => void; title: string; error?: string | null }) => (
    <div>
      <p>{title}</p>
      {error ? <p>{error}</p> : null}
      <button type="button" onClick={onConfirm}>Confirm mint</button>
    </div>
  ),
}))
vi.mock('@bananapus/nana-sdk-core/v6', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core/v6')>()),
  getProject721Shop: mocks.shop,
}))
vi.mock('@/lib/transaction-review', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/transaction-review')>()),
  requireContractTransactionReview: mocks.review,
}))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => mocks.safe,
  SAFE_NONCE_GUIDANCE: 'Choose the Safe nonce.',
  waitForSafeExecutionHash: mocks.waitSafe,
}))
vi.mock('@bananapus/nana-sdk-core/review', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core/review')>()),
  isTransactionReceiptUnavailableError: () => false,
  waitForTrackedReceipt: mocks.receipt,
}))

import { MintShopItemModal } from '@/components/project/MintShopItemModal'

let renderer: ReactTestRenderer

async function click(label: string) {
  const button = renderer.root.findAllByType('button').find(item => item.children.join('') === label)
  expect(button, label).toBeDefined()
  await act(async () => { await button!.props.onClick() })
}

async function mint() {
  await act(async () => {
    renderer = create(
      <MintShopItemModal chainId={1} projectId={7} hook={HOOK} tierId={1} itemName="Hat"
        remaining={5} isRevnet={false} onClose={vi.fn()} />,
    )
  })
  await click('Mint without payment')
  await click('Confirm mint')
}

beforeEach(() => {
  mocks.safe = false
  mocks.review.mockReset().mockResolvedValue(undefined)
  mocks.write.mockReset().mockResolvedValue(PROPOSAL)
  mocks.waitSafe.mockReset().mockResolvedValue(PROPOSAL)
  mocks.receipt.mockReset().mockImplementation(async (_client: unknown, hash: Hex) => ({
    status: 'success',
    transactionHash: hash,
    logs: [],
  }))
  mocks.shop.mockReset().mockResolvedValue({ hook: HOOK })
  mocks.client.readContract.mockReset().mockImplementation(async ({ functionName }: { functionName: string }) =>
    functionName === 'owner' ? ACCOUNT
      : functionName === 'STORE' ? STORE
        : { id: 1n, flags: { allowOwnerMint: true }, remainingSupply: 5 })
  mocks.client.simulateContract.mockReset().mockImplementation(async (request: object) => ({ request }))
  mocks.client.estimateContractGas.mockReset().mockResolvedValue(100_000n)
})

afterEach(async () => { await act(async () => renderer.unmount()) })

/** The Safe's execTransaction of the mint the wallet was asked to send, or of `data` in its place. */
function executesSentMint(data?: Hex) {
  mocks.client.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => {
    const sent = mocks.write.mock.calls[0][0] as { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }
    return {
      hash,
      from: STORE,
      to: ACCOUNT,
      input: encodeFunctionData({
        abi: SAFE_EXEC_ABI,
        functionName: 'execTransaction',
        args: [sent.address, 0n, data ?? encodeFunctionData(sent), 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'],
      }),
    }
  })
}

describe('free mint gas', () => {
  it('wallet-action:mint-shop-tiers-without-payment sends the measured gas limit from an ordinary wallet', async () => {
    await mint()
    expect(mocks.review.mock.calls[0][0]).not.toHaveProperty('safeTxGas')
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'mintFor', gas: 200_000n }))
  })

  it('wallet-action:mint-shop-tiers-without-payment proposes through a Safe app with gas 0 and reviews it as Safe gas 0', async () => {
    mocks.safe = true
    // Safe{Wallet} executed at once and returned the execution's own hash; the
    // Safe's event names its safeTxHash.
    mocks.receipt.mockImplementation(async (_client: unknown, hash: Hex) => ({
      status: 'success',
      transactionHash: hash,
      logs: [{ address: ACCOUNT, topics: [EXECUTION_SUCCESS, SAFE_TX], data: `0x${'00'.repeat(32)}` }],
    }))
    executesSentMint()
    await mint()
    expect(mocks.review).toHaveBeenCalledWith(
      expect.objectContaining({ address: HOOK, functionName: 'mintFor', safeTxGas: 0n }),
      expect.objectContaining({ description: 'Choose the Safe nonce.', confirmLabel: 'Agree & continue to Safe' }),
    )
    // A Safe app signs the sent gas as safeTxGas.
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'mintFor', gas: 0n }))
    expect(mocks.waitSafe).toHaveBeenCalledWith(1, PROPOSAL)
    expect(text()).toContain('Items minted')
  })

  it('reports a Safe execution that logged ExecutionFailure as a failed mint', async () => {
    mocks.safe = true
    // Safe{Wallet} executed at once and returned the execution's own hash; a
    // nonzero safeTxGas turned the failed mint into ExecutionFailure.
    mocks.receipt.mockImplementation(async (_client: unknown, hash: Hex) => ({
      status: 'success',
      transactionHash: hash,
      logs: [{ address: ACCOUNT, topics: [EXECUTION_FAILURE, SAFE_TX], data: `0x${'00'.repeat(32)}` }],
    }))
    executesSentMint()
    await mint()
    expect(text()).toContain('The mint failed.')
    expect(text()).not.toContain('Items minted')
  })

  it('does not report a mint Safe{Wallet} executed at once as minted when the execution ran another call', async () => {
    mocks.safe = true
    mocks.receipt.mockImplementation(async (_client: unknown, hash: Hex) => ({
      status: 'success',
      transactionHash: hash,
      logs: [{ address: ACCOUNT, topics: [EXECUTION_SUCCESS, SAFE_TX], data: `0x${'00'.repeat(32)}` }],
    }))
    executesSentMint('0xdeadbeef')
    await mint()
    expect(mocks.client.getTransaction).toHaveBeenCalledWith({ hash: PROPOSAL })
    expect(text()).toContain('Mint submitted')
    expect(text()).not.toContain('Items minted')
  })

  it("does not report a Safe app mint whose receipt doesn't show its proposal ran", async () => {
    mocks.safe = true
    mocks.receipt.mockImplementation(async (_client: unknown, hash: Hex) => ({
      status: 'success',
      transactionHash: hash,
      logs: [],
    }))
    await mint()
    expect(text()).toContain('Mint submitted')
    expect(text()).not.toContain('Items minted')
  })

  it('stops before the wallet when the Safe connection changes after review', async () => {
    mocks.review.mockImplementation(async () => {
      // A WalletConnect peer read lands mid-flow: the reviewed call was not a Safe proposal.
      mocks.safe = true
    })
    await mint()
    expect(mocks.write).not.toHaveBeenCalled()
    expect(text()).toContain('Wallet connection changed. Review the free mint again.')
  })
})

function text(): string {
  return JSON.stringify(renderer.toJSON())
}
