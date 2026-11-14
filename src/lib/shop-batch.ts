import { bytes32ToCidV0, jb721TiersHookAbi, jb721TiersHookStoreAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { getProjectNftInventory, hasPermissions, JBPermissionIdsV6 } from '@bananapus/nana-sdk-core/v6'
import { decodeFunctionData, encodeFunctionData, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { clientFor } from '@/lib/authority'
import { readAuthorityIdentity } from '@bananapus/nana-sdk-core/safe'
import { ipfsUrl } from '@/lib/format'
import { fetchMetadataJson } from '@/lib/metadata-json'
import { build721TierConfigs } from '@/lib/launch'
import { loadProjectBatch, projectBatchScope, type ProjectBatchCall } from '@/lib/project-batch'
import { storeItemsForChain, type PinnedStoreItemDraft } from '@/lib/store-items'
import { buildAdjustTiersRequest, buildSet721DiscountRequest, buildSet721TierMediaRequest } from '@/lib/transaction-builders'
import { assertShopCallPolicy } from '@/lib/shop-call-policy'
import { chainName } from '@/lib/urn'

export type ShopWriteTarget = {
  chainId: JBChainId
  projectId: number
  hook: Address | null
  pricing: { currency: number; decimals: number; symbol: string } | null
  error?: string
}
/** Every shop action: the permission an operator needs, the words for a refusal,
 * the call it sends, and whether it rewrites the item's metadata. */
export const SHOP_ACTIONS = {
  'shop-add-items': { permission: JBPermissionIdsV6.ADJUST_721_TIERS, verb: 'add items', functionName: 'adjustTiers', metadata: false },
  'shop-replace-media': { permission: JBPermissionIdsV6.SET_721_METADATA, verb: 'replace media', functionName: 'setMetadata', metadata: true },
  'shop-edit-details': { permission: JBPermissionIdsV6.SET_721_METADATA, verb: 'edit item details', functionName: 'setMetadata', metadata: true },
  'shop-set-discount': { permission: JBPermissionIdsV6.SET_721_DISCOUNT_PERCENT, verb: 'set discounts', functionName: 'setDiscountPercentOf', metadata: false },
  'shop-remove-item': { permission: JBPermissionIdsV6.ADJUST_721_TIERS, verb: 'remove items', functionName: 'adjustTiers', metadata: false },
} as const
export type ShopAction = keyof typeof SHOP_ACTIONS
export type ShopItemAction = Exclude<ShopAction, 'shop-add-items'>
export type ShopSnapshot = {
  target: ShopWriteTarget & { hook: Address; pricing: NonNullable<ShopWriteTarget['pricing']> }
  isRevnet: boolean
  action: ShopAction
  account: Address
  owner: Address
  authority: Address
  store: Address
  metadataIdTarget: Address
  state: string
  maxTierId?: string
  tierId?: number
  encodedIpfsUri?: Hex
}
export type ShopCallContext = {
  snapshot: ShopSnapshot
  items: { name: string; price: string; supply: string; tierId?: string }[]
  mediaName?: string
  /** What a discount or details update sets, as the review shows it. */
  summary?: string
}

function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry)
}

/** A chain selector cannot disambiguate two shops on the same chain. */
export function distinctShopTargets(targets: ShopWriteTarget[]): ShopWriteTarget[] {
  const seen = new Map<number, ShopWriteTarget>()
  for (const target of targets) {
    if (!Number.isSafeInteger(target.projectId) || target.projectId < 1) throw new Error('Invalid shop project ID.')
    const previous = seen.get(target.chainId)
    if (previous && fingerprint(previous) !== fingerprint(target)) {
      throw new Error(`Multiple shops on ${chainName(target.chainId)} must be updated in separate rounds. Reopen the intended shop first.`)
    }
    seen.set(target.chainId, target)
  }
  return [...seen.values()]
}

export function pendingShopBatch(action: ShopAction, targets: ShopWriteTarget[]) {
  for (const target of targets) {
    const batch = loadProjectBatch(projectBatchScope(action, target.chainId, target.projectId))
    if (batch?.status === 'pending') return batch
  }
  return null
}

