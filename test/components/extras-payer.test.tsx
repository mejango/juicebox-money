import { createElement, type ReactNode } from 'react'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import {
  encodeAbiParameters,
  encodeEventTopics,
  zeroAddress,
  type Address,
  type Log,
} from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  JB_PROJECT_PAYER_DEPLOYER,
  jbProjectPayerDeployerAbi,
} from '@bananapus/nana-sdk-core/v6'
import type { BsProjectPayer } from '@/lib/bendystraw'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const ADMIN = '0x2222222222222222222222222222222222222222' as Address
const PAYER = '0x3333333333333333333333333333333333333333' as Address

const mocks = vi.hoisted(() => ({
  address: undefined as Address | undefined,
  connected: true,
  openSignIn: vi.fn(),
  send: vi.fn(),
  reset: vi.fn(),
  refetchPayers: vi.fn(),
  getProjectPayers: vi.fn(),
  buildProjectDraftExport: vi.fn(),
  payerRows: [] as BsProjectPayer[],
  payersLoading: false,
  payersError: false,
  payersFetching: false,
  txPhase: 'idle' as string,
  txReceipt: null as { logs: Log[] } | null,
  writeText: vi.fn(),
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: Record<string, unknown>) =>
    createElement('a', { href, ...props }, children as never),
}))
// The real shell renders its children behind a close control; the stub keeps
// both so the dismiss path stays reachable without a top-layer <dialog>.
vi.mock('@/components/ui/ModalShell', () => ({
  ModalShell: ({
    children,
    onClose,
  }: {
    children: ReactNode
    onClose: () => void
  }) =>
    createElement(
      'div',
      null,
      createElement('button', { onClick: onClose }, 'Close dialog'),
      children,
    ),
}))
vi.mock('@/components/ChainIcon', () => ({ ChainIcon: () => null }))
vi.mock('wagmi', () => ({
  usePublicClient: () => ({ readContract: vi.fn() }),
}))
vi.mock('@tanstack/react-query', () => ({
  useQuery: ({
    queryKey,
    queryFn,
  }: {
    queryKey: readonly unknown[]
    queryFn: () => unknown
  }) => {
    if (queryKey[0] === 'projectPayers') {
      // Run the wired query function so a wrong argument list is a test
      // failure rather than an untested detail of the hook call.
      void queryFn()
      return {
        data: mocks.payerRows,
        isLoading: mocks.payersLoading,
        isError: mocks.payersError,
        isFetching: mocks.payersFetching,
        refetch: mocks.refetchPayers,
      }
    }
    return { data: undefined, isLoading: false, isError: false, isFetching: false }
  },
}))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({
    isConnected: mocks.connected,
    address: mocks.address,
    openSignIn: mocks.openSignIn,
  }),
}))
vi.mock('@/hooks/useSafeTx', () => ({
  useSafeTx: () => ({
    phase: mocks.txPhase,
    busy: false,
    hash: mocks.txPhase === 'idle' ? null : '0xdeadbeef',
    receipt: mocks.txReceipt,
    error: null,
    isSafe: false,
    send: mocks.send,
    reset: mocks.reset,
  }),
  txPhaseLabel: (phase: string, labels: Record<string, string> = {}) =>
    labels[phase] ?? phase,
}))
vi.mock('@/lib/project-draft-export', () => ({
  buildProjectDraftExport: mocks.buildProjectDraftExport,
}))
vi.mock('@/lib/bendystraw', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/bendystraw')>()
  return { ...original, getProjectPayers: mocks.getProjectPayers }
})

import { ExtrasTab } from '@/components/project/ExtrasTab'

const props = {
  chainId: 1 as const,
  projectId: 42,
  isRevnet: false,
  profile: { name: 'Test project', ticker: 'TEST', tagline: '', description: '' },
  chains: [[1, 42]] as [number, number][],
  authorities: [[1, ALICE]] as [number, string | null][],
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

function inputLabelled(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  return renderer.root
    .findAllByType('input')
    .find(input => input.props['aria-label'] === label)!
}

async function openDialog() {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(createElement(ExtrasTab, props))
  })
  await act(async () =>
    buttonWith(renderer, 'Create payer address').props.onClick(),
  )
  return renderer
}

