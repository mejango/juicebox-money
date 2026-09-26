import { jbContractAddress, type JBChainId } from '@bananapus/nana-sdk-core'
import { stickyDistributorAddress, v6Address } from '@bananapus/nana-sdk-core/v6'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  HttpRequestError,
  zeroAddress,
  type Address,
  type PublicClient,
} from 'viem'
import { describe, expect, it, vi } from 'vitest'

vi.mock('wagmi', async importOriginal => ({
  ...await importOriginal<typeof import('wagmi')>(),
  useReadContract: () => ({ data: 'STICKY' }),
  useConfig: () => ({ chains: [] }),
}))
vi.mock('@/hooks/useEnsName', () => ({ useEnsName: () => ({ data: null }) }))

import { newDraftSplit, splitOk, SplitsEditor, type DraftSplit } from '@/components/create/SplitsEditor'
import { combinedActivityParts, groupSameTxEvents } from '@/components/ActivityList'
import { SplitRecipient } from '@/components/project/SplitRecipient'
import { splitToDraft } from '@/components/project/EditSplitsFlow'
import { describeSplitGroups } from '@/components/TransactionReviewDialog'
import type { BsActivityEvent } from '@/lib/bendystraw'
import { parseDraft } from '@/lib/draft'
import { draftSplitRecipient } from '@/lib/split-recipient'
import { STICKY_RESERVED_NEEDS_ERC20, isStickyHook, stickyNoErc20Reason } from '@/lib/sticky'
import { checkStickyToken, stickyDestinationProblem, stickySplitsProblem } from '@/lib/sticky-check'

const CHAIN = 84532 as JBChainId
const OTHER_CHAIN = 11155111 as JBChainId
const TOKEN = '0x5ca1ab1e00000000000000000000000000005ca1' as Address
const DISTRIBUTOR = stickyDistributorAddress(CHAIN)
const STICKY_HOOK = jbContractAddress['6'].StickyHook[CHAIN] as Address

function stickyRow(patch: Partial<DraftSplit> = {}): DraftSplit {
  return {
    ...newDraftSplit(),
    value: '10',
    kind: 'hook',
    hookKind: 'sticky',
    beneficiary: TOKEN,
    stickyGroup: 'tenure',
    stickyMinWeeks: '4',
    stickyMaxWeeks: '52',
    ...patch,
  }
}

/** A chain whose Sticky hook tracks `registered` for project 9, and whose project 7 has `erc20`. */
function chainClient({
  registered = TOKEN as Address | null,
  projectIdRead = 'ok' as 'ok' | 'revert' | 'down',
  erc20 = TOKEN as Address | null,
} = {}): PublicClient {
  return {
    readContract: vi.fn(async ({ address, functionName }: { address: Address; functionName: string }) => {
      if (functionName === 'PROJECT_ID') {
        if (projectIdRead === 'revert') {
          throw new ContractFunctionExecutionError(
            new ContractFunctionRevertedError({ abi: [], functionName: 'PROJECT_ID' }),
            { abi: [], functionName: 'PROJECT_ID' },
          )
        }
        if (projectIdRead === 'down') throw new HttpRequestError({ url: 'https://rpc.test' })
        return 9n
      }
      if (functionName === 'tokenOf' && address.toLowerCase() === STICKY_HOOK.toLowerCase()) {
        return registered ?? zeroAddress
      }
      if (functionName === 'tokenOf') return erc20 ?? zeroAddress
      if (functionName === 'symbol') return 'STICKY'
      throw new Error(`unexpected read ${functionName}`)
    }),
  } as unknown as PublicClient
}

