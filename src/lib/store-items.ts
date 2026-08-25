import { parseUnits, zeroAddress, type Address } from 'viem'
import type {
  DraftItem,
  StoreCategory,
} from '@/components/create/StoreEditor'
import { splitOk, type DraftSplit } from '@/components/create/SplitsEditor'
import { resolvedAddress } from '@/lib/ens'
import { cidV0ToBytes32 } from '@bananapus/nana-sdk-core'
import { DISCOUNT_DENOMINATOR } from '@bananapus/nana-sdk-core/v6'
import {
  requireLpSplitHook,
  type SplitConfig,
  type StoreItem,
  splitShares,
} from '@/lib/launch'
import { JBCENTER_MAX_IMAGE_BYTES, jbCenterIpfs } from '@/lib/jbcenter-ipfs'

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
      const isImage = item.mediaFile.type.startsWith('image/')
      const uri = (
        isImage && item.mediaFile.size <= JBCENTER_MAX_IMAGE_BYTES
          ? await jbCenterIpfs.pinImage(item.mediaFile)
          : await jbCenterIpfs.pinMedia(item.mediaFile)
      ).uri
      if (isImage) image = uri
      else animationUrl = uri
    }

    onStatus(`${label}pinning metadata…`)
    const itemPin = await jbCenterIpfs.pinJson({
      name: item.name.trim(),
      description: item.description.trim() || undefined,
      image,
      animation_url: animationUrl,
      mediaType: item.mediaFile?.type || undefined,
      categoryName:
        categories.find(category => category.id === item.category)?.name ||
        undefined,
    })

    pinned.push({
      draft: item,
      encodedIpfsUri: cidV0ToBytes32(itemPin.cid),
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
      const relativePercents = splitShares(
        splitRows.map(split => Number(split.value)),
      )
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
      discountPercent: Math.round(
        (Number(item.discountPct || '0') * Number(DISCOUNT_DENOMINATOR)) / 100,
      ),
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
          ? requireLpSplitHook(chainId)
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
