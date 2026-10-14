import { describe, expect, it, vi } from 'vitest'
import type { Address, Hex } from 'viem'
import { createWriteHold, launchIntent, intent } from '@bananapus/nana-sdk-core/review'
import { launchHold, launchResumeGate, recoverSavedLaunch } from '@/lib/launch-hold'
import { modelNode } from '../support/chain-node'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const DEPLOYER = '0x2222222222222222222222222222222222222222' as Address
const SALT = `0x${'5a'.repeat(32)}` as Hex
const call = { to: DEPLOYER, data: '0x1234' as Hex, value: 7n }
const client = {
  getChainId: async () => 10,
  getBlockNumber: async () => 100n,
  getTransactionCount: async () => 3,
  getTransaction: async () => { throw Object.assign(new Error('not found'), { name: 'TransactionNotFoundError' }) },
  getTransactionReceipt: async () => null,
  getBlock: async () => ({ number: 100n, hash: `0x${'aa'.repeat(32)}`, timestamp: 1n }),
  request: async () => null,
}
const launch = { chainId: 10, account: ALICE, safe: false, salt: SALT, projectUri: 'ipfs://launch', call }

describe('a launch under the write hold', () => {
  it('is keyed by the SDK launchIntent of its frozen launch', () => {
    const hold = launchHold(launch)
    expect(hold.peek().status).toBe('clear')
    expect(launchIntent({ chainId: 10, account: ALICE, config: { salt: intent.hex(SALT), projectUri: 'ipfs://launch' } }))
      .toMatch(/^intent:launch/)
  })

  it('gives a lost-reply launch the warned exit, never a permanent refusal, and sends again only after it', async () => {
    const hold = launchHold(launch)
    // The wallet may have sent it without saying so.
    await hold.send(client as never, async gate => { await gate.beforeSend(); throw new Error('wallet transport disconnected') }).catch(() => null)
    const resumed = { phase: 'pending' as const, unverifiedSend: true as const, held: true as const }
    const gate = await launchResumeGate(hold, client as never, resumed)
    expect(gate).toMatchObject({ kind: 'held', state: { exit: true } })
    if (gate.kind !== 'held') throw new Error('held')
    await expect(hold.exit(gate.state, { checkedWallet: true }, client as never)).resolves.toMatchObject({ released: true })
    // The exit, recorded in the journal (its submission retired), is what permits the send.
    expect(await launchResumeGate(hold, client as never, { phase: 'failed' })).toEqual({ kind: 'send' })
    // A journal that still says the request may be out asks for the check: a missing record is no proof.
    expect(await launchResumeGate(hold, client as never, resumed)).toEqual({ kind: 'unverified' })
  })

  it('never takes a missing hold record as permission to send a submission the journal held', async () => {
    const hold = launchHold({ ...launch, projectUri: 'ipfs://no-record' })
    expect(await launchResumeGate(hold, client as never, { phase: 'pending', unverifiedSend: true, held: true }))
      .toEqual({ kind: 'unverified' })
  })

  it('offers an explicit check for a launch an earlier release left unverified with no hold of its own', async () => {
    const hold = launchHold({ ...launch, projectUri: 'ipfs://older' })
    expect(await launchResumeGate(hold, client as never, { phase: 'pending', unverifiedSend: true }))
      .toEqual({ kind: 'unverified' })
  })

  it('lets only one of two tabs resuming the same launch reach the wallet', async () => {
    const [first, second] = [createWriteHold(), createWriteHold()]
    const namespace = launchIntent({ chainId: 10, account: ALICE, config: { salt: intent.hex(SALT), projectUri: 'ipfs://twice' } })
    const open = (holds: typeof first) => holds.open({ chainId: 10, account: ALICE, safe: false, call, namespace })
    let wallet = 0
    let reply!: (hash: Hex) => void
    const sending = open(first).send(client as never, async gate => {
      await gate.beforeSend()
      wallet += 1
      const hash = await new Promise<Hex>(resolve => (reply = resolve))
      gate.afterSubmit(hash)
      return hash
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    await expect(open(second).send(client as never, async gate => {
      await gate.beforeSend()
      wallet += 1
      return `0x${'cd'.repeat(32)}` as Hex
    })).rejects.toThrow()
    reply(`0x${'ab'.repeat(32)}`)
    await sending
    expect(wallet).toBe(1)
    first.dispose()
    second.dispose()
  })
})

describe('a saved launch recovered through its hold (the shared recovery rule)', () => {
  const HASH = `0x${'ab'.repeat(32)}` as Hex
  const SAFE_TX = `0x${'cd'.repeat(32)}` as Hex
  const BLOCK = `0x${'b1'.repeat(32)}` as Hex
  /** A node that knows `known` hashes as mined in its canonical block, with a successful receipt; none else. */
  function node(known: readonly Hex[] = []) {
    const answer = {
      getTransaction: vi.fn(async ({ hash }: { hash: Hex }) => {
        if (!known.includes(hash)) throw Object.assign(new Error('not found'), { name: 'TransactionNotFoundError' })
        return { hash, chainId: 10, from: ALICE, to: DEPLOYER, input: call.data, value: call.value, nonce: 3, ...mined.minedAt }
      }),
      getTransactionReceipt: vi.fn(),
      getBlock: vi.fn(),
      getBlockNumber: vi.fn(),
      request: async () => null,
    }
    const mined = modelNode(answer, { chainId: () => 10, blockHash: BLOCK })
    mined.receiptsAre(hash => ({ transactionHash: hash, status: 'success', logs: [] }))
    answer.getTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => {
      if (!known.includes(hash)) throw Object.assign(new Error('missing'), { name: 'TransactionReceiptNotFoundError' })
      return { transactionHash: hash, status: 'success', logs: [], blockHash: BLOCK, blockNumber: 1n, transactionIndex: 0, from: ALICE, to: DEPLOYER }
    })
    return answer
  }

  it('follows a launch the hold settled while the page was closed, never sending it again', async () => {
    const chain = node([HASH])
    const hold = launchHold({ ...launch, projectUri: 'ipfs://settled' })
    await hold.send(chain as never, async gate => { await gate.beforeSend(); gate.afterSubmit(HASH); return HASH })
    await hold.state(chain as never)
    expect(await recoverSavedLaunch(hold, chain as never, { hash: HASH })).toEqual({ kind: 'settled', hash: HASH })
  })

  it('adopts a hash saved by the last release with no hold, and offers the warned exit once it is past the window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const chain = node()
      const hold = launchHold({ ...launch, projectUri: 'ipfs://main-era' })
      const first = await recoverSavedLaunch(hold, chain as never, { hash: HASH })
      expect(first).toMatchObject({ kind: 'held', state: { exit: false } })
      vi.setSystemTime(Date.now() + 31 * 60_000)
      expect(await recoverSavedLaunch(hold, chain as never, { hash: HASH })).toMatchObject({ kind: 'held', state: { exit: true } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives a Safe launch it cannot authenticate the exit, never an error that ends recovery', async () => {
    const chain = node()
    const hold = launchHold({ ...launch, safe: true, projectUri: 'ipfs://safe' })
    const recovered = await recoverSavedLaunch(hold, chain as never, { safeTxHash: SAFE_TX }, async () => null)
    expect(recovered).toMatchObject({ kind: 'held', state: { exit: true } })
  })

  it('holds a launch whose hash the hold saved before a reload, though the journal saved none', async () => {
    const chain = node()
    const hold = launchHold({ ...launch, projectUri: 'ipfs://reload' })
    // The wallet answered and the hold saved its hash; the page reloaded before the journal did.
    await hold.send(chain as never, async gate => { await gate.beforeSend(); gate.afterSubmit(HASH); return HASH })
    expect(await launchResumeGate(hold, chain as never, { phase: 'pending', unverifiedSend: true, held: true }))
      .toMatchObject({ kind: 'held', state: { status: 'pending-known-hash', exit: false } })
  })

  it('asks for an explicit check when the hold itself cannot be read', async () => {
    const hold = launchHold({ ...launch, projectUri: 'ipfs://unreadable' })
    const broken = { ...client, getChainId: async () => { throw new Error('node down') } }
    const recovered = await recoverSavedLaunch({ ...hold, state: async () => { throw new Error('node down') } } as never, broken as never, { hash: HASH })
    expect(recovered).toMatchObject({ kind: 'check' })
  })
})

