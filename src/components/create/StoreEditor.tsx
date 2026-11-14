"use client";

import { useRef, useState, type ReactNode } from "react";
import { AddressField } from "./AddressField";
import { SplitsEditor } from "./SplitsEditor";
import { AddButton, CheckMark, CheckRow } from "./ui";
import { ChainIcon } from "@/components/ChainIcon";
import { chainName } from "@/lib/urn";
import { ipfsUrl } from "@/lib/format";
import { pinItemMedia } from "@/lib/store-items";
import { JBCENTER_MAX_MEDIA_BYTES } from "@/lib/jbcenter-ipfs";
import {
  newDraftItem,
  itemPriceOk,
  itemSupplyOk,
  itemDiscountOk,
  itemReserveOk,
  type DraftItem,
  type StoreCategory,
} from "./store-draft";
export { itemOk, newDraftItem, type DraftItem, type StoreCategory } from "./store-draft";

/**
 * Store items editor for the create flow. Purely controlled — drafts live in
 * CreateForm state; pinning and encoding happen at launch time.
 */

const MAX_MEDIA_BYTES = JBCENTER_MAX_MEDIA_BYTES;

function mediaAllowed(file: File): boolean {
  const type = file.type;
  return (
    type.startsWith("image/") ||
    type.startsWith("video/") ||
    type.startsWith("audio/") ||
    type === "application/pdf" ||
    type.startsWith("text/") ||
    /\.(md|markdown|txt)$/i.test(file.name)
  );
}

/** A friendly tile for non-image media. */
function mediaEmoji(type: string): string {
  if (type.startsWith("video/")) return "🎬";
  if (type.startsWith("audio/")) return "🎵";
  return "📄";
}

