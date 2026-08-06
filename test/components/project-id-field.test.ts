// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ProjectIdField,
  projectLookupNote,
  type ProjectChainLookup,
} from '@/components/create/AddressField'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

function lookup(
  chainId: number,
  overrides: Partial<ProjectChainLookup> = {},
): ProjectChainLookup {
  return {
    chainId,
    found: true,
    name: 'KMAC\'s slop shop',
    suckerGroupId: 'group-a',
    ...overrides,
  }
}

describe('project recipient chain lookup', () => {
  it('fans the default project id out across every selected chain', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), 'http://localhost')
      const chainId = Number(url.searchParams.get('chainId'))
      const found = chainId === 84532
      return {
        ok: true,
        json: async () => ({
          found,
          name: found ? "KMAC's slop shop" : null,
          suckerGroupId: found ? 'group-a' : null,
        }),
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    act(() => {
      root.render(
        createElement(ProjectIdField, {
          value: '16',
          onChange: vi.fn(),
          disabled: false,
          chainIds: [11155111, 11155420, 84532, 421614],
        }),
      )
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(container.textContent).toContain(
      "KMAC's slop shop found on Base Sepolia only",
    )
    act(() => root.unmount())
  })

  it('accepts a project found on the one selected chain', () => {
    expect(projectLookupNote(16, [84532], [lookup(84532)])).toEqual({
      kind: 'ok',
      text: "→ KMAC's slop shop",
    })
  })

  it('identifies the exact chain when the project is only partially deployed', () => {
    expect(
      projectLookupNote(
        16,
        [11155111, 11155420, 84532, 421614],
        [
          lookup(11155111, { found: false, name: null, suckerGroupId: null }),
          lookup(11155420, { found: false, name: null, suckerGroupId: null }),
          lookup(84532),
          lookup(421614, { found: false, name: null, suckerGroupId: null }),
        ],
      ),
    ).toEqual({
      kind: 'warn',
      text: "→ KMAC's slop shop found on Base Sepolia only — set per-chain project IDs for the other selected chains",
    })
  })

  it('does not treat an existing unnamed project as missing', () => {
    expect(
      projectLookupNote(7, [84532], [lookup(84532, { name: null })]),
    ).toEqual({ kind: 'ok', text: '→ Project #7' })
  })

  it('warns when equal IDs refer to deployments without one verified group', () => {
    expect(
      projectLookupNote(9, [1, 10], [
        lookup(1, { name: 'One', suckerGroupId: 'group-a' }),
        lookup(10, { name: 'Two', suckerGroupId: 'group-b' }),
      ]),
    ).toEqual({
      kind: 'warn',
      text: "→ Project #9 exists on every selected chain, but the deployments aren't linked — confirm each per-chain project ID",
    })
  })

  it('reports a true miss across every selected chain', () => {
    expect(
      projectLookupNote(99, [1, 10], [
        lookup(1, { found: false, name: null, suckerGroupId: null }),
        lookup(10, { found: false, name: null, suckerGroupId: null }),
      ]),
    ).toEqual({
      kind: 'bad',
      text: 'No project #99 found on the selected chains',
      full: true,
    })
  })

  // An indexer outage is not evidence of absence. Calling a real project missing during one makes
  // the user "fix" a correct split recipient — the opposite of what the hint is for.
  it('says it could not check, rather than not found, when a lookup failed', () => {
    expect(
      projectLookupNote(99, [1, 10], [
        lookup(1, { found: false, name: null, suckerGroupId: null, unavailable: true }),
        lookup(10, { found: false, name: null, suckerGroupId: null }),
      ]),
    ).toEqual({
      kind: 'warn',
      text: "Couldn't check project #99 right now — verify it before deploying",
      full: true,
    })
  })

  it('still reports a true miss when every lookup completed', () => {
    expect(
      projectLookupNote(99, [1], [
        lookup(1, { found: false, name: null, suckerGroupId: null, unavailable: false }),
      ]).kind,
    ).toBe('bad')
  })
})
