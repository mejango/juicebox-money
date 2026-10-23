// @vitest-environment jsdom

/**
 * The SDK decodes each opaque argument; the dialog renders the decoded rows.
 * These cases pin what the dialog itself adds: which addresses read as native
 * ETH, how a router deadline reads, the standing copy behind a blank
 * description, and what an authorization says it commits to.
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeAbiParameters, encodeFunctionData, parseAbi, zeroAddress, type Hex } from 'viem'

const ACCOUNT = '0x2222222222222222222222222222222222222222'

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: ACCOUNT, chainId: 1 }),
}))
vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => createElement('img', { ...props, src: 'asset' }),
}))

import { relayrPaymentReview } from '@/lib/relayr-payment-review'
import { TransactionReviewProvider } from '@/components/TransactionReviewProvider'
import { buildTransactionReviewPrompt, type TransactionReviewRequest } from '@/lib/transaction-review'
import { requireReview } from '../support/prompt-review'
import '../dialog-shim'

const TOKEN = '0x3333333333333333333333333333333333333333'
const TARGET = '0x1111111111111111111111111111111111111111'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function review(request: TransactionReviewRequest): Promise<string> {
  act(() => root.render(<TransactionReviewProvider>{null}</TransactionReviewProvider>))
  await act(async () => {
    // Swallow the cancellation thrown when the modal unmounts after the test.
    requireReview(request).catch(() => {})
  })
  await act(async () => {
    await vi.dynamicImportSettled()
  })
  return document.querySelector('dialog')?.textContent ?? ''
}

describe('decoded transaction review', () => {
  it('decodes the exact network-fee payment without an unavailable ABI warning', async () => {
    const data = `0x103903a7${'11111111222233334444555555555555'.padEnd(64, '0')}${(1900000000n).toString(16).padStart(64, '0')}` as Hex
    const text = await review({
      title: 'Review payment', confirmLabel: 'Pay',
      calls: [{ chainId: 1, to: TARGET, data, value: 100n, gas: 150_000n,
        label: 'Pay network fee', ...relayrPaymentReview(data) }],
    })
    expect(text).toContain('prepayment(bytes16, uint40)')
    expect(text).toContain('0x11111111222233334444555555555555')
    expect(text).toContain('1900000000')
    expect(text).not.toContain('ABI is not available')
  })

  it('reads address zero as native ETH only where it is a pool currency', async () => {
    const abi = parseAbi(['function modifyLiquidities(bytes unlockData, uint256 deadline) payable'])
    const mint = encodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { type: 'address' },
            { type: 'address' },
            { type: 'uint24' },
            { type: 'int24' },
            { type: 'address' },
          ],
        },
        { type: 'int24' },
        { type: 'int24' },
        { type: 'uint256' },
        { type: 'uint128' },
        { type: 'uint128' },
        { type: 'address' },
        { type: 'bytes' },
      ],
      [[zeroAddress, TOKEN, 10_000, 200, zeroAddress], -200, 200, 5n, 7n, 9n, ACCOUNT, '0x'],
    )
    const unlockData = encodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes[]' }],
      ['0x02', [mint]],
    )
    const args = [unlockData, 1_900_000_000n] as const
    const text = await review({
      calls: [
        {
          chainId: 1,
          to: TARGET,
          data: encodeFunctionData({ abi, functionName: 'modifyLiquidities', args }),
          abi,
          functionName: 'modifyLiquidities',
          args,
        },
      ],
    })

    expect(text).toContain('unlockData bytes, decoded')
    expect(text).not.toContain('·')
    expect(text).toContain(`Currency0:native ETH | ${zeroAddress}`)
    expect(text).toContain(`Currency1:${TOKEN}`)
    // A pool with no hook has the zero address as its hook, which is not ETH.
    expect(text).toContain(`Hook:${zeroAddress}`)
    expect(text).not.toContain(`Hook:native ETH`)
  })

  it('shows a router deadline in UTC with its raw seconds', async () => {
    const abi = parseAbi([
      'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
    ])
    const wrap = encodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }],
      ['0x0000000000000000000000000000000000000002', 10n],
    )
    const args = ['0x0b', [wrap], 1_900_000_000n] as const
    const text = await review({
      calls: [
        {
          chainId: 1,
          to: TARGET,
          data: encodeFunctionData({ abi, functionName: 'execute', args }),
          abi,
          functionName: 'execute',
          args,
          value: 10n,
        },
      ],
    })

    expect(text).toContain('Wrap ETH into WETH')
    expect(text).toContain('Deadline:2030-03-17 17:46:40 UTC (1900000000)')
  })

  it('falls back to the standing guidance when a description is blank', async () => {
    const text = await review({
      description: '  \n ',
      calls: [{ chainId: 1, to: TARGET, data: '0xdeadbeef' as Hex }],
    })
    expect(text).toContain(
      'This is the exact destination, native value, and calldata the app will ask your wallet to send.',
    )
  })

  it('shows the sender a transaction names, and no sender it was not given for an authorization', async () => {
    let text = await review({ calls: [{ chainId: 1, from: ACCOUNT, to: TARGET, data: '0xdeadbeef' as Hex }] })
    expect(text).toContain(`From${ACCOUNT}`)
    act(() => root.unmount())
    root = createRoot(container)

    text = await review({
      kind: 'authorization',
      authorization: { kind: 'message', message: 'Sign in' },
      calls: [{ chainId: 1, to: TARGET, data: '0xdeadbeef' as Hex }],
    })
    expect(text).not.toContain(`From${ACCOUNT}`)
    // A message-signed authorization names a message, not typed data.
    expect(text).toContain('The Raw view also includes the exact message your signature commits to.')
    expect(text).toContain('plus the exact message your signature commits to')
    expect(text).not.toContain('typed data')
  })
})


it('keeps the audit action inside the first transaction card and copies the complete review', async () => {
  const request: TransactionReviewRequest = {
    kind: 'transaction',
    calls: [
      { chainId: 1, from: ACCOUNT, to: TARGET, data: '0x', value: 1n, label: 'First payment' },
      { chainId: 8453, from: ACCOUNT, to: TOKEN, data: '0x', value: 2n, label: 'Second payment' },
    ],
  }
  const writeText = vi.fn().mockResolvedValue(undefined)
  const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  try {
    await review(request)
    const dialog = document.querySelector('dialog')!
    expect(dialog.querySelector('header')?.textContent).not.toContain('Client safety check')
    expect(dialog.querySelector('h2')?.textContent).toBe('Review transaction')
    const button = [...dialog.querySelectorAll('button')].find(item => item.textContent === '[copy tx audit prompt]')!
    const card = button.closest('section')!
    expect(card.querySelector('h3')?.textContent).toBe('First payment')
    expect(button.parentElement?.textContent).toContain('chain 1')
    expect(dialog.querySelectorAll('section')).toHaveLength(2)
    expect([...dialog.querySelectorAll('button')].filter(item => item.textContent === '[copy tx audit prompt]')).toHaveLength(1)
    await act(async () => button.click())
    expect(writeText).toHaveBeenCalledWith(buildTransactionReviewPrompt(request))
  } finally {
    if (previous) Object.defineProperty(navigator, 'clipboard', previous)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})
