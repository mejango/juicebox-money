import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { createWriteHold, launchIntent, intent } from '@bananapus/nana-sdk-core/review'
import { launchHold, launchResumeGate } from '@/lib/launch-hold'

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
    expect(await launchResumeGate(hold, client as never, resumed)).toEqual({ kind: 'send' })
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
