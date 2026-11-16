import { QueryClient } from '@tanstack/react-query'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const readSafeQueue = vi.hoisted(() => vi.fn())
vi.mock('@/lib/safe', () => ({ readSafeQueue }))

import { safeQueueQueryOptions } from '@/lib/safe-queue-query'

const SAFE = '0xAbCdEf1111111111111111111111111111111111'

describe('shared Safe queue read', () => {
  it('serves every reader of one Safe on one chain from one read, then reads again once invalidated', async () => {
    readSafeQueue.mockResolvedValue({ nonce: 7, pending: [] })
    const cache = new QueryClient()
    const tray = safeQueueQueryOptions(1, SAFE)
    const card = safeQueueQueryOptions(1, SAFE.toLowerCase() as `0x${string}`)
    expect(card.queryKey).toEqual(tray.queryKey)
    expect(await cache.fetchQuery(tray)).toEqual({ nonce: 7, pending: [] })
    await cache.fetchQuery(card)
    expect(readSafeQueue).toHaveBeenCalledTimes(1)
    await cache.fetchQuery(safeQueueQueryOptions(10, SAFE))
    expect(readSafeQueue).toHaveBeenCalledTimes(2)
    await cache.invalidateQueries({ queryKey: ['safeQueue'] })
    await cache.fetchQuery(card)
    expect(readSafeQueue).toHaveBeenCalledTimes(3)
    cache.clear()
  })

  it('leaves only the two reads before a Safe action outside the shared key', () => {
    const direct = (file: string) =>
      readFileSync(`src/components/project/${file}.tsx`, 'utf8').match(/await readSafeQueue\(/g)?.length ?? 0
    expect(direct('SafeBatchTray')).toBe(0)
    expect(direct('SafeBatchDialog')).toBe(0)
    // freshCanonicalQueuedTx and the saved execution's revalidate read the queue themselves.
    expect(direct('SafeQueueCard')).toBe(2)
    for (const file of ['SafeBatchTray', 'SafeBatchDialog', 'SafeQueueCard']) {
      expect(readFileSync(`src/components/project/${file}.tsx`, 'utf8')).toContain('safeQueueQueryOptions(')
    }
  })
})
