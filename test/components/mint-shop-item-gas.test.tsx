// @vitest-environment jsdom
/**
 * The free mint through core's reviewed run: one review, the exact mint from
 * the account that reviewed it, minted only once its receipt lands, and held
 * by the write hold when the wallet's reply is lost. Only the wallet, the RPC
 * and the app review are fakes.
 */
import type { ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ safe: false, connectorUid: 'reviewed-wallet', shop: vi.fn() }))

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const HOOK = '0x2222222222222222222222222222222222222222' as Address
const STORE = '0x3333333333333333333333333333333333333333' as Address

vi.mock('wagmi', () => ({ useConfig: () => ({}) }))
vi.mock('@wagmi/core', async importOriginal => {
  const { wallet, walletActions } = await import('../support/fake-wallet')
  return {
    ...(await importOriginal<typeof import('@wagmi/core')>()),
    ...walletActions,
    getAccount: () => ({ address: wallet.account, chainId: 1, connector: { uid: mocks.connectorUid } }),
  }
})
vi.mock('wagmi/actions', async () => {
  const { wallet } = await import('../support/fake-wallet')
  return { getPublicClient: () => wallet.client }
})
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn().mockResolvedValue(undefined), cancelQueries: vi.fn().mockResolvedValue(undefined) }),
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {}, SUPPORTED_CHAINS: [] }))
vi.mock('@/hooks/useWallet', async () => {
  const { useFakeWallet } = await import('../support/fake-wallet')
  return { useWallet: useFakeWallet }
})
vi.mock('@/components/ui/ModalShell', () => ({
  ModalShell: ({ children, footer }: { children: ReactNode; footer: ReactNode }) => (
    <div>{children}{footer}</div>
  ),
}))
vi.mock('@/components/ui/TxProgress', () => ({
  // Once complete, the confirm offers only Done.
  TxProgress: ({ onConfirm, onClose, title, error, complete }: {
    onConfirm: () => void; onClose: () => void; title: string; error?: ReactNode; complete?: boolean
  }) => (
    <div>
      <p>{title}</p>
      {error ? <div>{error}</div> : null}
      {complete
        ? <button type="button" onClick={onClose}>Done</button>
        : <button type="button" onClick={onConfirm}>Confirm mint</button>}
    </div>
  ),
}))
vi.mock('@bananapus/nana-sdk-core/v6', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core/v6')>()),
  getProjectNftInventory: mocks.shop,
}))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => mocks.safe,
  useSafeConnection: () => mocks.safe,
  SAFE_NONCE_GUIDANCE: 'Choose the Safe nonce.',
}))

import { sentHash, wallet } from '../support/fake-wallet'
import { MintShopItemModal } from '@/components/project/MintShopItemModal'

let renderer: ReactTestRenderer

async function settle() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
}

async function click(label: string) {
  const button = renderer.root.findAllByType('button').find(item => item.children.join('') === label)
  expect(button, label).toBeDefined()
  await act(async () => { await button!.props.onClick() })
  await settle()
}

async function mint() {
  await act(async () => {
    renderer = create(
      <MintShopItemModal chainId={1} projectId={7} hook={HOOK} tierId={1} itemName="Hat"
        remaining={5} isRevnet={false} onClose={vi.fn()} />,
    )
  })
  await settle()
  await click('Mint without payment')
  await click('Confirm mint')
}

function text(): string {
  return JSON.stringify(renderer.toJSON())
}

beforeEach(() => {
  mocks.safe = false
  mocks.connectorUid = 'reviewed-wallet'
  localStorage.clear()
  wallet.reset()
  wallet.connect(ACCOUNT)
  vi.stubGlobal('navigator', { locks: { request: async (_key: string, _options: unknown, run: (lock: object) => Promise<unknown>) => run({}) } })
  mocks.shop.mockReset().mockResolvedValue({ hook: HOOK })
  wallet.client.readContract.mockImplementation(async ({ functionName }: { functionName: string }) =>
    functionName === 'owner' ? ACCOUNT
      : functionName === 'STORE' ? STORE
        : { id: 1n, flags: { allowOwnerMint: true }, remainingSupply: 5 })
})

afterEach(async () => {
  await act(async () => renderer.unmount())
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('a free mint through the reviewed run', () => {
  it('wallet-action:mint-shop-tiers-without-payment reviews once, sends the mint from the reviewing account, and says minted once its receipt lands', async () => {
    await mint()
    expect(wallet.requestReview).toHaveBeenCalledOnce()
    expect(wallet.writes()).toEqual([{ functionName: 'mintFor', account: ACCOUNT }])
    expect(text()).not.toContain('Items minted')
    await act(async () => wallet.confirm(sentHash(1)))
    await settle()
    expect(text()).toContain('Items minted')
  })

  it('wallet-action:mint-shop-tiers-without-payment proposes through a Safe app with the nonce guidance, and is never offered again while held', async () => {
    mocks.safe = true
    // The Safe's nonce is 0 and its service queues nothing.
    wallet.client.request.mockImplementation(async ({ method }: { method: string }) => {
      if (method === 'eth_call') return `0x${'0'.repeat(64)}`
      throw new Error(`unexpected ${method}`)
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ count: 0, next: null, previous: null, results: [] }))))
    await mint()
    const [model] = wallet.requestReview.mock.calls[0] as [{ description?: string; confirmLabel?: string }]
    expect(model.description).toContain('Choose the Safe nonce.')
    expect(model.confirmLabel).toBe('Agree & continue to Safe')
    expect(wallet.writes()).toEqual([{ functionName: 'mintFor', account: ACCOUNT }])
    const actions = renderer.root.findAllByType('button').map(button => button.children.join(''))
    expect(text()).toContain('Mint submitted')
    expect(actions).toContain('Done')
    expect(actions).not.toContain('Confirm mint')
    expect(text()).not.toContain('Items minted')
  })

  it('sends nothing on a second attempt after a lost wallet reply, across closing the modal, and shows the held line', async () => {
    wallet.writeContract.mockRejectedValueOnce(new Error('wallet transport disconnected'))
    await mint()
    expect(wallet.writeContract).toHaveBeenCalledOnce()
    await act(async () => renderer.unmount())

    await mint()
    expect(wallet.writeContract).toHaveBeenCalledOnce()
    expect(text()).toContain("Your earlier transaction hasn't confirmed yet. Check your wallet.")
  })

  it('refuses a connector replacement before the wallet opens', async () => {
    let owners = 0
    wallet.client.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      // The final eligibility read lands after another wallet took over the same address.
      if (functionName === 'owner' && ++owners === 2) mocks.connectorUid = 'replacement-wallet'
      return functionName === 'owner' ? ACCOUNT
        : functionName === 'STORE' ? STORE
          : { id: 1n, flags: { allowOwnerMint: true }, remainingSupply: 5 }
    })
    await mint()
    expect(owners).toBeGreaterThanOrEqual(2)
    expect(wallet.writeContract).not.toHaveBeenCalled()
    expect(text()).toContain('Connected wallet changed')
  })

  it('stops before the wallet when the Safe connection changes after review', async () => {
    wallet.requestReview.mockImplementation(async () => {
      // A WalletConnect peer read lands mid-flow: the reviewed call was not a Safe proposal.
      mocks.safe = true
      return true
    })
    await mint()
    expect(wallet.writeContract).not.toHaveBeenCalled()
    expect(text()).toContain('Wallet connection changed. Review the transaction again.')
  })
})
