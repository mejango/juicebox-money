import { describe, expect, it, vi } from 'vitest'
const invalidate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('@/lib/project-server-data', () => ({ invalidateProjectDisplay: invalidate }))
import { refreshProjectDisplay } from '@/app/actions/project-display'

describe('public display refresh action', () => {
  it('invalidates the exact requested project', async () => {
    await refreshProjectDisplay(8453, 7)
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(8453, 7)
  })
  it.each([[0, 7], [1, -1], [1, 2.5], [Number.NaN, 7], [1, Number.MAX_SAFE_INTEGER + 1]])(
    'rejects invalid identity %s:%s before accessing the cache', async (chainId, projectId) => {
      await expect(refreshProjectDisplay(chainId, projectId)).rejects.toThrow('Invalid project identity')
      expect(invalidate).not.toHaveBeenCalled()
    },
  )
})