export async function readShopTier(client: PublicClient, hook: Address, tierId: number) {
  const store = await client.readContract({ address: hook, abi: jb721TiersHookAbi, functionName: 'STORE' })
  // `tierOf` still returns a removed item, and `setMetadata` would write to it.
  const [tier, removed] = await Promise.all([
    client.readContract({ address: store, abi: jb721TiersHookStoreAbi, functionName: 'tierOf', args: [hook, BigInt(tierId), false] }),
    client.readContract({ address: store, abi: jb721TiersHookStoreAbi, functionName: 'isTierRemoved', args: [hook, BigInt(tierId)] }),
  ])
  if (removed || Number(tier.id) !== tierId || tier.initialSupply === 0 || /^0x0+$/.test(tier.encodedIpfsUri)) throw new Error('This shop no longer has the selected item.')
  return tier
}

/** Resolve the actual project hook and its authority; never trust route props alone. */
export async function readShopSnapshot(target: ShopWriteTarget, account: Address, isRevnet: boolean, action: ShopAction, tierId?: number): Promise<ShopSnapshot> {
  if (!target.hook || !target.pricing || target.error) throw new Error(`${chainName(target.chainId)} shop is unavailable.`)
  const client = clientFor(target.chainId)
  const shop = await getProjectNftInventory(client, { chainId: target.chainId, projectId: BigInt(target.projectId), isRevnet, tierLimit: 1 })
  if (shop?.protocol === 'defifa') throw new Error('This collection does not support the standard tier editor.')
  if (!shop || shop.hook.toLowerCase() !== target.hook.toLowerCase()) throw new Error(`The shop on ${chainName(target.chainId)} changed. Reopen it and review again.`)
  if (shop.pricing.currency !== target.pricing.currency || shop.pricing.decimals !== target.pricing.decimals) throw new Error(`Shop pricing changed on ${chainName(target.chainId)}. Review again.`)
  const [owner, projectId] = await Promise.all([
    client.readContract({ address: target.hook, abi: jb721TiersHookAbi, functionName: 'owner' }),
    client.readContract({ address: target.hook, abi: jb721TiersHookAbi, functionName: 'projectId' }),
  ])
  if (projectId !== BigInt(target.projectId)) throw new Error('The shop is associated with a different project.')
  let authority = owner
  if (owner.toLowerCase() !== account.toLowerCase()) {
    const identity = await readAuthorityIdentity(client, owner)
    if (identity?.kind !== 'safe' || !identity.owners.some(signer => signer.toLowerCase() === account.toLowerCase())) {
      if (!await hasPermissions(client, {
        chainId: target.chainId, operator: account, account: owner, projectId,
        permissionIds: [SHOP_ACTIONS[action].permission],
      })) throw new Error(`This wallet cannot ${SHOP_ACTIONS[action].verb} on ${chainName(target.chainId)}.`)
      authority = account
    }
  }
  const common = { target: { ...target, hook: target.hook, pricing: { ...target.pricing } }, isRevnet, action, account: account.toLowerCase() as Address, owner, authority: authority.toLowerCase() as Address, store: shop.store, metadataIdTarget: shop.metadataIdTarget }
  if (action === 'shop-add-items') {
    const [maxTierId, flags] = await Promise.all([
      client.readContract({ address: shop.store, abi: jb721TiersHookStoreAbi, functionName: 'maxTierIdOf', args: [target.hook] }),
      client.readContract({ address: shop.store, abi: jb721TiersHookStoreAbi, functionName: 'flagsOf', args: [target.hook] }),
    ])
    return { ...common, state: fingerprint({ maxTierId, flags }), maxTierId: maxTierId.toString() }
  }
  if (!tierId || !Number.isSafeInteger(tierId)) throw new Error('Choose an item to update.')
  const [tier, resolver, baseURI] = await Promise.all([
    readShopTier(client, target.hook, tierId),
    client.readContract({ address: shop.store, abi: jb721TiersHookStoreAbi, functionName: 'tokenUriResolverOf', args: [target.hook] }),
    client.readContract({ address: target.hook, abi: jb721TiersHookAbi, functionName: 'baseURI' }),
  ])
  if (SHOP_ACTIONS[action].metadata && resolver.toLowerCase() !== zeroAddress) throw new Error(`The shop on ${chainName(target.chainId)} uses a custom URI resolver. Its media must be updated through that resolver.`)
  if (action === 'shop-remove-item' && tier.flags.cantBeRemoved) throw new Error(`This item cannot be removed on ${chainName(target.chainId)}.`)
  // Sales may change remaining supply during review; they do not change the
  // item being edited. Every configuration field and the original URI do.
  const { remainingSupply: _remaining, resolvedUri: _resolved, ...configuration } = tier
  void _remaining; void _resolved
  return { ...common, state: fingerprint({ configuration, resolver, baseURI }), tierId, encodedIpfsUri: tier.encodedIpfsUri }
}

