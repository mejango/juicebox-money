// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  wallet: { address: '0x2222222222222222222222222222222222222222' },
  runAuthorityCalls: vi.fn(),
  readAuthorityOf: vi.fn(),
  resolveRoute: vi.fn(),
  submit: vi.fn(),
  resolvePreset: vi.fn(),
}))

vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) =>
    createElement('img', { ...props, src: 'asset' }),
}))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => mocks.wallet }))
vi.mock('@/lib/authority', () => ({
  clientFor: () => ({}),
  readAuthorityOf: mocks.readAuthorityOf,
  runAuthorityCalls: mocks.runAuthorityCalls,
  safeOutcomeMessage: (_result: unknown, message: string) => message,
}))
vi.mock('@/lib/safe-batch-submit', async original => ({
  ...(await original<typeof import('@/lib/safe-batch-submit')>()),
  resolveSafeBatchRoute: mocks.resolveRoute,
  submitSafeBatch: mocks.submit,
}))
vi.mock('@/lib/safe-batch-presets', async original => ({
  ...(await original<typeof import('@/lib/safe-batch-presets')>()),
  resolvePreset: mocks.resolvePreset,
}))

import { SafeBatchProvider } from '@/components/project/SafeBatchProvider'
import { SafeBatchTray } from '@/components/project/SafeBatchTray'
import { buildStep, readSafeBatch, safeBatchStorageKey, writeSafeBatch } from '@/lib/safe-batch'
import '../dialog-shim'

const SAFE = '0x1111111111111111111111111111111111111111' as Address
const HOOK = '0xB222Da5A71e8FB89a5A38b7c920EaB5DfbC74B91' as Address
const TERMINAL = '0x4a56AEf5b6A5b9742AbB02cA67C5a85ba183D901' as Address
const NATIVE = '0x000000000000000000000000000000000000EEEe' as Address
const DEPLOYMENTS = [
  { chainId: 1 as const, projectId: 2, indexedAuthority: SAFE },
  { chainId: 8453 as const, projectId: 6, indexedAuthority: SAFE },
]

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  window.localStorage.clear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  mocks.readAuthorityOf.mockResolvedValue(SAFE)
  mocks.resolveRoute.mockResolvedValue({ kind: 'safe-owner', authorityKind: 'safe' })
  mocks.submit.mockResolvedValue({
    kind: 'safe-owner',
    result: { chainId: 1, mode: 'service', status: 'queued', nonce: 7, safeTxHash: `0x${'ab'.repeat(32)}` },
  })
  mocks.resolvePreset.mockResolvedValue({ status: 'nothing', message: 'Nothing to do.', steps: [] })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function seed() {
  // Deliberately mis-ordered: the pool registration sits ahead of the hook.
  writeSafeBatch(1, 2, [
    buildStep({
      kind: 'setPoolFor',
      chainId: 1,
      projectId: 2,
      values: { fee: 10_000, tickSpacing: 200, twapWindow: 1800n, terminalToken: NATIVE },
    }),
    buildStep({ kind: 'setHookFor', chainId: 1, projectId: 2, values: { hook: HOOK } }),
  ])
}

function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <SafeBatchProvider deployments={DEPLOYMENTS} isRevnet={false}>
          <SafeBatchTray chainId={1} />
        </SafeBatchProvider>
      </QueryClientProvider>,
    ),
  )
}

async function settle() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
}

function button(label: string | RegExp): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(candidate =>
    typeof label === 'string'
      ? candidate.textContent?.trim() === label
      : label.test(candidate.textContent ?? ''),
  )
  if (!found) throw new Error(`No button ${String(label)}`)
  return found
}

function byAria(label: string): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!found) throw new Error(`No control ${label}`)
  return found
}

function click(element: HTMLElement) {
  act(() => element.click())
}

