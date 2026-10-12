import type { ReactNode } from 'react'

export const CHECKOUT_AMOUNT_INPUT_CLASS = 'min-w-0 flex-1 bg-transparent px-4 py-3 text-lg font-medium outline-none placeholder:text-smoke-500 disabled:opacity-60'
export const CHECKOUT_ACTION_BUTTON_CLASS = 'btn-primary shrink-0 rounded-l-none px-5 text-sm disabled:opacity-60'

/** Shared layout only; each checkout owns its amount, currency and action. */
export function CheckoutAmountRow({ amount, currency, action }: {
  amount: ReactNode
  currency: ReactNode
  action: ReactNode
}) {
  return (
    <div className="input-well flex items-stretch overflow-hidden !p-0">
      {amount}
      <div className="flex shrink-0 flex-col items-end justify-center gap-0.5 pr-3">
        {currency}
      </div>
      {action}
    </div>
  )
}
