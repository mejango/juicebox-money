import { resolvedAddress } from "@/lib/ens";
import { splitOk, splitsTotal, type DraftSplit } from "./SplitsEditor";

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

function itemSplitsOk(item: DraftItem): boolean {
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
