import type { ComponentProps, ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import type { Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Owner actions that show their own error show Discard in its place once their
// saved Relayr session can only be discarded (ruling R114).
const mocks = vi.hoisted(() => ({ run: vi.fn(), discard: vi.fn(), read: vi.fn() }))

vi.mock('@/providers/Providers', () => ({ wagmiConfig: {}, SUPPORTED_CHAINS: [] }))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ address: '0x1111111111111111111111111111111111111111', isConnected: true, openSignIn: vi.fn() }),
}))
vi.mock('@/lib/authority', async original => ({
  ...await original<typeof import('@/lib/authority')>(),
  clientFor: () => ({ readContract: mocks.read }),
  runAuthorityCalls: mocks.run,
  safeOutcomeMessage: (_result: unknown, completed: string) => completed,
}))
vi.mock('@/lib/relayr', async original => ({ ...await original<typeof import('@/lib/relayr')>(), discardRelayrSession: mocks.discard }))
vi.mock('@/components/project/SafeBatchProvider', () => ({ useSafeBatch: () => null }))
vi.mock('@/components/ui/TxConfirmDialog', () => ({
  TxConfirmDialog: (props: { error?: ReactNode; children?: ReactNode; actionDisabled?: boolean; onConfirm: () => void }) => (
    <div>
      {props.error ? <p>{props.error}</p> : null}
      {props.children}
      <button disabled={props.actionDisabled} onClick={props.onConfirm}>Confirm dialog</button>
    </div>
  ),
}))
vi.mock('@/components/ui/ChainPicker', () => ({ ChainPicker: () => null }))
vi.mock('@/components/ui/PerChainAddressField', () => ({ PerChainAddressField: ({ children }: { children?: ReactNode }) => <div>{children}</div> }))
vi.mock('@/components/create/AddressField', () => ({
  AddressField: ({ value, onChange, ariaLabel }: { value: string; onChange: (value: string) => void; ariaLabel: string }) => (
    <input aria-label={ariaLabel} value={value} onChange={event => onChange(event.target.value)} />
  ),
}))
vi.mock('@/components/create/ui', async original => ({ ...await original<typeof import('@/components/create/ui')>(), CheckRow: () => null }))
vi.mock('@/components/ChainIcon', () => ({ ChainIcon: () => null }))
vi.mock('@/components/ui/AddressLink', () => ({ AddressLink: () => null }))
vi.mock('@/components/ui/AddressLabel', () => ({ AddressLabel: () => null, AddressText: () => null }))

import { BuybackActionForm } from '@/components/project/MultiChainBuybackRouterCard'
import { PermissionEditor, TransferAuthorityFlow } from '@/components/project/AuthorityOverview'
import { TokenEditor } from '@/components/project/AuthorityEditsCard'
import { RelayrDiscardError } from '@/lib/relayr'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const OTHER = '0x2222222222222222222222222222222222222222' as Address
const HOOK = '0x3333333333333333333333333333333333333333' as Address
const REGISTRY = '0x4444444444444444444444444444444444444444' as Address
const CONTROLLER = '0x5555555555555555555555555555555555555555' as Address
const TOKEN = '0x6666666666666666666666666666666666666666' as Address
const SCOPE = 'authority:0xabc'
const LINE = 'This action\'s earlier signature may already have run. Check the project, then discard it to review it again.'
const PROJECTS = [{ chainId: 1 as const, projectId: 42, name: 'Ethereum' }, { chainId: 10 as const, projectId: 91, name: 'Optimism' }]
let renderer: ReactTestRenderer | undefined

const text = (node: ReactTestInstance): string => node.children.map(child => typeof child === 'string' ? child : text(child)).join('')
const button = (label: string) => renderer!.root.findAllByType('button').find(item => text(item) === label)
async function click(label: string) {
  const target = button(label)
  expect(target, label).toBeDefined()
  await act(async () => { await target!.props.onClick() })
}
async function check() {
  await act(async () => { renderer!.root.findByProps({ type: 'checkbox' }).props.onChange({ target: { checked: true } }) })
}
async function render(element: React.ReactElement) {
  await act(async () => { renderer = create(element) })
}

