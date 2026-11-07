import { describe, expect, it } from 'vitest'
import { shopCategories, shopCategoryChips } from '@/lib/shop-tiers'

const tiers = [{ id: 1, category: 0 }, { id: 2, category: 1 }, { id: 3, category: 4 }, { id: 4, category: 4 }]
const names = (chips: { name: string }[]) => chips.map(chip => chip.name)

describe('shopCategoryChips', () => {
  it('keeps every category that has a name, including category 0 and one named by a single item', () => {
    const media = { 1: { categoryName: 'Banny body' }, 2: { categoryName: 'Background' }, 3: {}, 4: { categoryName: 'Head' } }
    expect(names(shopCategoryChips(tiers, media, false))).toEqual(['Banny body', 'Background', 'Head'])
  })

  it('hides a numbered category beside a named one', () => {
    expect(names(shopCategoryChips(tiers, { 1: {}, 2: { categoryName: 'Hats' }, 3: {}, 4: {} }, false))).toEqual(['General', 'Hats'])
  })

  it('shows no row when no category has a name', () => {
    expect(shopCategoryChips(tiers, { 1: {}, 2: {}, 3: {}, 4: {} }, false)).toEqual([])
  })

  it('shows no numbered chips while metadata is still loading', () => {
    expect(shopCategoryChips(tiers, undefined, false)).toEqual([])
  })

  it('keeps a category whose metadata failed, since its name is unknown', () => {
    expect(names(shopCategoryChips(tiers, { 1: {}, 2: {}, 3: {} }, true))).toEqual(['General', 'Category 4'])
    expect(names(shopCategoryChips(tiers, undefined, true))).toEqual(['General', 'Category 1', 'Category 4'])
  })

  it('has no row for a shop with one category, named or not', () => {
    expect(shopCategoryChips([{ id: 1, category: 3 }], { 1: { categoryName: 'Hats' } }, false)).toEqual([])
  })

  it('leaves the full list for the add-items form', () => {
    expect(names(shopCategories(tiers, { 2: { categoryName: 'Hats' } }))).toEqual(['General', 'Hats', 'Category 4'])
  })
})
