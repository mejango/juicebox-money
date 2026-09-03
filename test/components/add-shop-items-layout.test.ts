import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  'src/components/project/AddShopItemsModal.tsx',
  'utf8',
)

describe('add shop items layout', () => {
  it('keeps breathing room between the chain selector and sticky actions', () => {
    expect(source).toContain(
      'className="mt-6 border-t border-smoke-200 pt-5 pb-5"',
    )
  })

  it('reviews the frozen items in the shared confirm dialog', () => {
    expect(source).toContain("'Review items'}")
    expect(source).toContain('<TxConfirmDialog')
    expect(source).toContain("'Add items for sale'")
  })
})
