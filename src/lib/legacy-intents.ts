// REMOVE after one release (2026-11). The intent namespaces juicebox.money #129
// (SDK 2.35) keyed its writes by, frozen exactly as that release built them,
// so an attempt it left unresolved still holds the same action after the
// switch to the SDK 2.38 builders (passed as each write's `legacy`).
// Each *Keys helper below returns every namespace the old release could have
// built from the same inputs: its form fields' provenance (useChosen: typed,
// a policy such as Max, or untouched) isn't kept any more, so each is tried.
// More candidates can only add a false block, never a second send.
// Approval steps keep no old keys (ruling): a repeated approval costs gas, not
// funds, and the SDK's approvalIntent still holds one within the same action.

import { intent, writeIntentKey } from '@bananapus/nana-sdk-core/review'
import { isAddress } from 'viem'

// ---- frozen from origin/main src/lib/transaction-builders.ts (#129), unchanged ----

type Chosen = { chainId: number; projectId: number; beneficiary: string; memo: string }

/**
 * An amount in a key: the canonical decimal the user typed ("1", "1.0" and
 * "01.00" are "1"), never units scaled by a token's decimals, which change when
 * the app falls back to another token. Text that isn't a decimal stays as is.
 */
// ponytail: app-side until the SDK's writeIntentKey takes typed decimals (Homerun has the same need).
function decimalKey(text: string): string {
  const trimmed = text.trim()
  const match = /^(\d*)(?:\.(\d*))?$/.exec(trimmed)
  if (!match || (!match[1] && !match[2])) return trimmed
  const whole = match[1].replace(/^0+/, '') || '0'
  const fraction = (match[2] ?? '').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

/** A token in a key: its address, or a provenance marker (useChosen) such as `auto:token`. */
const tokenKey = (token: string) => (isAddress(token, { strict: false }) ? intent.address(token) : token)

/** A payment: the token the user pays with and the typed amount, whatever route (pay or swap) carries it. */
function paymentIntent(p: Chosen & { token: string; amount: string }): string {
  return writeIntentKey('pay', {
    chainId: p.chainId, projectId: p.projectId, token: tokenKey(p.token), amount: p.amount,
    beneficiary: intent.address(p.beneficiary), memo: p.memo,
  })
}

/** A checkout: the collection and the items the user chose, as sorted [tier, quantity] pairs; never its priced total. */
function checkoutIntent(p: Chosen & { token: string; hook: string; items: Record<number, number> }): string {
  const items = Object.entries(p.items)
    .filter(([, quantity]) => quantity > 0)
    .map(([tierId, quantity]) => [Number(tierId), quantity])
    .sort(([a], [b]) => a - b)
  return writeIntentKey('checkout', {
    chainId: p.chainId, projectId: p.projectId, hook: intent.address(p.hook), items, token: tokenKey(p.token),
    beneficiary: intent.address(p.beneficiary), memo: p.memo,
  })
}

/**
 * A cash-out of the project's token: the project (its token is the project's
 * own, so never an address that loads later) and the amount as chosen (useChosen),
 * whatever venue (a pool sale or the terminal) serves it.
 */
function cashOutIntent(p: Omit<Chosen, 'memo'> & { amount: bigint | string }): string {
  return writeIntentKey('cash-out', {
    chainId: p.chainId, projectId: p.projectId, amount: p.amount,
    beneficiary: intent.address(p.beneficiary),
  })
}

const CART_PRUNED_LINE = 'These items are no longer available. Change or clear your cart.'
const CHECKOUT_NOT_READY_LINE = 'Choose a currency these items can be paid in.'

/**
 * The pay panel's write intent. With items chosen it is always the checkout of
 * that preserved choice, blocked while none of them is still available, never
 * a plain payment. The token is the user's own pick, or `auto:token` while they
 * haven't picked one, whatever currency the app falls back to.
 */
function payPanelIntent(p: Chosen & {
  mode: 'pay' | 'addbalance'
  hook?: string | null
  /** The typed amount, as decimalKey keys it. */
  amount: string
  token: { from: string; value: string | null }
  chosenCart: Record<number, number>
  cartCount: number
  /** The checkout can be paid in the selected currency (its metadata is built). */
  checkoutReady: boolean
}): { key: string } | { blocked: string } {
  const token = p.token.from === 'typed' && p.token.value ? p.token.value : 'auto:token'
  if (p.mode !== 'pay') {
    return { key: writeIntentKey('add-to-balance', { chainId: p.chainId, projectId: p.projectId, token: tokenKey(token), amount: p.amount, memo: p.memo }) }
  }
  // Items chosen: a checkout of them or nothing, until the user changes or clears the cart.
  if (Object.values(p.chosenCart).some(quantity => quantity > 0)) {
    if (p.cartCount === 0) return { blocked: CART_PRUNED_LINE }
    if (!p.checkoutReady || !p.hook) return { blocked: CHECKOUT_NOT_READY_LINE }
    return { key: checkoutIntent({ ...p, hook: p.hook, token, items: p.chosenCart }) }
  }
  return { key: paymentIntent({ ...p, token }) }
}

/** A move to another chain: the bridge, the backing token, the amount as chosen (useChosen) and beneficiary; never the reclaim minimum it quotes. */
function moveIntent(p: { chainId: number; sucker: string; token: string; amount: bigint | string; beneficiary: string }): string {
  return writeIntentKey('bridge-prepare', {
    chainId: p.chainId, sucker: intent.address(p.sucker), token: intent.address(p.token), amount: p.amount,
    beneficiary: intent.address(p.beneficiary),
  })
}

/** Sending a bridge's queued outbox for a token: the bridge and token, by this account; never the fee it requotes. */
function bridgeSendIntent(p: { chainId: number; sucker: string; token: string; account: string }): string {
  return writeIntentKey('bridge-send', {
    chainId: p.chainId, sucker: intent.address(p.sucker), token: intent.address(p.token), account: intent.address(p.account),
  })
}

/** Syncing a bridge's accounting data: the bridge, by this account; never the fee it requotes. */
function bridgeSyncIntent(p: { chainId: number; sucker: string; account: string }): string {
  return writeIntentKey('bridge-sync', { chainId: p.chainId, sucker: intent.address(p.sucker), account: intent.address(p.account) })
}


// ---- the old keys, per write, from today's inputs ----

/** Every key an old useChosen amount field could have given: typed, Max, or untouched. */
function chosenKeys(text: string, field: string, policies: readonly string[] = ['max']): string[] {
  return [decimalKey(text), ...policies.map(policy => `policy:${policy}`), `auto:${field}`]
}

/** A payment, checkout or add to balance: the pay panel's old key, with the token picked or untouched. */
export function legacyPayKeys(p: {
  mode: 'pay' | 'addbalance'; chainId: number; projectId: number; hook?: string | null; amount: string
  token: string; cart: Record<number, number>; checkoutReady: boolean; beneficiary: string; memo: string
}): string[] {
  const keys = [p.token, null].flatMap(picked => {
    const plan = payPanelIntent({
      ...p, amount: decimalKey(p.amount), token: picked ? { from: 'typed', value: picked } : { from: 'auto', value: null },
      chosenCart: p.cart, cartCount: Object.values(p.cart).reduce((sum, quantity) => sum + quantity, 0),
    })
    return 'key' in plan ? [plan.key] : []
  })
  return [...new Set(keys)]
}

export function legacyCashOutKeys(p: { chainId: number; projectId: number; amount: string; beneficiary: string }): string[] {
  return chosenKeys(p.amount, 'amount').map(amount => cashOutIntent({ ...p, amount }))
}

export function legacyMoveKeys(p: { chainId: number; sucker: string; token: string; amount: string; beneficiary: string }): string[] {
  return chosenKeys(p.amount, 'amount').map(amount => moveIntent({ ...p, amount }))
}

export const legacyBridgeSendKey = (p: { chainId: number; sucker: string; token: string; account: string }) => bridgeSendIntent(p)
export const legacyBridgeSyncKey = (p: { chainId: number; sucker: string; account: string }) => bridgeSyncIntent(p)

/** Every combination of the old keyed fields. */
function combinations<T extends Record<string, readonly unknown[]>>(fields: T): { [K in keyof T]: T[K][number] }[] {
  return Object.entries(fields).reduce<Record<string, unknown>[]>(
    (rows, [name, values]) => rows.flatMap(row => values.map(value => ({ ...row, [name]: value }))),
    [{}],
  ) as { [K in keyof T]: T[K][number] }[]
}

const rangeKey = (min: string, max: string) => ({ min: decimalKey(min), max: decimalKey(max) })

export function legacyAddLiquidityKeys(p: {
  market: boolean; chainId: number; positionManager: string; pool: string; account: string
  mode: string; tokText: string; pairText: string; min: string; max: string
}): string[] {
  return combinations({
    token: chosenKeys(p.tokText, 'token-amount'),
    pair: chosenKeys(p.pairText, 'pair-amount'),
    range: p.mode === 'range'
      ? [rangeKey(p.min, p.max), 'policy:default', 'policy:solved', 'policy:full', 'auto:range']
      : [undefined],
  }).map(({ token, pair, range }) => writeIntentKey(p.market ? 'add-market-liquidity' : 'add-liquidity', {
    chainId: p.chainId, positionManager: intent.address(p.positionManager), pool: intent.hex(p.pool), account: intent.address(p.account),
    mode: p.mode, token, pair,
    ...(range === undefined ? {} : { range }),
  }))
}

export function legacyEditPositionKeys(p: {
  chainId: number; positionManager: string; pool: string; tokenId: bigint; account: string
  tokText: string; pairText: string; min: string; max: string
}): string[] {
  return combinations({
    token: [decimalKey(p.tokText), 'policy:keep-current'],
    pair: [decimalKey(p.pairText), 'policy:keep-current'],
    range: [rangeKey(p.min, p.max), 'policy:keep-current', 'policy:fit'],
  }).map(({ token, pair, range }) => writeIntentKey('edit-position', {
    chainId: p.chainId, positionManager: intent.address(p.positionManager), pool: intent.hex(p.pool), tokenId: p.tokenId,
    account: intent.address(p.account), token, pair, range,
  }))
}

export function legacyEditMarketKeys(p: {
  chainId: number; positionManager: string; pool: string; account: string; tokText: string; pairText: string; refit: boolean
}): string[] {
  return combinations({
    token: [decimalKey(p.tokText), 'policy:keep-current', 'auto:token-target'],
    pair: [decimalKey(p.pairText), 'policy:keep-current', 'auto:pair-target'],
    refit: [p.refit, 'auto:refit'],
  }).map(({ token, pair, refit }) => writeIntentKey('edit-market', {
    chainId: p.chainId, positionManager: intent.address(p.positionManager), pool: intent.hex(p.pool),
    account: intent.address(p.account), token, pair, refit,
  }))
}

export const legacyClaimFeesKey = (p: { chainId: number; positionManager: string; account: string; positions: readonly bigint[] }) =>
  writeIntentKey('claim-lp-fees', {
    chainId: p.chainId, positionManager: intent.address(p.positionManager), account: intent.address(p.account), positions: [...p.positions],
  })

export const legacyRemoveLpKey = (p: { chainId: number; positionManager: string; tokenId: bigint; account: string }) =>
  writeIntentKey('remove-lp', { chainId: p.chainId, positionManager: intent.address(p.positionManager), tokenId: p.tokenId, account: intent.address(p.account) })

export const legacyRepayKey = (p: { chainId: number; loanId: string; holder: string }) =>
  writeIntentKey('repay-loan', { chainId: p.chainId, loanId: p.loanId, holder: intent.address(p.holder) })

export function legacyBorrowKeys(p: { chainId: number; projectId: number; token: string; collateral: string; prepaid: number; beneficiary: string }): string[] {
  return chosenKeys(p.collateral, 'amount').map(collateral => writeIntentKey('borrow', {
    chainId: p.chainId, revnetId: p.projectId, token: intent.address(p.token), collateral, prepaid: p.prepaid, beneficiary: intent.address(p.beneficiary),
  }))
}

export function legacyBurnKeys(p: { chainId: number; holder: string; project: bigint; amount: string }): string[] {
  return chosenKeys(p.amount, 'amount').map(amount => writeIntentKey('burn', {
    chainId: p.chainId, holder: intent.address(p.holder), project: String(p.project), amount,
  }))
}

export function legacyAllowanceKeys(p: {
  chainId: number; projectId: number; terminal: string; token: string; amount: string; currency: number; beneficiary: string
}): string[] {
  return chosenKeys(p.amount, 'amount').map(amount => writeIntentKey('use-allowance', {
    chainId: p.chainId, projectId: p.projectId, terminal: intent.address(p.terminal), token: intent.address(p.token), amount,
    currency: p.currency, beneficiary: intent.address(p.beneficiary),
  }))
}

// ---- frozen from origin/main c0d995b (#130, SDK 2.38): the five keys SDK 2.41's builders replace ----
// REMOVE after one release (2026-11). An attempt the live build left unresolved under one of these
// still holds the same action (passed as `legacy`), so a write pending from it blocks a resend.

export const legacyRedeemItemsKey = (p: { chainId: number; projectId: number; hook: string; tokenIds: readonly bigint[]; holder: string }) =>
  writeIntentKey('redeem-items', {
    chainId: p.chainId, projectId: p.projectId, hook: intent.address(p.hook),
    tokenIds: [...p.tokenIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), holder: intent.address(p.holder),
  })

export const legacyUseAllowanceKey = (p: { chainId: number; projectId: number; token: string; currency: number; beneficiary: string }) =>
  writeIntentKey('use-allowance', {
    chainId: p.chainId, projectId: p.projectId, token: intent.address(p.token), currency: p.currency, beneficiary: intent.address(p.beneficiary),
  })

export const legacyBurnKey = (p: { chainId: number; holder: string; project: bigint }) =>
  writeIntentKey('burn', { chainId: p.chainId, holder: intent.address(p.holder), project: p.project })

export const legacySafeBatchKey = (p: { chainId: number; safe: string; calls: readonly { to: string; data: string; value?: bigint }[] }) =>
  writeIntentKey('safe-batch', {
    chainId: p.chainId, safe: intent.address(p.safe), calls: p.calls.map(call => [intent.address(call.to), intent.hex(call.data), call.value ?? 0n]),
  })

/** The sync key #130 built with SDK 2.38's bridgeIntent (the zero address as its token). */
export const legacySyncKey = (p: { chainId: number; sucker: string; account: string }) =>
  writeIntentKey('bridge', {
    chainId: p.chainId, sucker: intent.address(p.sucker), token: intent.address('0x0000000000000000000000000000000000000000'), account: intent.address(p.account),
  })