describe('Sticky split encoding', () => {
  it('encodes the distributor, the token, and the tenure group', () => {
    expect(draftSplitRecipient(stickyRow(), CHAIN)).toEqual({
      projectId: 4052n,
      beneficiary: TOKEN,
      preferAddToBalance: false,
      lockedUntil: 0,
      hook: DISTRIBUTOR,
    })
    expect(draftSplitRecipient(stickyRow({ stickyGroup: 'all' }), CHAIN).projectId).toBe(0n)
    expect(draftSplitRecipient(stickyRow({ stickyMaxWeeks: '' }), CHAIN).projectId).toBe(4000n)
  })

  it('decodes a live Sticky split back into the same row', () => {
    const encoded = { percent: 100_000_000, ...draftSplitRecipient(stickyRow(), CHAIN) }
    const row = splitToDraft(encoded, CHAIN)
    expect(row).toMatchObject({
      kind: 'hook',
      hookKind: 'sticky',
      value: '10',
      beneficiary: TOKEN,
      stickyGroup: 'tenure',
      stickyMinWeeks: '4',
      stickyMaxWeeks: '52',
    })
    expect(draftSplitRecipient(row, CHAIN)).toEqual(draftSplitRecipient(stickyRow(), CHAIN))
    // Group 0 is every holder.
    expect(splitToDraft({ ...encoded, projectId: 0n }, CHAIN).stickyGroup).toBe('all')
  })

  it('keeps an unrelated hook as a custom hook row', () => {
    const row = splitToDraft(
      { percent: 1, projectId: 4052n, beneficiary: TOKEN, preferAddToBalance: false, lockedUntil: 0, hook: TOKEN },
      CHAIN,
    )
    expect(row.kind).toBe('hook')
    expect(row.hookKind).toBe('custom')
    expect(isStickyHook(TOKEN, CHAIN)).toBe(false)
    expect(isStickyHook(DISTRIBUTOR, CHAIN)).toBe(true)
  })

  it('rejects rows the distributor would not honor', () => {
    expect(splitOk(stickyRow(), 'percent')).toBe(true)
    expect(splitOk(stickyRow({ beneficiary: '' }), 'percent')).toBe(false)
    expect(splitOk(stickyRow({ stickyMinWeeks: '0' }), 'percent')).toBe(false)
    expect(splitOk(stickyRow({ stickyMinWeeks: '521', stickyMaxWeeks: '' }), 'percent')).toBe(false)
    expect(splitOk(stickyRow({ stickyMaxWeeks: '3' }), 'percent')).toBe(false)
    // 600 would carry into the minimum if it were encoded.
    expect(splitOk(stickyRow({ stickyMaxWeeks: '600' }), 'percent')).toBe(false)
  })

  it('survives a .jb draft round trip instead of collapsing to an address', () => {
    const draft = parseDraft(JSON.stringify({ name: 'Sticky', chains: [CHAIN], stages: [{ reservedSplits: [stickyRow()] }] }))
    expect(draft.stages[0].reservedSplits[0]).toMatchObject({
      kind: 'hook',
      hookKind: 'sticky',
      beneficiary: TOKEN,
      stickyGroup: 'tenure',
      stickyMinWeeks: '4',
      stickyMaxWeeks: '52',
    })
  })

  it('loads a draft saved with the old sticky kind as a Sticky hook row', () => {
    const { kind: _kind, hookKind: _hookKind, ...legacy } = stickyRow()
    const draft = parseDraft(JSON.stringify({
      name: 'Sticky',
      chains: [CHAIN],
      stages: [{ reservedSplits: [{ ...legacy, kind: 'sticky' }] }],
      items: [{ name: 'Tee', splits: [{ ...legacy, kind: 'sticky', hookKind: 'fundmarket' }] }],
    }))
    const row = draft.stages[0].reservedSplits[0]
    expect(row).toMatchObject({ kind: 'hook', hookKind: 'sticky', beneficiary: TOKEN, stickyMinWeeks: '4' })
    expect(draftSplitRecipient(row, CHAIN)).toEqual(draftSplitRecipient(stickyRow(), CHAIN))
    expect(draft.items[0].splits[0]).toMatchObject({ kind: 'hook', hookKind: 'sticky' })
  })
})

