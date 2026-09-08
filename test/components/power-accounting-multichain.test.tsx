import { createElement, type ComponentProps, type ReactNode } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeFunctionData } from 'viem'
import { jbMultiTerminalAbi } from '@bananapus/nana-sdk-core'

const mocks = vi.hoisted(() => ({ runAuthorityCalls: vi.fn() }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: '0x1111111111111111111111111111111111111111' }) }))
vi.mock('@/lib/authority', () => ({
  clientFor: vi.fn(), readAuthorityOf: vi.fn(),
  runAuthorityCalls: mocks.runAuthorityCalls,
  safeOutcomeMessage: (_result: unknown, completed: string) => completed,
}))
vi.mock('@/components/ui/ChainPicker', () => ({ ChainPicker: () => null }))
vi.mock('@/components/ui/PerChainAddressField', () => ({ PerChainAddressField: () => null }))
vi.mock('@/components/ui/PerChainAddressListField', () => ({ PerChainAddressListField: () => null }))
vi.mock('@/components/ui/TxConfirmDialog', () => ({
  TxConfirmDialog: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('@/components/ui/TxError', () => ({ ErrorNote: ({ message }: { message: string }) => message }))

import { PowerActionForm } from '@/components/project/AuthorityPowersCard'
import { POWERS } from '@/lib/projectPowers'
import { ChainPicker } from '@/components/ui/ChainPicker'
import { PerChainAddressField } from '@/components/ui/PerChainAddressField'
import { TxConfirmDialog } from '@/components/ui/TxConfirmDialog'

const authority = '0x1111111111111111111111111111111111111111' as const
const controller = '0x2222222222222222222222222222222222222222' as const
const tokens = { 1: '0x3333333333333333333333333333333333333333', 10: '0x4444444444444444444444444444444444444444' }
const rows: ComponentProps<typeof PowerActionForm>['rows'] = [
  { chainId: 1, projectId: 42, name: 'Ethereum', authority, controller, indexedAuthority: authority, terminals: [], metadata: { allowAddAccountingContext: true }, error: null },
  { chainId: 10, projectId: 91, name: 'Optimism', authority, controller, indexedAuthority: authority, terminals: [], metadata: { allowAddAccountingContext: true }, error: null },
]
let renderer: TestRenderer.ReactTestRenderer | undefined

async function renderForm() {
  await act(async () => {
    renderer = TestRenderer.create(createElement(PowerActionForm, {
      power: POWERS.find(power => power.flag === 'allowAddAccountingContext')!,
      rows, onCancel: vi.fn(), onDone: vi.fn(),
    }))
  })
  await act(async () => {
    renderer!.root.findByType(PerChainAddressField).props.onChange(tokens)
  })
}

async function decimals(chain: string, value: string) {
  await act(async () => {
    renderer!.root.findByProps({ 'aria-label': `Decimals on ${chain}` }).props.onChange({ target: { value } })
  })
}

async function review() {
  await act(async () => {
    renderer!.root.findAllByType('button').find(button => button.children.includes('Add accounting token'))!.props.onClick()
  })
}

async function submit() {
  await act(async () => {
    renderer!.root.findByProps({ type: 'checkbox' }).props.onChange({ target: { checked: true } })
  })
  await act(async () => { await renderer!.root.findByType(TxConfirmDialog).props.onConfirm() })
}

beforeEach(() => { mocks.runAuthorityCalls.mockReset().mockResolvedValue({}) })
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount())
  renderer = undefined
})

describe('multichain accounting-token review', () => {
  it('encodes and reviews each destination token with its own decimals and project ID', async () => {
    await renderForm()
    await decimals('Ethereum', '6')
    await decimals('Optimism', '18')
    await review()
    const summary = renderer!.root.findByType(TxConfirmDialog).props.rows
    expect(summary.find((row: { label: string }) => row.label === 'Ethereum').value).toContain('Decimals 6')
    expect(summary.find((row: { label: string }) => row.label === 'Optimism').value).toContain('Decimals 18')
    await submit()
    const calls = mocks.runAuthorityCalls.mock.calls[0][0].calls
    expect(calls).toHaveLength(2)
    for (const [index, expected] of [{ projectId: 42n, token: tokens[1], decimals: 6 }, { projectId: 91n, token: tokens[10], decimals: 18 }].entries()) {
      const decoded = decodeFunctionData({ abi: jbMultiTerminalAbi, data: calls[index].data })
      expect(decoded.functionName).toBe('addAccountingContextsFor')
      expect(decoded.args).toEqual([expected.projectId, [{ token: expected.token, decimals: expected.decimals, currency: Number(BigInt(expected.token) & 0xffffffffn) }]])
    }
  })

  it('blocks a destination without valid decimals before review or submission', async () => {
    await renderForm()
    await decimals('Ethereum', '6')
    for (const value of ['', '1.5', '-1', '33']) {
      await decimals('Optimism', value)
      await review()
      expect(renderer!.root.findAllByType(TxConfirmDialog)).toHaveLength(0)
      expect(JSON.stringify(renderer!.toJSON())).toContain('Optimism: decimals must be a whole number between 0 and 32')
    }
    expect(mocks.runAuthorityCalls).not.toHaveBeenCalled()
  })

  it('ignores deselected chains and invalidates a review when local decimals change', async () => {
    await renderForm()
    await decimals('Ethereum', '6')
    await act(async () => { renderer!.root.findByType(ChainPicker).props.onChange(new Set([1])) })
    await review()
    expect(renderer!.root.findByType(TxConfirmDialog).props.steps).toHaveLength(1)
    await decimals('Ethereum', '8')
    expect(renderer!.root.findAllByType(TxConfirmDialog)).toHaveLength(0)
    await review()
    await submit()
    expect(mocks.runAuthorityCalls.mock.calls[0][0].calls[0].args[1][0].decimals).toBe(8)
  })
})
