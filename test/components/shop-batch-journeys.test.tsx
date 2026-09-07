import { bytes32ToCidV0 } from '@bananapus/nana-sdk-core'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address, Hex } from 'viem'
import type { ProjectBatch, ProjectBatchCall } from '@/lib/project-batch'
import type { ShopAction, ShopSnapshot, ShopWriteTarget } from '@/lib/shop-batch'

const mocks = vi.hoisted(() => ({ wallet: { address: '0x1111111111111111111111111111111111111111', isConnected: true, openSignIn: vi.fn() }, saved: null as ProjectBatch | null, run: vi.fn(), snapshot: vi.fn(), reverify: vi.fn(), pinItems: vi.fn(), pinImage: vi.fn(), pinJson: vi.fn(), metadata: vi.fn(), tier: vi.fn(), invalidate: vi.fn() }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => mocks.wallet }))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: mocks.invalidate }) }))
vi.mock('@/lib/authority', () => ({ clientFor: () => ({}) }))
vi.mock('@/lib/project-batch', () => ({ loadProjectBatch: () => mocks.saved, projectBatchScope: (action: string, chain: number, project: number) => `${action}:${chain}:${project}`, runProjectBatch: mocks.run }))
vi.mock('@/lib/store-items', async original => ({ ...await original(), pinStoreItemDrafts: mocks.pinItems }))
vi.mock('@/lib/jbcenter-ipfs', () => ({ JBCENTER_MAX_IMAGE_BYTES: 1_000_000, JBCENTER_MAX_MEDIA_BYTES: 500_000_000, jbCenterIpfs: { pinImage: mocks.pinImage, pinMedia: mocks.pinImage, pinJson: mocks.pinJson } }))
vi.mock('@/lib/shop-batch', async original => ({ ...await original(), pendingShopBatch: () => mocks.saved, readShopSnapshot: mocks.snapshot, reverifyShopCall: mocks.reverify, readOriginalShopMetadata: mocks.metadata, readShopTier: mocks.tier }))
vi.mock('@/components/create/StoreEditor', async original => ({ ...await original(), StoreEditor: () => null }))
vi.mock('@/components/ui/ModalShell', () => ({ ModalShell: ({ children, footer }: { children: React.ReactNode; footer: React.ReactNode }) => <section>{children}{footer}</section> }))
vi.mock('@/components/ui/TxConfirmDialog', () => ({ TxConfirmDialog: () => null }))
vi.mock('@/components/ui/ChainPillButton', () => ({ ChainPillButton: () => null }))
vi.mock('@/components/ChainIcon', () => ({ ChainIcon: () => null }))

import { AddShopItemsModal } from '@/components/project/AddShopItemsModal'
import { ReplaceTierMediaModal } from '@/components/project/ReplaceTierMediaModal'
import { StoreEditor, newDraftItem } from '@/components/create/StoreEditor'
import { TxConfirmDialog } from '@/components/ui/TxConfirmDialog'
import { buildShopAddCalls, buildShopMediaCalls } from '@/lib/shop-batch'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const HOOK = '0x2222222222222222222222222222222222222222' as Address
const PEER = '0x3333333333333333333333333333333333333333' as Address
const URI = `0x${'a'.repeat(64)}` as Hex
const targets: ShopWriteTarget[] = [
  { chainId: 1, projectId: 101, hook: HOOK, pricing: { currency: 2, decimals: 18, symbol: 'USD' } },
  { chainId: 8453, projectId: 202, hook: PEER, pricing: { currency: 2, decimals: 6, symbol: 'USD' } },
]
function snapshot(target: ShopWriteTarget, action: ShopAction): ShopSnapshot {
  return { target: { ...target, hook: target.hook!, pricing: target.pricing! }, isRevnet: false, action, account: ACCOUNT, owner: ACCOUNT, authority: ACCOUNT, store: HOOK, metadataIdTarget: HOOK, state: 'frozen', ...(action === 'shop-add-items' ? { maxTierId: '20' } : { tierId: 7, encodedIpfsUri: URI }) }
}
function journal(action: ShopAction, calls: ProjectBatchCall[]): ProjectBatch {
  return { version: 1, id: 'saved', scope: `${action}:1:101`, action, account: ACCOUNT, title: 'Saved shop update', status: 'pending', calls, completedIds: [calls[0].id], rounds: [calls.map(call => call.id)], submissions: {}, relayrRounds: [0] }
}
beforeEach(() => {
  mocks.saved = null; mocks.wallet.address = ACCOUNT
  mocks.snapshot.mockImplementation(async (target, _account, _revnet, action) => snapshot(target, action))
  mocks.reverify.mockResolvedValue(undefined)
  mocks.tier.mockResolvedValue({ encodedIpfsUri: URI })
  mocks.metadata.mockResolvedValue({ name: 'Original item', properties: { nested: ['preserve'] }, custom: 123, image: 'ipfs://old' })
  mocks.pinItems.mockImplementation(async (drafts: ReturnType<typeof newDraftItem>[]) => drafts.map(draft => ({ draft, encodedIpfsUri: URI })))
  mocks.pinImage.mockResolvedValue({ uri: 'ipfs://new-media' })
  mocks.pinJson.mockResolvedValue({ cid: bytes32ToCidV0(URI) })
  mocks.run.mockImplementation(async args => {
    const saved = mocks.saved ?? journal(args.action, args.calls)
    // The actual runner proves unfinished calls; confirmed peers skip source checks.
    for (const call of saved.calls.filter(call => !saved.completedIds.includes(call.id))) await args.reverify(call)
    return { ...saved, status: 'complete', completedIds: saved.calls.map(call => call.id) }
  })
})
async function addModal() {
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(<AddShopItemsModal targets={targets} activePricing={targets[0].pricing!} existingCategories={[]} isRevnet={false} onClose={() => {}} />) })
  return renderer
}
async function mediaModal() {
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = create(<ReplaceTierMediaModal chainId={1} hook={HOOK} tierId={7} current={{ name: 'Display item' }} targets={targets} isRevnet={false} onClose={() => {}} />) })
  return renderer
}
async function clickReview(renderer: ReactTestRenderer) {
  const button = renderer.root.findAllByType('button').find(button => button.props.className.includes('btn-primary'))!
  await act(async () => { button.props.onClick(); await Promise.resolve() })
}
async function confirm(renderer: ReactTestRenderer) {
  await act(async () => { renderer.root.findByType(TxConfirmDialog).props.onConfirm(); await Promise.resolve() })
}

