// @vitest-environment jsdom

/**
 * A liquidity plan bakes its position owner or fee recipient into the
 * reviewed bytes, and sends its steps one after another: each approval, then
 * the mint or edit, once the step before it confirms. When the wallet
 * switches to another account part way, the next step must not go out from
 * that account: nothing more reaches the wallet, and the dialog says why.
 * A claim or a removal frozen for one account is never sent by another.
 *
 * The real useSafeTx, useStepRun and the SDK's reviewed write run here; only
 * the wallet, the RPC and the app review are fakes.
 */

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { zeroAddress, type Address, type Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address
const TOKEN = '0x3333333333333333333333333333333333333333' as Address
const POSITION_MANAGER = '0x4444444444444444444444444444444444444444' as Address
const CHANGED = 'The connected account changed. Review again.'

/** The plan's own bytes name the account they were reviewed for. */
const unlockDataFor = (account: string) => (account === ALICE ? '0xaa' : '0xbb') as Hex
const ERC20 = [{ currency: TOKEN, max: 10n ** 18n }]

vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@wagmi/core', async importOriginal => {
  const { wallet } = await import('../support/fake-wallet')
  return {
    ...(await importOriginal<typeof import('@wagmi/core')>()),
    getAccount: () => ({ address: wallet.account, chainId: 1 }),
  }
})
vi.mock('wagmi', async importOriginal => {
  const { walletHooks } = await import('../support/fake-wallet')
  return { ...(await importOriginal<typeof import('wagmi')>()), ...walletHooks }
})
vi.mock('@/hooks/useWallet', async () => {
  const { useFakeWallet } = await import('../support/fake-wallet')
  return { useWallet: useFakeWallet }
})
vi.mock('@/hooks/useViewedAccount', async () => {
  const { wallet } = await import('../support/fake-wallet')
  return {
    useViewedAccount: () => {
      const account = wallet.useAccount()
      return { address: account, connectedAddress: account, isViewAs: false }
    },
  }
})
vi.mock('@/lib/transaction-review', async importOriginal => {
  const { wallet } = await import('../support/fake-wallet')
  return {
    ...(await importOriginal<typeof import('@/lib/transaction-review')>()),
    requestContractTransactionReview: wallet.requestReview,
  }
})
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => false,
  useSafeConnection: () => false,
}))
vi.mock('@/hooks/useProjectTokenSymbol', () => ({
  useProjectTokenSymbol: () => ({ data: { symbol: 'TKN' } }),
}))
vi.mock('@/hooks/useCashOutFloor', () => ({ useCashOutFloor: () => ({ data: null }) }))
vi.mock('@/components/project/LiquidityRangePreview', () => ({ LiquidityRangePreview: () => null }))
vi.mock('@/components/project/MarketSection', async importOriginal => ({
  ...(await importOriginal<typeof import('@/components/project/MarketSection')>()),
  resolveMarket: async () => POOL,
  // Alice and Bob both hold positions in the pool, so a switch keeps the table up.
  readUserLpPositions: async (_client: unknown, _chainId: number, _pool: unknown, holder: string) =>
    holder.toLowerCase() === ALICE.toLowerCase() ? [TOKEN_SIDE, PAIR_SIDE] : [BOB_SIDE],
}))
vi.mock('@bananapus/nana-sdk-core/v6', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core/v6')>()),
  getTokenAddress: async () => TOKEN,
  readUniswapV4PositionFees: async () => ({ amount0: 10n ** 15n, amount1: 10n ** 15n }),
}))
vi.mock('@/lib/uniswap-v4', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/uniswap-v4')>()),
  solveRangeFromAmounts: () => ({ minPrice: 0.5, maxPrice: 2 }),
  POSITION_MANAGER_BY_CHAIN: { 1: '0x4444444444444444444444444444444444444444' },
}))
vi.mock('@/lib/lp-mint', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/lp-mint')>()),
  buildMint: ({ account }: { account: string }) => ({
    unlockData: unlockDataFor(account),
    value: 0n,
    erc20: ERC20,
    tickLower: -200,
    tickUpper: 200,
    liquidity: 1n,
    need: { amount0: 0n, amount1: 10n ** 18n },
    amount0Max: 0n,
    amount1Max: 10n ** 18n,
  }),
}))
vi.mock('@/lib/edit-liquidity', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/edit-liquidity')>()),
  bandPrices: () => ({ min: 0.5, max: 2 }),
  buildEditLiquidityPlan: ({ account }: { account: string }) => ({
    ...EMPTY_EDIT,
    kind: 'increase',
    unlockData: unlockDataFor(account),
  }),
  describeEditLiquidityPlan: () => ({ lead: 'Tops up the position.', detail: '', tech: '' }),
  editLiquidityStillFits: () => null,
}))
vi.mock('@/lib/market-liquidity', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/market-liquidity')>()),
  buildMarketEdit: ({ account }: { account: string }) => ({
    ...EMPTY_EDIT,
    token: null,
    pair: null,
    refit: false,
    unlockData: unlockDataFor(account),
  }),
  marketEditStillFits: () => null,
}))

