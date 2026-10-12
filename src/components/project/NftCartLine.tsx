/** Ordinary and native selected NFT presentation; callers own quantity limits. */
export function NftCartLine({ tierId, name, image, quantity, onRemove, onAdd, removeDisabled = false, addDisabled = false }: {
  tierId: number
  name: string
  image?: string
  quantity: number
  onRemove: () => void
  onAdd: () => void
  removeDisabled?: boolean
  addDisabled?: boolean
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="text-sm text-smoke-500">+</span>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded bg-white text-[10px] text-smoke-500">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={image} alt="" className="h-full w-full object-cover" />
        ) : (
          `#${tierId}`
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">{name}</span>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onRemove}
          disabled={removeDisabled}
          aria-label={`Remove one ${name}`}
          className="flex h-6 w-6 items-center justify-center rounded-full border border-smoke-300 text-xs text-smoke-700 disabled:opacity-40"
        >
          −
        </button>
        <span className="min-w-4 text-center text-xs tabular-nums text-ink">{quantity}</span>
        <button
          type="button"
          onClick={onAdd}
          disabled={addDisabled}
          aria-label={`Add one ${name}`}
          className="flex h-6 w-6 items-center justify-center rounded-full border border-smoke-300 text-xs text-smoke-700 disabled:opacity-40"
        >
          +
        </button>
      </div>
    </div>
  )
}