export async function reverifyShopCall(call: ProjectBatchCall, account: Address, authorizing = false) {
  const { snapshot } = call.context as ShopCallContext
  if (!snapshot || snapshot.target.chainId !== call.chainId || snapshot.target.projectId !== call.projectId || snapshot.target.hook.toLowerCase() !== call.target.toLowerCase() || snapshot.account?.toLowerCase() !== account.toLowerCase() || snapshot.authority?.toLowerCase() !== call.authority.toLowerCase()) throw new Error('The saved shop update has an inconsistent identity.')
  if (authorizing) {
    // The bytes must be the reviewed action on the reviewed item, nothing wider.
    const decoded = decodeFunctionData({ abi: jb721TiersHookAbi, data: call.data })
    const item = BigInt(snapshot.tierId ?? 0)
    const exact = decoded.functionName !== SHOP_ACTIONS[snapshot.action]?.functionName ? false
      : decoded.functionName === 'adjustTiers' ? (snapshot.action === 'shop-add-items' ? decoded.args[1].length === 0 : decoded.args[0].length === 0 && decoded.args[1].length === 1 && decoded.args[1][0] === item)
      : decoded.functionName === 'setDiscountPercentOf' ? decoded.args[0] === item
      : decoded.functionName === 'setMetadata' && decoded.args.slice(0, 4).every(text => text === '') && decoded.args[4].toLowerCase() === call.target.toLowerCase() && decoded.args[5] === item
    if (!exact) throw new Error('The saved shop update is not the reviewed action.')
    assertShopCallPolicy(call.data, call.target)
  }
  const fresh = await readShopSnapshot(snapshot.target, account, snapshot.isRevnet, snapshot.action, snapshot.tierId)
  if (fingerprint(fresh) !== fingerprint(snapshot)) throw new Error(`The shop or item on ${chainName(call.chainId)} changed since review. This saved update cannot be signed against different settings.`)
}

export function buildShopAddCalls(snapshots: ShopSnapshot[], account: Address, pinned: PinnedStoreItemDraft[]): ProjectBatchCall[] {
  return snapshots.map(snapshot => {
    if (snapshot.account.toLowerCase() !== account.toLowerCase()) throw new Error('The shop review belongs to another wallet.')
    const { target } = snapshot
    for (const { draft } of pinned) {
      // viem parseUnits rounds excess precision; this editor must reject it.
      const fraction = draft.price.trim().split('.')[1]?.replace(/0+$/, '') ?? ''
      if (fraction.length > target.pricing.decimals) throw new Error(`“${draft.name.trim()}” has too many decimal places for ${chainName(target.chainId)}.`)
    }
    const tiers = build721TierConfigs(storeItemsForChain(pinned, target.pricing.decimals, target.chainId), target.chainId)
    const { flags } = JSON.parse(snapshot.state) as { flags: { noNewTiersWithVotes: boolean } }
    if (flags.noNewTiersWithVotes && tiers.some(tier => tier.price > 0n)) {
      throw new Error(`${chainName(target.chainId)}: voting rules block new paid items.`)
    }
    const request = buildAdjustTiersRequest({ chainId: target.chainId, hook: target.hook, tiers })
    const items = [...pinned].sort((a, b) => a.draft.category - b.draft.category).map(({ draft }, index) => ({ name: draft.name.trim(), price: draft.price, supply: draft.perChainSupply[target.chainId]?.trim() || draft.supply, tierId: (BigInt(snapshot.maxTierId ?? '0') + BigInt(index) + 1n).toString() }))
    return { id: `${target.chainId}:${target.hook}:add`, projectId: target.projectId, chainId: target.chainId, authority: snapshot.authority, target: target.hook, data: encodeFunctionData(request), abi: request.abi, functionName: request.functionName, args: request.args, contractName: 'JB721TiersHook', label: 'Add shop items', context: { snapshot, items } satisfies ShopCallContext }
  })
}

export type ShopItemChange =
  | { action: 'shop-replace-media'; encodedIpfsUri: Hex; mediaName: string }
  | { action: 'shop-edit-details'; encodedIpfsUri: Hex; summary: string }
  /** `discountPercent` is out of the hook's 200. */
  | { action: 'shop-set-discount'; discountPercent: number; summary: string }
  | { action: 'shop-remove-item' }
const ITEM_CALLS = {
  'shop-replace-media': ['media', 'Replace item media'],
  'shop-edit-details': ['details', 'Edit item details'],
  'shop-set-discount': ['discount', 'Set item discount'],
  'shop-remove-item': ['remove', 'Remove shop item'],
} as const

