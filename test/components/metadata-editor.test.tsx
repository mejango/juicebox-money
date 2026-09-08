import { JBCoreContracts, RevnetCoreContracts, jbContractAddress, jbControllerAbi } from '@bananapus/nana-sdk-core'
import { JBPermissionIdsV6 } from '@bananapus/nana-sdk-core/v6'
import { createElement, type ComponentProps } from 'react'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import { decodeFunctionData, type Address } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The Advanced custom-properties box is the only control that can DELETE a
// projectUri field the app doesn't know about, so these tests pin the exact
// object handed to Juicebox Center for every edit shape.
const mocks = vi.hoisted(() => ({
  metadata: undefined as Record<string, unknown> | undefined,
  loading: false,
  errored: false,
  runAuthorityCalls: vi.fn(),
  fetchProjectMetadataJson: vi.fn(),
  pinJson: vi.fn(),
  clientFor: vi.fn(),
  readAuthorityOf: vi.fn(),
  getAccount: vi.fn(),
  resumeRelayrSession: vi.fn(),
  useQuery: vi.fn(),
  hasPermissions: vi.fn(),
  readAuthorityIdentity: vi.fn(),
  requestLock: vi.fn(),
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: mocks.useQuery,
}))
vi.mock('@wagmi/core', async importOriginal => ({
  ...await importOriginal<typeof import('@wagmi/core')>(),
  getAccount: mocks.getAccount,
}))
vi.mock('@/providers/Providers', () => ({
  wagmiConfig: {},
  SUPPORTED_CHAINS: [],
}))
vi.mock('@/lib/relayr', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/relayr')>(),
  resumeRelayrSession: mocks.resumeRelayrSession,
}))
vi.mock('@bananapus/nana-sdk-core/v6', async importOriginal => ({
  ...await importOriginal<typeof import('@bananapus/nana-sdk-core/v6')>(),
  hasPermissions: mocks.hasPermissions,
}))
vi.mock('@/lib/cross-chain-authority', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/cross-chain-authority')>(),
  readAuthorityIdentity: mocks.readAuthorityIdentity,
}))
vi.mock('@/components/ChainIcon', () => ({
  ChainIcon: () => null,
}))
vi.mock('@/components/LoadingSkeletons', () => ({
  ActionRowsSkeleton: () => null,
}))
vi.mock('@/components/ui/AddressLabel', () => ({
  AddressLabel: () => null,
  AddressText: () => null,
}))
vi.mock('@/lib/authority', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/authority')>()
  return {
    ...original,
    clientFor: mocks.clientFor,
    readAuthorityOf: mocks.readAuthorityOf,
    runAuthorityCalls: mocks.runAuthorityCalls,
    safeOutcomeMessage: (_result: unknown, completed: string) => completed,
  }
})
vi.mock('@/lib/project-metadata', async importOriginal => {
  const original =
    await importOriginal<typeof import('@/lib/project-metadata')>()
  return { ...original, fetchProjectMetadataJson: mocks.fetchProjectMetadataJson }
})
vi.mock('@/lib/jbcenter-ipfs', () => ({
  JBCENTER_MAX_IMAGE_BYTES: 25 * 1024 * 1024,
  jbCenterIpfs: {
    pinJson: mocks.pinJson,
    pinImage: vi.fn(),
    pinMedia: vi.fn(),
  },
}))

import { MetadataEditor } from '@/components/project/AuthorityEditsCard'
import type { AuthorityCall } from '@/lib/authority'
import {
  clearRelayrPendingSession,
  relayrCallsScope,
  saveRelayrPendingSession,
  type RelayrPendingSession,
} from '@/lib/relayr'

type EditorRow = ComponentProps<typeof MetadataEditor>['rows'][number]
type ContractRequest = {
  address: Address
  functionName: string
  args: readonly unknown[]
}

const ALICE = '0x1111111111111111111111111111111111111111' as const
const OTHER = '0x3333333333333333333333333333333333333333' as const
const SAFE = '0x5555555555555555555555555555555555555555' as const
const storage = new Map<string, string>()
const liveRows = new Map<string, EditorRow>()
const owners = new Map<string, Address>()
const metadataByUri = new Map<string, Record<string, unknown>>()
const readsByChain = new Map<number, ReturnType<typeof vi.fn>>()

