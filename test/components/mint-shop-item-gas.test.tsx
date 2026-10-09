import type { ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { encodeFunctionData, toEventSelector, zeroAddress, type Abi, type Address, type Hex } from 'viem'
import { SAFE_EXEC_ABI } from '@bananapus/nana-sdk-core/safe-service'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserWriteRecoveryModel } from '../support/write-recovery'

const mocks = vi.hoisted(() => ({
  safe: false,
  connectorUid: 'reviewed-wallet',
  review: vi.fn(),
  write: vi.fn(),
  waitSafe: vi.fn(),
  receipt: vi.fn(),
  shop: vi.fn(),
  client: { readContract: vi.fn(), simulateContract: vi.fn(), estimateContractGas: vi.fn(), getTransaction: vi.fn(), getChainId: vi.fn(), getTransactionReceipt: vi.fn(), getBlock: vi.fn() },
}))

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const HOOK = '0x2222222222222222222222222222222222222222' as Address
const STORE = '0x3333333333333333333333333333333333333333' as Address
const PROPOSAL = `0x${'ab'.repeat(32)}` as Hex
const BLOCK = `0x${'cd'.repeat(32)}` as Hex
const EXECUTION_FAILURE = toEventSelector('ExecutionFailure(bytes32,uint256)')
const EXECUTION_SUCCESS = toEventSelector('ExecutionSuccess(bytes32,uint256)')
/** The safeTxHash the Safe's own event names, which a wallet that executed at once never returns. */
const SAFE_TX = `0x${'ef'.repeat(32)}` as Hex

vi.mock('wagmi', () => ({
  useConfig: () => ({}),
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
  useWriteContract: () => ({ writeContractAsync: mocks.write }),
}))
vi.mock('@wagmi/core', () => ({ getAccount: () => ({ address: ACCOUNT, chainId: 1, connector: { uid: mocks.connectorUid } }) }))
vi.mock('wagmi/actions', () => ({
  getAccount: () => ({ address: ACCOUNT, chainId: 1, connector: { uid: mocks.connectorUid } }),
  getPublicClient: () => mocks.client,
}))
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn().mockResolvedValue(undefined) }),
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {}, SUPPORTED_CHAINS: [] }))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ isConnected: true, address: ACCOUNT, openSignIn: vi.fn() }),
}))
vi.mock('@/components/ui/ModalShell', () => ({
  ModalShell: ({ children, footer }: { children: ReactNode; footer: ReactNode }) => (
    <div>{children}{footer}</div>
  ),
}))
vi.mock('@/components/ui/TxConfirmDialog', () => ({
  // Once complete, the confirm offers only Done.
  TxConfirmDialog: ({ onConfirm, onClose, title, error, status, complete, children }: {
    onConfirm: () => void; onClose: () => void; title: string; error?: string | null; status?: string; complete?: boolean; children?: ReactNode
  }) => (
    <div>
      <p>{title}</p>
      {error ? <p>{error}</p> : null}
      {status ? <p>{status}</p> : null}
      {children}
      {complete
        ? <button type="button" onClick={onClose}>Done</button>
        : <button type="button" onClick={onConfirm}>Confirm mint</button>}
    </div>
  ),
}))
vi.mock('@bananapus/nana-sdk-core/v6', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core/v6')>()),
  getProject721Shop: mocks.shop,
}))
vi.mock('@/lib/transaction-review', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/transaction-review')>()),
  requireContractTransactionReview: mocks.review,
}))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => mocks.safe,
  SAFE_NONCE_GUIDANCE: 'Choose the Safe nonce.',
  waitForSafeExecutionHash: mocks.waitSafe,
}))
vi.mock('@bananapus/nana-sdk-core/review', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core/review')>()),
  isTransactionReceiptUnavailableError: () => false,
  waitForTrackedReceipt: mocks.receipt,
}))

import { MintShopItemModal } from '@/components/project/MintShopItemModal'

let renderer: ReactTestRenderer