const EMPTY_EDIT = {
  erc20: ERC20,
  value: 0n,
  tokenFlow: 0n,
  pairFlow: 0n,
  tokenFunding: 0n,
  pairFunding: 0n,
  tokenMinimum: 0n,
  pairMinimum: 0n,
  tokenHolding: 0n,
  pairHolding: 0n,
  tickLower: -200,
  tickUpper: 200,
  liquidity: 1n,
  liquidityBefore: 1n,
  liquidityDelta: 0n,
  amount0Max: 0n,
  amount1Max: 0n,
  tokenId: 7n,
  mint: null,
  actions: '',
  parameters: [],
}
const POOL = {
  status: 'pool' as const,
  hook: zeroAddress,
  pair: { addr: zeroAddress, tokenOrig: zeroAddress, decimals: 18, symbol: 'ETH', isNative: true },
  key: { currency0: zeroAddress, currency1: TOKEN, fee: 10_000, tickSpacing: 200, hooks: zeroAddress },
  sqrtP: 2n ** 96n,
  poolId: `0x${'55'.repeat(32)}` as Hex,
  pairIsC0: true,
  price: 1,
  issuance: 2,
}
const TOKEN_SIDE = { tokenId: 7n, tickLower: 0, tickUpper: 200, liquidity: 1n, pairAmount: 0n, tokenAmount: 10n ** 18n }
const PAIR_SIDE = { tokenId: 8n, tickLower: -200, tickUpper: 0, liquidity: 1n, pairAmount: 10n ** 18n, tokenAmount: 0n }
const BOB_SIDE = { tokenId: 9n, tickLower: -400, tickUpper: -200, liquidity: 1n, pairAmount: 10n ** 18n, tokenAmount: 0n }

import { sentHash, wallet } from '../support/fake-wallet'
import { ModalShell } from '@/components/ui/ModalShell'
import { AddLiquidityFlow } from '@/components/project/AddLiquidityFlow'
import { EditPositionPanel } from '@/components/project/EditPositionPanel'
import { LiquidityPositions } from '@/components/project/LiquidityPositions'
import { MarketEditPanel } from '@/components/project/MarketEditPanel'

let host: HTMLDivElement
let root: Root
let queryClient: QueryClient

beforeEach(() => {
  wallet.reset()
  wallet.connect(ALICE)
  wallet.client.readContract.mockImplementation(async ({ functionName, args }) => {
    if (functionName === 'allowance') return args?.length === 3 ? [0n, 0, 0] : 0n
    if (functionName === 'balanceOf') return 10n ** 30n
    throw new Error(`Unexpected read ${functionName}`)
  })
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function render(flow: ReactElement) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <ModalShell title="Liquidity" onClose={() => {}}>
          {flow}
        </ModalShell>
      </QueryClientProvider>,
    ),
  )
}

/** Let queries, effects and async sends run until `done` holds. */
async function waitUntil(done: () => boolean) {
  for (let attempt = 0; attempt < 50 && !done(); attempt++) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
}

function button(label: string, inConfirm = false): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(
    item => item.textContent === label && !!item.closest('[data-tx-confirm]') === inConfirm,
  )
  expect(found, label).toBeDefined()
  return found!
}

async function click(label: string, inConfirm = false) {
  await act(async () => button(label, inConfirm).click())
  await waitUntil(() => false)
}

/** The confirm dialog's action. */
async function confirm() {
  const action = host.querySelector<HTMLButtonElement>('[data-tx-confirm] footer .btn-primary')
  expect(action, 'the confirm dialog action').not.toBeNull()
  await act(async () => action!.click())
  await waitUntil(() => false)
}