const ROWS: EditorRow[] = [
  {
    chainId: 1 as const,
    projectId: 42,
    indexedAuthority: null,
    name: 'Ethereum',
    authority: '0x1111111111111111111111111111111111111111' as const,
    controller: '0x2222222222222222222222222222222222222222' as const,
    uri: 'ipfs://QmCurrent',
    token: null,
    tokenName: null,
    tokenSymbol: null,
    error: null,
  },
]

const PEER: EditorRow = {
  ...ROWS[0],
  chainId: 8453,
  projectId: 303,
  name: 'Base',
  controller: '0x4444444444444444444444444444444444444444',
  uri: 'ipfs://QmBaseCurrent',
}

const CURRENT = {
  name: 'Old name',
  description: 'What we do',
  tags: ['games'],
  coverImageUri: 'ipfs://QmCover',
  leagueID: 42,
  extensions: { scoreboard: { url: 'https://scores.example' } },
}

const INITIAL = {
  name: 'Old name',
  tagline: '',
  description: 'What we do',
  logoUri: null,
}

function installLiveRows(rows: EditorRow[]) {
  for (const row of rows) liveRows.set(`${row.chainId}:${row.projectId}`, { ...row })
  for (const chainId of new Set(rows.map(row => row.chainId))) {
    readsByChain.set(chainId, vi.fn(async (request: ContractRequest) => {
      const row = liveRows.get(`${chainId}:${request.args?.[0]}`)
      if (!row) throw new Error(`Unexpected project read on ${chainId}: ${request.args?.[0]}`)
      if (request.functionName === 'ownerOf') {
        expect(request.address.toLowerCase()).toBe(jbContractAddress['6'][JBCoreContracts.JBProjects][chainId].toLowerCase())
        expect(request.args).toEqual([BigInt(row.projectId)])
        return owners.get(`${chainId}:${row.projectId}`) ?? row.authority
      }
      if (request.functionName === 'controllerOf') {
        expect(request.address.toLowerCase()).toBe(jbContractAddress['6'][JBCoreContracts.JBDirectory][chainId].toLowerCase())
        expect(request.args).toEqual([BigInt(row.projectId)])
        return row.controller
      }
      if (request.functionName === 'uriOf') {
        expect(request.address.toLowerCase()).toBe(row.controller?.toLowerCase())
        expect(request.args).toEqual([BigInt(row.projectId)])
        return row.uri
      }
      throw new Error(`Unexpected contract read: ${request.functionName}`)
    }))
  }
}

function submittedCalls(): AuthorityCall[] {
  const last = mocks.runAuthorityCalls.mock.calls.at(-1)
  expect(last, 'expected authority calls').toBeDefined()
  return last![0].calls as AuthorityCall[]
}

function saveSession(calls: AuthorityCall[], paymentStatus: RelayrPendingSession['paymentStatus']) {
  const scope = relayrCallsScope(calls)
  saveRelayrPendingSession(scope, {
    bundleUuid: '11111111-1111-4111-8111-111111111111',
    paymentHash: paymentStatus === 'unpaid' ? null : `0x${'ab'.repeat(32)}`,
    paymentChainId: 1,
    paymentStatus,
    chainIds: calls.map(call => call.chainId),
    expectedCount: calls.length,
    itemCount: calls.length,
    records: [],
    account: ALICE,
    createdAt: Date.now(),
  })
  return scope
}

function renderedText(instance: ReactTestInstance): string {
  return instance.children
    .map(child =>
      typeof child === 'string'
        ? child
        : typeof child === 'number'
          ? String(child)
          : renderedText(child),
    )
    .join('')
}

function buttonWith(renderer: TestRenderer.ReactTestRenderer, text: string) {
  return renderer.root
    .findAllByType('button')
    .find(button => renderedText(button).includes(text))!
}

function customBox(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType('textarea')
    .find(area => area.props['aria-label'] === 'Custom properties (JSON)')!
}

async function renderEditor(rows = ROWS, onDone = vi.fn(), isRevnet = false) {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(MetadataEditor, {
        rows,
        isRevnet,
        initial: INITIAL,
        onCancel: () => {},
        onDone,
      } as never),
    )
  })
  return renderer
}

async function typeField(renderer: TestRenderer.ReactTestRenderer, label: string, value: string) {
  const field = renderer.root.findAllByType('label').find(item =>
    item.findAllByType('span').some(span => renderedText(span).replace(/\*$/, '').trim() === label),
  )!
  await act(async () => field.findByType('input').props.onChange({ target: { value } }))
}

async function typeCustom(
  renderer: TestRenderer.ReactTestRenderer,
  value: string,
) {
  await act(async () => {
    customBox(renderer).props.onChange({ target: { value } })
  })
}