describe('Sticky split validation', () => {
  it('accepts a registered token and reads its symbol', async () => {
    expect(await checkStickyToken(chainClient(), CHAIN, TOKEN)).toEqual({ ok: true, symbol: 'STICKY' })
  })

  it('rejects a token the Sticky hook does not track', async () => {
    const other = '0x0000000000000000000000000000000000000abc' as Address
    expect(await checkStickyToken(chainClient({ registered: other }), CHAIN, TOKEN)).toEqual({
      ok: false,
      reason: '0x5ca1…5ca1 is not a Sticky token on Base Sepolia.',
    })
  })

  it('rejects a contract without PROJECT_ID, and says so apart from a failed read', async () => {
    expect(await checkStickyToken(chainClient({ projectIdRead: 'revert' }), CHAIN, TOKEN)).toMatchObject({
      reason: '0x5ca1…5ca1 is not a Sticky token on Base Sepolia.',
    })
    expect(await checkStickyToken(chainClient({ projectIdRead: 'down' }), CHAIN, TOKEN)).toMatchObject({
      reason: 'Could not check the Sticky token on Base Sepolia.',
    })
  })

  it('checks every target chain and names the one that fails', async () => {
    const clients: Record<number, PublicClient> = {
      [CHAIN]: chainClient(),
      [OTHER_CHAIN]: chainClient({ registered: null }),
    }
    const problem = await stickySplitsProblem(
      [{ beneficiary: TOKEN, projectId: 4052n }],
      [CHAIN, OTHER_CHAIN],
      chainId => clients[chainId],
    )
    expect(problem).toBe('0x5ca1…5ca1 is not a Sticky token on Sepolia.')
  })

  it('rejects an invalid group before reading anything', async () => {
    const client = chainClient()
    expect(
      await stickySplitsProblem([{ beneficiary: TOKEN, projectId: 3n }], [CHAIN], () => client),
    ).toBe('Tenure groups need a minimum of at least 1 week.')
    expect(client.readContract).not.toHaveBeenCalled()
  })

  it('blocks reserved Sticky splits until the project has an ERC-20', async () => {
    const splits = [{ beneficiary: TOKEN, projectId: 0n }]
    const noErc20 = chainClient({ erc20: null })
    expect(
      await stickyDestinationProblem({ client: noErc20, chainId: CHAIN, projectId: 7, reserved: true, splits }),
    ).toBe(stickyNoErc20Reason(CHAIN))
    // Payouts pay in the terminal token, so the ERC-20 does not matter.
    expect(
      await stickyDestinationProblem({ client: noErc20, chainId: CHAIN, projectId: 7, reserved: false, splits }),
    ).toBeNull()
    expect(
      await stickyDestinationProblem({ client: chainClient(), chainId: CHAIN, projectId: 7, reserved: true, splits }),
    ).toBeNull()
    expect(
      await stickyDestinationProblem({ client: noErc20, chainId: CHAIN, projectId: 7, reserved: true, splits: [] }),
    ).toBeNull()
    expect(v6Address('JBTokens', CHAIN)).not.toBe(STICKY_HOOK)
  })
})