async function click(label: string) {
  const button = renderer.root.findAllByType('button').find(item => item.children.join('') === label)
  expect(button, label).toBeDefined()
  await act(async () => { await button!.props.onClick() })
}

async function openMint(remaining = 5) {
  await act(async () => {
    renderer = create(
      <MintShopItemModal chainId={1} projectId={7} hook={HOOK} tierId={1} itemName="Hat"
        remaining={remaining} isRevnet={false} onClose={vi.fn()} />,
    )
  })
}

async function mint() {
  await openMint()
  await click('Mint without payment')
  await click('Confirm mint')
}

beforeEach(() => {
  mocks.safe = false
  mocks.connectorUid = 'reviewed-wallet'
  mocks.review.mockReset().mockResolvedValue(undefined)
  mocks.write.mockReset().mockResolvedValue(PROPOSAL)
  mocks.waitSafe.mockReset().mockResolvedValue(PROPOSAL)
  mocks.receipt.mockReset().mockImplementation(async (_client: unknown, hash: Hex) => mintReceipt(hash))
  mocks.client.getChainId.mockReset().mockResolvedValue(1)
  mocks.client.getTransaction.mockReset().mockImplementation(async ({ hash }: { hash: Hex }) => ({
    hash, from: ACCOUNT, to: HOOK, input: '0x',
    blockHash: BLOCK, blockNumber: 10n, transactionIndex: 0,
  }))
  mocks.client.getTransactionReceipt.mockReset().mockImplementation(async ({ hash }: { hash: Hex }) =>
    mocks.receipt(mocks.client, hash))
  mocks.client.getBlock.mockReset().mockImplementation(async ({ blockNumber }: { blockNumber?: bigint }) => ({
    hash: BLOCK, number: blockNumber ?? 10n, timestamp: 1n,
  }))
  mocks.shop.mockReset().mockResolvedValue({ hook: HOOK })
  mocks.client.readContract.mockReset().mockImplementation(async ({ functionName }: { functionName: string }) =>
    functionName === 'owner' ? ACCOUNT
      : functionName === 'STORE' ? STORE
        : { id: 1n, flags: { allowOwnerMint: true }, remainingSupply: 5 })
  mocks.client.simulateContract.mockReset().mockImplementation(async (request: object) => ({ request }))
  mocks.client.estimateContractGas.mockReset().mockResolvedValue(100_000n)
})

afterEach(async () => { await act(async () => renderer.unmount()) })

/** The Safe's execTransaction of the mint the wallet was asked to send, or of `data` in its place. */
function executesSentMint(data?: Hex) {
  mocks.client.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => {
    const sent = mocks.write.mock.calls[0][0] as { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }
    return {
      hash,
      from: STORE,
      to: ACCOUNT,
      blockHash: BLOCK, blockNumber: 10n, transactionIndex: 0,
      input: encodeFunctionData({
        abi: SAFE_EXEC_ABI,
        functionName: 'execTransaction',
        args: [sent.address, 0n, data ?? encodeFunctionData(sent), 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'],
      }),
    }
  })
}

function mintReceipt(hash: Hex, options: { status?: 'success' | 'reverted'; logs?: object[] } = {}) {
  return {
    status: options.status ?? 'success', transactionHash: hash,
    from: mocks.safe ? STORE : ACCOUNT, to: mocks.safe ? ACCOUNT : HOOK,
    blockHash: BLOCK, blockNumber: 10n, transactionIndex: 0,
    logs: (options.logs ?? []).map(log => ({
      ...log, removed: false, transactionHash: hash,
      blockHash: BLOCK, blockNumber: 10n, transactionIndex: 0,
    })),
  }
}

