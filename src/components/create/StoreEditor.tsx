'use client'

/**
 * Store items editor for the create flow. Purely controlled — drafts live in
 * CreateForm state; pinning and encoding happen at launch time.
 */

export type DraftItem = {
  id: number
  name: string
  /** Human units in the store currency (ETH or USD). */
  price: string
  /** '' = unlimited inventory. */
  supply: string
  description: string
  imageFile: File | null
  imagePreview: string | null
}

let nextId = 1

export function newDraftItem(): DraftItem {
  return {
    id: nextId++,
    name: '',
    price: '',
    supply: '',
    description: '',
    imageFile: null,
    imagePreview: null,
  }
}

export function itemPriceOk(price: string): boolean {
  const n = Number(price)
  return Number.isFinite(n) && n > 0
}

export function itemSupplyOk(supply: string): boolean {
  if (supply.trim() === '') return true
  const n = Number(supply)
  return Number.isInteger(n) && n >= 1 && n <= 999_999_998
}

export function itemOk(item: DraftItem): boolean {
  return (
    item.name.trim().length > 0 &&
    itemPriceOk(item.price) &&
    itemSupplyOk(item.supply)
  )
}

const MAX_IMAGE_BYTES = 1024 * 1024

export function StoreEditor({
  items,
  onChange,
  currencyLabel,
  disabled,
}: {
  items: DraftItem[]
  onChange: (items: DraftItem[]) => void
  currencyLabel: 'ETH' | 'USD'
  disabled: boolean
}) {
  const update = (id: number, patch: Partial<DraftItem>) => {
    onChange(items.map(item => (item.id === id ? { ...item, ...patch } : item)))
  }

  const remove = (id: number) => {
    const item = items.find(i => i.id === id)
    if (item?.imagePreview) URL.revokeObjectURL(item.imagePreview)
    onChange(items.filter(i => i.id !== id))
  }

  const onImageChange = (id: number, file: File | null) => {
    const item = items.find(i => i.id === id)
    if (item?.imagePreview) URL.revokeObjectURL(item.imagePreview)
    if (!file || !file.type.startsWith('image/') || file.size > MAX_IMAGE_BYTES) {
      update(id, { imageFile: null, imagePreview: null })
      return
    }
    update(id, { imageFile: file, imagePreview: URL.createObjectURL(file) })
  }

  return (
    <div>
      {items.map((item, index) => (
        <div
          key={item.id}
          className="mt-4 rounded-xl border border-smoke-200 bg-bone p-4 sm:p-5"
        >
          <div className="flex items-center justify-between">
            <span className="field-label">Item {index + 1}</span>
            <button
              onClick={() => remove(item.id)}
              disabled={disabled}
              className="text-xs font-medium text-smoke-700 underline underline-offset-2 hover:text-ink disabled:opacity-60"
            >
              Remove
            </button>
          </div>

          <div className="mt-3 flex gap-4">
            <label className="shrink-0 cursor-pointer">
              {item.imagePreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.imagePreview}
                  alt=""
                  className="h-20 w-20 rounded-lg border border-smoke-200 object-cover"
                />
              ) : (
                <span className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-smoke-300 text-center text-[11px] leading-tight text-smoke-700">
                  <span className="text-lg">🖼️</span>
                  Add image
                </span>
              )}
              <input
                type="file"
                accept="image/*"
                disabled={disabled}
                className="sr-only"
                onChange={e => onImageChange(item.id, e.target.files?.[0] ?? null)}
              />
            </label>

            <div className="min-w-0 flex-1 space-y-3">
              <input
                type="text"
                value={item.name}
                onChange={e => update(item.id, { name: e.target.value.slice(0, 100) })}
                disabled={disabled}
                placeholder="Item name"
                className="input-well min-h-[44px] px-3.5 text-sm font-medium placeholder:font-normal disabled:opacity-60"
              />
              <div className="flex gap-3">
                <label className="min-w-0 flex-1">
                  <span className="field-label">Price ({currencyLabel})</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={item.price}
                    onChange={e => update(item.id, { price: e.target.value.slice(0, 20) })}
                    disabled={disabled}
                    placeholder={currencyLabel === 'USD' ? '25' : '0.01'}
                    className={`input-well mt-1 min-h-[44px] px-3.5 text-sm disabled:opacity-60 ${
                      item.price && !itemPriceOk(item.price) ? '!border-red-400' : ''
                    }`}
                  />
                </label>
                <label className="min-w-0 flex-1">
                  <span className="field-label">Quantity</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={item.supply}
                    onChange={e => update(item.id, { supply: e.target.value.slice(0, 9) })}
                    disabled={disabled}
                    placeholder="Unlimited"
                    className={`input-well mt-1 min-h-[44px] px-3.5 text-sm disabled:opacity-60 ${
                      !itemSupplyOk(item.supply) ? '!border-red-400' : ''
                    }`}
                  />
                </label>
              </div>
            </div>
          </div>

          <input
            type="text"
            value={item.description}
            onChange={e =>
              update(item.id, { description: e.target.value.slice(0, 1000) })
            }
            disabled={disabled}
            placeholder="Short description (optional)"
            className="input-well mt-3 min-h-[44px] px-3.5 text-sm disabled:opacity-60"
          />
        </div>
      ))}

      <button
        onClick={() => onChange([...items, newDraftItem()])}
        disabled={disabled}
        className="mt-4 text-sm font-medium text-bluebs-600 hover:text-bluebs-700 disabled:opacity-60"
      >
        + Add an item
      </button>
    </div>
  )
}
