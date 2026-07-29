"use client";

import { resolvedAddress } from "@/lib/ens";
import { AddressField } from "./AddressField";
import {
  SplitsEditor,
  splitOk,
  splitsTotal,
  type DraftSplit,
} from "./SplitsEditor";
import { AddButton, CheckRow } from "./ui";
import { ChainIcon } from "@/components/ChainIcon";
import { chainName } from "@/lib/urn";

/**
 * Store items editor for the create flow. Purely controlled — drafts live in
 * CreateForm state; pinning and encoding happen at launch time.
 */

export type DraftItem = {
  id: string;
  name: string;
  /** Human units in the store currency (ETH or USD). */
  price: string;
  /** '' = unlimited inventory. */
  supply: string;
  description: string;
  /** Any media: image, video, audio, PDF, or text (website/ parity). */
  mediaFile: File | null;
  /** Object URL preview — images only. */
  mediaPreview: string | null;
  /** Initial discount, 0–100 (%). '' = none. */
  discountPct: string;
  /** Reserve 1 of every N for the beneficiary. '' = off. */
  reserveN: string;
  reserveBeneficiary: string;
  /** % of each sale routed to recipients (percent mode). */
  splits: DraftSplit[];
  /** Category id (0 = default). */
  category: number;
  votingUnits: string;
  allowOwnerMint: boolean;
  transfersPausable: boolean;
  cantBeRemoved: boolean;
  allowCredits: boolean;
  ownerCanEditDiscount: boolean;
  /** Per-chain quantity overrides ('' = default; 'unlimited' allowed). */
  perChainSupply: Record<number, string>;
  perChainSupplyOpen: boolean;
  moreOpen: boolean;
};

export type StoreCategory = { id: number; name: string };

export function newDraftItem(): DraftItem {
  return {
    id: crypto.randomUUID(),
    name: "",
    price: "",
    supply: "",
    description: "",
    mediaFile: null,
    mediaPreview: null,
    discountPct: "",
    reserveN: "",
    reserveBeneficiary: "",
    splits: [],
    category: 0,
    votingUnits: "",
    allowOwnerMint: false,
    transfersPausable: false,
    cantBeRemoved: false,
    allowCredits: true,
    ownerCanEditDiscount: true,
    perChainSupply: {},
    perChainSupplyOpen: false,
    moreOpen: false,
  };
}

export function itemPriceOk(price: string): boolean {
  const n = Number(price);
  return Number.isFinite(n) && n > 0;
}

export function itemSupplyOk(supply: string): boolean {
  if (supply.trim() === "") return true;
  const n = Number(supply);
  return Number.isInteger(n) && n >= 1 && n <= 999_999_998;
}

export function itemDiscountOk(discountPct: string): boolean {
  if (discountPct.trim() === "") return true;
  const n = Number(discountPct);
  return Number.isFinite(n) && n >= 0 && n <= 100;
}

export function itemReserveOk(item: DraftItem): boolean {
  if (item.reserveN.trim() === "") return true;
  const n = Number(item.reserveN);
  return (
    Number.isInteger(n) &&
    n >= 1 &&
    n <= 65_535 &&
    resolvedAddress(item.reserveBeneficiary) !== null
  );
}

export function itemSplitsOk(item: DraftItem): boolean {
  return (
    item.splits.every((s) => splitOk(s, "percent")) &&
    splitsTotal(item.splits, "percent") <= 100
  );
}

export function itemVotingOk(item: DraftItem): boolean {
  if (item.votingUnits.trim() === "") return true;
  const n = Number(item.votingUnits);
  return Number.isInteger(n) && n >= 0 && n <= 4_294_967_295;
}

export function itemOk(item: DraftItem): boolean {
  return (
    item.name.trim().length > 0 &&
    itemPriceOk(item.price) &&
    itemSupplyOk(item.supply) &&
    itemDiscountOk(item.discountPct) &&
    itemReserveOk(item) &&
    itemSplitsOk(item) &&
    itemVotingOk(item) &&
    Object.values(item.perChainSupply).every(
      (v) => v.trim() === "" || v.trim() === "unlimited" || itemSupplyOk(v),
    )
  );
}

const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

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