/** The action's review shows the line once and Discard, with its confirm disabled, until Discard ends the session. */
async function discardsInPlaceOfTheError() {
  expect(text(renderer!.root).split(LINE)).toHaveLength(2)
  expect(button('Confirm dialog')!.props.disabled).toBe(true)
  await click('Discard')
  expect(mocks.discard).toHaveBeenCalledWith(SCOPE)
  expect(text(renderer!.root)).not.toContain(LINE)
  expect(button('Confirm dialog')!.props.disabled).toBeFalsy()
}

beforeEach(() => {
  mocks.run.mockReset().mockRejectedValue(new RelayrDiscardError(SCOPE, 'ran'))
  mocks.discard.mockReset().mockResolvedValue(undefined)
  mocks.read.mockReset().mockResolvedValue(0n)
})
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount())
  renderer = undefined
})

describe('owner actions whose saved Relayr session can only be discarded', () => {
  it('shows Discard in the buyback hook review', async () => {
    const rows: ComponentProps<typeof BuybackActionForm>['rows'] = PROJECTS.map(project => ({
      ...project, indexedAuthority: ALICE, authority: ALICE, buybackRegistry: REGISTRY, routerRegistry: null,
      buybackAvailable: true, routerAvailable: false, hook: null, terminal: null, defaultHook: HOOK, defaultTerminal: null,
      pools: [], poolSummary: '', readError: null,
    }))
    await render(<BuybackActionForm kind="hook" rows={rows} onDone={vi.fn()} />)
    await check()
    await click('Set buyback hook')
    await click('Confirm dialog')
    expect(mocks.run).toHaveBeenCalledOnce()
    await discardsInPlaceOfTheError()
  })

  it('shows Discard in the ownership transfer review', async () => {
    const rows = PROJECTS.map(project => ({ ...project, indexedAuthority: ALICE, authority: ALICE, safe: null, accountType: 'EOA' as const }))
    await render(<TransferAuthorityFlow rows={rows} authority={ALICE} isRevnet={false} onDone={vi.fn()} />)
    await click('Transfer project ownership')
    await act(async () => { renderer!.root.findByProps({ 'aria-label': 'New project owner' }).props.onChange({ target: { value: OTHER } }) })
    await check()
    await click('Transfer project ownership')
    await click('Confirm dialog')
    expect(mocks.run).toHaveBeenCalledOnce()
    await discardsInPlaceOfTheError()
  })

  it('shows Discard in the operator permissions review', async () => {
    const deployments = PROJECTS.map(({ chainId, projectId }) => ({ chainId, projectId, indexedAuthority: ALICE }))
    const authorityRows = PROJECTS.map(project => ({ ...project, indexedAuthority: ALICE, authority: ALICE, safe: null, accountType: 'EOA' as const }))
    await render(<PermissionEditor grant={null} presetIds={[24]} deployments={deployments} authorityRows={authorityRows} onCancel={vi.fn()} onDone={vi.fn()} />)
    await act(async () => { renderer!.root.findByProps({ 'aria-label': 'Operator address' }).props.onChange({ target: { value: OTHER } }) })
    await check()
    await click('Add operator')
    await click('Confirm dialog')
    expect(mocks.run).toHaveBeenCalledOnce()
    await discardsInPlaceOfTheError()
  })

  it('shows Discard in the token details review', async () => {
    const rows = PROJECTS.map(project => ({ ...project, indexedAuthority: ALICE, authority: ALICE, controller: CONTROLLER,
      uri: null, token: TOKEN, tokenName: 'Old token', tokenSymbol: 'OLD', error: null }))
    await render(<TokenEditor rows={rows} fallbackName="Project" onCancel={vi.fn()} onDone={vi.fn()} />)
    await click('Save token details')
    await click('Confirm dialog')
    expect(mocks.run).toHaveBeenCalledOnce()
    await discardsInPlaceOfTheError()
  })
})