async function typeInto(label: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  expect(input, label).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/**
 * Alice's first step (the ERC-20 approval) reaches her wallet; the wallet then
 * switches to Bob and that approval confirms, which starts the next step.
 */
async function switchWhileTheFirstStepConfirms() {
  await confirm()
  expect(wallet.writes()).toEqual([{ functionName: 'approve', account: ALICE }])
  await act(async () => wallet.connect(BOB))
  await act(async () => wallet.confirm(sentHash(1)))
  await waitUntil(() => wallet.writeContract.mock.calls.length > 1 || !!host.textContent?.includes(CHANGED))
}

describe('a liquidity plan reviewed for one account', () => {
  it('wallet-action:add-uniswap-v4-liquidity never sends its next step from an account switched to mid-run', async () => {
    await render(<AddLiquidityFlow chainId={1} projectId={7} tokenSymbol="TKN" />)
    await waitUntil(() => !!host.querySelector('input[aria-label="TKN amount"]'))
    await typeInto('TKN amount', '1')
    await click('Add liquidity')

    await switchWhileTheFirstStepConfirms()

    expect(wallet.writes()).toEqual([{ functionName: 'approve', account: ALICE }])
    expect(host.textContent).toContain(CHANGED)
  })

  it('wallet-action:edit-uniswap-v4-liquidity never sends its next step from an account switched to mid-run', async () => {
    await render(
      <EditPositionPanel
        chainId={1}
        projectId={7}
        pool={POOL as never}
        positionManager={POSITION_MANAGER}
        position={TOKEN_SIDE}
        sym="TKN"
        floor={null}
        onClose={() => {}}
        onDone={() => {}}
      />,
    )
    await waitUntil(() => false)
    await click('Edit position')

    await switchWhileTheFirstStepConfirms()

    expect(wallet.writes()).toEqual([{ functionName: 'approve', account: ALICE }])
    expect(host.textContent).toContain(CHANGED)
  })

  it('wallet-action:make-or-edit-a-uniswap-v4-market never sends its next step from an account switched to mid-run', async () => {
    await render(
      <MarketEditPanel
        chainId={1}
        projectId={7}
        pool={POOL as never}
        positionManager={POSITION_MANAGER}
        sides={{ tokenSide: TOKEN_SIDE, pairSide: PAIR_SIDE }}
        sym="TKN"
        floor={0.5}
        onClose={() => {}}
        onDone={() => {}}
      />,
    )
    await waitUntil(() => false)
    await click('Edit the market')

    await switchWhileTheFirstStepConfirms()

    expect(wallet.writes()).toEqual([{ functionName: 'approve', account: ALICE }])
    expect(host.textContent).toContain(CHANGED)
  })

  it('sends every step from the account that reviewed it', async () => {
    await render(<AddLiquidityFlow chainId={1} projectId={7} tokenSymbol="TKN" />)
    await waitUntil(() => !!host.querySelector('input[aria-label="TKN amount"]'))
    await typeInto('TKN amount', '1')
    await click('Add liquidity')
    await confirm()
    await act(async () => wallet.confirm(sentHash(1)))
    await waitUntil(() => wallet.writeContract.mock.calls.length > 1)
    await act(async () => wallet.confirm(sentHash(2)))
    await waitUntil(() => wallet.writeContract.mock.calls.length > 2)

    expect(wallet.writes()).toEqual([
      { functionName: 'approve', account: ALICE },
      { functionName: 'approve', account: ALICE },
      { functionName: 'modifyLiquidities', account: ALICE },
    ])
  })
})

describe('an LP fee claim reviewed for one account', () => {
  it('wallet-action:claim-uniswap-v4-lp-fees never claims from an account switched to before confirming', async () => {
    await render(<LiquidityPositions chains={[{ chainId: 1, projectId: 7 }]} sym="TKN" />)
    await waitUntil(() => [...host.querySelectorAll('button')].some(item => item.textContent === 'Claim fees'))
    await click('Claim fees')
    expect(host.querySelector('[data-tx-confirm]')).not.toBeNull()

    await act(async () => wallet.connect(BOB))
    // Bob's own position loads; the claim frozen for Alice's stays open.
    await waitUntil(() => !!host.querySelector('[data-tx-confirm]') && !host.textContent?.includes('Reading your positions'))
    await confirm()

    expect(wallet.writeContract).not.toHaveBeenCalled()
    expect(wallet.requestReview).not.toHaveBeenCalled()
    expect(host.textContent).toContain(CHANGED)
  })
})
