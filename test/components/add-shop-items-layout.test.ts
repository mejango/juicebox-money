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

  it('runs the item cards to the modal edge on phones', () => {
    // The wrapper finds StoreEditor's cards by their corner class.
    expect(source).toContain('max-sm:[&>div>.rounded-xl]:-mx-5 max-sm:[&>div>.rounded-xl]:px-5')
    expect(readFileSync('src/components/create/StoreEditor.tsx', 'utf8')).toContain(
      'className="mt-4 rounded-xl border border-smoke-200 bg-bone p-4 sm:p-5 max-sm:-mx-4',
    )
  })

  it('reviews the frozen items in the shared confirm dialog', () => {
    expect(source).toContain("'Add items for sale'}")
    expect(source).toContain('<TxProgress')
    expect(source).toContain("'Add items for sale'")
  })
})
