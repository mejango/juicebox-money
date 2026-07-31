import { createElement } from 'react'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import { zeroAddress, type Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  address: '0x1111111111111111111111111111111111111111' as Address | undefined,
  connected: true,
  openSignIn: vi.fn(),
  send: vi.fn(),
  reset: vi.fn(),
  amountToAutoIssue: vi.fn(),
  buildAutoIssue: vi.fn(),
  clientAvailable: true,
  publicClient: { readContract: vi.fn() },
  refetchBalance: vi.fn(),
  balance: 5n * 10n ** 18n,
  txPhase: 'idle',
  txBusy: false,
  txHash: null as string | null,
  txError: null as Error | null,
  safeTxCall: 0,
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: Record<string, unknown>) =>
    createElement('a', { href, ...props }, children as never),
}))
vi.mock('wagmi', () => ({
  usePublicClient: () =>
    mocks.clientAvailable ? mocks.publicClient : undefined,
  useReadContract: () => ({
    data: mocks.balance,
    refetch: mocks.refetchBalance,
  }),
}))
vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    switch (queryKey[0]) {
      case 'projectTokenSymbol':
        return {
          data: {
            address: '0x3333333333333333333333333333333333333333',
            symbol: 'JBT',
          },
          isFetching: false,
          isError: false,
        }
      case 'cashOutContext':
        return {
          data: {
            token: '0x4444444444444444444444444444444444444444',
            decimals: 6,
            currency: 2,
          },
        }
      case 'cashOutTerminal':
        return {
          data: {
            address: '0x5555555555555555555555555555555555555555',
            isRouter: false,
          },
        }
      case 'cashOutQuote':
        return {
          data: {
            route: 'treasury',
            expectedReturn: 9_750n,
            minimumReturn: 9_652n,
            terminalMinimum: 9_652n,
            metadata: '0x',
            treasuryGross: 10_000n,
            treasuryProtocolFee: 250n,
            treasuryNet: 9_750n,
            buyback: null,
          },
          isFetching: false,
          isError: false,
        }
      default:
        return { data: undefined, isFetching: false, isError: false }
    }
  },
}))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({
    isConnected: mocks.connected,
    address: mocks.address,
    openSignIn: mocks.openSignIn,
  }),
}))
vi.mock('@/hooks/useSafeTx', () => {
  return {
    useSafeTx: () => {
      const approval = mocks.safeTxCall % 2 === 1
      mocks.safeTxCall += 1
      return {
        phase: approval ? 'idle' : mocks.txPhase,
        busy: approval ? false : mocks.txBusy,
        hash: approval ? null : mocks.txHash,
        receipt: null,
        error: approval ? null : mocks.txError,
        isSafe: false,
        send: mocks.send,
        reset: mocks.reset,
      }
    },
    txPhaseLabel: (
      phase: string,
      labels: Record<string, string> = {},
    ) => labels[phase] ?? phase,
  }
})
vi.mock('@/lib/ens', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/ens')>()
  return {
    ...original,
    lookupEnsAddress: vi.fn(),
    lookupEnsName: vi.fn(),
  }
})
vi.mock('@bananapus/nana-sdk-core/v6', async importOriginal => {
  const original = await importOriginal<
    typeof import('@bananapus/nana-sdk-core/v6')
  >()
  return {
    ...original,
    getAmountToAutoIssue: mocks.amountToAutoIssue,
    buildAutoIssueTx: mocks.buildAutoIssue,
  }
})

