import {
  decodeEventLog,
  formatUnits,
  numberToHex,
  parseAbi,
  type Address,
  type Hex,
} from 'viem'

// Kept identical in the three independently deployed clients. Simulation results are
// advisory estimates only; the existing transaction simulation/authorization remains mandatory.
const abi = parseAbi([
  'event Mint(uint256 indexed projectId,uint256 leftoverAmount,uint256 tokenCount,address caller)',
  'event Swap(uint256 indexed projectId,uint256 amountToSwapWith,bytes32 indexed poolId,uint256 amountReceived,address caller)',
  'event Pay(uint256 indexed rulesetId,uint256 indexed rulesetCycleNumber,uint256 indexed projectId,address payer,address beneficiary,uint256 amount,uint256 newlyIssuedTokenCount,string memo,bytes metadata,address caller)',
  'event MintTokens(address indexed beneficiary,uint256 indexed projectId,uint256 tokenCount,uint256 beneficiaryTokenCount,string memo,uint256 reservedPercent,address caller)',
])
export type Fee = {
  key: string
  projectId: bigint
  received: bigint
  route: 'fallback' | 'swap' | 'issuance' | 'unknown'
}
export type FeeResult = {
  status: 'none' | 'fallback' | 'ready' | 'unknown'
  fees: Fee[]
  block?: string
  checkedAt?: number
}
export type FeeCall = {
  from?: Address
  to: Address
  data: Hex
  value?: bigint
  gas?: bigint
}
export type FeeOptions = {
  trustedHooks: readonly string[]
  beneficiary: string
  terminals?: readonly string[]
  controllers?: readonly string[]
  feePayers?: readonly string[]
}
export type FeeRpc = { request: (args: never) => Promise<unknown> }
const unknownResult = (): FeeResult => ({ status: 'unknown', fees: [] })
const same = (a?: string, b?: string) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase()

/** Successful simulation logs include internal same-terminal fees that call traces cannot isolate. */
export function analyzeFeeSimulation(
  value: unknown,
  options: FeeOptions,
): FeeResult {
  if (!Array.isArray(value) || value.length !== 1) return unknownResult()
  const calls = value[0]?.calls
  if (
    !Array.isArray(calls) ||
    calls.length !== 1 ||
    calls[0]?.status !== '0x1' ||
    !Array.isArray(calls[0]?.logs) ||
    calls[0].logs.length > 20000
  )
    return unknownResult()
  const fees: Fee[] = []
  const active = new Map<
    string,
    { fee: Fee; hook?: string; mint: boolean; swap: boolean; sawSwap: boolean }
  >()
  const includes = (
    addresses: readonly string[] | undefined,
    address: string,
  ) => addresses?.some(a => same(a, address))
  try {
    for (const log of calls[0].logs) {
      let event
      try {
        event = decodeEventLog({
          abi,
          data: log.data as Hex,
          topics: log.topics as [Hex, ...Hex[]],
        })
      } catch {
        continue
      }
      const args = event.args
      if (event.eventName === 'Pay') {
        const a = event.args
        if (!includes(options.terminals, log.address)) continue
        const key = `${log.address.toLowerCase()}:${a.projectId}`
        // Every pay closes the prior scope for this project, even if unrelated.
        active.delete(key)
        if (
          !same(a.beneficiary, options.beneficiary) ||
          !includes(options.feePayers, a.payer) ||
          a.amount === 0n
        )
          continue
        const fee: Fee = {
          key: `${key}:${a.beneficiary.toLowerCase()}:${fees.length}`,
          projectId: a.projectId,
          received: a.newlyIssuedTokenCount,
          route: a.newlyIssuedTokenCount > 0n ? 'issuance' : 'unknown',
        }
        fees.push(fee)
        active.set(key, { fee, mint: false, swap: false, sawSwap: false })
      } else if (event.eventName === 'Mint' || event.eventName === 'Swap') {
        if (!includes(options.trustedHooks, log.address)) continue
        const state = active.get(
          `${args.caller.toLowerCase()}:${args.projectId}`,
        )
        if (!state || (state.hook && !same(state.hook, log.address))) continue
        state.hook = log.address
        if (event.eventName === 'Mint' && event.args.tokenCount > 0n)
          state.mint = true
        if (event.eventName === 'Swap') state.sawSwap = true
        if (event.eventName === 'Swap' && event.args.amountReceived > 0n)
          state.swap = true
      } else if (event.eventName === 'MintTokens') {
        if (
          !includes(options.controllers, log.address) ||
          !same(event.args.beneficiary, options.beneficiary)
        )
          continue
        const matches = [...active.entries()].filter(
          ([, s]) =>
            s.fee.projectId === event.args.projectId &&
            same(s.hook, event.args.caller),
        )
        if (matches.length !== 1) continue
        const [key, state] = matches[0]
        state.fee.received += event.args.beneficiaryTokenCount
        state.fee.route =
          state.fee.received === 0n
            ? 'issuance'
            : state.swap
              ? 'swap'
              : state.mint && state.sawSwap
                ? 'issuance'
                : state.mint
                  ? 'fallback'
                  : 'unknown'
        active.delete(key)
      }
    }
  } catch {
    return unknownResult()
  }
  // Ordinary issuance has no buyback Mint/Swap event and must not be called a fallback.
  return {
    status: fees.some(f => f.route === 'fallback')
      ? 'fallback'
      : fees.some(f => f.route === 'unknown')
        ? 'unknown'
        : fees.some(f => f.route === 'swap')
          ? 'ready'
          : 'none',
    fees,
  }
}

