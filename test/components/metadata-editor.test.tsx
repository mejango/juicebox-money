import { createElement } from 'react'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The Advanced custom-properties box is the only control that can DELETE a
// projectUri field the app doesn't know about, so these tests pin the exact
// object handed to /api/ipfs/pin-json for every edit shape.
const mocks = vi.hoisted(() => ({
  metadata: undefined as Record<string, unknown> | undefined,
  loading: false,
  errored: false,
  runAuthorityCalls: vi.fn(),
  fetchProjectMetadataJson: vi.fn(),
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ enabled }: { enabled?: boolean }) => ({
    data: enabled === false ? undefined : mocks.metadata,
    isLoading: enabled === false ? false : mocks.loading,
    isError: enabled === false ? false : mocks.errored,
  }),
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
    clientFor: vi.fn(),
    readAuthorityOf: vi.fn(),
    runAuthorityCalls: mocks.runAuthorityCalls,
    safeOutcomeMessage: (_result: unknown, completed: string) => completed,
  }
})
vi.mock('@/lib/project-metadata', async importOriginal => {
  const original =
    await importOriginal<typeof import('@/lib/project-metadata')>()
  return { ...original, fetchProjectMetadataJson: mocks.fetchProjectMetadataJson }
})

import { MetadataEditor } from '@/components/project/AuthorityEditsCard'

const ROWS = [
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

async function renderEditor() {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(
      createElement(MetadataEditor, {
        rows: ROWS,
        initial: INITIAL,
        onCancel: () => {},
        onDone: () => {},
      } as never),
    )
  })
  return renderer
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
  await act(async () => buttonWith(renderer, 'Review changes').props.onClick())
  await act(async () =>
    buttonWith(renderer, 'Save project metadata').props.onClick(),
  )
  const pinCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
    call => String(call[0]).includes('pin-json'),
  )
  expect(pinCall, 'expected a pin-json request').toBeTruthy()
  return JSON.parse(String(pinCall![1].body)) as Record<string, unknown>
}

beforeEach(() => {
  mocks.metadata = CURRENT
  mocks.loading = false
  mocks.errored = false
  mocks.runAuthorityCalls.mockResolvedValue({ results: [] })
  mocks.fetchProjectMetadataJson.mockResolvedValue(CURRENT)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ cid: 'QmPinned' }),
    })),
  )
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
    await act(async () => buttonWith(renderer, 'Review changes').props.onClick())

    expect(renderedText(renderer.root)).toMatch(/valid JSON/i)
    expect(buttonWith(renderer, 'Save project metadata')).toBeUndefined()
    expect(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(0)
  })

  it('blocks the save when the box holds an array or a scalar', async () => {
    const renderer = await renderEditor()
    await typeCustom(renderer, '[1, 2]')
    await act(async () => buttonWith(renderer, 'Review changes').props.onClick())

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