import { ExtrasTab } from '@/components/project/ExtrasTab'
import { DistributeFlow } from '@/components/project/AutoIssuanceSection'
import { CashOutPanel } from '@/components/project/CashOutFlow'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const AUTO_ISSUE_REQUEST = {
  chainId: 1,
  address: '0x2222222222222222222222222222222222222222' as Address,
  abi: [],
  functionName: 'autoIssueFor',
  args: [42n, 3n, ALICE],
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

beforeEach(() => {
  mocks.address = ALICE
  mocks.clientAvailable = true
  mocks.connected = true
  mocks.balance = 5n * 10n ** 18n
  mocks.txPhase = 'idle'
  mocks.txBusy = false
  mocks.txHash = null
  mocks.txError = null
  mocks.safeTxCall = 0
  mocks.amountToAutoIssue.mockResolvedValue(10n)
  mocks.buildAutoIssue.mockReturnValue(AUTO_ISSUE_REQUEST)
  mocks.send.mockResolvedValue('0xhash')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('project payer write flow', () => {
  const extrasProps = {
    chainId: 1 as const,
    projectId: 42,
    isRevnet: false,
    profile: {
      name: 'Test project',
      ticker: 'TEST',
      tagline: '',
      description: '',
    },
    chains: [[1, 42] as [number, number]],
    authorities: [[1, ALICE] as [number, string]],
  }

  it('freezes the edited payer settings at review and sends that exact request', async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(ExtrasTab, {
          ...extrasProps,
          chains: [[1, 42], [10, 84]],
        }),
      )
    })

    await act(async () => {
      renderer.root.findByType('select').props.onChange({
        target: { value: 'balance' },
      })
      renderer.root
        .findAllByType('input')
        .find(input => input.props['aria-label'] === 'Memo')!
        .props.onChange({ target: { value: ' treasury top-up ' } })
      renderer.root
        .findAllByType('input')
        .find(input => input.props.type === 'checkbox')!
        .props.onChange({ target: { checked: true } })
    })
    await act(async () => buttonWith(renderer, 'Review deploy').props.onClick())

    expect(renderedText(renderer.root)).toContain('Confirm deploy')
    await act(async () => buttonWith(renderer, 'Confirm deploy').props.onClick())

    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(mocks.send.mock.calls[0][0]).toMatchObject({
      chainId: 1,
      functionName: 'deployProjectPayer',
      args: [42n, zeroAddress, 'treasury top-up', '0x', true, ALICE],
    })
  })

  it('opens sign-in without constructing or sending a write when disconnected', async () => {
    mocks.connected = false
    mocks.address = undefined
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ExtrasTab, extrasProps))
    })

    await act(async () =>
      buttonWith(renderer, 'Sign in to continue').props.onClick(),
    )

    expect(mocks.openSignIn).toHaveBeenCalledTimes(1)
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('invalidates a reviewed write when the connected account changes', async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(ExtrasTab, extrasProps))
    })
    await act(async () => buttonWith(renderer, 'Review deploy').props.onClick())

    mocks.address = '0x3333333333333333333333333333333333333333'
    await act(async () =>
      renderer.update(createElement(ExtrasTab, extrasProps)),
    )
    await act(async () => buttonWith(renderer, 'Confirm deploy').props.onClick())

    expect(mocks.send).not.toHaveBeenCalled()
    expect(renderedText(renderer.root)).toMatch(/connected account changed/i)
  })
})

describe('auto-issuance write flow', () => {
  const props = {
    chainId: 1 as const,
    projectId: 42,
    stageId: '3',
    beneficiary: ALICE,
    onDone: vi.fn(),
  }

  it('re-reads availability immediately before sending the reviewed request', async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(DistributeFlow, props))
    })
    await act(async () => buttonWith(renderer, 'Distribute').props.onClick())

    expect(mocks.amountToAutoIssue).toHaveBeenCalledWith(mocks.publicClient, {
      chainId: 1,
      revnetId: 42n,
      stageId: 3n,
      beneficiary: ALICE,
    })
    expect(mocks.buildAutoIssue).toHaveBeenCalledWith({
      chainId: 1,
      revnetId: 42n,
      stageId: 3n,
      beneficiary: ALICE,
    })
    expect(mocks.send).toHaveBeenCalledWith(AUTO_ISSUE_REQUEST)
  })

  it('fails closed when the latest on-chain allocation is already empty', async () => {
    mocks.amountToAutoIssue.mockResolvedValueOnce(0n)
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(DistributeFlow, props))
    })
    await act(async () => buttonWith(renderer, 'Distribute').props.onClick())

    expect(mocks.send).not.toHaveBeenCalled()
    expect(renderedText(renderer.root)).toMatch(/nothing left to distribute/i)
  })

  it('requests sign-in before any authoritative read when disconnected', async () => {
    mocks.connected = false
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(DistributeFlow, props))
    })
    await act(async () => buttonWith(renderer, 'Distribute').props.onClick())

    expect(mocks.openSignIn).toHaveBeenCalledTimes(1)
    expect(mocks.amountToAutoIssue).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('fails closed before reading or writing when the chain client is unavailable', async () => {
    mocks.clientAvailable = false
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(DistributeFlow, props))
    })
    await act(async () => buttonWith(renderer, 'Distribute').props.onClick())

    expect(mocks.amountToAutoIssue).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })
})