async function saveAndReadPin(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => buttonWith(renderer, 'Save project details').props.onClick())
  expect(renderedText(renderer.root)).toContain('Confirm project metadata')
  await act(async () => buttonWith(renderer, 'Confirm & save').props.onClick())
  const pinCall = mocks.pinJson.mock.calls.at(-1)
  expect(pinCall, 'expected a Juicebox Center pin').toBeTruthy()
  return pinCall![0] as Record<string, unknown>
}

beforeEach(() => {
  storage.clear()
  liveRows.clear()
  owners.clear()
  metadataByUri.clear()
  readsByChain.clear()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  })
  mocks.requestLock.mockImplementation(async (_name, _options, callback) => callback({}))
  vi.stubGlobal('navigator', { locks: { request: mocks.requestLock } })
  mocks.metadata = CURRENT
  mocks.loading = false
  mocks.errored = false
  mocks.useQuery.mockImplementation(({ enabled }: { enabled?: boolean }) => ({
    data: enabled === false ? undefined : mocks.metadata,
    isLoading: enabled === false ? false : mocks.loading,
    isError: enabled === false ? false : mocks.errored,
  }))
  mocks.getAccount.mockReturnValue({ address: ALICE, isConnected: true })
  mocks.hasPermissions.mockReset()
  mocks.hasPermissions.mockResolvedValue(false)
  mocks.readAuthorityIdentity.mockReset()
  mocks.readAuthorityIdentity.mockResolvedValue({ kind: 'eoa' })
  mocks.runAuthorityCalls.mockReset()
  mocks.runAuthorityCalls.mockImplementation(async ({ calls }: { calls: AuthorityCall[] }) => {
    for (const call of calls) await call.reverifyAuthority?.()
    return { directResults: [], relayrGroups: 1, relayrResults: [], safeResults: [] }
  })
  mocks.fetchProjectMetadataJson.mockReset()
  mocks.fetchProjectMetadataJson.mockImplementation(async (uri: string) => {
    const json = metadataByUri.get(uri)
    if (!json) throw new Error(`Unexpected metadata URI: ${uri}`)
    return json
  })
  mocks.clientFor.mockImplementation((chainId: number) => {
    const readContract = readsByChain.get(chainId)
    if (!readContract) throw new Error(`Unexpected client chain: ${chainId}`)
    return { chain: { id: chainId }, readContract }
  })
  mocks.readAuthorityOf.mockImplementation(async (client: { chain: { id: number } }, row: EditorRow) => {
    expect(client.chain.id).toBe(row.chainId)
    const current = liveRows.get(`${row.chainId}:${row.projectId}`)
    if (!current) throw new Error('Unknown authority deployment')
    return current.authority
  })
  mocks.resumeRelayrSession.mockReset()
  mocks.resumeRelayrSession.mockResolvedValue({ records: [] })
  installLiveRows(ROWS)
  metadataByUri.set(ROWS[0].uri!, CURRENT)
  mocks.pinJson.mockReset()
  mocks.pinJson.mockResolvedValue({
    cid: 'QmPinned',
    uri: 'ipfs://QmPinned',
    gatewayUrl: '/ipfs/QmPinned',
    status: 'queued',
  })
})

