import { createElement } from 'react'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core'
import type { Address } from 'viem'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const SOURCE_SUCKER = '0x2222222222222222222222222222222222222222' as Address
const DEST_SUCKER = '0x3333333333333333333333333333333333333333' as Address
const PROJECT_TOKEN = '0x4444444444444444444444444444444444444444' as Address
const AMOUNT = 2n * 10n ** 18n
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  verify: vi.fn(),
  pairs: vi.fn(),
  send: vi.fn(),
  walletWrite: vi.fn(),
  rejection: null as unknown,
  phase: 'idle',
  reset: vi.fn(),
}))
const sourceClient = { readContract: mocks.read }
const destinationClient = { chain: { id: 10 } }

vi.mock('wagmi', () => ({ useConfig: () => ({}) }))
vi.mock('wagmi/actions', () => ({
  getPublicClient: (_config: unknown, { chainId }: { chainId: number }) =>
    chainId === 1 ? sourceClient : destinationClient,
}))
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: {
    pairs: [{ local: SOURCE_SUCKER, remote: DEST_SUCKER, remoteChainId: 10n }],
    token: PROJECT_TOKEN,
    erc20Balance: 10n * AMOUNT,
  } }),
}))
vi.mock('@bananapus/nana-sdk-core/v6', async original => ({
  ...await original<typeof import('@bananapus/nana-sdk-core/v6')>(),
  getAccountingContexts: vi.fn(async () => [{ token: NATIVE_TOKEN, decimals: 18 }]),
  getV6SuckerPairs: mocks.pairs,
  verifySuckerDestinationMint: mocks.verify,
}))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ address: ACCOUNT, isConnected: true, openSignIn: vi.fn() }),
}))
vi.mock('@/hooks/useSafeTx', () => ({
  useSafeTx: () => ({
    send: mocks.send, phase: mocks.phase, busy: false, error: null,
    hash: null, reset: mocks.reset,
  }),
  txPhaseLabel: (_phase: unknown, { idle }: { idle: string }) => idle,
}))
vi.mock('@/components/project/SettlementSection', async () => ({
  SUCKER_EXTRA_ABI: (await import('@bananapus/nana-sdk-core/v6')).jbSuckerV6Abi,
  classifyInfra: vi.fn(async () => 'native'),
  unpackAddress: (address: Address) => address,
  findToRemoteValue: vi.fn(async () => 0n),
}))
vi.mock('@/lib/token-symbol', () => ({ tokenSymbol: vi.fn(async () => 'ETH') }))

import { MoveCard } from '@/components/project/MoveFlow'

function text(node: ReactTestInstance): string {
  return node.children.map(child => typeof child === 'string' ? child : text(child)).join('')
}

async function click(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const button = renderer.root.findAllByType('button').find(item => text(item) === label)
  expect(button, label).toBeDefined()
  await act(async () => { await button!.props.onClick() })
}

async function renderMove() {
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(createElement(MoveCard, {
      chainId: 1, projectId: 42, chains: [[1, 42], [10, 84]],
    }))
  })
  await act(async () => {
    renderer.root.findByType('input').props.onChange({ target: { value: '2' } })
  })
  return renderer
}

beforeEach(() => {
  mocks.phase = 'idle'
  mocks.rejection = null
  mocks.verify.mockReset().mockResolvedValue(undefined)
  mocks.pairs.mockReset().mockResolvedValue([
    { local: DEST_SUCKER, remote: SOURCE_SUCKER, remoteChainId: 1n },
  ])
  mocks.reset.mockImplementation(() => { mocks.phase = 'idle' })
  mocks.read.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'projectId') return 42n
    if (functionName === 'remoteTokenFor') return { enabled: true, addr: NATIVE_TOKEN }
    if (functionName === 'balanceOf' || functionName === 'allowance') return 10n * AMOUNT
    if (functionName === 'previewCashOutFrom') return [null, 10n ** 18n, 0n, []]
    throw new Error(`Unexpected read: ${functionName}`)
  })
  mocks.send.mockImplementation(async (request, options) => {
    try {
      await options.reverify?.(request)
      mocks.walletWrite(request)
    } catch (error) {
      mocks.rejection = error
    }
  })
})

describe('manual bridge mint readiness', () => {
  it('rejects a destination project whose registry does not authenticate the exact reciprocal peer', async () => {
    mocks.pairs.mockResolvedValue([])
    const renderer = await renderMove()
    await click(renderer, 'Move to Optimism')

    expect(text(renderer.root)).toContain('The destination bridge no longer matches this transfer.')
    expect(mocks.verify).not.toHaveBeenCalled()
    expect(mocks.walletWrite).not.toHaveBeenCalled()
    await act(async () => renderer.unmount())
  })

  it('blocks review when the destination peer cannot mint', async () => {
    mocks.verify.mockRejectedValue(new Error('Destination mint denied.'))
    const renderer = await renderMove()
    await click(renderer, 'Move to Optimism')

    expect(text(renderer.root)).toContain('Destination mint denied.')
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.walletWrite).not.toHaveBeenCalled()
    await act(async () => renderer.unmount())
  })

  it('rechecks exact destination mint inputs before the source prepare wallet request', async () => {
    const renderer = await renderMove()
    await click(renderer, 'Move to Optimism')
    await act(async () => {
      renderer.root.findByType('input').props.onChange({ target: { value: '5' } })
    })
    mocks.verify.mockRejectedValueOnce(new Error('Destination mint authority changed.'))
    await click(renderer, 'Prepare')

    expect(mocks.verify).toHaveBeenCalledTimes(2)
    expect(mocks.pairs).toHaveBeenNthCalledWith(2, destinationClient, {
      chainId: 10, projectId: 84n, sucker: DEST_SUCKER,
    })
    for (const call of mocks.verify.mock.calls) {
      expect(call).toEqual([destinationClient, {
        chainId: 10, projectId: 84n, sucker: DEST_SUCKER,
        beneficiary: ACCOUNT, tokenCount: AMOUNT,
      }])
    }
    expect(mocks.walletWrite).not.toHaveBeenCalled()
    expect(mocks.rejection).toEqual(new Error('Destination mint authority changed.'))
    await click(renderer, 'Prepare')
    expect(mocks.walletWrite).toHaveBeenCalledOnce()
    await act(async () => renderer.unmount())
  })

  it('submits the source prepare when the destination mint remains available', async () => {
    const renderer = await renderMove()
    await click(renderer, 'Move to Optimism')
    await click(renderer, 'Prepare')

    expect(mocks.verify).toHaveBeenCalledTimes(2)
    expect(mocks.walletWrite).toHaveBeenCalledWith(expect.objectContaining({
      chainId: 1, address: SOURCE_SUCKER, functionName: 'prepare',
    }))
    await act(async () => renderer.unmount())
  })

  it('keeps sending an already prepared outbox available when destination minting becomes unavailable', async () => {
    const renderer = await renderMove()
    await click(renderer, 'Move to Optimism')
    await click(renderer, 'Prepare')
    mocks.verify.mockRejectedValue(new Error('Destination mint denied.'))
    mocks.phase = 'success'
    await act(async () => {
      renderer.update(createElement(MoveCard, {
        chainId: 1, projectId: 42, chains: [[1, 42], [10, 84]],
      }))
    })
    await click(renderer, 'Send to Optimism')

    expect(mocks.verify).toHaveBeenCalledTimes(2)
    expect(mocks.walletWrite).toHaveBeenLastCalledWith(expect.objectContaining({
      chainId: 1, address: SOURCE_SUCKER, functionName: 'toRemote',
    }))
    await act(async () => renderer.unmount())
  })
})
