/**
 * Live-mainnet verification of the cash-out plumbing in src/lib/cashOut.ts.
 *
 * Run: npx -y tsx scripts/verify-cash-out.ts
 *
 * 1. eth:3 (Revnet Network, native accounting): resolve the accounting
 *    context, quote a 1e18-token cash-out through the hook-aware route,
 *    assemble the tx request.
 * 2. base:6 (Artizen, USDC accounting): prove context resolution returns the
 *    USDC token/decimals/currency — never assume native.
 */
import {
  getHookAwareCashOutQuote,
  resolvePaymentTerminal,
  type CashOutRoute,
} from '@bananapus/nana-sdk-core/v6'
import { createPublicClient, http, type PublicClient } from 'viem'
import { base, mainnet } from 'viem/chains'
import {
  buildCashOutRequest,
  getCashOutContext,
  getContextCashOutQuote,
  isNativeToken,
} from '../src/lib/cashOut'

const HOLDER = '0x000000000000000000000000000000000000dEaD' as const

/** Assemble a cash-out tx request and check the route's floor invariants. */
function assembleAndCheck(
  chainId: 1 | 8453,
  terminal: `0x${string}`,
  projectId: bigint,
  tokenToReclaim: `0x${string}`,
  route: CashOutRoute,
) {
  const request = buildCashOutRequest({
    chainId,
    terminal,
    holder: HOLDER,
    projectId,
    cashOutCount: 10n ** 18n,
    tokenToReclaim,
    route,
    beneficiary: HOLDER,
  })
  console.log(`${chainId}:${projectId} tx request:`, {
    chainId: request.chainId,
    address: request.address,
    functionName: request.functionName,
    args: request.args.map(String),
  })
  if (request.args[4] !== route.terminalMinimum) {
    throw new Error('minTokensReclaimed does not match the route minimum')
  }
  if (request.args[6] !== route.metadata) {
    throw new Error('metadata does not match the route metadata')
  }
  if (route.route === 'treasury') {
    if (request.args[4] !== route.minimumReturn || request.args[4] === 0n) {
      throw new Error('treasury route must carry a non-zero terminal minimum')
    }
  } else {
    // On the pool route the terminal reclaims nothing — the floor lives in
    // the buyback hook metadata and the terminal minimum must be zero.
    if (request.args[4] !== 0n || request.args[6] === '0x') {
      throw new Error('amm route must carry a zero terminal minimum + metadata')
    }
  }
}

async function main() {
  // ---- eth:3 — Revnet Network (native accounting) ----
  const eth = createPublicClient({
    chain: mainnet,
    transport: http('https://ethereum-rpc.publicnode.com'),
  }) as PublicClient

  const ethContext = await getCashOutContext(eth, {
    chainId: 1,
    projectId: 3n,
  })
  if (!ethContext) throw new Error('eth:3 has no accounting context')
  console.log('eth:3 accounting context:', ethContext)
  console.log('eth:3 token is native:', isNativeToken(ethContext.token))

  const terminal = await resolvePaymentTerminal(eth, {
    chainId: 1,
    projectId: 3n,
    token: ethContext.token,
  })
  console.log('eth:3 terminal:', terminal)

  const route = await getHookAwareCashOutQuote(eth, {
    chainId: 1,
    projectId: 3n,
    holder: HOLDER,
    cashOutCount: 10n ** 18n,
    tokenToReclaim: ethContext.token,
    terminal: terminal.address,
  })
  console.log('eth:3 route for 1e18 tokens:', {
    route: route.route,
    expectedReturn: route.expectedReturn.toString(),
    minimumReturn: route.minimumReturn.toString(),
    terminalMinimum: route.terminalMinimum.toString(),
  })

  if (route.minimumReturn > 0n) {
    assembleAndCheck(1, terminal.address, 3n, ethContext.token, route)
  } else {
    // A zero floor must never produce an unprotected tx.
    let threw = false
    try {
      buildCashOutRequest({
        chainId: 1,
        terminal: terminal.address,
        holder: HOLDER,
        projectId: 3n,
        cashOutCount: 10n ** 18n,
        tokenToReclaim: ethContext.token,
        route,
        beneficiary: HOLDER,
      })
    } catch {
      threw = true
    }
    if (!threw) throw new Error('zero-floor request must throw, not send 0')
    console.log(
      'eth:3 route floor is 0 (V6 treasury is empty) — buildCashOutRequest',
      'correctly refused to assemble an unprotected tx.',
    )
  }

  // ---- eth:1 — Juicebox Protocol V6 (native accounting, non-empty
  // treasury). Exercises the nonzero-quote path end to end. ----
  const jbContext = await getCashOutContext(eth, { chainId: 1, projectId: 1n })
  if (!jbContext) throw new Error('eth:1 has no accounting context')
  console.log('eth:1 accounting context:', jbContext)
  const jbTerminal = await resolvePaymentTerminal(eth, {
    chainId: 1,
    projectId: 1n,
    token: jbContext.token,
  })
  const jbRoute = await getHookAwareCashOutQuote(eth, {
    chainId: 1,
    projectId: 1n,
    holder: HOLDER,
    cashOutCount: 10n ** 18n,
    tokenToReclaim: jbContext.token,
    terminal: jbTerminal.address,
  })
  console.log('eth:1 route for 1e18 tokens:', {
    route: jbRoute.route,
    expectedReturn: jbRoute.expectedReturn.toString(),
    minimumReturn: jbRoute.minimumReturn.toString(),
    terminalMinimum: jbRoute.terminalMinimum.toString(),
  })
  if (jbRoute.minimumReturn > 0n) {
    assembleAndCheck(1, jbTerminal.address, 1n, jbContext.token, jbRoute)
  } else {
    console.log('eth:1 route floor is 0 — skipping tx assembly.')
  }

  // ---- base:6 — Artizen (USDC accounting) ----
  const baseClient = createPublicClient({
    chain: base,
    transport: http('https://base-rpc.publicnode.com'),
  }) as PublicClient

  const artizenContext = await getCashOutContext(baseClient, {
    chainId: 8453,
    projectId: 6n,
  })
  if (!artizenContext) throw new Error('base:6 has no accounting context')
  console.log('base:6 (Artizen) accounting context:', artizenContext)

  const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
  if (artizenContext.token.toLowerCase() !== USDC_BASE)
    throw new Error('expected Artizen accounting token to be Base USDC')
  if (artizenContext.decimals !== 6)
    throw new Error('expected Artizen accounting decimals to be 6')
  if (BigInt(artizenContext.currency) !== BigInt(USDC_BASE) % 2n ** 32n)
    throw new Error('expected uint32(uint160(USDC)) currency')
  console.log(
    'base:6 context is USDC (token/decimals/currency all check out) —',
    'quotes must be requested in 6-decimal USDC terms, not native.',
  )

  const artizenQuote = await getContextCashOutQuote(baseClient, {
    chainId: 8453,
    projectId: 6n,
    cashOutCount: 10n ** 18n,
    context: artizenContext,
  })
  console.log('base:6 display quote for 1e18 tokens (USDC, 6 decimals):', {
    reclaimAmount: artizenQuote.reclaimAmount.toString(),
    reclaimAmountAfterFee: artizenQuote.reclaimAmountAfterFee.toString(),
  })

  console.log('\nAll cash-out verifications passed.')
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