export function StoreEditor({
  items,
  onChange,
  currencyLabel,
  disabled,
  categories,
  onAddCategory,
  chainIds,
  isRevnet = false,
}: {
  items: DraftItem[];
  onChange: (items: DraftItem[]) => void;
  currencyLabel: string;
  disabled: boolean;
  categories: StoreCategory[];
  onAddCategory: (name: string) => number;
  chainIds: number[];
  /** Revnet items cannot opt into ruleset-controlled transfer pauses. */
  isRevnet?: boolean;
}) {
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
      update(id, { mediaFile: null, mediaPreview: null });
      return;
    }
    update(id, {
      mediaFile: file,
      mediaPreview: file.type.startsWith("image/")
        ? URL.createObjectURL(file)
        : null,
    });
  };

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
              ) : (
                <span className="flex h-20 w-20 items-center justify-center rounded-lg border border-dashed border-smoke-300 text-2xl">
                  🖼️
                </span>
              )}
              <label className="btn-secondary min-h-[32px] cursor-pointer px-2.5 text-[11px]">
                {item.mediaFile ? "Change media" : "Upload media"}
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
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                <label
                  htmlFor={`item-price-${item.id}`}
                  className="field-label min-w-0"
                >
                  Price ({currencyLabel})
                </label>
                <label
                  htmlFor={`item-quantity-${item.id}`}
                  className="field-label min-w-0"
                >
                  Quantity{" "}
                  <span className="font-normal text-smoke-500">
                    (on each chain)
                  </span>
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
                  className={`input-well min-h-[44px] px-3.5 text-sm disabled:opacity-60 ${
                    item.price && !itemPriceOk(item.price)
                      ? "!border-red-400"
                      : ""
                  }`}
                />
                <input
                  id={`item-quantity-${item.id}`}
                  type="text"
                  inputMode="numeric"
                  value={item.supply}
                  onChange={(e) =>
                    update(item.id, {
                      supply: e.target.value.slice(0, 9),
                    })
                  }
                  disabled={disabled}
                  placeholder="Unlimited"
                  className={`input-well min-h-[44px] px-3.5 text-sm disabled:opacity-60 ${
                    !itemSupplyOk(item.supply) ? "!border-red-400" : ""
                  }`}
                />
                {chainIds.length > 1 ? (
                  <div className="col-start-2 mt-0.5 min-w-0">
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
              </div>
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
                  value={String(item.category)}
                  onChange={(e) => {
                    if (e.target.value === "new") {
                      const name = window.prompt("New category name")?.trim();
                      if (name) {
                        const id = onAddCategory(name);
                        update(item.id, { category: id });
                      }
                    } else {
                      update(item.id, { category: Number(e.target.value) });
                    }
                  }}
                  disabled={disabled}
                  className="input-well select-caret mt-2 min-h-[44px] w-56 px-3 pr-8 text-sm disabled:opacity-60"
                >
                  <option value="0">Default</option>
                  {categories.map((cat) => (
                    <option key={cat.id} value={String(cat.id)}>
                      {cat.name}
                    </option>
                  ))}
                  <option value="new">+ Add category…</option>
                </select>
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

              <div>
                <span className="field-label">Discount</span>
                <p className="mt-1 text-xs leading-relaxed text-smoke-700">
                  Launch the item at a discount off its price — you can end the
                  discount later.
                </p>
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
              </div>

              <div>
                <span className="field-label">Reserve inventory</span>
                <p className="mt-1 text-xs leading-relaxed text-smoke-700">
                  Set aside some of this item for a specific wallet as others
                  buy it.
                </p>
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
                      itemReserveOk(item) ? "" : "!border-red-400"
                    }`}
                  />
                  <span className="text-sm text-smoke-700">sold goes to</span>
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
              </div>

              <div>
                <span className="field-label">Voting power</span>
                <p className="mt-1 text-xs leading-relaxed text-smoke-700">
                  Give each of this item a custom number of governance votes.
                </p>
                <div className="mt-2 flex items-center gap-2.5">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={item.votingUnits}
                    onChange={(e) =>
                      update(item.id, {
                        votingUnits: e.target.value.slice(0, 10),
                      })
                    }
                    disabled={disabled}
                    placeholder="0"
                    className={`input-well min-h-[44px] w-28 px-3 text-sm tabular-nums disabled:opacity-60 ${
                      itemVotingOk(item) ? "" : "!border-red-400"
                    }`}
                  />
                  <span className="text-sm text-smoke-700">votes each</span>
                </div>
              </div>

              <div className="space-y-2">
                <span className="field-label">Item rules</span>
                {(
                  [
                    [
                      "allowOwnerMint",
                      "Project owner can mint for free",
                      "The project owner (or revnet revnet operator) can mint this item without paying.",
                    ],
                    ...(isRevnet
                      ? []
                      : ([
                          [
                            "transfersPausable",
                            "Transfers pausable",
                            "Rulesets can pause transfers of this item.",
                          ],
                        ] as const)),
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
