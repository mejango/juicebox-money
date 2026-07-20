'use client'

/**
 * The −/count/+ round-button stepper shop cards use for cart quantities.
 * `md` is the Shop tab card size; `sm` is the pay-panel mini-shop's tighter
 * variant. `itemName` feeds the "Add one …"/"Remove one …" aria labels.
 */
export function QuantityStepper({
  quantity,
  itemName,
  onAdd,
  onRemove,
  disabledAdd = false,
  disabledRemove = false,
  size = 'md',
}: {
  quantity: number
  itemName: string
  onAdd: () => void
  onRemove: () => void
  disabledAdd?: boolean
  disabledRemove?: boolean
  size?: 'md' | 'sm'
}) {
  const container =
    size === 'sm'
      ? 'flex items-center justify-center gap-1.5 px-2 pb-2'
      : 'flex shrink-0 items-center gap-1.5'
  const button =
    size === 'sm'
      ? 'h-5 w-5 rounded-full border border-smoke-300 text-xs leading-none text-smoke-700 disabled:opacity-40'
      : 'flex h-7 w-7 items-center justify-center rounded-full border border-smoke-300 text-sm text-smoke-700 disabled:opacity-35'
  const count =
    size === 'sm'
      ? 'min-w-[1ch] text-xs tabular-nums'
      : 'min-w-4 text-center text-xs tabular-nums text-ink'

  return (
    <div className={container}>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabledRemove}
        aria-label={`Remove one ${itemName}`}
        className={button}
      >
        −
      </button>
      <span className={count}>{quantity}</span>
      <button
        type="button"
        onClick={onAdd}
        disabled={disabledAdd}
        aria-label={`Add one ${itemName}`}
        className={button}
      >
        +
      </button>
    </div>
  )
}
