import { jb721TiersHookAbi } from '@bananapus/nana-sdk-core'
import { decodeFunctionData, parseUnits, zeroAddress, type Address, type Hex } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ shop: vi.fn(), permissions: vi.fn(), client: vi.fn(), load: vi.fn(), identity: vi.fn() }))
vi.mock('@bananapus/nana-sdk-core/v6', async original => ({ ...await original(), getProject721Shop: mocks.shop, hasPermissions: mocks.permissions }))
vi.mock('@/lib/authority', () => ({ clientFor: mocks.client }))
vi.mock('@/lib/cross-chain-authority', () => ({ readAuthorityIdentity: mocks.identity }))
vi.mock('@/lib/project-batch', () => ({ loadProjectBatch: mocks.load, projectBatchScope: (action: string, chain: number, project: number) => `${action}:${chain}:${project}` }))

import { newDraftSplit } from '@/components/create/SplitsEditor'
import { newDraftItem } from '@/components/create/StoreEditor'
import { buildShopAddCalls, buildShopMediaCalls, distinctShopTargets, pendingShopBatch, readOriginalShopMetadata, readShopSnapshot, replaceShopMetadataMedia, reverifyShopCall, type ShopWriteTarget } from '@/lib/shop-batch'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const HOOK = '0x2222222222222222222222222222222222222222' as Address
const STORE = '0x3333333333333333333333333333333333333333' as Address
const PEER_HOOK = '0x4444444444444444444444444444444444444444' as Address
const PEER_RECIPIENT = '0x5555555555555555555555555555555555555555' as Address
const URI = `0x${'a'.repeat(64)}` as Hex
const NEW_URI = `0x${'b'.repeat(64)}` as Hex
const targets: ShopWriteTarget[] = [
  { chainId: 1, projectId: 101, hook: HOOK, pricing: { currency: 2, decimals: 18, symbol: 'USD' } },
  { chainId: 8453, projectId: 202, hook: PEER_HOOK, pricing: { currency: 2, decimals: 6, symbol: 'USD' } },
]
const flags = { allowOwnerMint: true, transfersPausable: true, cantBeRemoved: false, cantIncreaseDiscountPercent: false, cantBuyWithCredits: false }
const state = new Map<number, { owner: Address; projectId: bigint; max: bigint; uri: Hex; remaining: number; price: bigint; resolver: Address; baseURI: string; denied?: boolean }>()
beforeEach(() => {
  for (const target of targets) state.set(target.chainId, { owner: ACCOUNT, projectId: BigInt(target.projectId), max: target.chainId === 1 ? 19n : 38n, uri: URI, remaining: 15, price: 987654321123456789n, resolver: zeroAddress, baseURI: 'ipfs://' })
  mocks.identity.mockResolvedValue({ kind: 'eoa' })
  mocks.shop.mockImplementation(async (_client, args) => {
    const target = targets.find(target => target.chainId === args.chainId)!
    return { hook: target.hook, store: STORE, metadataIdTarget: HOOK, pricing: target.pricing }
  })
  mocks.permissions.mockImplementation(async (_client, args) => !state.get(args.chainId)?.denied)
  mocks.client.mockImplementation((chain: number) => ({ readContract: vi.fn(async request => {
    const value = state.get(chain)!
    switch (request.functionName) {
      case 'owner': return value.owner
      case 'projectId': return value.projectId
      case 'STORE': return STORE
      case 'tokenUriResolverOf': return value.resolver
      case 'baseURI': return value.baseURI
      case 'flagsOf': return { noNewTiersWithReserves: false, noNewTiersWithVotes: false, noNewTiersWithOwnerMinting: false, preventOverspending: false }
      case 'maxTierIdOf': return value.max
      case 'tierOf': return { id: Number(request.args[1]), price: value.price, remainingSupply: value.remaining, initialSupply: 40, votingUnits: 100000000000000000000n, reserveFrequency: 2, reserveBeneficiary: PEER_RECIPIENT, encodedIpfsUri: value.uri, category: 8, discountPercent: 17, flags, splitPercent: 123456789, resolvedUri: '' }
      default: throw new Error(`Unexpected ${request.functionName}`)
    }
  }) }))
  mocks.load.mockReturnValue(null)
})

