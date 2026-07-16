/**
 * Live-mainnet verification of the cash-out plumbing in src/lib/cashOut.ts.
 *
 * Run: npx -y tsx scripts/verify-cash-out.ts
 *
 * 1. eth:3 (Revnet Network, native accounting): resolve the accounting
 *    context, quote a 1e18-token cash-out, assemble the tx request.
 * 2. base:6 (Artizen, USDC accounting): prove context resolution returns the
 *    USDC token/decimals/currency — never assume native.
 */
import { resolvePaymentTerminal } from '@bananapus/nana-sdk-core/v6'
import { createPublicClient, http, type PublicClient } from 'viem'
import { base, mainnet } from 'viem/chains'
import {
  buildCashOutRequest,
  getCashOutContext,
  getContextCashOutQuote,
  isNativeToken,
  minReclaimedFloor,
} from '../src/lib/cashOut'

const HOLDER = '0x000000000000000000000000000000000000dEaD' as const

/** Assemble a cash-out tx request and check the slippage-floor invariants. */
function assembleAndCheck(
  chainId: 1 | 8453,
  terminal: `0x${string}`,
  projectId: bigint,
  tokenToReclaim: `0x${string}`,
  quote: { reclaimAmount: bigint; reclaimAmountAfterFee: bigint },
) {
  const request = buildCashOutRequest({
    chainId,
    terminal,
    holder: HOLDER,
    projectId,
    cashOutCount: 10n ** 18n,
    tokenToReclaim,
    quote,
    beneficiary: HOLDER,
  })
  console.log(`${chainId}:${projectId} tx request:`, {
    chainId: request.chainId,
    address: request.address,
    functionName: request.functionName,
    args: request.args.map(String),
  })
  if (request.args[4] !== minReclaimedFloor(quote)) {
    throw new Error('minTokensReclaimed does not match the 97.5% floor')
  }
  if (request.args[4] === 0n) {
    throw new Error('minTokensReclaimed must never be 0')
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

  const quote = await getContextCashOutQuote(eth, {
    chainId: 1,
    projectId: 3n,
    cashOutCount: 10n ** 18n,
    context: ethContext,
  })
  console.log('eth:3 quote for 1e18 tokens:', {
    reclaimAmount: quote.reclaimAmount.toString(),
    reclaimAmountAfterFee: quote.reclaimAmountAfterFee.toString(),
  })
  console.log(
    'eth:3 min reclaimed floor (97.5%):',
    minReclaimedFloor(quote).toString(),
  )

  const terminal = await resolvePaymentTerminal(eth, {
    chainId: 1,
    projectId: 3n,
    token: ethContext.token,
  })
  console.log('eth:3 terminal:', terminal)

  if (minReclaimedFloor(quote) > 0n) {
    assembleAndCheck(1, terminal.address, 3n, ethContext.token, quote)
  } else {
    // A zero quote must never produce a tx with minTokensReclaimed = 0.
    let threw = false
    try {
      buildCashOutRequest({
        chainId: 1,
        terminal: terminal.address,
        holder: HOLDER,
        projectId: 3n,
        cashOutCount: 10n ** 18n,
        tokenToReclaim: ethContext.token,
        quote,
        beneficiary: HOLDER,
      })
    } catch {
      threw = true
    }
    if (!threw) throw new Error('zero-floor request must throw, not send 0')
    console.log(
      'eth:3 quote is 0 (V6 treasury is empty) — buildCashOutRequest',
      'correctly refused to assemble a tx with minTokensReclaimed = 0.',
    )
  }

  // ---- eth:1 — Juicebox Protocol V6 (native accounting, non-empty
  // treasury). Exercises the nonzero-quote path end to end. ----
  const jbContext = await getCashOutContext(eth, { chainId: 1, projectId: 1n })
  if (!jbContext) throw new Error('eth:1 has no accounting context')
  console.log('eth:1 accounting context:', jbContext)
  const jbQuote = await getContextCashOutQuote(eth, {
    chainId: 1,
    projectId: 1n,
    cashOutCount: 10n ** 18n,
    context: jbContext,
  })
  console.log('eth:1 quote for 1e18 tokens:', {
    reclaimAmount: jbQuote.reclaimAmount.toString(),
    reclaimAmountAfterFee: jbQuote.reclaimAmountAfterFee.toString(),
  })
  if (jbQuote.reclaimAmountAfterFee > 0n) {
    const jbTerminal = await resolvePaymentTerminal(eth, {
      chainId: 1,
      projectId: 1n,
      token: jbContext.token,
    })
    assembleAndCheck(1, jbTerminal.address, 1n, jbContext.token, jbQuote)
  } else {
    console.log('eth:1 quote is 0 — skipping tx assembly.')
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
  console.log('base:6 quote for 1e18 tokens (USDC, 6 decimals):', {
    reclaimAmount: artizenQuote.reclaimAmount.toString(),
    reclaimAmountAfterFee: artizenQuote.reclaimAmountAfterFee.toString(),
  })

  console.log('\nAll cash-out verifications passed.')
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