/** A real DeployProjectPayer log from the canonical deployer. */
function deployLog(payer: Address): Log {
  const event = jbProjectPayerDeployerAbi.find(
    (entry): entry is Extract<
      (typeof jbProjectPayerDeployerAbi)[number],
      { type: 'event' }
    > => entry.type === 'event' && entry.name === 'DeployProjectPayer',
  )!
  const topics = encodeEventTopics({
    abi: jbProjectPayerDeployerAbi,
    eventName: 'DeployProjectPayer',
    args: { projectPayer: payer },
  })
  // Body params come from the ABI itself, so a signature change fails this
  // test rather than quietly producing a log the strict decoder rejects.
  const data = encodeAbiParameters(
    event.inputs.filter(input => !input.indexed),
    [42n, zeroAddress, '', '0x', false, ALICE, zeroAddress, ALICE],
  )
  return { address: JB_PROJECT_PAYER_DEPLOYER, data, topics } as unknown as Log
}

function payerRow(overrides: Partial<BsProjectPayer> = {}): BsProjectPayer {
  return {
    chainId: 1,
    projectId: 42,
    version: 6,
    address: PAYER,
    defaultAddToBalance: false,
    defaultBeneficiary: zeroAddress,
    owner: zeroAddress,
    paymentsCount: 0,
    addToBalanceCount: 0,
    totalFacilitated: '0',
    totalFacilitatedUsd: '0',
    lastUsedAt: null,
    createdAt: 0,
    ...overrides,
  }
}

beforeEach(() => {
  mocks.address = ALICE
  mocks.connected = true
  mocks.payerRows = []
  mocks.payersLoading = false
  mocks.payersError = false
  mocks.payersFetching = false
  mocks.txPhase = 'idle'
  mocks.txReceipt = null
  mocks.getProjectPayers.mockResolvedValue([])
  vi.stubGlobal('navigator', { clipboard: { writeText: mocks.writeText } })
})

