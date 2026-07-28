import { getAddress, type Address } from 'viem'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))

import { safesForOwner } from '@/lib/safe'

const OWNER = '0x1111111111111111111111111111111111111111' as Address
const SAFE_A = '0x4444444444444444444444444444444444444444'
const SAFE_B = '0x5555555555555555555555555555555555555555'

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('safesForOwner', () => {
  it('maps the owners endpoint response to checksummed Safes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ safes: [SAFE_A, SAFE_B, 'not-an-address'] }))
    vi.stubGlobal('fetch', fetchMock)

    const safes = await safesForOwner(OWNER, 1)

    expect(safes).toEqual([getAddress(SAFE_A), getAddress(SAFE_B)])
    const url = String(fetchMock.mock.calls[0]?.[0])
    expect(url).toBe(
      `https://api.safe.global/tx-service/eth/api/v1/owners/${getAddress(OWNER)}/safes/`,
    )
  })

  it('returns nothing for chains without a hosted Safe service, without fetching', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(safesForOwner(OWNER, 421614)).resolves.toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('degrades service errors and non-OK responses to an empty list', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({}, 503))
    vi.stubGlobal('fetch', fetchMock)
    await expect(safesForOwner(OWNER, 1)).resolves.toEqual([])

    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await expect(safesForOwner(OWNER, 1)).resolves.toEqual([])
  })
})
