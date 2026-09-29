import type { ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { Address, Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  safe: false,
  review: vi.fn(),
  write: vi.fn(),
  waitSafe: vi.fn(),
  shop: vi.fn(),
  client: { readContract: vi.fn(), simulateContract: vi.fn(), estimateContractGas: vi.fn() },
}))

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const HOOK = '0x2222222222222222222222222222222222222222' as Address
const STORE = '0x3333333333333333333333333333333333333333' as Address
const PROPOSAL = `0x${'ab'.repeat(32)}` as Hex

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
  TxConfirmDialog: ({ onConfirm }: { onConfirm: () => void }) => (
    <button type="button" onClick={onConfirm}>Confirm mint</button>
  ),
}))
vi.mock('@bananapus/nana-sdk-core/v6', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core/v6')>()),
  getProject721Shop: mocks.shop,
}))
vi.mock('@/lib/transaction-review', () => ({ requireContractTransactionReview: mocks.review }))
vi.mock('@/lib/safe-connector', () => ({
  isSafeConnection: () => mocks.safe,
  SAFE_NONCE_GUIDANCE: 'Choose the Safe nonce.',
  waitForSafeExecutionHash: mocks.waitSafe,
}))
vi.mock('@/lib/receipt', () => ({
  isTransactionReceiptUnavailableError: () => false,
  waitForTrackedReceipt: async () => ({ status: 'success' }),
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
  mocks.shop.mockReset().mockResolvedValue({ hook: HOOK })
  mocks.client.readContract.mockReset().mockImplementation(async ({ functionName }: { functionName: string }) =>
    functionName === 'owner' ? ACCOUNT
      : functionName === 'STORE' ? STORE
        : { id: 1n, flags: { allowOwnerMint: true }, remainingSupply: 5 })
  mocks.client.simulateContract.mockReset().mockImplementation(async (request: object) => ({ request }))
  mocks.client.estimateContractGas.mockReset().mockResolvedValue(100_000n)
})

afterEach(async () => { await act(async () => renderer.unmount()) })

describe('free mint gas', () => {
  it('sends the measured gas limit from an ordinary wallet', async () => {
    await mint()
    expect(mocks.review.mock.calls[0][0]).not.toHaveProperty('safeTxGas')
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'mintFor', gas: 200_000n }))
  })

  it('proposes through a Safe app with gas 0 and reviews it as Safe gas 0', async () => {
    mocks.safe = true
    await mint()
    expect(mocks.review).toHaveBeenCalledWith(
      expect.objectContaining({ address: HOOK, functionName: 'mintFor', safeTxGas: 0n }),
      expect.objectContaining({ description: 'Choose the Safe nonce.', confirmLabel: 'Agree & continue to Safe' }),
    )
    // A Safe app signs the sent gas as safeTxGas.
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'mintFor', gas: 0n }))
    expect(mocks.waitSafe).toHaveBeenCalledWith(1, PROPOSAL)
  })
})