describe('shop batch destination review', () => {
  it('preserves exact price, recipient/project/hook mappings, flags, and per-chain inventory', async () => {
    const snapshots = await Promise.all(targets.map(target => readShopSnapshot(target, ACCOUNT, false, 'shop-add-items')))
    const draft = { ...newDraftItem(), name: 'Exact item', price: '999999999999.123456', supply: '9', perChainSupply: { 8453: '23' }, category: 4, allowOwnerMint: true, votingUnits: '19', reserveN: '3', reserveBeneficiary: ACCOUNT, discountPct: '12.5' }
    draft.splits = [
      { ...newDraftSplit(), value: '20', kind: 'project', projectId: '15', beneficiary: ACCOUNT, perChain: { 8453: '29' }, perChainBeneficiary: { 8453: PEER_RECIPIENT }, preferAddToBalance: true, lockedUntil: '2030-01-01T00:00:00Z' },
      { ...newDraftSplit(), value: '10', kind: 'hook', hookKind: 'custom', hookAddress: PEER_HOOK, projectId: '17', beneficiary: PEER_RECIPIENT },
    ]
    const calls = buildShopAddCalls(snapshots, ACCOUNT, [{ draft, encodedIpfsUri: URI }])
    expect(calls.map(call => [call.chainId, call.projectId, call.target])).toEqual([[1, 101, HOOK], [8453, 202, PEER_HOOK]])
    const configs = calls.map(call => decodeFunctionData({ abi: jb721TiersHookAbi, data: call.data }))
    expect(configs[0].functionName).toBe('adjustTiers')
    const first = configs[0].args![0] as unknown as { price: bigint; initialSupply: number }[]
    const second = configs[1].args![0] as unknown as { price: bigint; initialSupply: number }[]
    expect(first[0]).toMatchObject({ price: parseUnits(draft.price, 18), initialSupply: 9, encodedIpfsUri: URI, votingUnits: 19, reserveFrequency: 3, reserveBeneficiary: ACCOUNT, category: 4, discountPercent: 25, flags: { allowOwnerMint: true, useReserveBeneficiaryAsDefault: true } })
    expect(first[0]).toMatchObject({ splitPercent: 300000000, splits: [{ projectId: 15n, beneficiary: ACCOUNT, preferAddToBalance: true, lockedUntil: 1893456000, hook: zeroAddress }, { projectId: 17n, beneficiary: PEER_RECIPIENT, hook: PEER_HOOK }] })
    expect(second[0]).toMatchObject({ price: parseUnits(draft.price, 6), initialSupply: 23, splits: [{ projectId: 29n, beneficiary: PEER_RECIPIENT, preferAddToBalance: true, lockedUntil: 1893456000, hook: zeroAddress }, { projectId: 17n, beneficiary: PEER_RECIPIENT, hook: PEER_HOOK }] })
    expect(configs.map(config => config.args![1])).toEqual([[], []])
    expect(snapshots.map(snapshot => snapshot.maxTierId)).toEqual(['19', '38'])
  })
  it('rejects excess destination price precision rather than allowing parseUnits to round', async () => {
    const snapshot = await readShopSnapshot(targets[1], ACCOUNT, false, 'shop-add-items')
    const draft = { ...newDraftItem(), name: 'Precise', price: '1.0000001' }
    expect(() => buildShopAddCalls([snapshot], ACCOUNT, [{ draft, encodedIpfsUri: URI }])).toThrow('too many decimal places')
  })
  it.each(['owner', 'project', 'hook', 'tiers', 'permissions'] as const)('fails closed if %s changes after review', async change => {
    const snapshot = await readShopSnapshot(targets[0], ACCOUNT, false, 'shop-add-items')
    const call = buildShopAddCalls([snapshot], ACCOUNT, [{ draft: { ...newDraftItem(), name: 'One', price: '1' }, encodedIpfsUri: URI }])[0]
    if (change === 'owner') state.get(1)!.owner = PEER_RECIPIENT
    if (change === 'project') state.get(1)!.projectId = 909n
    if (change === 'hook') mocks.shop.mockResolvedValue({ hook: PEER_HOOK })
    if (change === 'tiers') state.get(1)!.max++
    if (change === 'permissions') { state.get(1)!.owner = PEER_RECIPIENT; state.get(1)!.denied = true }
    await expect(reverifyShopCall(call, ACCOUNT)).rejects.toThrow()
  })
  it('allows sales during media review but rejects a replaced URI or changed item configuration', async () => {
    const snapshot = await readShopSnapshot(targets[0], ACCOUNT, false, 'shop-replace-media', 7)
    const call = buildShopMediaCalls([snapshot], ACCOUNT, NEW_URI, 'new.png', 'Original name')[0]
    state.get(1)!.remaining = 3
    await expect(reverifyShopCall(call, ACCOUNT)).resolves.toBeUndefined()
    state.get(1)!.price++
    await expect(reverifyShopCall(call, ACCOUNT)).rejects.toThrow('changed since review')
    state.get(1)!.price--; state.get(1)!.uri = NEW_URI
    await expect(reverifyShopCall(call, ACCOUNT)).rejects.toThrow('changed since review')
    const decoded = decodeFunctionData({ abi: jb721TiersHookAbi, data: call.data })
    expect(decoded).toMatchObject({ functionName: 'setMetadata', args: ['', '', '', '', HOOK, 7n, NEW_URI] })
  })
  it('refuses tier media replacement when a custom resolver controls the item URI', async () => {
    state.get(1)!.resolver = PEER_HOOK
    await expect(readShopSnapshot(targets[0], ACCOUNT, false, 'shop-replace-media', 7)).rejects.toThrow('custom URI resolver')
    await expect(readShopSnapshot(targets[0], ACCOUNT, false, 'shop-add-items')).resolves.toMatchObject({ authority: ACCOUNT })
  })
  it('rechecks the reviewed media resolver and base URI before signing', async () => {
    const reviewed = await readShopSnapshot(targets[0], ACCOUNT, false, 'shop-replace-media', 7)
    const call = buildShopMediaCalls([reviewed], ACCOUNT, NEW_URI, 'new.png', 'Item')[0]
    state.get(1)!.baseURI = 'https://different.example/'
    await expect(reverifyShopCall(call, ACCOUNT)).rejects.toThrow('changed since review')
    state.get(1)!.baseURI = 'ipfs://'; state.get(1)!.resolver = PEER_HOOK
    await expect(reverifyShopCall(call, ACCOUNT)).rejects.toThrow('custom URI resolver')
  })
  it.each(['shop-add-items', 'shop-replace-media'] as const)('routes %s through the proven owner Safe and freezes that authority', async action => {
    state.get(1)!.owner = PEER_RECIPIENT
    state.get(1)!.denied = true
    mocks.identity.mockResolvedValue({ kind: 'safe', owners: [ACCOUNT] })
    const reviewed = await readShopSnapshot(targets[0], ACCOUNT, false, action, 7)
    const call = action === 'shop-add-items'
      ? buildShopAddCalls([reviewed], ACCOUNT, [{ draft: { ...newDraftItem(), name: 'Item', price: '1' }, encodedIpfsUri: URI }])[0]
      : buildShopMediaCalls([reviewed], ACCOUNT, NEW_URI, 'new.png', 'Item')[0]
    expect(reviewed).toMatchObject({ owner: PEER_RECIPIENT, authority: PEER_RECIPIENT, account: ACCOUNT })
    expect(call.authority).toBe(PEER_RECIPIENT)
    expect(mocks.permissions).not.toHaveBeenCalled()
    await expect(reverifyShopCall(call, ACCOUNT)).resolves.toBeUndefined()
    await expect(reverifyShopCall({ ...call, authority: ACCOUNT }, ACCOUNT)).rejects.toThrow('inconsistent identity')
    mocks.identity.mockResolvedValue({ kind: 'safe', owners: [PEER_HOOK] })
    await expect(reverifyShopCall(call, ACCOUNT)).rejects.toThrow('This wallet cannot')
  })
  it('uses a separate operator directly only while its explicit permission remains valid', async () => {
    state.get(1)!.owner = PEER_RECIPIENT
    mocks.identity.mockResolvedValue({ kind: 'safe', owners: [PEER_HOOK] })
    const reviewed = await readShopSnapshot(targets[0], ACCOUNT, false, 'shop-replace-media', 7)
    const call = buildShopMediaCalls([reviewed], ACCOUNT, NEW_URI, 'new.png', 'Item')[0]
    expect(call.authority).toBe(ACCOUNT)
    expect(mocks.permissions).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ account: PEER_RECIPIENT, operator: ACCOUNT, projectId: 101n }))
    state.get(1)!.denied = true
    await expect(reverifyShopCall(call, ACCOUNT)).rejects.toThrow('This wallet cannot')
  })
  it('blocks ambiguous same-chain project or hook identity', () => {
    expect(() => distinctShopTargets([targets[0], { ...targets[0], projectId: 404 }])).toThrow('separate rounds')
    expect(distinctShopTargets([targets[0], { ...targets[0] }])).toEqual([targets[0]])
  })
  it('finds a saved operation from any peer project alias', () => {
    const pending = { status: 'pending', scope: 'original' }
    mocks.load.mockImplementation(scope => scope.endsWith(':8453:202') ? pending : null)
    expect(pendingShopBatch('shop-add-items', targets)).toBe(pending)
  })
})