describe('Safe batch tray', () => {
  it('shows one chip per chain from storage and only Presets when nothing is queued', async () => {
    render()
    await settle()
    expect(container.textContent).toContain('Nothing queued')
    expect(button('Presets')).toBeTruthy()
    expect(container.textContent).not.toContain('queued ·')

    seed()
    await settle()
    expect(button(/2 queued · Ethereum/)).toBeTruthy()
    expect(container.textContent).not.toContain('Base')
    expect(button('Clear')).toBeTruthy()
    expect(button('Same on every chain')).toBeTruthy()
  })

  it('opens the batch dialog with the steps, disables submit on a dependency problem, and fixes it by moving', async () => {
    seed()
    render()
    await settle()
    click(button(/2 queued · Ethereum/))
    await settle()

    const dialog = document.querySelector('dialog')
    expect(dialog?.open).toBe(true)
    expect(dialog?.textContent).toContain('Batch on Ethereum')
    expect(dialog?.textContent).toContain('Register buyback pool')
    expect(dialog?.textContent).toContain('Set buyback hook')
    expect(dialog?.textContent).toContain('0x1111…1111 (Safe)')
    expect(dialog?.textContent).toContain('One MultiSend proposal signed by a Safe owner')
    expect(dialog?.textContent).toContain('JBBuybackHookRegistry.setPoolFor(uint256, uint24, int24, uint256, address)')
    expect(dialog?.querySelector('[role="alert"]')?.textContent).toMatch(
      /Set the buyback hook before registering its pool/,
    )
    const submit = button('Propose batch to Safe')
    expect(submit.disabled).toBe(true)

    click(byAria('Move step 1 down'))
    await settle()
    expect(document.querySelector('dialog [role="alert"]')).toBeNull()
    expect(button('Propose batch to Safe').disabled).toBe(false)
    expect(readSafeBatch(1, 2).map(step => step.kind)).toEqual(['setHookFor', 'setPoolFor'])

    click(byAria('Remove step 2'))
    await settle()
    expect(readSafeBatch(1, 2).map(step => step.kind)).toEqual(['setHookFor'])
    expect(document.querySelector('dialog')?.textContent).not.toContain('Register buyback pool')

    click(button('Propose batch to Safe'))
    await settle()
    expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        chainId: 1,
        authority: SAFE,
        route: { kind: 'safe-owner', authorityKind: 'safe' },
        steps: [expect.objectContaining({ kind: 'setHookFor' })],
      }),
    )
    // The submit path reports the proposal; the tray for that chain is cleared.
    await act(async () => {
      await mocks.submit.mock.calls[0][0].onProposed(`0x${'ab'.repeat(32)}`)
    })
    await settle()
    expect(document.querySelector('dialog')?.textContent).toContain(
      'Proposed to Safe as one batch of 1 call.',
    )
    expect(window.localStorage.getItem(safeBatchStorageKey(1, 2))).toBeNull()
  })

  it('adds the resolved preset steps for checked chains and reports it', async () => {
    seed()
    mocks.resolvePreset.mockImplementation(async (_preset, { chainId, projectId }) =>
      chainId === 1
        ? {
            status: 'ready',
            message: null,
            steps: [
              buildStep({ kind: 'setHookFor', chainId, projectId, values: { hook: HOOK } }),
              buildStep({
                kind: 'setPoolFor',
                chainId,
                projectId,
                values: { fee: 3000, tickSpacing: 60, twapWindow: 1800n, terminalToken: NATIVE },
                note: 'The old window was the deployer default (48h); 30 minutes will be stored.',
              }),
              buildStep({ kind: 'setTerminalFor', chainId, projectId, values: { terminal: TERMINAL } }),
            ],
          }
        : { status: 'unavailable', message: 'Not deployed on Base yet.', steps: [] },
    )
    render()
    await settle()
    click(button('Presets'))
    await settle()
    const dialog = document.querySelector('dialog')
    expect(dialog?.textContent).toContain('Move to buyback 1.4.0 + gateway')
    expect(dialog?.textContent).toContain('Not deployed on Base yet.')
    expect(dialog?.textContent).toContain('30 minutes will be stored')
    const window_ = dialog?.querySelector<HTMLInputElement>('input[aria-label^="TWAP window on Ethereum"]')
    expect(window_?.value).toBe('1800')
    const checkboxes = [...(dialog?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? [])]
    expect(checkboxes.map(box => [box.checked, box.disabled])).toEqual([
      [true, false],
      [false, true],
    ])

    click(button('Add 3 steps to batch'))
    await settle()
    expect(document.querySelector('dialog')).toBeNull()
    expect(readSafeBatch(1, 2).map(step => step.kind)).toEqual([
      'setPoolFor',
      'setHookFor',
      'setTerminalFor',
    ])
    expect(readSafeBatch(1, 2)[0].args).toEqual([2n, 3000, 60, 1800n, NATIVE])
    expect(button(/3 queued · Ethereum/)).toBeTruthy()
    expect(container.textContent).toContain('Added to the batch for Ethereum.')
    expect(mocks.submit).not.toHaveBeenCalled()
  })

  it('clears every chain', async () => {
    seed()
    writeSafeBatch(8453, 6, [
      buildStep({ kind: 'setHookFor', chainId: 8453, projectId: 6, values: { hook: HOOK } }),
    ])
    render()
    await settle()
    expect(button(/1 queued · Base/)).toBeTruthy()
    click(button('Clear'))
    await settle()
    expect(readSafeBatch(1, 2)).toEqual([])
    expect(readSafeBatch(8453, 6)).toEqual([])
    expect(container.textContent).toContain('Nothing queued')
  })
})
