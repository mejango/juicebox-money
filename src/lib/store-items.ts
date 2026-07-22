import { parseUnits, zeroAddress, type Address } from 'viem'
import type {
  DraftItem,
  StoreCategory,
} from '@/components/create/StoreEditor'
import { splitOk, type DraftSplit } from '@/components/create/SplitsEditor'
import { resolvedAddress } from '@/lib/ens'
import { cidV0ToBytes32 } from '@bananapus/nana-sdk-core'
import {
  LP_SPLIT_HOOK,
  type SplitConfig,
  type StoreItem,
} from '@/lib/launch'

export type PinnedStoreItemDraft = {
  draft: DraftItem
  encodedIpfsUri: `0x${string}`
}

type PinStatus = (message: string) => void

/** Pin each draft's media and metadata exactly once. The returned drafts can
 * then be encoded independently for every selected chain. */
export async function pinStoreItemDrafts(
  items: DraftItem[],
  categories: StoreCategory[],
  onStatus: PinStatus = () => {},
): Promise<PinnedStoreItemDraft[]> {
  const pinned: PinnedStoreItemDraft[] = []

  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    const label = items.length > 1 ? `Item ${index + 1}: ` : ''
    let image: string | undefined
    let animationUrl: string | undefined

    if (item.mediaFile) {
      onStatus(`${label}pinning media…`)
      const form = new FormData()
      form.append('file', item.mediaFile)
      const mediaRes = await fetch('/api/ipfs/pin-media', {
        method: 'POST',
        body: form,
      })
      const mediaJson = (await mediaRes.json()) as {
        cid?: string
        error?: string
      }
      if (!mediaRes.ok || !mediaJson.cid) {
        throw new Error(
          mediaJson.error ?? `${label}media upload failed — try again.`,
        )
      }
      const uri = `ipfs://${mediaJson.cid}`
      if (item.mediaFile.type.startsWith('image/')) image = uri
      else animationUrl = uri
    }

    onStatus(`${label}pinning metadata…`)
    const itemRes = await fetch('/api/ipfs/pin-item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: item.name.trim(),
        description: item.description.trim() || undefined,
        image,
        animation_url: animationUrl,
        mediaType: item.mediaFile?.type || undefined,
        categoryName:
          categories.find(category => category.id === item.category)?.name ||
          undefined,
      }),
    })
    const itemJson = (await itemRes.json()) as {
      cid?: string
      error?: string
    }
    if (!itemRes.ok || !itemJson.cid) {
      throw new Error(
        itemJson.error ??
          `${label}saving “${item.name.trim()}” failed — try again.`,
      )
    }

    pinned.push({
      draft: item,
      encodedIpfsUri: cidV0ToBytes32(itemJson.cid),
    })
  }

  return pinned
}

/** Materialize pinned drafts for one chain. Prices use the shop's fixed
 * pricing precision; recipient and quantity overrides use this chain. */
export function storeItemsForChain(
  pinned: PinnedStoreItemDraft[],
  decimals: number,
  chainId: number,
): StoreItem[] {
  return pinned.map(({ draft: item, encodedIpfsUri }) => {
    let price: bigint
    try {
      price = parseUnits(item.price.trim(), decimals)
    } catch {
      throw new Error(
        `“${item.name.trim()}” has too many decimal places for this store.`,
      )
    }
    if (price <= 0n) {
      throw new Error(
        `The price of “${item.name.trim()}” is too small — it rounds to 0.`,
      )
    }
    if (price > (1n << 104n) - 1n) {
      throw new Error(`The price of “${item.name.trim()}” is too large.`)
    }

    const splitRows = item.splits.filter(split => splitOk(split, 'percent'))
    const totalSplitPct = splitRows.reduce(
      (total, split) => total + Number(split.value),
      0,
    )
    let splitPercent = 0
    let splits: SplitConfig[] = []
    if (totalSplitPct > 0) {
      splitPercent = Math.round((totalSplitPct / 100) * 1e9)
      const relativePercents = splitRows.map(split =>
        Math.round((Number(split.value) / totalSplitPct) * 1e9),
      )
      relativePercents[relativePercents.length - 1] =
        1e9 -
        relativePercents.slice(0, -1).reduce((sum, value) => sum + value, 0)
      splits = splitRows.map((split, index) => ({
        percent: relativePercents[index],
        ...splitRecipientForChain(split, chainId),
      }))
    }

    const perChainSupply: Record<number, number | null> = {}
    for (const [id, value] of Object.entries(item.perChainSupply)) {
      const quantity = value.trim().toLowerCase()
      if (!quantity) continue
      perChainSupply[Number(id)] =
        quantity === 'unlimited' ? null : Number(quantity)
    }

    const reserveOn = item.reserveN.trim() !== ''
    const supply = item.supply.trim() === '' ? null : Number(item.supply)
    const effectiveSupply =
      chainId in perChainSupply ? perChainSupply[chainId] : supply
    if (reserveOn && effectiveSupply === 1) {
      throw new Error(
        `“${item.name.trim()}” needs at least 2 items on every chain when inventory is reserved.`,
      )
    }

    return {
      price,
      supply,
      encodedIpfsUri,
      splitPercent,
      splits,
      discountPercent: Math.round(Number(item.discountPct || '0') * 2),
      reserveFrequency: reserveOn ? Number(item.reserveN) : 0,
      reserveBeneficiary: reserveOn
        ? resolvedAddress(item.reserveBeneficiary)
        : null,
      category: item.category,
      votingUnits:
        item.votingUnits.trim() === '' ? 0 : Number(item.votingUnits),
      flags: {
        allowOwnerMint: item.allowOwnerMint,
        transfersPausable: item.transfersPausable,
        cantBeRemoved: item.cantBeRemoved,
        allowCredits: item.allowCredits,
        ownerCanEditDiscount: item.ownerCanEditDiscount,
      },
      perChainSupply,
    }
  })
}

function splitRecipientForChain(split: DraftSplit, chainId: number) {
  const override = split.perChain[chainId]?.trim() || ''
  const lockedUntil = split.lockedUntil
    ? Math.floor(new Date(split.lockedUntil).getTime() / 1000)
    : 0

  if (split.kind === 'hook') {
    const optionalProjectId = split.projectId.trim().replace('#', '')
    return {
      projectId: optionalProjectId ? BigInt(optionalProjectId) : 0n,
      beneficiary: resolvedAddress(split.beneficiary) ?? zeroAddress,
      preferAddToBalance: false,
      lockedUntil,
      hook:
        split.hookKind === 'fundmarket'
          ? LP_SPLIT_HOOK
          : resolvedAddress(split.hookAddress)!,
    }
  }

  if (split.kind === 'project') {
    const projectId = (override || split.projectId).trim().replace('#', '')
    const beneficiary =
      split.perChainBeneficiary[chainId]?.trim() || split.beneficiary
    return {
      projectId: BigInt(projectId),
      beneficiary: split.preferAddToBalance
        ? (resolvedAddress(beneficiary) ?? zeroAddress)
        : resolvedAddress(beneficiary)!,
      preferAddToBalance: split.preferAddToBalance,
      lockedUntil,
      hook: zeroAddress,
    }
  }

  return {
    projectId: 0n,
    beneficiary: resolvedAddress(override || split.recipient)! as Address,
    preferAddToBalance: false,
    lockedUntil,
    hook: zeroAddress,
  }
}
