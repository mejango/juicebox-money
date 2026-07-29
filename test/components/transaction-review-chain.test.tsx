// @vitest-environment jsdom

/**
 * The review modal is the last surface between a click and a signature, and
 * the chain it names is the difference between paying a project and paying a
 * lookalike on a testnet. Chain identity here must be readable at a glance,
 * so the chip carries the chain mark as well as the name.
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, chainId: undefined }),
}))
vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) =>
    createElement('img', { ...props, src: 'asset' }),
}))

import { TransactionReviewProvider } from '@/components/TransactionReviewProvider'
import { requireTransactionReview } from '@/lib/transaction-review'
import '../dialog-shim'

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

async function openReviewOn(chainId: number) {
  act(() =>
    root.render(<TransactionReviewProvider>{null}</TransactionReviewProvider>),
  )
  await act(async () => {
    // Swallow the cancellation thrown when the modal unmounts after the test.
    requireTransactionReview({
      calls: [
        {
          chainId,
          to: '0x1111111111111111111111111111111111111111',
          data: '0xdeadbeef',
        },
      ],
    }).catch(() => {})
  })
}

describe('transaction review chain identity', () => {
  it('renders the chain mark beside the chain name', async () => {
    await openReviewOn(8453)

    const chip = document.querySelector('dialog .chip')
    expect(chip?.textContent).toContain('Base')

    // The name is visible in the chip, so the mark itself is decorative —
    // naming it too would make the chip announce "Base" twice.
    const logo = document.querySelector<HTMLImageElement>('dialog img')
    expect(logo).not.toBeNull()
    expect(logo?.getAttribute('alt')).toBe('')
    expect(logo?.getAttribute('aria-hidden')).toBe('true')
    expect(logo?.hasAttribute('title')).toBe(false)
  })

  it('distinguishes near-identical testnet names by their mark', async () => {
    await openReviewOn(84532)

    expect(
      document.querySelector<HTMLImageElement>('dialog img[aria-hidden="true"]'),
    ).not.toBeNull()
    // Base Sepolia reuses the Base mark, so the mark alone is not the whole
    // story — the visible name must still be present.
    expect(document.querySelector('dialog .chip')?.textContent).toContain(
      'Base Sepolia',
    )
  })
})