describe('metadata editor custom properties', () => {
  it('prefills the box with the unrecognized keys only', async () => {
    const renderer = await renderEditor()
    expect(JSON.parse(customBox(renderer).props.value)).toEqual({
      leagueID: 42,
      extensions: { scoreboard: { url: 'https://scores.example' } },
    })
    // Recognized-but-uneditable fields are kept, not exposed for deletion.
    expect(renderedText(renderer.root)).toContain('coverImageUri')
  })

  it('is blank for metadata written only through our own sites', async () => {
    mocks.metadata = { name: 'Old name', description: 'What we do' }
    const renderer = await renderEditor()
    expect(customBox(renderer).props.value).toBe('')
  })

  it('keeps untouched custom properties verbatim through a save', async () => {
    const renderer = await renderEditor()
    const pinned = await saveAndReadPin(renderer)
    expect(pinned.leagueID).toBe(42)
    expect(pinned.extensions).toEqual({
      scoreboard: { url: 'https://scores.example' },
    })
    expect(pinned.tags).toEqual(['games'])
  })

  it('lands edits, additions, and deletions from the box', async () => {
    const renderer = await renderEditor()
    await typeCustom(renderer, '{"leagueID": 43, "seasonId": "winter"}')
    const pinned = await saveAndReadPin(renderer)
    expect(pinned.leagueID).toBe(43)
    expect(pinned.seasonId).toBe('winter')
    expect(pinned).not.toHaveProperty('extensions')
    expect(pinned.name).toBe('Old name')
    expect(pinned.coverImageUri).toBe('ipfs://QmCover')
  })

  it('deletes every custom property when the user clears a filled box', async () => {
    const renderer = await renderEditor()
    await typeCustom(renderer, '')
    const pinned = await saveAndReadPin(renderer)
    expect(pinned).not.toHaveProperty('leagueID')
    expect(pinned).not.toHaveProperty('extensions')
    expect(pinned.tags).toEqual(['games'])
  })

  it('blocks the save on invalid JSON instead of dropping it', async () => {
    const renderer = await renderEditor()
    await typeCustom(renderer, '{"leagueID": }')
    await act(async () => buttonWith(renderer, 'Save project details').props.onClick())

    expect(renderedText(renderer.root)).toMatch(/valid JSON/i)
    expect(buttonWith(renderer, 'Confirm & save')).toBeUndefined()
    expect(
      mocks.pinJson.mock.calls,
    ).toHaveLength(0)
  })

  it('blocks the save when the box holds an array or a scalar', async () => {
    const renderer = await renderEditor()
    await typeCustom(renderer, '[1, 2]')
    await act(async () => buttonWith(renderer, 'Save project details').props.onClick())

    expect(renderedText(renderer.root)).toMatch(/JSON object/i)
    expect(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(0)
  })

  it('resolves a managed-key collision in the form’s favor and says so', async () => {
    const renderer = await renderEditor()
    await typeCustom(
      renderer,
      '{"name": "Sneaky", "tags": ["hijack"], "leagueID": 7}',
    )

    const text = renderedText(renderer.root)
    expect(text).toContain('name')
    expect(text).toMatch(/ignored|form/i)

    const pinned = await saveAndReadPin(renderer)
    expect(pinned.name).toBe('Old name')
    expect(pinned.tags).toEqual(['games'])
    expect(pinned.leagueID).toBe(7)
  })

  it('shows a loading state and disables the box until the live JSON lands', async () => {
    mocks.metadata = undefined
    mocks.loading = true
    const renderer = await renderEditor()

    expect(customBox(renderer).props.disabled).toBe(true)
    expect(renderedText(renderer.root)).toMatch(/loading/i)
  })

  it('never presents a failed read as an empty custom-property set', async () => {
    mocks.metadata = undefined
    mocks.errored = true
    const renderer = await renderEditor()

    expect(customBox(renderer).props.disabled).toBe(true)
    expect(renderedText(renderer.root)).toMatch(/could not be read/i)
  })
})

describe('metadata editor per-chain review and recovery', () => {
  const peerMetadata = {
    name: 'Base name',
    projectTagline: 'Base tagline',
    description: 'Base description',
    logoUri: 'ipfs://QmBaseLogo',
    infoUri: 'https://base.example',
    twitter: 'base_project',
    discord: 'https://discord.example/base',
    telegram: 'base_telegram',
    whatsapp: 'base_whatsapp',
    instagram: 'base_instagram',
    payDisclosure: 'Base payment notice',
    coverImageUri: 'ipfs://QmBaseCover',
    tags: ['base', 'art'],
    version: 9,
    leagueID: 303,
    extensions: { scoreboard: { url: 'https://base-scores.example' } },
    peerOnly: { enabled: true },
  }

  beforeEach(() => {
    installLiveRows([PEER])
    metadataByUri.set(PEER.uri!, peerMetadata)
  })

  it('applies only an explicitly edited name to each live profile and encodes distinct project IDs/controllers', async () => {
    mocks.pinJson.mockImplementation(async () => ({ uri: `ipfs://QmPinned${mocks.pinJson.mock.calls.length}` }))
    const renderer = await renderEditor([...ROWS, PEER])
    await typeField(renderer, 'Name', 'Shared new name')
    await saveAndReadPin(renderer)

    expect(mocks.fetchProjectMetadataJson.mock.calls.map(([uri]) => uri).sort()).toEqual([ROWS[0].uri, PEER.uri].sort())
    expect(mocks.pinJson.mock.calls.map(([json]) => json)).toEqual([
      { ...CURRENT, name: 'Shared new name' },
      { ...peerMetadata, name: 'Shared new name' },
    ])
    const calls = submittedCalls()
    expect(calls).toHaveLength(2)
    expect(calls.map(call => [call.chainId, call.authority, call.target])).toEqual([
      [1, ALICE, ROWS[0].controller],
      [8453, ALICE, PEER.controller],
    ])
    expect(calls.map(call => decodeFunctionData({ abi: jbControllerAbi, data: call.data }))).toEqual([
      { functionName: 'setUriOf', args: [42n, 'ipfs://QmPinned1'] },
      { functionName: 'setUriOf', args: [303n, 'ipfs://QmPinned2'] },
    ])
    await act(async () => renderer.unmount())
  })

  it('pins once when the resulting profiles are identical across chains', async () => {
    // Content identity is independent of JSON object insertion order.
    metadataByUri.set(PEER.uri!, Object.fromEntries(
      Object.entries({ ...CURRENT, name: 'Different current name' }).reverse(),
    ))
    const renderer = await renderEditor([...ROWS, PEER])
    await typeField(renderer, 'Name', 'Shared new name')
    await saveAndReadPin(renderer)

    expect(mocks.pinJson).toHaveBeenCalledOnce()
    const decoded = submittedCalls().map(call => decodeFunctionData({ abi: jbControllerAbi, data: call.data }))
    expect(decoded.map(call => call.args)).toEqual([
      [42n, 'ipfs://QmPinned'],
      [303n, 'ipfs://QmPinned'],
    ])
    await act(async () => renderer.unmount())
  })

  it('applies edited custom keys while retaining peer-only and untouched differing custom values', async () => {
    const renderer = await renderEditor([...ROWS, PEER])
    const edited = JSON.parse(customBox(renderer).props.value)
    edited.leagueID = 100
    await typeCustom(renderer, JSON.stringify(edited))
    await saveAndReadPin(renderer)

    expect(mocks.pinJson.mock.calls.map(([json]) => json)).toEqual([
      { ...CURRENT, leagueID: 100 },
      { ...peerMetadata, leagueID: 100 },
    ])
    await act(async () => renderer.unmount())
  })

  it('clears only the displayed baseline custom keys and keeps peer-only properties', async () => {
    const renderer = await renderEditor([...ROWS, PEER])
    await typeCustom(renderer, '')
    await saveAndReadPin(renderer)

    const expectedPrimary: Record<string, unknown> = { ...CURRENT }
    const expectedPeer: Record<string, unknown> = { ...peerMetadata }
    for (const metadata of [expectedPrimary, expectedPeer]) {
      delete metadata.leagueID
      delete metadata.extensions
    }
    expect(mocks.pinJson.mock.calls.map(([json]) => json)).toEqual([expectedPrimary, expectedPeer])
    expect(mocks.pinJson.mock.calls[1][0].peerOnly).toEqual({ enabled: true })
    await act(async () => renderer.unmount())
  })

  it.each(['uri', 'controller', 'authority'] as const)('rechecks the reviewed %s before authorizing the frozen calls', async field => {
    mocks.runAuthorityCalls.mockImplementationOnce(async ({ calls }: { calls: AuthorityCall[] }) => {
      for (const call of calls) await call.reverifyAuthority?.()
      throw new Error('Wallet review is still pending')
    })
    const renderer = await renderEditor([...ROWS, PEER])
    await saveAndReadPin(renderer)
    const peerCall = submittedCalls()[1]
    expect(peerCall.reverifyAuthority).toBeTypeOf('function')
    await expect(peerCall.reverifyAuthority!()).resolves.toBeUndefined()

    const livePeer = liveRows.get(`${PEER.chainId}:${PEER.projectId}`)!
    if (field === 'uri') livePeer.uri = 'ipfs://QmChangedAfterReview'
    else livePeer[field] = OTHER
    await expect(peerCall.reverifyAuthority!()).rejects.toThrow(/changed|controller|authority|profile|metadata|uri/i)
    await act(async () => renderer.unmount())
  })

  it('retries the same pinned profiles and calldata after payment cancellation', async () => {
    mocks.runAuthorityCalls.mockImplementationOnce(async ({ calls }: { calls: AuthorityCall[] }) => {
      for (const call of calls) await call.reverifyAuthority?.()
      saveSession(calls, 'unpaid')
      throw new Error('Payment canceled')
    })
    const onDone = vi.fn()
    const renderer = await renderEditor([...ROWS, PEER], onDone)
    await typeField(renderer, 'Name', 'Reviewed name')
    await saveAndReadPin(renderer)
    const original = submittedCalls().map(({ chainId, target, data }) => ({ chainId, target, data }))
    const pins = mocks.pinJson.mock.calls.length
    const fetches = mocks.fetchProjectMetadataJson.mock.calls.length
    expect(renderedText(renderer.root)).toContain('Payment canceled')
    expect(onDone).not.toHaveBeenCalled()

    await act(async () => buttonWith(renderer, 'Retry').props.onClick())

    expect(mocks.runAuthorityCalls).toHaveBeenCalledTimes(2)
    expect(submittedCalls().map(({ chainId, target, data }) => ({ chainId, target, data }))).toEqual(original)
    expect(mocks.pinJson).toHaveBeenCalledTimes(pins)
    expect(mocks.fetchProjectMetadataJson).toHaveBeenCalledTimes(fetches)
    expect(onDone).toHaveBeenCalledOnce()
    expect(mocks.resumeRelayrSession).not.toHaveBeenCalled()
    clearRelayrPendingSession(relayrCallsScope(submittedCalls()))
    await act(async () => renderer.unmount())
  })

  it('recovers a paid bundle after remount without fetching or pinning a replacement profile', async () => {
    let scope = ''
    mocks.runAuthorityCalls.mockImplementationOnce(async ({ calls }: { calls: AuthorityCall[] }) => {
      scope = saveSession(calls, 'confirmed')
      throw new Error('Destination confirmation unavailable')
    })
    const first = await renderEditor([...ROWS, PEER])
    await typeField(first, 'Name', 'Already paid name')
    await saveAndReadPin(first)
    expect(storage.has('jb-metadata-review-v1:1:42')).toBe(true)
    expect(storage.has('jb-metadata-review-v1:8453:303')).toBe(true)
    await act(async () => first.unmount())

    mocks.runAuthorityCalls.mockClear()
    mocks.fetchProjectMetadataJson.mockClear()
    mocks.fetchProjectMetadataJson.mockRejectedValue(new Error('Completed-chain profile is unavailable'))
    mocks.pinJson.mockClear()
    mocks.clientFor.mockClear()
    mocks.readAuthorityOf.mockClear()
    mocks.useQuery.mockClear()
    mocks.metadata = undefined
    mocks.errored = true
    liveRows.get(`${PEER.chainId}:${PEER.projectId}`)!.uri = 'ipfs://QmAlreadyExecuted'
    const onDone = vi.fn()
    // Either deployment opens the same saved action, even after the route's
    // indexed profile changes or another chain has already executed.
    const renderer = await renderEditor([{ ...PEER, uri: 'ipfs://QmAlreadyExecuted' }], onDone)
    expect(renderedText(renderer.root)).toContain('Confirm project metadata')
    const resume = buttonWith(renderer, 'Retry') ?? buttonWith(renderer, 'Confirm & save')
    await act(async () => resume.props.onClick())

    expect(mocks.resumeRelayrSession).toHaveBeenCalledWith(expect.objectContaining({ scope, account: ALICE }))
    expect(mocks.runAuthorityCalls).not.toHaveBeenCalled()
    expect(mocks.fetchProjectMetadataJson).not.toHaveBeenCalled()
    expect(mocks.pinJson).not.toHaveBeenCalled()
    expect(mocks.clientFor).not.toHaveBeenCalled()
    expect(mocks.readAuthorityOf).not.toHaveBeenCalled()
    expect(mocks.useQuery.mock.calls.every(([options]) => options.enabled === false)).toBe(true)
    expect(onDone).toHaveBeenCalledOnce()
    expect(storage.has('jb-metadata-review-v1:1:42')).toBe(false)
    expect(storage.has('jb-metadata-review-v1:8453:303')).toBe(false)
    clearRelayrPendingSession(scope)
    await act(async () => renderer.unmount())
  })

  it('keeps an unpaid remounted review frozen when a destination profile changes', async () => {
    let scope = ''
    mocks.runAuthorityCalls.mockImplementationOnce(async ({ calls }: { calls: AuthorityCall[] }) => {
      scope = saveSession(calls, 'unpaid')
      throw new Error('Payment canceled')
    })
    const first = await renderEditor([...ROWS, PEER])
    await saveAndReadPin(first)
    const originalData = submittedCalls().map(call => call.data)
    await act(async () => first.unmount())
    mocks.fetchProjectMetadataJson.mockClear()
    mocks.pinJson.mockClear()
    liveRows.get(`${PEER.chainId}:${PEER.projectId}`)!.uri = 'ipfs://QmChangedAfterReview'

    const onDone = vi.fn()
    const renderer = await renderEditor([PEER], onDone)
    await act(async () => buttonWith(renderer, 'Confirm & save').props.onClick())

    expect(submittedCalls().map(call => call.data)).toEqual(originalData)
    expect(renderedText(renderer.root)).toMatch(/changed after review/i)
    expect(mocks.fetchProjectMetadataJson).not.toHaveBeenCalled()
    expect(mocks.pinJson).not.toHaveBeenCalled()
    expect(mocks.resumeRelayrSession).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
    expect(storage.has('jb-metadata-review-v1:1:42')).toBe(true)
    expect(storage.has('jb-metadata-review-v1:8453:303')).toBe(true)
    clearRelayrPendingSession(scope)
    await act(async () => renderer.unmount())
  })

  it('requires the original wallet before resuming a saved paid review', async () => {
    let scope = ''
    mocks.runAuthorityCalls.mockImplementationOnce(async ({ calls }: { calls: AuthorityCall[] }) => {
      scope = saveSession(calls, 'submitted')
      throw new Error('Payment receipt unavailable')
    })
    const first = await renderEditor()
    await saveAndReadPin(first)
    await act(async () => first.unmount())
    mocks.runAuthorityCalls.mockClear()
    mocks.getAccount.mockReturnValue({ address: OTHER, isConnected: true })

    const onDone = vi.fn()
    const renderer = await renderEditor(ROWS, onDone)
    await act(async () => buttonWith(renderer, 'Confirm & save').props.onClick())

    expect(renderedText(renderer.root)).toMatch(/wallet that reviewed/i)
    expect(mocks.resumeRelayrSession).not.toHaveBeenCalled()
    expect(mocks.runAuthorityCalls).not.toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
    expect(storage.has('jb-metadata-review-v1:1:42')).toBe(true)
    clearRelayrPendingSession(scope)
    await act(async () => renderer.unmount())
  })
})

describe('metadata editor permission scope and submission locks', () => {
  function grantMetadataToConnectedWallet() {
    mocks.hasPermissions.mockImplementation(async (
      client: { chain: { id: number } },
      options: {
        chainId: number
        account: Address
        operator: Address
        projectId: bigint
        permissionIds: number[]
        includeRoot?: boolean
        includeWildcardProjectId?: boolean
      },
    ) => {
      expect(options.chainId).toBe(client.chain.id)
      expect(options.account).toBe(owners.get(`${options.chainId}:${options.projectId}`))
      expect(options.permissionIds).toEqual([JBPermissionIdsV6.SET_PROJECT_URI])
      expect(options.includeRoot).not.toBe(false)
      expect(options.includeWildcardProjectId).not.toBe(false)
      return options.operator === ALICE
    })
  }

  function leaveWalletReviewPending() {
    mocks.runAuthorityCalls.mockImplementationOnce(async ({ calls }: { calls: AuthorityCall[] }) => {
      for (const call of calls) await call.reverifyAuthority?.()
      throw new Error('Wallet review is still pending')
    })
  }

  it.each([false, true])('accepts a delegate holding only SET_PROJECT_URI (revnet: %s)', async isRevnet => {
    const owner = isRevnet
      ? jbContractAddress['6'][RevnetCoreContracts.REVOwner][1]
      : OTHER
    owners.set('1:42', owner)
    const row = { ...ROWS[0], authority: null, indexedAuthority: null }
    installLiveRows([row])
    grantMetadataToConnectedWallet()
    const renderer = await renderEditor([row], vi.fn(), isRevnet)
    await saveAndReadPin(renderer)

    expect(mocks.hasPermissions).toHaveBeenCalled()
    expect(submittedCalls()[0]).toMatchObject({
      authority: ALICE,
      chainId: 1,
      target: row.controller,
      functionName: 'setUriOf',
    })
    expect(decodeFunctionData({ abi: jbControllerAbi, data: submittedCalls()[0].data }).args).toEqual([42n, 'ipfs://QmPinned'])
    await act(async () => renderer.unmount())
  })

  it('keeps a revnet destination selectable when only its indexed full operator is unknown', async () => {
    owners.set('1:42', jbContractAddress['6'][RevnetCoreContracts.REVOwner][1])
    const row = {
      ...ROWS[0],
      authority: null,
      indexedAuthority: null,
      error: 'Could not resolve authority',
    }
    installLiveRows([row])
    grantMetadataToConnectedWallet()
    const renderer = await renderEditor([row], vi.fn(), true)
    await saveAndReadPin(renderer)

    expect(submittedCalls()[0]).toMatchObject({
      chainId: 1,
      authority: ALICE,
      target: row.controller,
      functionName: 'setUriOf',
    })
    await act(async () => renderer.unmount())
  })

  it('rechecks ownership even when the same delegate retains a metadata grant', async () => {
    owners.set('1:42', OTHER)
    grantMetadataToConnectedWallet()
    leaveWalletReviewPending()
    const renderer = await renderEditor()
    await saveAndReadPin(renderer)
    const call = submittedCalls()[0]
    expect(call.authority).toBe(ALICE)
    owners.set('1:42', SAFE)

    await expect(call.reverifyAuthority!()).rejects.toThrow(/changed after review/i)
    expect(storage.has('jb-metadata-review-v1:1:42')).toBe(true)
    await act(async () => renderer.unmount())
  })

  it('rejects a revoked metadata grant before funding the reviewed call', async () => {
    owners.set('1:42', OTHER)
    grantMetadataToConnectedWallet()
    leaveWalletReviewPending()
    const renderer = await renderEditor()
    await saveAndReadPin(renderer)
    const call = submittedCalls()[0]
    expect(call.authority).toBe(ALICE)
    mocks.hasPermissions.mockResolvedValue(false)

    await expect(call.reverifyAuthority!()).rejects.toThrow(/cannot set|permission|authority/i)
    expect(storage.has('jb-metadata-review-v1:1:42')).toBe(true)
    await act(async () => renderer.unmount())
  })

  it.each([false, true])('keeps a Safe owner/operator as the execution authority (revnet: %s)', async isRevnet => {
    const owner = isRevnet
      ? jbContractAddress['6'][RevnetCoreContracts.REVOwner][1]
      : SAFE
    owners.set('1:42', owner)
    const row = { ...ROWS[0], authority: SAFE, indexedAuthority: SAFE }
    installLiveRows([row])
    mocks.readAuthorityIdentity.mockImplementation(async (_client, authority: Address) =>
      authority === SAFE ? { kind: 'safe', owners: [ALICE, OTHER], threshold: 2 } : { kind: 'contract' },
    )
    mocks.hasPermissions.mockImplementation(async (_client, options) => options.operator === SAFE)
    const renderer = await renderEditor([row], vi.fn(), isRevnet)
    await saveAndReadPin(renderer)

    expect(submittedCalls()[0].authority).toBe(SAFE)
    expect(mocks.readAuthorityIdentity).toHaveBeenCalledWith(expect.anything(), SAFE)
    expect(mocks.hasPermissions.mock.calls.every(([, options]) => options.operator !== ALICE)).toBe(true)
    await act(async () => renderer.unmount())
  })

  it('rejects selected destinations requiring different execution authorities before submission', async () => {
    const peer = { ...PEER, authority: SAFE, indexedAuthority: SAFE }
    installLiveRows([peer])
    metadataByUri.set(peer.uri!, CURRENT)
    mocks.readAuthorityIdentity.mockImplementation(async (_client, authority: Address) =>
      authority === SAFE ? { kind: 'safe', owners: [ALICE], threshold: 1 } : { kind: 'eoa' },
    )
    const renderer = await renderEditor([...ROWS, peer])
    await act(async () => buttonWith(renderer, 'Save project details').props.onClick())
    const confirm = buttonWith(renderer, 'Confirm & save')
    if (confirm) await act(async () => confirm.props.onClick())

    expect(mocks.runAuthorityCalls).not.toHaveBeenCalled()
    expect(renderedText(renderer.root)).toMatch(/same owner\/operator|different.*authorit|one.*authority|authority.*group/i)
    await act(async () => renderer.unmount())
  })

  it('refuses submission when another tab holds a project lock and keeps the saved review', async () => {
    const renderer = await renderEditor()
    await act(async () => buttonWith(renderer, 'Save project details').props.onClick())
    mocks.requestLock.mockImplementationOnce(async (_name, _options, callback) => callback(null))
    await act(async () => buttonWith(renderer, 'Confirm & save').props.onClick())

    expect(mocks.runAuthorityCalls).not.toHaveBeenCalled()
    expect(renderedText(renderer.root)).toMatch(/already.*another tab/i)
    expect(storage.has('jb-metadata-review-v1:1:42')).toBe(true)
    await act(async () => renderer.unmount())
  })
})