export async function checkFeeBuyback(
  client: FeeRpc,
  call: FeeCall,
  options: FeeOptions,
): Promise<FeeResult> {
  if (!call.from || !options.trustedHooks.length) return unknownResult()
  // Bound provider stalls; a stalled quote must not trap the confirmation dialog.
  const request = async (args: unknown) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        client.request(args as never),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Fee estimate timed out')),
            8000,
          )
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  try {
    const block = await request({ method: 'eth_blockNumber' })
    if (typeof block !== 'string' || !/^0x[0-9a-f]+$/i.test(block))
      return unknownResult()
    const simulation = await request({
      method: 'eth_simulateV1',
      params: [
        {
          blockStateCalls: [
            {
              calls: [
                {
                  from: call.from,
                  to: call.to,
                  data: call.data,
                  value: numberToHex(call.value ?? 0n),
                  gas: numberToHex(call.gas ?? 10000000n),
                },
              ],
            },
          ],
          validation: false,
        },
        block,
      ],
    })
    return {
      ...analyzeFeeSimulation(simulation, options),
      block,
      checkedAt: Date.now(),
    }
  } catch {
    return { ...unknownResult(), checkedAt: Date.now() }
  }
}

export function feeMessage(result: FeeResult): string {
  if (result.status === 'fallback')
    return 'Your fee would create tokens at the issuance rate. Wait for “Buyback ready” to use the pool rate.'
  if (result.status === 'ready')
    return 'Buyback ready — review and submit now. The rate may change before execution.'
  if (result.status === 'unknown')
    return 'Fee return unavailable. Retry now, or submit without an estimate.'
  return ''
}
export function feeReceipt(fee: Fee): string {
  const amount = formatUnits(fee.received, 18)
  const [whole, fraction] = amount.split('.')
  return `~${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? '.' + fraction.slice(0, 4) : ''} project #${fee.projectId} tokens`
}

/** One review owns one watcher. It never sends, and stale/closed reviews cannot approve. */
export function createFeeWatch(
  check: () => Promise<FeeResult>,
  changed: (result: FeeResult) => void,
) {
  let stopped = false
  let latest: FeeResult = unknownResult()
  let pending: Promise<FeeResult> | undefined
  const affected = new Set<string>()
  async function refresh(): Promise<FeeResult> {
    if (stopped) return unknownResult()
    if (pending) return pending
    pending = (async () => {
      let next: FeeResult
      try {
        next = await check()
      } catch {
        next = unknownResult()
      }
      if (stopped) return unknownResult()
      for (const fee of next.fees)
        if (fee.route === 'fallback') affected.add(fee.key)
      if (
        next.status !== 'fallback' &&
        [...affected].some(
          key =>
            !next.fees.some(fee => fee.key === key && fee.route === 'swap'),
        )
      )
        next = { ...next, status: 'unknown' }
      latest = next
      changed(next)
      return next
    })()
    try {
      return await pending
    } finally {
      pending = undefined
    }
  }
  return {
    refresh,
    async confirm() {
      if (stopped) return false
      const before = latest
      if (pending) await pending
      const fresh = await refresh()
      if (stopped) return false
      // A fresh degradation must be displayed before the user can elect to submit anyway.
      if (
        fresh.status === 'fallback' &&
        (before.status !== 'fallback' ||
          fresh.fees.some(
            fee =>
              fee.route === 'fallback' &&
              !before.fees.some(
                old => old.key === fee.key && old.route === 'fallback',
              ),
          ))
      )
        return false
      if (fresh.status === 'unknown' && before.status !== 'unknown')
        return false
      return true
    },
    stop() {
      stopped = true
    },
  }
}