describe('Sticky split editor', () => {
  const render = (props: Partial<Parameters<typeof SplitsEditor>[0]>) =>
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <SplitsEditor splits={[stickyRow()]} onChange={() => {}} disabled={false} bucketLabel="payouts" chainIds={[CHAIN]} {...props} />
      </QueryClientProvider>,
    )
  const hookRow = { ...newDraftSplit(), kind: 'hook' as const, hookKind: 'custom' as const }
  const kindOptions = (html: string) =>
    html.match(/aria-label="Recipient type"[^>]*>(.*?)<\/select>/)![1]
  const hookOptions = (html: string) =>
    html.match(/aria-label="Hook type"[^>]*>(.*?)<\/select>/)?.[1] ?? ''

  it('lists Sticky as a hook type, never as a recipient type', () => {
    const html = render({ allowHook: true, allowSticky: true })
    expect(kindOptions(html)).not.toContain('Sticky')
    expect(kindOptions(html)).toContain('<option value="hook" selected="">Hook</option>')
    expect(hookOptions(html)).toContain('<option value="sticky" selected="">Sticky</option>')
    expect(html).toContain('aria-label="Sticky token"')
    expect(html).toContain('Holders stuck at least')
    expect(html).toContain('Sticky holders stuck 4 to 52 weeks → 0x5ca1…5ca1')
  })

  it('offers Sticky next to the Fund market on reserved splits that can pay it', () => {
    const html = render({ splits: [hookRow], allowHook: true, allowFundMarket: true, allowSticky: true })
    expect(hookOptions(html)).toContain('Fund market')
    expect(hookOptions(html)).toContain('<option value="sticky">Sticky</option>')
    expect(hookOptions(html)).toContain('Custom')
  })

  it('offers the Sticky hook on payouts, which have no Fund market', () => {
    const html = render({ splits: [hookRow], allowHook: true, allowSticky: true })
    expect(hookOptions(html)).toContain('<option value="sticky">Sticky</option>')
    expect(hookOptions(html)).not.toContain('Fund market')
  })

  it('hides Sticky on reserved splits without an ERC-20, and keeps an existing row with the reason', () => {
    const blocked = { allowHook: true, allowFundMarket: true, allowSticky: true, stickyBlocked: STICKY_RESERVED_NEEDS_ERC20 }
    expect(hookOptions(render({ ...blocked, splits: [hookRow] }))).not.toContain('Sticky')
    const html = render(blocked)
    expect(hookOptions(html)).toContain('<option value="sticky" selected="">Sticky</option>')
    expect(html).toContain(STICKY_RESERVED_NEEDS_ERC20)
    expect(html).not.toContain('aria-label="Sticky token"')
  })

  it('never offers Sticky where the distributor would reject the caller', () => {
    const html = render({ allowHook: true, allowSticky: false })
    expect(html).toContain('Sticky holders can only get payouts and reserved tokens.')
    expect(hookOptions(render({ allowHook: true, allowSticky: false, splits: [hookRow] }))).toBe('')
    expect(render({ allowSticky: false, splits: [newDraftSplit()] })).not.toContain('value="sticky"')
  })

  it('flags a Fund market row outside reserved splits', () => {
    const html = render({ allowHook: true, allowSticky: true, splits: [{ ...hookRow, hookKind: 'fundmarket' }] })
    expect(html).toContain('The Fund market only takes reserved tokens.')
  })
})

describe('Sticky split display', () => {
  const split = {
    percent: 250_000_000,
    projectId: 4052n,
    beneficiary: TOKEN,
    preferAddToBalance: false,
    lockedUntil: 0,
    hook: DISTRIBUTOR,
  }

  it('decodes setSplitGroupsOf calldata as Sticky holders, never a project', () => {
    const steps = describeSplitGroups(CHAIN, [{ groupId: 1n, splits: [split] }])!
    const text = steps.flatMap(step => step.rows.map(row => row.join('='))).join('\n')
    expect(text).toContain(`Sticky holders stuck 4 to 52 weeks → Sticky token ${TOKEN}`)
    expect(text).toContain(`via StickyDistributor ${DISTRIBUTOR}`)
    expect(text).not.toContain('project #4052')
  })

  it('renders the split recipient with the token symbol', () => {
    const html = renderToStaticMarkup(<SplitRecipient split={split} chainId={CHAIN} />)
    expect(html).toContain('Sticky holders stuck 4 to 52 weeks → STICKY')
    expect(html).not.toContain('Project #4052')
  })

  it('names Sticky holders in a reserved distribution row', () => {
    const base = { chainId: CHAIN, projectId: 6, timestamp: 1, from: '0xfrom', txHash: '0xreserved', payEvent: null, cashOutTokensEvent: null }
    const events = [
      { ...base, id: 'r', sendReservedTokensToSplitsEvent: { tokenCount: '1000000000000000000000', from: '0xfrom' } },
      {
        ...base,
        id: 's',
        sendReservedTokensToSplitEvent: {
          tokenCount: '1000000000000000000000',
          beneficiary: TOKEN,
          splitProjectId: 4052,
          hook: DISTRIBUTOR,
          from: '0xfrom',
        },
      },
    ] as unknown as BsActivityEvent[]
    const parts = combinedActivityParts(groupSameTxEvents(events)[0], 'ART')
    const text = parts.actions.map(action => renderToStaticMarkup(<>{action}</>)).join('\n')
    expect(text).toContain('Sticky holders stuck 4 to 52 weeks → STICKY')
    expect(text).not.toContain('project #4052')
  })
})
