// @vitest-environment jsdom

/**
 * Each liquidity flow sends a plan's steps one after another, from a confirm
 * hosted in the ModalShell that holds the flow (as OwnersTab hosts them).
 *
 * - A run that stopped part way belongs to that plan only: after the account
 *   changes and a new plan is reviewed, confirming must start the new plan,
 *   never send the old plan's stopped step (an approval for another account,
 *   or a write whose recipient is baked into its bytes).
 * - While a send is in flight, the shell does not close: Escape, a backdrop
 *   click or its × would drop the run, and reopening would send it again.
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
const H1 = `0x${'a1'.repeat(32)}` as Hex
const H2 = `0x${'a2'.repeat(32)}` as Hex
const H3 = `0x${'a3'.repeat(32)}` as Hex

const m = vi.hoisted(() => ({ account: '' as string }))

/** The plan's own bytes name the account they were reviewed for. */
const unlockDataFor = (account: string) => (account === ALICE ? '0xaa' : '0xbb') as Hex
const ERC20 = [{ currency: TOKEN, max: 10n ** 18n }]

vi.mock('@/hooks/useSafeTx', async () => {
  const { engine } = await import('../support/lp-flow-harness')
  return { useSafeTx: () => engine.useSafeTx() }
})
vi.mock('wagmi', async importOriginal => ({
  ...(await importOriginal<typeof import('wagmi')>()),
  usePublicClient: () => client,
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ isConnected: true, address: m.account, openSignIn: () => {} }),
}))
vi.mock('@/hooks/useViewedAccount', () => ({
  useViewedAccount: () => ({ connectedAddress: m.account, isViewAs: false }),
}))
vi.mock('@/hooks/useProjectTokenSymbol', () => ({
  useProjectTokenSymbol: () => ({ data: { symbol: 'TKN' } }),
}))
vi.mock('@/hooks/useCashOutFloor', () => ({ useCashOutFloor: () => ({ data: null }) }))
vi.mock('@/components/project/LiquidityRangePreview', () => ({ LiquidityRangePreview: () => null }))
vi.mock('@/components/project/MarketSection', async importOriginal => ({
  ...(await importOriginal<typeof import('@/components/project/MarketSection')>()),
  resolveMarket: async () => POOL,
  readUserLpPositions: async () => [TOKEN_SIDE, PAIR_SIDE],
}))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => false,
}))
vi.mock('@bananapus/nana-sdk-core/v6', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core/v6')>()),
  getTokenAddress: async () => TOKEN,
}))
vi.mock('@/lib/uniswap-v4', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/uniswap-v4')>()),
  solveRangeFromAmounts: () => ({ minPrice: 0.5, maxPrice: 2 }),
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

const client = {
  readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
    if (functionName === 'allowance') return args?.length === 3 ? [0n, 0, 0] : 0n
    if (functionName === 'balanceOf') return 10n ** 30n
    throw new Error(`Unexpected read ${functionName}`)
  },
  getBalance: async () => 10n ** 30n,
}

import { engine } from '../support/lp-flow-harness'
import { ModalShell } from '@/components/ui/ModalShell'
import { AddLiquidityFlow } from '@/components/project/AddLiquidityFlow'
import { EditPositionPanel } from '@/components/project/EditPositionPanel'
import { MarketEditPanel } from '@/components/project/MarketEditPanel'

let host: HTMLDivElement
let root: Root
let queryClient: QueryClient
let make: () => ReactElement