describe('cash-out write flow', () => {
  it('debounces the amount and sends the exact freshly rendered quote floor', async () => {
    vi.useFakeTimers()
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(CashOutPanel, {
          chainId: 1,
          projectId: 42,
          projectName: 'Safe Project',
          accountingToken: '0x4444444444444444444444444444444444444444',
          accountingTokenSymbol: 'USDC',
        }),
      )
    })
    const amount = renderer.root
      .findAllByType('input')
      .find(input => String(input.props['aria-label']).startsWith('Amount of'))!

    await act(async () => {
      amount.props.onChange({ target: { value: '2' } })
    })
    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    await act(async () => buttonWith(renderer, 'Cash out 2 JBT').props.onClick())

    expect(mocks.send).toHaveBeenCalledTimes(1)
    expect(mocks.send.mock.calls[0][0]).toMatchObject({
      chainId: 1,
      address: '0x5555555555555555555555555555555555555555',
      functionName: 'cashOutTokensOf',
      args: [
        ALICE,
        42n,
        2n * 10n ** 18n,
        '0x4444444444444444444444444444444444444444',
        9_652n,
        ALICE,
        '0x',
      ],
    })
  })

  it('uses the full balance, changes slippage, and rejects malformed amounts', async () => {
    vi.useFakeTimers()
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(CashOutPanel, {
          chainId: 1,
          projectId: 42,
          accountingToken: '0x4444444444444444444444444444444444444444',
          accountingTokenSymbol: 'USDC',
        }),
      )
    })

    await act(async () => buttonWith(renderer, 'MAX').props.onClick())
    expect(buttonWith(renderer, 'Cash out 5 JBT')).toBeDefined()

    await act(async () => buttonWith(renderer, '3%').props.onClick())
    expect(buttonWith(renderer, '3%').props['aria-pressed']).toBe(true)

    const amount = renderer.root
      .findAllByType('input')
      .find(input => String(input.props['aria-label']).startsWith('Amount of'))!
    await act(async () => amount.props.onChange({ target: { value: '1.2.3' } }))
    await act(async () => {
      vi.advanceTimersByTime(400)
    })

    expect(buttonWith(renderer, 'Cash out').props.disabled).toBe(true)
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('signs in before attempting a cash-out and links an empty holder to pay', async () => {
    mocks.connected = false
    mocks.address = undefined
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(CashOutPanel, {
          chainId: 1,
          projectId: 42,
        }),
      )
    })

    await act(async () =>
      buttonWith(renderer, 'Sign in to cash out').props.onClick(),
    )
    expect(mocks.openSignIn).toHaveBeenCalledTimes(1)
    expect(mocks.send).not.toHaveBeenCalled()

    const onGoToPay = vi.fn()
    mocks.connected = true
    mocks.address = ALICE
    mocks.balance = 0n
    await act(async () => {
      renderer.update(
        createElement(CashOutPanel, {
          chainId: 1,
          projectId: 42,
          onGoToPay,
        }),
      )
    })
    await act(async () => buttonWith(renderer, 'pay to get some').props.onClick())
    expect(onGoToPay).toHaveBeenCalledTimes(1)
  })

  it('shows a confirmed cash-out, links its receipt, and resets for another', async () => {
    mocks.txPhase = 'success'
    mocks.txHash = `0x${'1'.repeat(64)}`
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(CashOutPanel, {
          chainId: 1,
          projectId: 42,
        }),
      )
    })

    expect(renderedText(renderer.root)).toContain('Cashed out!')
    expect(renderedText(renderer.root)).toContain(
      "Your share of the project's treasury is on its way.",
    )
    const receipt = renderer.root.findByType('a')
    expect(receipt.props.href).toContain(mocks.txHash)
    expect(mocks.refetchBalance).toHaveBeenCalled()

    await act(async () => buttonWith(renderer, 'Cash out again').props.onClick())
    expect(mocks.reset).toHaveBeenCalled()
  })
})