describe('free mint gas', () => {
  it('wallet-action:mint-shop-tiers-without-payment sends the measured gas limit from an ordinary wallet', async () => {
    await mint()
    expect(mocks.review.mock.calls[0][0]).not.toHaveProperty('safeTxGas')
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'mintFor', gas: 200_000n }))
  })

  it('wallet-action:mint-shop-tiers-without-payment proposes through a Safe app with gas 0 and reviews it as Safe gas 0', async () => {
    mocks.safe = true
    // Safe{Wallet} executed at once and returned the execution's own hash; the
    // Safe's event names its safeTxHash.
    mocks.receipt.mockImplementation(async (_client: unknown, hash: Hex) => mintReceipt(hash, {
      logs: [{ address: ACCOUNT, topics: [EXECUTION_SUCCESS, SAFE_TX], data: `0x${'00'.repeat(32)}` }],
    }))
    executesSentMint()
    await mint()
    expect(mocks.review).toHaveBeenCalledWith(
      expect.objectContaining({ address: HOOK, functionName: 'mintFor', safeTxGas: 0n }),
      expect.objectContaining({ description: 'Choose the Safe nonce.', confirmLabel: 'Agree & continue to Safe' }),
    )
    // A Safe app signs the sent gas as safeTxGas.
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'mintFor', gas: 0n }))
    expect(mocks.waitSafe).toHaveBeenCalledWith(1, PROPOSAL, { signal: expect.any(AbortSignal) })
    expect(text()).toContain('Items minted')
  })

  it('reports a Safe execution that logged ExecutionFailure as a failed mint', async () => {
    mocks.safe = true
    // Safe{Wallet} executed at once and returned the execution's own hash; a
    // nonzero safeTxGas turned the failed mint into ExecutionFailure.
    mocks.receipt.mockImplementation(async (_client: unknown, hash: Hex) => mintReceipt(hash, {
      logs: [{ address: ACCOUNT, topics: [EXECUTION_FAILURE, SAFE_TX], data: `0x${'00'.repeat(32)}` }],
    }))
    executesSentMint()
    await mint()
    expect(text()).toContain('The mint failed.')
    expect(text()).not.toContain('Items minted')
  })

  it('does not report a mint Safe{Wallet} executed at once as minted when the execution ran another call', async () => {
    mocks.safe = true
    mocks.receipt.mockImplementation(async (_client: unknown, hash: Hex) => mintReceipt(hash, {
      logs: [{ address: ACCOUNT, topics: [EXECUTION_SUCCESS, SAFE_TX], data: `0x${'00'.repeat(32)}` }],
    }))
    executesSentMint('0xdeadbeef')
    await mint()
    expect(mocks.client.getTransaction).toHaveBeenCalledWith({ hash: PROPOSAL })
    expect(text()).toContain('Mint submitted')
    expect(text()).not.toContain('Items minted')
  })

  it("does not report a Safe app mint whose receipt doesn't show its proposal ran", async () => {
    mocks.safe = true
    mocks.receipt.mockImplementation(async (_client: unknown, hash: Hex) => mintReceipt(hash, {
      logs: [],
    }))
    await mint()
    expect(text()).toContain('Mint submitted')
    expect(text()).not.toContain('Items minted')
  })

  it.each([
    ['the Safe service cannot track the proposal', new Error("Safe’s transaction service has no record of this proposal.")],
    ['the wait ends', new DOMException('Safe execution wait aborted', 'AbortError')],
  ])('keeps a Safe app mint submitted, never offered again, when %s', async (_, ended) => {
    mocks.safe = true
    mocks.waitSafe.mockRejectedValue(ended)
    await mint()
    expect(text()).toContain('Mint submitted')
    expect(text()).not.toContain(ended.message)
    expect(mocks.receipt).not.toHaveBeenCalled()
    const actions = renderer.root.findAllByType('button').map(button => button.children.join(''))
    expect(actions).toContain('Done')
    expect(actions).not.toContain('Confirm mint')
    expect(mocks.write).toHaveBeenCalledOnce()
  })

  it("ends the wait for a Safe app mint's execution when the modal closes", async () => {
    mocks.safe = true
    let waiting: AbortSignal | undefined
    mocks.waitSafe.mockImplementation((_chainId: number, _hash: Hex, { signal }: { signal: AbortSignal }) => {
      waiting = signal
      return new Promise(() => {})
    })
    await mint()
    expect(waiting?.aborted).toBe(false)
    await act(async () => renderer.unmount())
    expect(waiting?.aborted).toBe(true)
    renderer = create(<p />)
  })

  it('refuses a connector replacement during the final mint eligibility read', async () => {
    const read = mocks.client.readContract.getMockImplementation()!
    let owners = 0
    mocks.client.readContract.mockImplementation(async request => {
      const result = await read(request)
      if (request.functionName === 'owner' && ++owners === 2) mocks.connectorUid = 'replacement-wallet'
      return result
    })
    await mint()
    expect(owners).toBeGreaterThanOrEqual(2)
    expect(mocks.write).not.toHaveBeenCalled()
    expect(text()).toContain('Connected wallet changed')
    expect(localStorage.length).toBe(0)
  })

  it('stops before the wallet when the Safe connection changes after review', async () => {
    mocks.review.mockImplementation(async () => {
      // A WalletConnect peer read lands mid-flow: the reviewed call was not a Safe proposal.
      mocks.safe = true
    })
    await mint()
    expect(mocks.write).not.toHaveBeenCalled()
    expect(text()).toContain('Wallet connection changed. Review the transaction again.')
  })
})
describe('free mint recovery', () => {
  it('keeps a lost wallet reply pending across changed quantities, remount, and storage reload', async () => {
    mocks.write.mockImplementation(async () => {
      expect(localStorage.length).toBe(1)
      throw new Error('wallet reply lost after broadcast')
    })
    await mint()
    expect(text()).toContain('Mint status unknown')
    expect(text()).toContain('including after reopening the page')
    expect(localStorage.length).toBe(1)
    await act(async () => {
      renderer.root.findAllByType('input')[1].props.onChange({ target: { value: '2' } })
    })
    await click('Check existing mint')
    expect(mocks.write).toHaveBeenCalledOnce()
    await act(async () => renderer.unmount())
    const key = localStorage.key(0)!
    const serialized = localStorage.getItem(key)!
    const reloaded = browserWriteRecoveryModel()
    reloaded.storage.setItem(key, serialized)
    vi.stubGlobal('localStorage', reloaded.storage)
    vi.stubGlobal('navigator', { locks: reloaded.locks })
    await openMint()
    await click('Mint without payment')
    expect(text()).toContain('Mint status unknown')
    expect(mocks.write).toHaveBeenCalledOnce()
    expect(mocks.review).toHaveBeenCalledOnce()
    expect(localStorage.getItem(key)).toBe(serialized)
  })

  it('resumes a saved hash with depleted inventory and clears only its canonical receipt', async () => {
    mocks.receipt.mockRejectedValueOnce(new Error('RPC unavailable'))
    await mint()
    expect(text()).toContain('Mint submitted')
    expect(localStorage.length).toBe(1)
    await act(async () => renderer.unmount())
    await openMint(0)
    await click('Mint without payment')
    expect(text()).toContain('Items minted')
    expect(mocks.write).toHaveBeenCalledOnce()
    expect(mocks.review).toHaveBeenCalledOnce()
    expect(localStorage.length).toBe(0)
  })

  it('retains a hash whose receipt is no longer canonical, then rechecks it without sending', async () => {
    mocks.client.getBlock.mockResolvedValue({ hash: SAFE_TX, number: 10n, timestamp: 1n })
    await mint()
    expect(text()).toContain('Mint submitted')
    expect(localStorage.length).toBe(1)
    mocks.client.getBlock.mockResolvedValue({ hash: BLOCK, number: 10n, timestamp: 1n })
    await click('Check existing mint')
    expect(text()).toContain('Items minted')
    expect(mocks.write).toHaveBeenCalledOnce()
    expect(localStorage.length).toBe(0)
  })

  it('holds an unfinalized failure and permits retry only after a finalized failure', async () => {
    mocks.receipt.mockImplementation(async (_client: unknown, hash: Hex) => mintReceipt(hash, { status: 'reverted' }))
    mocks.client.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber?: bigint }) => ({
      hash: BLOCK, number: blockNumber ?? 9n, timestamp: 1n,
    }))
    await mint()
    expect(text()).toContain('Mint submitted')
    expect(localStorage.length).toBe(1)
    mocks.client.getBlock.mockResolvedValue({ hash: BLOCK, number: 10n, timestamp: 1n })
    await click('Check existing mint')
    expect(text()).toContain('The mint failed.')
    expect(mocks.write).toHaveBeenCalledOnce()
    expect(localStorage.length).toBe(0)
  })

  it('clears explicit wallet rejection and permits another reviewed attempt', async () => {
    mocks.write.mockRejectedValueOnce(Object.assign(new Error('User rejected'), { code: 4001 }))
    await mint()
    expect(localStorage.length).toBe(0)
    await click('Confirm mint')
    expect(mocks.write).toHaveBeenCalledTimes(2)
    expect(text()).toContain('Items minted')
  })

  it.each(['missing storage', 'failed persistence', 'missing locks'])('refuses a wallet write with %s', async failure => {
    if (failure === 'missing storage') vi.stubGlobal('localStorage', undefined)
    if (failure === 'missing locks') vi.stubGlobal('navigator', {})
    if (failure === 'failed persistence') vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota exceeded') })
    await openMint()
    await click('Mint without payment')
    if (renderer.root.findAllByType('button').some(button => button.children.join('') === 'Confirm mint')) {
      await click('Confirm mint')
    }
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('retains the known hash when saving it fails and retries persistence before tracking', async () => {
    const setItem = localStorage.setItem.bind(localStorage)
    const storageWrite = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (JSON.parse(value).hash) throw new Error('storage temporarily full')
      setItem(key, value)
    })
    await mint()
    expect(text()).toContain('Mint submitted')
    expect(JSON.parse(localStorage.getItem(localStorage.key(0)!)!).hash).toBeUndefined()
    expect(mocks.receipt).not.toHaveBeenCalled()
    storageWrite.mockRestore()
    await click('Check existing mint')
    expect(text()).toContain('Items minted')
    expect(mocks.write).toHaveBeenCalledOnce()
    expect(localStorage.length).toBe(0)
  })

  it('reattaches a late hash from SDK memory after failed persistence and remount', async () => {
    let broadcast!: (hash: Hex) => void
    mocks.write.mockImplementation(() => new Promise<Hex>(resolve => { broadcast = resolve }))
    await mint()
    await act(async () => renderer.unmount())
    const storageWrite = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage temporarily full')
    })
    await act(async () => { broadcast(PROPOSAL) })
    expect(JSON.parse(localStorage.getItem(localStorage.key(0)!)!).hash).toBeUndefined()
    storageWrite.mockRestore()
    await openMint()
    await click('Mint without payment')
    expect(text()).toContain('Items minted')
    expect(mocks.write).toHaveBeenCalledOnce()
    expect(localStorage.length).toBe(0)
  })

  it('persists a hash returned after unmount and resumes it from the next modal', async () => {
    let broadcast!: (hash: Hex) => void
    mocks.write.mockImplementation(() => new Promise<Hex>(resolve => { broadcast = resolve }))
    await mint()
    expect(localStorage.length).toBe(1)
    await act(async () => renderer.unmount())
    await act(async () => { broadcast(PROPOSAL) })
    expect(JSON.parse(localStorage.getItem(localStorage.key(0)!)!).hash).toBe(PROPOSAL)
    await openMint()
    await click('Mint without payment')
    expect(text()).toContain('Items minted')
    expect(mocks.write).toHaveBeenCalledOnce()
    expect(localStorage.length).toBe(0)
  })

  it('does not send after the modal unmounts while transaction review is open', async () => {
    let finishReview!: () => void
    mocks.review.mockImplementation(() => new Promise<void>(resolve => { finishReview = resolve }))
    await mint()
    expect(mocks.review).toHaveBeenCalledOnce()
    await act(async () => renderer.unmount())
    await act(async () => { finishReview() })
    expect(mocks.write).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
    renderer = create(<p />)
  })
})

function text(): string {
  return JSON.stringify(renderer.toJSON())
}