/** One call per reviewed chain for a change to one existing item. */
export function buildShopItemCalls(snapshots: ShopSnapshot[], account: Address, change: ShopItemChange, itemName: string): ProjectBatchCall[] {
  return snapshots.map(snapshot => {
    if (snapshot.account.toLowerCase() !== account.toLowerCase()) throw new Error('The shop review belongs to another wallet.')
    const { target, tierId } = snapshot
    if (!tierId || snapshot.action !== change.action) throw new Error('The reviewed item is missing.')
    const place = { chainId: target.chainId, hook: target.hook }
    let request
    if (change.action === 'shop-remove-item') request = buildAdjustTiersRequest({ ...place, tiers: [], tierIdsToRemove: [BigInt(tierId)] })
    else if (change.action === 'shop-set-discount') {
      const { configuration } = JSON.parse(snapshot.state) as { configuration: { discountPercent: number; flags: { cantIncreaseDiscountPercent: boolean } } }
      if (change.discountPercent === configuration.discountPercent) throw new Error(`${chainName(target.chainId)} already has this discount.`)
      if (configuration.flags.cantIncreaseDiscountPercent && change.discountPercent > configuration.discountPercent) throw new Error(`This item's discount can only be lowered on ${chainName(target.chainId)}.`)
      request = buildSet721DiscountRequest({ ...place, tierId, discountPercent: change.discountPercent })
    } else request = buildSet721TierMediaRequest({ ...place, tierId, encodedIpfsUri: change.encodedIpfsUri })
    const [suffix, label] = ITEM_CALLS[change.action]
    const context: ShopCallContext = { snapshot, items: [{ name: itemName, price: '', supply: '' }], ...('mediaName' in change ? { mediaName: change.mediaName } : {}), ...('summary' in change ? { summary: change.summary } : {}) }
    return { id: `${target.chainId}:${target.hook}:${tierId}:${suffix}`, projectId: target.projectId, chainId: target.chainId, authority: snapshot.authority, target: target.hook, data: encodeFunctionData(request as Parameters<typeof encodeFunctionData>[0]), abi: request.abi, functionName: request.functionName, args: request.args, contractName: 'JB721TiersHook', label, context }
  })
}

export function buildShopMediaCalls(snapshots: ShopSnapshot[], account: Address, encodedIpfsUri: Hex, mediaName: string, itemName: string): ProjectBatchCall[] {
  return buildShopItemCalls(snapshots, account, { action: 'shop-replace-media', encodedIpfsUri, mediaName }, itemName)
}

export async function readOriginalShopMetadata(encodedIpfsUri: Hex): Promise<Record<string, unknown>> {
  const cid = bytes32ToCidV0(encodedIpfsUri)
  const url = cid && ipfsUrl(`ipfs://${cid}`)
  if (!url) throw new Error('The original item metadata is not readable.')
  let metadata: unknown
  try {
    metadata = await fetchMetadataJson(url, { signal: AbortSignal.timeout(15_000) })
  } catch (error) {
    throw new Error('Could not load the original item metadata. Try again before replacing media.', { cause: error })
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('The original item metadata is not a JSON object.')
  return metadata as Record<string, unknown>
}

export function replaceShopMetadataMedia(original: Record<string, unknown>, uri: string, mimeType: string): Record<string, unknown> {
  const next: Record<string, unknown> = { ...original, mediaType: mimeType }
  delete next.image
  delete next.animation_url
  if (mimeType.startsWith('image/')) next.image = uri
  else next.animation_url = uri
  return next
}

export const SHOP_ITEM_NAME_MAX = 200
export const SHOP_ITEM_DESCRIPTION_MAX = 20_000

/** Rename or redescribe an item, keeping every other field of its original JSON. */
export function editShopMetadataDetails(original: Record<string, unknown>, name: string, description: string): Record<string, unknown> {
  const next = { ...original, name: name.trim(), description: description.trim() }
  if (!next.name) throw new Error('Name the item.')
  if (next.name.length > SHOP_ITEM_NAME_MAX) throw new Error(`Keep the name within ${SHOP_ITEM_NAME_MAX} characters.`)
  if (next.description.length > SHOP_ITEM_DESCRIPTION_MAX) throw new Error(`Keep the description within ${SHOP_ITEM_DESCRIPTION_MAX.toLocaleString('en-US')} characters.`)
  if (next.name === original.name && next.description === (original.description ?? '')) throw new Error('Change the name or the description first.')
  return next
}
