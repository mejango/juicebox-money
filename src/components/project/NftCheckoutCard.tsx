'use client'

import { QuantityStepper } from '@/components/ui/QuantityStepper'

/** Presentation only: the protocol owner supplies quantities, prices and actions. */
export function NftCheckoutCard({ tierId, name, image, qty, priceLabel, soldOut, busy, canAdd, onSelect, onAdd, onRemove }: {
  tierId: number
  name: string
  image?: string | null
  qty: number
  priceLabel: string
  soldOut: boolean
  busy: boolean
  canAdd: boolean
  onSelect: () => void
  onAdd: () => void
  onRemove: () => void
}) {
  return (
                <div
                  data-nft-checkout-tier={tierId}
                  className={`relative w-24 shrink-0 overflow-hidden rounded-lg border bg-white text-center transition ${
                    qty > 0
                      ? "border-bluebs-500 bg-bluebs-25"
                      : "border-smoke-200 hover:border-bluebs-300"
                  } ${soldOut ? "opacity-40" : ""}`}
                >
                  {qty > 0 ? (
                    <span className="absolute right-1.5 top-1.5 z-10 flex h-5 min-w-5 items-center justify-center rounded-full bg-bluebs-600 px-1 text-[10px] font-medium text-white">
                      {qty}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    aria-label={name}
                    onClick={() => {
                      if (soldOut || qty > 0) return;
                      onSelect();
                    }}
                    disabled={busy || soldOut || (qty === 0 && !canAdd)}
                    className="block w-full disabled:cursor-not-allowed"
                    title={
                      soldOut
                        ? `${name} is sold out`
                        : `Add ${name} to cart`
                    }
                  >
                    {image ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={image}
                        alt={name}
                        loading="lazy"
                        decoding="async"
                        className="block aspect-square w-full object-contain"
                      />
                    ) : (
                      <span className="flex aspect-square w-full items-center justify-center bg-smoke-75 text-xs text-smoke-500">
                        #{tierId}
                      </span>
                    )}
                  </button>
                  {soldOut ? (
                    <p className="px-2 pb-2 text-[10px] text-smoke-500">
                      Sold out
                    </p>
                  ) : qty === 0 ? (
                    <button
                      type="button"
                      onClick={onSelect}
                      disabled={busy || !canAdd}
                      className="w-full px-2 pb-2 text-[11px] text-smoke-700"
                    >
                      {priceLabel}
                    </button>
                  ) : (
                    <QuantityStepper
                      size="sm"
                      quantity={qty}
                      itemName={name}
                      onRemove={onRemove}
                      onAdd={onAdd}
                      disabledRemove={busy || qty === 0}
                      disabledAdd={busy || !canAdd}
                    />
                  )}
                </div>
  )
}