describe('shop batch component journeys', () => {
  it('reviews and submits per-destination add calls with frozen items and live revalidation', async () => {
    mocks.invalidate.mockRejectedValueOnce(new Error('Cache refresh unavailable'))
    const renderer = await addModal()
    const draft = { ...newDraftItem(), name: 'Reviewed', price: '3.123456', supply: '7', perChainSupply: { 8453: '19' } }
    await act(async () => { renderer.root.findByType(StoreEditor).props.onChange([draft]) })
    await clickReview(renderer)
    draft.price = '999'; draft.perChainSupply[8453] = '88'
    await confirm(renderer)
    const args = mocks.run.mock.calls[0][0]
    expect(args.calls.map((call: ProjectBatchCall) => [call.chainId, call.projectId, call.target])).toEqual([[1, 101, HOOK], [8453, 202, PEER]])
    expect(args.calls[1].context.items[0]).toMatchObject({ name: 'Reviewed', price: '3.123456', supply: '19' })
    expect(mocks.reverify).toHaveBeenCalled()
    expect(renderer.root.findByType(TxConfirmDialog).props.complete).toBe(true)
    await act(async () => renderer.unmount())
  })
  it('stops a stale add review before pinning or publishing', async () => {
    const renderer = await addModal()
    await act(async () => renderer.root.findByType(StoreEditor).props.onChange([{ ...newDraftItem(), name: 'Item', price: '1' }]))
    await clickReview(renderer)
    mocks.reverify.mockRejectedValue(new Error('Shop changed'))
    await confirm(renderer)
    expect(mocks.pinItems).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled()
    expect(renderer.root.findByType(TxConfirmDialog).props.error).toContain('Shop changed')
    await act(async () => renderer.unmount())
  })
  it('passes a frozen owner Safe to the shared shop runner for an EOA signer', async () => {
    mocks.snapshot.mockImplementation(async (target, _account, _revnet, action) => ({ ...snapshot(target, action), owner: PEER, authority: PEER }))
    const renderer = await addModal()
    await act(async () => renderer.root.findByType(StoreEditor).props.onChange([{ ...newDraftItem(), name: 'Safe item', price: '1' }]))
    await clickReview(renderer); await confirm(renderer)
    const submitted = mocks.run.mock.calls[0][0]
    expect(submitted.account).toBe(ACCOUNT)
    expect(submitted.calls.every((call: ProjectBatchCall) => call.authority === PEER)).toBe(true)
    expect(renderer.root.findByType(TxConfirmDialog).props.complete).toBe(true)
    await act(async () => renderer.unmount())
  })
  it('reopens a partially confirmed add batch without drafts, re-pinning or new calls', async () => {
    const calls = buildShopAddCalls(targets.map(target => snapshot(target, 'shop-add-items')), ACCOUNT, [{ draft: { ...newDraftItem(), name: 'Original', price: '1' }, encodedIpfsUri: URI }])
    mocks.saved = journal('shop-add-items', calls)
    const renderer = await addModal()
    expect(renderer.root.findByType(TxConfirmDialog).props.action).toBe('Continue saved update')
    await confirm(renderer)
    expect(mocks.run.mock.calls[0][0]).toMatchObject({ scope: mocks.saved.scope, account: ACCOUNT, calls: mocks.saved.calls, expectedBatchId: mocks.saved.id })
    expect(mocks.pinItems).not.toHaveBeenCalled()
    expect(mocks.reverify.mock.calls.map(([call]) => call.id)).toEqual([calls[1].id])
    expect(renderer.root.findByType(TxConfirmDialog).props.complete).toBe(true)
    await act(async () => renderer.unmount())
  })
  it('preserves the full original media JSON in a newly reviewed multichain update', async () => {
    const renderer = await mediaModal()
    const file = new File(['image'], 'new.png', { type: 'image/png' })
    await act(async () => renderer.root.findByProps({ type: 'file' }).props.onChange({ target: { files: [file] } }))
    await clickReview(renderer); await confirm(renderer)
    expect(mocks.pinJson).toHaveBeenCalledWith({ name: 'Original item', properties: { nested: ['preserve'] }, custom: 123, image: 'ipfs://new-media', mediaType: 'image/png' })
    const args = mocks.run.mock.calls[0][0]
    expect(args.calls.map((call: ProjectBatchCall) => [call.chainId, call.projectId, call.target])).toEqual([[1, 101, HOOK], [8453, 202, PEER]])
    expect(renderer.root.findByType(TxConfirmDialog).props.complete).toBe(true)
    await act(async () => renderer.unmount())
  })
  it('resumes saved media without the upload file and rejects another connected account', async () => {
    const calls = buildShopMediaCalls(targets.map(target => snapshot(target, 'shop-replace-media')), ACCOUNT, URI, 'saved.png', 'Saved item')
    mocks.saved = journal('shop-replace-media', calls)
    const renderer = await mediaModal()
    mocks.wallet.address = PEER
    await act(async () => renderer.update(<ReplaceTierMediaModal chainId={1} hook={HOOK} tierId={7} current={undefined} targets={targets} isRevnet={false} onClose={() => {}} />))
    await confirm(renderer)
    expect(mocks.run).not.toHaveBeenCalled()
    expect(renderer.root.findByType(TxConfirmDialog).props.error).toContain('Reconnect')
    mocks.wallet.address = ACCOUNT
    await act(async () => renderer.update(<ReplaceTierMediaModal chainId={1} hook={HOOK} tierId={7} current={undefined} targets={targets} isRevnet={false} onClose={() => {}} />))
    await confirm(renderer)
    expect(mocks.run.mock.calls[0][0]).toMatchObject({ calls: mocks.saved.calls, scope: mocks.saved.scope, expectedBatchId: mocks.saved.id })
    expect(mocks.pinImage).not.toHaveBeenCalled(); expect(mocks.pinJson).not.toHaveBeenCalled()
    expect(renderer.root.findByType(TxConfirmDialog).props.complete).toBe(true)
    await act(async () => renderer.unmount())
  })

  it.each(['add', 'media'] as const)('clears an abandoned %s batch before retrying the reviewed inputs', async kind => {
    const renderer = kind === 'add' ? await addModal() : await mediaModal()
    if (kind === 'add') {
      await act(async () => renderer.root.findByType(StoreEditor).props.onChange([{ ...newDraftItem(), name: 'Item', price: '1' }]))
    } else {
      const file = new File(['image'], 'new.png', { type: 'image/png' })
      await act(async () => renderer.root.findByProps({ type: 'file' }).props.onChange({ target: { files: [file] } }))
    }
    await clickReview(renderer)
    mocks.run.mockImplementationOnce(async args => {
      mocks.saved = { ...journal(args.action, args.calls), completedIds: [] }
      args.onProgress({ message: 'Preparing…', completed: 0, total: args.calls.length, round: 1, rounds: 1 })
      mocks.saved = null // The runner abandoned an intent with no exposed request.
      throw new Error('Review canceled before publication.')
    })
    await confirm(renderer)
    expect(renderer.root.findByType(TxConfirmDialog).props.complete).toBe(false)
    await confirm(renderer)
    expect(mocks.run.mock.calls[1][0]).toMatchObject({ expectedBatchId: undefined })
    expect(mocks.run.mock.calls[1][0].calls).toEqual(mocks.run.mock.calls[0][0].calls)
    expect(kind === 'add' ? mocks.pinItems : mocks.pinJson).toHaveBeenCalledTimes(1)
    expect(renderer.root.findByType(TxConfirmDialog).props.complete).toBe(true)
    await act(async () => renderer.unmount())
  })
})