/** An optional setting: its fields stay hidden until the row is checked, and unchecking clears them. */
function Optional({
  title,
  blurb,
  on,
  onClear,
  disabled,
  children,
}: {
  title: string;
  /** Shown once the setting is on. */
  blurb?: string;
  /** Whether the draft already holds a value for this setting. */
  on: boolean;
  onClear: () => void;
  disabled: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(on);
  return (
    <div>
      <button
        type="button"
        role="checkbox"
        aria-checked={open}
        onClick={() => {
          if (open) onClear();
          setOpen(!open);
        }}
        disabled={disabled}
        className="group flex min-h-[28px] items-center gap-2 text-left text-sm font-medium text-smoke-700 focus-visible:outline-none disabled:opacity-60"
      >
        <CheckMark checked={open} />
        {title}
      </button>
      {open ? (
        <>
          {blurb ? (
            <p className="mt-1 text-xs leading-relaxed text-smoke-700">{blurb}</p>
          ) : null}
          {children}
        </>
      ) : null}
    </div>
  );
}

export function StoreEditor({
  items,
  onChange,
  currencyLabel,
  disabled,
  categories,
  existingCategoryIds = [],
  onAddCategory,
  chainIds,
  isRevnet = false,
}: {
  items: DraftItem[];
  onChange: (items: DraftItem[]) => void;
  currencyLabel: string;
  disabled: boolean;
  categories: StoreCategory[];
  /** Categories the shop already had; they stay listed even when no item here uses them. */
  existingCategoryIds?: readonly number[];
  onAddCategory: (name: string) => number;
  chainIds: number[];
  /** Revnet item transferability is fixed per item at launch. */
  isRevnet?: boolean;
}) {
  // The item whose "+ Add category…" field is open, and what has been typed into it.
  const [newCategory, setNewCategory] = useState<{ itemId: string; name: string } | null>(null);
  // A category typed here and then left unused drops off the list.
  const listedCategories = categories.filter(
    (cat) =>
      existingCategoryIds.includes(cat.id) ||
      items.some((item) => item.category === cat.id),
  );
  /** The latest rows, for a pin that lands after other edits. */
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const update = (id: string, patch: Partial<DraftItem>) => {
    onChange(
      items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  };

  const remove = (id: string) => {
    const item = items.find((i) => i.id === id);
    if (item?.mediaPreview) URL.revokeObjectURL(item.mediaPreview);
    onChange(items.filter((i) => i.id !== id));
  };

  const onMediaChange = (id: string, file: File | null) => {
    const item = items.find((i) => i.id === id);
    if (item?.mediaPreview) URL.revokeObjectURL(item.mediaPreview);
    if (!file || !mediaAllowed(file) || file.size > MAX_MEDIA_BYTES) {
      update(id, { mediaFile: null, mediaPreview: null, mediaUri: "", mediaType: "" });
      return;
    }
    update(id, {
      mediaFile: file,
      mediaPreview: file.type.startsWith("image/")
        ? URL.createObjectURL(file)
        : null,
      mediaUri: "",
      mediaType: "",
    });
    // Pinned when chosen, so an exported draft carries it. A pin that fails
    // here is made again when the items are sent.
    void pinItemMedia(file).then(
      (pin) =>
        onChange(
          itemsRef.current.map((entry) =>
            entry.id === id && entry.mediaFile === file
              ? { ...entry, mediaUri: pin.uri, mediaType: pin.type }
              : entry,
          ),
        ),
      () => {},
    );
  };

  return (
    <div>
      {items.map((item, index) => (
        <div
          key={item.id}
          className="mt-4 rounded-xl border border-smoke-200 bg-bone p-4 sm:p-5 max-sm:-mx-4 max-sm:rounded-none max-sm:border-x-0 max-sm:border-bluebs-600 max-sm:bg-white max-sm:not-first:-mt-px"
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
            <div className="flex shrink-0 flex-col items-center gap-2">
              {item.mediaPreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.mediaPreview}
                  alt=""
                  className="h-20 w-20 rounded-lg border border-smoke-200 object-cover"
                />
              ) : item.mediaFile ? (
                <span
                  title={item.mediaFile.name}
                  className="flex h-20 w-20 flex-col items-center justify-center gap-1 overflow-hidden rounded-lg border border-smoke-200 bg-white px-1 text-center"
                >
                  <span className="text-2xl">
                    {mediaEmoji(item.mediaFile.type)}
                  </span>
                  <span className="w-full truncate text-[10px] text-smoke-700">
                    {item.mediaFile.name}
                  </span>
                </span>
              ) : item.mediaUri && item.mediaType.startsWith("image/") ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={ipfsUrl(item.mediaUri) ?? undefined}
                  alt=""
                  className="h-20 w-20 rounded-lg border border-smoke-200 object-cover"
                />
              ) : item.mediaUri ? (
                <span className="flex h-20 w-20 items-center justify-center rounded-lg border border-smoke-200 bg-white text-2xl">
                  {mediaEmoji(item.mediaType)}
                </span>
              ) : (
                <span className="flex h-20 w-20 items-center justify-center rounded-lg border border-dashed border-smoke-300 text-2xl">
                  🖼️
                </span>
              )}
              <label className="btn-secondary min-h-[32px] cursor-pointer px-2.5 text-[11px]">
                {item.mediaFile || item.mediaUri ? "Change media" : "Upload media"}
                <input
                  type="file"
                  accept="image/*,video/*,audio/*,application/pdf,text/*,.md,.markdown"
                  disabled={disabled}
                  className="sr-only"
                  onChange={(e) =>
                    onMediaChange(item.id, e.target.files?.[0] ?? null)
                  }
                />
              </label>
            </div>

            <div className="min-w-0 flex-1 space-y-3">
              <input
                type="text"
                value={item.name}
                onChange={(e) =>
                  update(item.id, { name: e.target.value.slice(0, 100) })
                }
                disabled={disabled}
                placeholder="Item name"
                className="input-well min-h-[44px] px-3.5 text-sm font-medium placeholder:font-normal disabled:opacity-60"
              />
              <div>
                <label
                  htmlFor={`item-price-${item.id}`}
                  className="field-label"
                >
                  Price ({currencyLabel})
                </label>
                <input
                  id={`item-price-${item.id}`}
                  type="text"
                  inputMode="decimal"
                  value={item.price}
                  onChange={(e) =>
                    update(item.id, { price: e.target.value.slice(0, 20) })
                  }
                  disabled={disabled}
                  placeholder={currencyLabel === "USD" ? "25" : "0.01"}
                  className={`input-well mt-1 min-h-[44px] px-3.5 text-sm disabled:opacity-60 ${
                    item.price && !itemPriceOk(item.price)
                      ? "!border-red-400"
                      : ""
                  }`}
                />
              </div>
              <Optional
                title="Limited supply"
                on={
                  item.supply.trim() !== "" ||
                  Object.values(item.perChainSupply).some((v) => v?.trim())
                }
                onClear={() =>
                  update(item.id, {
                    supply: "",
                    perChainSupply: {},
                    perChainSupplyOpen: false,
                  })
                }
                disabled={disabled}
              >
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={item.supply}
                    onChange={(e) =>
                      update(item.id, {
                        supply: e.target.value.slice(0, 9),
                      })
                    }
                    disabled={disabled}
                    placeholder="100"
                    aria-label="Quantity on each chain"
                    className={`input-well min-h-[44px] !w-28 px-3.5 text-sm tabular-nums disabled:opacity-60 ${
                      !itemSupplyOk(item.supply) ? "!border-red-400" : ""
                    }`}
                  />
                  {chainIds.length > 1 ? (
                    <span className="text-xs text-smoke-700">on each chain</span>
                  ) : null}
                </div>
                {chainIds.length > 1 ? (
                  <div className="mt-1.5 min-w-0">
                    <button
                      type="button"
                      onClick={() =>
                        update(item.id, {
                          perChainSupplyOpen: !item.perChainSupplyOpen,
                        })
                      }
                      disabled={disabled}
                      aria-expanded={item.perChainSupplyOpen}
                      className="whitespace-nowrap text-[11px] font-medium text-bluebs-600 hover:text-bluebs-700 disabled:opacity-60"
                    >
                      {item.perChainSupplyOpen
                        ? "Use same quantity on all chains"
                        : "Set per chain"}
                    </button>
                    {item.perChainSupplyOpen ? (
                      <div className="mt-2 space-y-2">
                        {chainIds.map((chainId) => (
                          <div
                            key={chainId}
                            className="flex items-center gap-2"
                          >
                            <span className="mt-1 flex w-9 shrink-0 items-center justify-center">
                              <ChainIcon chainId={chainId} size={28} />
                            </span>
                            <input
                              type="text"
                              inputMode="numeric"
                              value={item.perChainSupply[chainId] ?? ""}
                              onChange={(e) =>
                                update(item.id, {
                                  perChainSupply: {
                                    ...item.perChainSupply,
                                    [chainId]: e.target.value.slice(0, 9),
                                  },
                                })
                              }
                              disabled={disabled}
                              placeholder={item.supply.trim() || "Unlimited"}
                              aria-label={`Quantity on ${chainName(chainId)}`}
                              className="input-well min-h-[40px] w-28 px-2.5 text-xs tabular-nums disabled:opacity-60"
                            />
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </Optional>
            </div>
          </div>

          <input
            type="text"
            value={item.description}
            onChange={(e) =>
              update(item.id, { description: e.target.value.slice(0, 1000) })
            }
            disabled={disabled}
            placeholder="Short description (optional)"
            className="input-well mt-3 min-h-[44px] px-3.5 text-sm disabled:opacity-60"
          />

          <button
            onClick={() => update(item.id, { moreOpen: !item.moreOpen })}
            disabled={disabled}
            aria-expanded={item.moreOpen}
            className="mt-3 text-xs font-medium text-bluebs-600 hover:text-bluebs-700 disabled:opacity-60"
          >
            {item.moreOpen ? "Fewer options" : "More options"}
          </button>

          {item.moreOpen ? (
            <div className="mt-3 space-y-5 border-t border-smoke-200 pt-4">
              <div>
                <span className="field-label">Category</span>
                <p className="mt-1 text-xs leading-relaxed text-smoke-700">
                  Group items into named shelves on your store page.
                </p>
                <select
                  value={newCategory?.itemId === item.id ? "new" : String(item.category)}
                  onChange={(e) => {
                    if (e.target.value === "new") {
                      setNewCategory({ itemId: item.id, name: "" });
                    } else {
                      setNewCategory(null);
                      update(item.id, { category: Number(e.target.value) });
                    }
                  }}
                  disabled={disabled}
                  className="input-well select-caret mt-2 min-h-[44px] w-56 px-3 pr-8 text-sm disabled:opacity-60"
                >
                  <option value="0">Default</option>
                  {listedCategories.map((cat) => (
                    <option key={cat.id} value={String(cat.id)}>
                      {cat.name}
                    </option>
                  ))}
                  <option value="new">+ Add category…</option>
                </select>
                {newCategory?.itemId === item.id ? (
                  <input
                    type="text"
                    value={newCategory.name}
                    onChange={(e) =>
                      setNewCategory({ itemId: item.id, name: e.target.value.slice(0, 40) })
                    }
                    // Leaving the field or pressing Enter keeps the name; an empty one adds nothing.
                    onBlur={() => {
                      const name = newCategory.name.trim();
                      if (name) {
                        // A name already on file is that category, not a second one.
                        const known = categories.find(
                          (cat) => cat.name.toLowerCase() === name.toLowerCase(),
                        );
                        update(item.id, {
                          category: known ? known.id : onAddCategory(name),
                        });
                      }
                      setNewCategory(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                    disabled={disabled}
                    autoFocus
                    enterKeyHint="done"
                    placeholder="Category name"
                    aria-label="New category name"
                    className="input-well mt-2 min-h-[44px] !w-56 px-3 text-sm disabled:opacity-60"
                  />
                ) : null}
              </div>

              <div>
                <span className="field-label">Split sales</span>
                <p className="mt-1 text-xs leading-relaxed text-smoke-700">
                  Route a share of each sale of this item to other accounts or
                  projects.
                </p>
                <SplitsEditor
                  splits={item.splits}
                  onChange={(splits) => update(item.id, { splits })}
                  disabled={disabled}
                  bucketLabel="sale proceeds"
                  remainderNote="stay with the project"
                  chainIds={chainIds}
                />
                {item.splits.length > 0 && item.allowCredits ? (
                  <p className="mt-2 rounded-lg bg-split-50 px-3 py-2 text-[11px] leading-relaxed text-split-800">
                    Shop credit purchases may bring in no new payment to divide.
                    Turn off credit purchases below if every sale must honor
                    this split.
                  </p>
                ) : null}
              </div>

              <Optional
                title="Add discount"
                blurb={`Launch the item at a discount off its price. The ${isRevnet ? "revnet operator" : "project owner"} can end the discount later.`}
                on={item.discountPct.trim() !== ""}
                onClear={() => update(item.id, { discountPct: "" })}
                disabled={disabled}
              >
                <div className="mt-2 flex items-center gap-2.5">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={item.discountPct}
                    onChange={(e) =>
                      update(item.id, {
                        discountPct: e.target.value.slice(0, 5),
                      })
                    }
                    disabled={disabled}
                    placeholder="0"
                    className={`input-well min-h-[44px] w-20 px-3 text-sm tabular-nums disabled:opacity-60 ${
                      itemDiscountOk(item.discountPct) ? "" : "!border-red-400"
                    }`}
                  />
                  <span className="text-sm text-smoke-700">% off</span>
                </div>
              </Optional>

              <Optional
                title="Reserve inventory"
                blurb="Reserve some of this item for a specific wallet as others buy it."
                on={
                  item.reserveN.trim() !== "" ||
                  item.reserveBeneficiary.trim() !== ""
                }
                onClear={() =>
                  update(item.id, { reserveN: "", reserveBeneficiary: "" })
                }
                disabled={disabled}
              >
                <div className="mt-2 flex flex-wrap items-center gap-2.5">
                  <span className="text-sm text-smoke-700">1 of every</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={item.reserveN}
                    onChange={(e) =>
                      update(item.id, { reserveN: e.target.value.slice(0, 5) })
                    }
                    disabled={disabled}
                    placeholder="—"
                    className={`input-well min-h-[44px] w-16 px-3 text-sm tabular-nums disabled:opacity-60 ${
                      itemReserveOk(item, chainIds) ? "" : "!border-red-400"
                    }`}
                  />
                  <span className="text-sm text-smoke-700">sold</span>
                  {/* Phones break the sentence here, so the address gets a line's width. */}
                  <span className="-my-1.5 basis-full sm:hidden" />
                  <span className="text-sm text-smoke-700">goes to</span>
                  <AddressField
                    value={item.reserveBeneficiary}
                    onChange={(reserveBeneficiary) =>
                      update(item.id, { reserveBeneficiary })
                    }
                    disabled={disabled}
                    ariaLabel="Reserve beneficiary"
                    className="flex-1"
                  />
                </div>
              </Optional>

              <div className="space-y-2">
                <span className="field-label">Item rules</span>
                {(
                  [
                    [
                      "allowOwnerMint",
                      "Owner can create this item for free",
                      "The project owner or revnet operator can create this item without paying.",
                    ],
                    [
                      "transfersPausable",
                      isRevnet ? "Non-transferable" : "Allow rulesets to pause transfers",
                      isRevnet
                        ? "This item can be created or destroyed, but cannot move between wallets."
                        : "The current rules can stop holders from sending this item to another wallet. Creating and destroying it stay allowed.",
                    ],
                    [
                      "cantBeRemoved",
                      "Permanent",
                      "This item can never be removed from the store.",
                    ],
                    [
                      "allowCredits",
                      "Allow credit purchases",
                      "Buyers can spend leftover pay credits on this item.",
                    ],
                    [
                      "ownerCanEditDiscount",
                      "Discounts can change later",
                      "The project owner can raise or end the discount after launch.",
                    ],
                  ] as const
                ).map(([key, title, blurb]) => (
                  <CheckRow
                    key={key}
                    checked={item[key]}
                    onToggle={() => update(item.id, { [key]: !item[key] })}
                    disabled={disabled}
                    title={title}
                    blurb={blurb}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ))}

      <div className="mt-4">
        <AddButton
          onClick={() => onChange([...items, newDraftItem()])}
          disabled={disabled}
        >
          Add an item
        </AddButton>
      </div>
    </div>
  );
}
