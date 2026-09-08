import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  registerFundingChainSelectionHandler,
  requireFundingChainSelection,
} from '@/lib/transaction-review'

const OPTIONS = [
  { chainId: 1, label: 'Ethereum · 0.002 ETH' },
  { chainId: 8453, label: 'Base · 0.001 ETH' },
]
const cleanups: (() => void)[] = []

function handle(handler: Parameters<typeof registerFundingChainSelectionHandler>[0]) {
  const unregister = registerFundingChainSelectionHandler(handler)
  cleanups.push(unregister)
  return unregister
}

afterEach(() => {
  cleanups.splice(0).reverse().forEach(unregister => unregister())
})

describe('explicit funding chain selection', () => {
  it('requires the selection UI even when only one quote is available', async () => {
    await expect(requireFundingChainSelection([OPTIONS[0]])).rejects.toThrow(/selection is unavailable/i)
  })

  it('returns the user choice and restores an earlier provider after unregistering', async () => {
    const earlier = vi.fn().mockResolvedValue(1)
    const latest = vi.fn().mockResolvedValue(8453)
    handle(earlier)
    const unregister = handle(latest)

    await expect(requireFundingChainSelection(OPTIONS)).resolves.toBe(8453)
    expect(latest).toHaveBeenCalledWith(OPTIONS)
    expect(earlier).not.toHaveBeenCalled()
    unregister()
    await expect(requireFundingChainSelection(OPTIONS)).resolves.toBe(1)
  })

  it('cancels without returning a funding chain when the UI closes', async () => {
    handle(async () => null)
    await expect(requireFundingChainSelection(OPTIONS)).rejects.toThrow(/cancelled.*nothing was sent/i)
  })

  it('rejects choices outside the original options even if the caller mutates them', async () => {
    const options = OPTIONS.map(option => ({ ...option }))
    handle(async shown => {
      options[0].chainId = 10
      expect(shown[0].chainId).toBe(1)
      return 10
    })
    await expect(requireFundingChainSelection(options)).rejects.toThrow(/not available in this quote/i)
  })

  it.each([
    { options: [] },
    { options: [OPTIONS[0], OPTIONS[0]] },
    { options: [{ chainId: 0, label: 'Invalid' }] },
    { options: [{ chainId: 1.5, label: 'Invalid' }] },
    { options: [{ chainId: 1, label: ' ' }] },
  ])('rejects invalid options before opening the UI: $options', async ({ options }) => {
    const handler = vi.fn().mockResolvedValue(1)
    handle(handler)
    await expect(requireFundingChainSelection(options)).rejects.toThrow(/no valid funding chain choices/i)
    expect(handler).not.toHaveBeenCalled()
  })
})
