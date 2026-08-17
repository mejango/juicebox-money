// @vitest-environment jsdom
import { recordOnRampPurchase } from '@/providers/para-config'
import { describe, expect, it } from 'vitest'

describe('recording an on-ramp purchase Para did not open', () => {
  it("hands the purchase over so the portal's first message can be answered", () => {
    // Without it, `ONRAMPS__INIT` is answered with `undefined` and the frame
    // spins with no error — which is what an embedded on-ramp did before this
    // existed.
    const client: Record<string, unknown> = {}
    const purchase = { id: 'purchase-1' }

    expect(recordOnRampPurchase(client, purchase)).toBe(true)
    expect(
      (client as { onRampPopup?: { onRampPurchase: unknown } }).onRampPopup
        ?.onRampPurchase,
    ).toBe(purchase)
  })

  it('reports failure rather than showing a frame that can only spin', () => {
    // The field is `protected`; an SDK that renames or freezes it must fall
    // back to a window.
    expect(recordOnRampPurchase(Object.freeze({}), { id: 'purchase-2' })).toBe(
      false,
    )
  })
})
