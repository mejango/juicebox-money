import { QueryClient } from '@tanstack/react-query'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SHOP_721_QUERY_PREFIX, shop721QueryKey } from '@/hooks/useShop721'

describe('shop inventory invalidation', () => {
  it('refreshes the exact minted project and every managed inventory using the shared prefix', async () => {
    const client = new QueryClient()
    const minted = shop721QueryKey(1, 12, false)
    const other = shop721QueryKey(8453, 27, false)
    client.setQueryData(minted, { supply: 0 })
    client.setQueryData(other, { supply: 0 })
    await client.invalidateQueries({ queryKey: minted })
    expect(client.getQueryState(minted)?.isInvalidated).toBe(true)
    expect(client.getQueryState(other)?.isInvalidated).toBe(false)
    await client.fetchQuery({ queryKey: minted, queryFn: async () => ({ supply: 1 }) })
    expect(client.getQueryData(minted)).toEqual({ supply: 1 })
    expect(client.getQueryState(minted)?.isInvalidated).toBe(false)
    await client.invalidateQueries({ queryKey: SHOP_721_QUERY_PREFIX })
    expect(client.getQueryState(minted)?.isInvalidated).toBe(true)
    expect(client.getQueryState(other)?.isInvalidated).toBe(true)
    client.clear()
  })

  it('keeps every successful mint and management caller on the owned key', () => {
    const mint = readFileSync('src/components/project/MintShopItemModal.tsx', 'utf8')
    expect(mint).toContain('queryKey: shop721QueryKey(chainId, projectId, isRevnet)')
    for (const name of ['AddShopItemsModal', 'ReplaceTierMediaModal']) {
      const source = readFileSync(`src/components/project/${name}.tsx`, 'utf8')
      expect(source).toContain('invalidateQueries({ queryKey: SHOP_721_QUERY_PREFIX })')
      expect(source).not.toContain("queryKey: ['shop721']")
    }
  })
})
