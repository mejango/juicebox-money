import type { ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { encodeFunctionData, toEventSelector, TransactionNotFoundError, zeroAddress, type Abi, type Address, type Hex } from 'viem'
import { SAFE_EXEC_ABI } from '@bananapus/nana-sdk-core/safe-service'
import { WRITE_HOLD_IN_TAB_LINE } from '@bananapus/nana-sdk-core/review'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  safe: false,
  connectorUid: 'reviewed-wallet',
  review: vi.fn(),
  write: vi.fn(),
  waitSafe: vi.fn(),
  receipt: vi.fn(),
  shop: vi.fn(),
  client: {
    readContract: vi.fn(), simulateContract: vi.fn(), estimateContractGas: vi.fn(), getTransaction: vi.fn(),
    getChainId: vi.fn(async () => 1),
    getTransactionReceipt: vi.fn(async (_args: { hash: `0x${string}` }): Promise<unknown> => null),
    // The account's next nonce, read before the wallet opens.
    getBlockNumber: vi.fn(async () => 100n),
    getTransactionCount: vi.fn(async () => 0),
  },
}))

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const HOOK = '0x2222222222222222222222222222222222222222' as Address
const STORE = '0x3333333333333333333333333333333333333333' as Address
const PROPOSAL = `0x${'ab'.repeat(32)}` as Hex
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
  TxConfirmDialog: ({ onConfirm, onClose, title, error, complete }: {
    onConfirm: () => void; onClose: () => void; title: string; error?: string | null; complete?: boolean
  }) => (
    <div>
      <p>{title}</p>
      {error ? <p>{error}</p> : null}
      {complete
        ? <button type="button" onClick={onClose}>Done</button>
        : <button type="button" onClick={onConfirm}>Confirm mint</button>}
    </div>
  ),
}))
vi.mock('@bananapus/nana-sdk-core/v6', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core/v6')>()),
  getProjectNftInventory: mocks.shop,
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

async function mint() {
  await act(async () => {
    renderer = create(
      <MintShopItemModal chainId={1} projectId={7} hook={HOOK} tierId={1} itemName="Hat"
        remaining={5} isRevnet={false} onClose={vi.fn()} />,
    )
  })
  await click('Mint without payment')
  await click('Confirm mint')
}

beforeEach(() => {
  mocks.safe = false
  mocks.connectorUid = 'reviewed-wallet'
  mocks.review.mockReset().mockResolvedValue(undefined)
  mocks.write.mockReset().mockResolvedValue(PROPOSAL)
  mocks.waitSafe.mockReset().mockResolvedValue(PROPOSAL)
  mocks.receipt.mockReset().mockImplementation(async (_client: unknown, hash: Hex) => mined({
    status: 'success',
    transactionHash: hash,
    logs: [],
  }))
  // One node: a hash it shows as a transaction has the receipt its watcher reads, in canonical block 7.
  mocks.client.getTransactionReceipt.mockReset().mockImplementation(async ({ hash }: { hash: Hex }) => {
    const known = await mocks.client.getTransaction({ hash }).then(() => true, () => false)
    return known ? mocks.receipt(mocks.client, hash) : null
  })
  ;(mocks.client as Record<string, unknown>).getBlock = vi.fn(async (args: { blockTag?: string; blockNumber?: bigint } = {}) =>
    args.blockTag === 'finalized'
      ? { number: 100n, hash: `0x${'44'.repeat(32)}`, timestamp: 1n }
      : { number: args.blockNumber ?? 8n, hash: args.blockNumber === 7n ? BLOCK : `0x${'66'.repeat(32)}` })
  mocks.shop.mockReset().mockResolvedValue({ hook: HOOK })
  mocks.client.readContract.mockReset().mockImplementation(async ({ functionName }: { functionName: string }) =>
    functionName === 'owner' ? ACCOUNT
      : functionName === 'STORE' ? STORE
        : { id: 1n, flags: { allowOwnerMint: true }, remainingSupply: 5 })
  mocks.client.simulateContract.mockReset().mockImplementation(async (request: object) => ({ request }))
  mocks.client.estimateContractGas.mockReset().mockResolvedValue(100_000n)
  // A safeTxHash is no transaction; a test that executes one says so.
  mocks.client.getTransaction.mockReset().mockImplementation(async ({ hash }: { hash: Hex }) => { throw new TransactionNotFoundError({ hash }) })
})

afterEach(async () => { await act(async () => renderer.unmount()) })

const BLOCK = `0x${'77'.repeat(32)}` as Hex
/** A receipt as the node shows it, in canonical block 7, its logs bound to it. */
function mined(receipt: { status: string; transactionHash: Hex; logs: { address: Address; topics: Hex[]; data: Hex }[] }) {
  const at = { blockHash: BLOCK, blockNumber: 7n, transactionIndex: 0 }
  return {
    ...receipt, ...at, from: STORE, to: ACCOUNT,
    logs: receipt.logs.map(log => ({ ...log, ...at, removed: false, transactionHash: receipt.transactionHash })),
  }
}

/** The Safe's execTransaction of the mint the wallet was asked to send, or of `data` in its place. */
function executesSentMint(data?: Hex) {
  mocks.client.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => {
    const sent = mocks.write.mock.calls[0][0] as { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }
    return {
      hash,
      chainId: 1,
      blockHash: BLOCK,
      blockNumber: 7n,
      transactionIndex: 0,
      from: STORE,
      to: ACCOUNT,
      input: encodeFunctionData({
        abi: SAFE_EXEC_ABI,
        functionName: 'execTransaction',
        args: [sent.address, 0n, data ?? encodeFunctionData(sent), 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'],
      }),
    }
  })
}


describe('a free mint held by the write hold', () => {
  it('says minted only once the write hold settles the receipt, never from a receipt the chain does not show canonical', async () => {
    const SENT = `0x${'cd'.repeat(32)}` as Hex
    mocks.write.mockResolvedValueOnce(SENT)
    mocks.client.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => ({
      hash, chainId: 1, from: ACCOUNT, to: HOOK, input: '0x', value: 0n, nonce: 0, blockHash: BLOCK, blockNumber: 7n, transactionIndex: 0,
    }))
    ;(mocks.client as Record<string, unknown>).getBlock = vi.fn(async (args: { blockTag?: string; blockNumber?: bigint } = {}) =>
      args.blockTag === 'finalized' ? { number: 100n, hash: `0x${'44'.repeat(32)}`, timestamp: 1n } : { number: args.blockNumber, hash: `0x${'66'.repeat(32)}` })
    await mint()
    expect(mocks.write).toHaveBeenCalledOnce()
    expect(text()).not.toContain('Items minted')
  })

  it('shows the exit once it becomes due after a receipt timeout, without reopening, and accepting it mints exactly once more', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    try {
      // The wallet returns a hash the network never sees, and its receipt watch times out.
      mocks.write.mockResolvedValueOnce(`0x${'cd'.repeat(32)}`)
      mocks.client.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => { throw new TransactionNotFoundError({ hash }) })
      mocks.receipt.mockRejectedValueOnce(new Error('The receipt could not be read in time.'))
      await mint()
      expect(mocks.write).toHaveBeenCalledOnce()
      expect(JSON.stringify(renderer.toJSON())).toContain('Still pending in your wallet.')
      expect(JSON.stringify(renderer.toJSON())).not.toContain('I checked my wallet. Send again')

      vi.setSystemTime(Date.now() + 31 * 60_000)
      await act(async () => { vi.advanceTimersByTime(60_000) })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      expect(JSON.stringify(renderer.toJSON())).toContain('I checked my wallet. Send again')
      await click('I checked my wallet. Send again')
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      expect(mocks.write).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('offers the exit when a proposed mint can no longer be followed, and accepting it proposes exactly once more', async () => {
    mocks.safe = true
    mocks.waitSafe.mockRejectedValueOnce(new Error('Safe service unavailable'))
    await mint()
    expect(mocks.write).toHaveBeenCalledOnce()
    const shown = JSON.stringify(renderer.toJSON())
    expect(shown).toContain("This Safe transaction couldn't be confirmed here. Check your Safe, then send again.")
    expect(shown).toContain('I checked my wallet. Send again')
    await click('I checked my wallet. Send again')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(mocks.write).toHaveBeenCalledTimes(2)
  })

  it('sends nothing on a second click after a lost wallet reply, across closing the modal, and shows the held line with its exit', async () => {
    mocks.write.mockRejectedValueOnce(new Error('wallet transport disconnected'))
    await mint()
    expect(mocks.write).toHaveBeenCalledOnce()
    await act(async () => renderer.unmount())

    await mint()
    expect(mocks.write).toHaveBeenCalledOnce()
    const shown = JSON.stringify(renderer.toJSON())
    expect(shown).toContain("Your earlier transaction hasn't confirmed yet. Check your wallet.")
    expect(shown).toContain('I checked my wallet. Send again')

    // The user checked their wallet: the same mint is sent again, once.
    await click('I checked my wallet. Send again')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(mocks.write).toHaveBeenCalledTimes(2)
  })
})

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
    mocks.receipt.mockImplementation(async (_client: unknown, hash: Hex) => mined({
      status: 'success',
      transactionHash: hash,
      logs: [{ address: ACCOUNT, topics: [EXECUTION_SUCCESS, SAFE_TX], data: `0x${'00'.repeat(32)}` }],
    }))
    executesSentMint()
    await mint()
    expect(mocks.review).toHaveBeenCalledWith(
      expect.objectContaining({ address: HOOK, functionName: 'mintFor', safeTxGas: 0n }),
      expect.objectContaining({ description: `Choose the Safe nonce.\n\n${WRITE_HOLD_IN_TAB_LINE}`, confirmLabel: 'Agree & continue to Safe' }),
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
    mocks.receipt.mockImplementation(async (_client: unknown, hash: Hex) => mined({
      status: 'success',
      transactionHash: hash,
      logs: [{ address: ACCOUNT, topics: [EXECUTION_FAILURE, SAFE_TX], data: `0x${'00'.repeat(32)}` }],
    }))
    executesSentMint()
    await mint()
    expect(text()).toContain('The mint failed.')
    expect(text()).not.toContain('Items minted')
  })

  it('does not report a mint Safe{Wallet} executed at once as minted when the execution ran another call', async () => {
    mocks.safe = true
    mocks.receipt.mockImplementation(async (_client: unknown, hash: Hex) => mined({
      status: 'success',
      transactionHash: hash,
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
    mocks.receipt.mockImplementation(async (_client: unknown, hash: Hex) => mined({
      status: 'success',
      transactionHash: hash,
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
    // Held by the write hold: only its checked-wallet exit can propose it again.
    expect(actions).toContain('I checked my wallet. Send again')
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

function text(): string {
  return JSON.stringify(renderer.toJSON())
}
