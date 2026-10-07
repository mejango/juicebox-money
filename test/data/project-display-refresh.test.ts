import { describe, expect, it, vi } from 'vitest'
const invalidate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('@/lib/project-server-data', () => ({ invalidateProjectDisplay: invalidate }))
import { refreshProjectDisplay } from '@/app/actions/project-display'

describe('public display refresh action', () => {
  it('invalidates the exact requested project', async () => {
    await refreshProjectDisplay(8453, 7)
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(8453, 7, undefined)
  })
  it('passes the known group to invalidate only related in-flight reads', async () => {
    await refreshProjectDisplay(8453, 7, 'known-group')
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(8453, 7, 'known-group')
  })
  it.each(['', 'x'.repeat(257), 123])('rejects an invalid group %s', async group => {
    await expect(refreshProjectDisplay(8453, 7, group as string)).rejects.toThrow('Invalid project group')
    expect(invalidate).not.toHaveBeenCalled()
  })
  it.each([[0, 7], [1, -1], [1, 2.5], [Number.NaN, 7], [1, Number.MAX_SAFE_INTEGER + 1]])(
    'rejects invalid identity %s:%s before accessing the cache', async (chainId, projectId) => {
      await expect(refreshProjectDisplay(chainId, projectId)).rejects.toThrow('Invalid project identity')
      expect(invalidate).not.toHaveBeenCalled()
    },
  )
})