describe('original item metadata', () => {
  it('preserves arbitrary original metadata and changes only the media fields', () => {
    const original = { name: 'Original', description: 'Keep', categoryName: 'Rare', image: 'old.png', animation_url: 'old.mp4', attributes: [{ trait_type: 'color', value: 'blue' }], properties: { license: 'custom', nested: [1, 2] }, external_url: 'https://example.com', custom: 123 }
    expect(replaceShopMetadataMedia(original, 'ipfs://new', 'audio/wav')).toEqual({ name: 'Original', description: 'Keep', categoryName: 'Rare', animation_url: 'ipfs://new', mediaType: 'audio/wav', attributes: original.attributes, properties: original.properties, external_url: original.external_url, custom: 123 })
    expect(original.image).toBe('old.png')
    expect(replaceShopMetadataMedia(original, 'ipfs://new', 'image/png')).not.toHaveProperty('animation_url')
  })
  it('fails closed on an unavailable or invalid original JSON', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response)
    await expect(readOriginalShopMetadata(URI)).rejects.toThrow('Could not load')
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => [] } as unknown as Response)
    await expect(readOriginalShopMetadata(URI)).rejects.toThrow('not a JSON object')
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ unknown: [123] }) } as unknown as Response)
    await expect(readOriginalShopMetadata(URI)).resolves.toEqual({ unknown: [123] })
  })
})
