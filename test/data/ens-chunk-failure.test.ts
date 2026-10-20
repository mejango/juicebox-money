import { expect, it, vi } from 'vitest'

// The first download of the ENS client fails, as a dropped chunk would.
const state = vi.hoisted(() => ({ failures: 1, getEnsAddress: vi.fn(async () => `0x${'ab'.repeat(20)}`) }))
vi.mock('@/lib/ens-client', async () => {
  if (state.failures-- > 0) throw new Error('Loading chunk 3936 failed.')
  return { ensClient: { getEnsAddress: state.getEnsAddress } }
})

import { lookupEnsAddress, resolvedAddress } from '@/lib/ens'

it('a failed client download is not cached as "no address"', async () => {
  expect(await lookupEnsAddress('vitalik.eth')).toBeNull()
  expect(resolvedAddress('vitalik.eth')).toBeNull()
  expect(await lookupEnsAddress('vitalik.eth')).toBe(`0x${'ab'.repeat(20)}`)
  expect(resolvedAddress('vitalik.eth')).toBe(`0x${'ab'.repeat(20)}`)
})