beforeEach(() => {
  m.account = ALICE
  engine.restart()
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const hostClose = vi.fn()

/**
 * Render the flow inside a ModalShell; `flow` builds a fresh element each
 * time, so a re-render reaches it.
 */
async function render(flow: () => ReactElement) {
  make = () => (
    <QueryClientProvider client={queryClient}>
      <ModalShell title="Liquidity" onClose={hostClose}>
        {flow()}
      </ModalShell>
    </QueryClientProvider>
  )
  await act(async () => root.render(make()))
}

/** Switch the connected wallet; the flow sees it on its next render. */
async function switchAccount(account: Address) {
  m.account = account
  await act(async () => root.render(make()))
}

const settle = () => act(async () => {})

/** Let queries and effects run until the flow shows `selector`. */
async function waitFor(selector: string) {
  for (let attempt = 0; attempt < 50 && !host.querySelector(selector); attempt++) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
  expect(host.querySelector(selector), selector).not.toBeNull()
}

function buttons(): HTMLButtonElement[] {
  return [...host.querySelectorAll('button')]
}

/** The flow's own review button, never the confirm dialog's action. */
async function review(label: string) {
  const button = buttons().find(
    item => item.textContent === label && !item.closest('[data-tx-confirm]'),
  )
  expect(button, label).toBeDefined()
  await act(async () => button!.click())
  await settle()
}

function action(): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>('[data-tx-confirm] footer .btn-primary')
  expect(button, 'the confirm dialog action').not.toBeNull()
  return button!
}

/** Try every way out of the shell: Escape, a backdrop click and its ×. */
async function tryToLeave() {
  const dialog = host.querySelector('dialog')!
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  await act(async () => {
    dialog.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  })
  const [shellClose] = dialog.querySelectorAll<HTMLButtonElement>('button[aria-label="Close"]')
  await act(async () => shellClose.click())
}

async function confirm() {
  await act(async () => action().click())
}

/** Confirm steps one by one: the engine takes each send and it lands. */
async function land(...hashes: Hex[]) {
  for (const [index, hash] of hashes.entries()) {
    await act(async () => engine.answer(hash))
    await act(async () => engine.confirm(hash, 10n + BigInt(index)))
  }
}

async function typeInto(label: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  expect(input, label).not.toBeNull()
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const sent = () => engine.send.mock.calls.map(([request]) => request as Record<string, unknown>)

/** Stop at step k, switch account, review a new plan, and confirm it. */
async function replanAfterStop({
  reviewLabel,
  stoppedAction,
  stoppedError,
  finalAction,
}: {
  reviewLabel: string
  stoppedAction: string
  stoppedError: string
  finalAction: string
}) {
  expect(action().textContent).toBe(stoppedAction)
  expect(host.textContent).toContain(stoppedError)
  await switchAccount(BOB)
  await confirm()
  expect(host.textContent).toContain('Your connected account changed — review again.')
  expect(host.querySelector('[data-tx-confirm]')).toBeNull()

  await review(reviewLabel)
  // The new plan's review shows nothing of the old run.
  expect(action().textContent).toBe(finalAction)
  expect(host.textContent).not.toContain(stoppedError)
  await confirm()
  const first = sent().at(-1)!
  // The new plan's first step: the approval for Bob, never the old plan's stopped step.
  expect(first).toMatchObject({ address: TOKEN, functionName: 'approve' })
  expect(sent().filter(request => request.functionName === 'modifyLiquidities')).toHaveLength(
    stoppedAction.startsWith('Retry step 3') ? 1 : 0,
  )
}

describe('a stopped liquidity run never continues on a newly reviewed plan', () => {
  it('add liquidity', async () => {
    await render(() => <AddLiquidityFlow chainId={1} projectId={7} tokenSymbol="TKN" />)
    await waitFor('input[aria-label="TKN amount"]')
    await typeInto('TKN amount', '1')
    await review('Add liquidity')
    await confirm()
    await land(H1, H2)
    expect(sent().map(request => request.functionName)).toEqual(['approve', 'approve', 'modifyLiquidities'])
    // Alice rejects the mint in her wallet: the run stops at step 3.
    await act(async () => engine.fail('Transaction cancelled.'))
    await act(async () => engine.answer(null))

    await replanAfterStop({
      reviewLabel: 'Add liquidity',
      stoppedAction: 'Retry step 3 of 3',
      stoppedError: 'Transaction cancelled.',
      finalAction: 'Confirm & add liquidity',
    })
  })

  it('edit position', async () => {
    await render(() => (
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
      />
    ))
    await settle()
    await review('Edit position')
    await confirm()
    await land(H1, H2)
    // The edit itself fails for Alice: the run stops at step 3 with that error.
    await act(async () => engine.answer(H3))
    await act(async () => engine.fail('Old failure'))

    await replanAfterStop({
      reviewLabel: 'Edit position',
      stoppedAction: 'Retry step 3 of 3',
      stoppedError: 'Old failure',
      finalAction: 'Increase the position',
    })
  })

  it('edit market', async () => {
    await render(() => (
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
      />
    ))
    await settle()
    await review('Edit the market')
    await confirm()
    await land(H1)
    // Alice rejects the position-manager authorization in her wallet: the run stops at step 2.
    await act(async () => engine.fail('Transaction cancelled.'))
    await act(async () => engine.answer(null))

    await replanAfterStop({
      reviewLabel: 'Edit the market',
      stoppedAction: 'Retry step 2 of 3',
      stoppedError: 'Transaction cancelled.',
      finalAction: 'Edit the market',
    })
    // Neither plan's Permit2 authorization was sent again in Alice's name.
    expect(sent().filter(request => request.functionName === 'approve')).toHaveLength(3)
  })
})

describe('a liquidity run keeps its modal open while a send is in flight', () => {
  it('add liquidity', async () => {
    await render(() => <AddLiquidityFlow chainId={1} projectId={7} tokenSymbol="TKN" />)
    await waitFor('input[aria-label="TKN amount"]')
    await typeInto('TKN amount', '1')
    await review('Add liquidity')
    await confirm()
    // The first approval waits on the wallet.
    expect(engine.send).toHaveBeenCalledTimes(1)
    await tryToLeave()
    expect(hostClose).not.toHaveBeenCalled()

    // The mint is pending onchain.
    await land(H1, H2)
    await act(async () => engine.answer(H3))
    await tryToLeave()
    expect(hostClose).not.toHaveBeenCalled()
    expect(host.querySelector('[data-tx-confirm]')).not.toBeNull()

    // Once the run is done, the shell closes again.
    await act(async () => engine.confirm(H3, 12n))
    await tryToLeave()
    expect(hostClose).toHaveBeenCalled()
  })

  it('edit position', async () => {
    await render(() => (
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
      />
    ))
    await settle()
    await review('Edit position')
    await confirm()
    expect(engine.send).toHaveBeenCalledTimes(1)

    await tryToLeave()
    expect(hostClose).not.toHaveBeenCalled()
    expect(host.querySelector('[data-tx-confirm]')).not.toBeNull()
  })

  it('edit market', async () => {
    await render(() => (
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
      />
    ))
    await settle()
    await review('Edit the market')
    await confirm()
    expect(engine.send).toHaveBeenCalledTimes(1)

    await tryToLeave()
    expect(hostClose).not.toHaveBeenCalled()
    expect(host.querySelector('[data-tx-confirm]')).not.toBeNull()
  })
})