describe('payer deploy input validation', () => {
  it('reads the indexed payer list for this project on every deployed chain', async () => {
    await openDialog()
    expect(mocks.getProjectPayers).toHaveBeenCalledWith(props.chains)
  })

  it('refuses a beneficiary that is neither an address nor a resolved name', async () => {
    const renderer = await openDialog()

    await act(async () =>
      inputLabelled(renderer, 'Token beneficiary').props.onChange({
        target: { value: 'not-an-address' },
      }),
    )
    await act(async () => buttonWith(renderer, 'Review deploy').props.onClick())

    expect(renderedText(renderer.root)).toContain(
      'Enter a valid beneficiary address or ENS name, or leave it empty.',
    )
    expect(mocks.send).not.toHaveBeenCalled()
    // Never reached review, so there is nothing to confirm.
    expect(renderedText(renderer.root)).not.toContain('Confirm deploy')
  })

  it('refuses an admin that is neither an address nor a resolved name', async () => {
    const renderer = await openDialog()

    await act(async () =>
      renderer.root
        .findAllByType('input')
        .find(input => input.props.type === 'checkbox')!
        .props.onChange({ target: { checked: true } }),
    )
    await act(async () =>
      inputLabelled(renderer, 'Address admin').props.onChange({
        target: { value: 'nope.not-ens' },
      }),
    )
    await act(async () => buttonWith(renderer, 'Review deploy').props.onClick())

    expect(renderedText(renderer.root)).toContain(
      'Enter a valid admin address or ENS name.',
    )
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('names the entered admin as owner rather than the connected wallet', async () => {
    const renderer = await openDialog()

    await act(async () =>
      renderer.root
        .findAllByType('input')
        .find(input => input.props.type === 'checkbox')!
        .props.onChange({ target: { checked: true } }),
    )
    await act(async () =>
      inputLabelled(renderer, 'Address admin').props.onChange({
        target: { value: ADMIN },
      }),
    )
    await act(async () =>
      inputLabelled(renderer, 'Token beneficiary').props.onChange({
        target: { value: ADMIN },
      }),
    )
    await act(async () => buttonWith(renderer, 'Review deploy').props.onClick())

    expect(renderedText(renderer.root)).toContain(
      `${ADMIN.slice(0, 6)}…${ADMIN.slice(-4)} can change these settings later.`,
    )
    await act(async () => buttonWith(renderer, 'Confirm deploy').props.onClick())

    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(mocks.send.mock.calls[0][0]).toMatchObject({
      functionName: 'deployProjectPayer',
      args: [42n, ADMIN, '', '0x', false, ADMIN],
    })
  })

  it('closes the dialog without sending anything', async () => {
    const renderer = await openDialog()
    expect(renderedText(renderer.root)).toContain('Review deploy')

    await act(async () => buttonWith(renderer, 'Close dialog').props.onClick())

    expect(renderedText(renderer.root)).not.toContain('Review deploy')
    expect(mocks.send).not.toHaveBeenCalled()
  })
})

describe('indexed payer address list', () => {
  it('reports each address with its behavior, counts and facilitated total', async () => {
    mocks.payerRows = [
      payerRow({
        address: PAYER,
        paymentsCount: 3,
        addToBalanceCount: 2,
        totalFacilitatedUsd: '1234560000000000000000',
      }),
      payerRow({
        chainId: 10,
        address: 'not-an-address',
        defaultAddToBalance: true,
        totalFacilitatedUsd: '5000000000000000',
      }),
    ]
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ExtrasTab, props))
    })

    const text = renderedText(renderer.root)
    expect(text).toContain('3 pay | 2 balance')
    expect(text).toContain('$1,234.56')
    // Half a cent rounds up, and a row whose address the indexer could not
    // normalize is still shown rather than linked.
    expect(text).toContain('No payments yet')
    expect(text).toContain('$0.01')
    expect(text).not.toContain('$0.00')
    expect(text).toContain('not-an-address')
    expect(text).toContain('Add to balance')
  })

  it('reads a malformed facilitated total as zero instead of crashing the tab', async () => {
    mocks.payerRows = [payerRow({ totalFacilitatedUsd: 'not-a-number' })]
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ExtrasTab, props))
    })

    expect(renderedText(renderer.root)).toContain('$0.00')
  })
})

describe('payer deploy success panel', () => {
  beforeEach(() => {
    mocks.txPhase = 'success'
    mocks.txReceipt = { logs: [deployLog(PAYER)] }
  })

  it('shows the deployed address from the receipt and refreshes the list', async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ExtrasTab, props))
    })
    await act(async () =>
      buttonWith(renderer, 'Create payer address').props.onClick(),
    )

    expect(renderedText(renderer.root)).toContain(PAYER)
    expect(mocks.refetchPayers).toHaveBeenCalled()

    await act(async () => buttonWith(renderer, 'Copy').props.onClick())
    expect(mocks.writeText).toHaveBeenCalledWith(PAYER)
    expect(renderedText(renderer.root)).toContain('Copied!')

    await act(async () =>
      buttonWith(renderer, 'Deploy another').props.onClick(),
    )
    expect(mocks.reset).toHaveBeenCalledTimes(1)
  })

  it('points at the explorer when the receipt carries no payer deployment', async () => {
    mocks.txReceipt = { logs: [] }
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ExtrasTab, props))
    })
    await act(async () =>
      buttonWith(renderer, 'Create payer address').props.onClick(),
    )

    expect(renderedText(renderer.root)).toContain(
      'The new address will show on the transaction',
    )
    expect(renderedText(renderer.root)).not.toContain('Copy')
  })
})
