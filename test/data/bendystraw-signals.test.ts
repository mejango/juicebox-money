import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import {
  getAccountActivity,
  getPermissionHoldersAcrossDeployments,
  getProject,
  getProjectActivity,
  getProjectActivityByProject,
  getProjectPayers,
  getProjectsOwnedBy,
  getRevnetOperator,
  getSuckerGroupAddToBalance,
  getSuckerGroupMoments,
  getSuckerGroupProjects,
} from '@/lib/bendystraw'
import { fetchIndexedLpPositions, fetchIndexedPoolLiquidityEvents } from '@/lib/lp-positions-queries'
import { fetchPendingPayments } from '@/lib/pending-payments'
import { bindingsOf, findReaders, idOf, parse, SRC, sourcesUnder } from '../support/bendystraw-readers'

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * A fetch as the platform's behaves: a request whose signal has aborted is
 * never sent, and one under way stops when its signal aborts. With `answer`,
 * a request that is sent is answered at once.
 */
function network(answer?: () => Response) {
  const sent: string[] = []
  const fetcher = vi.fn<typeof fetch>((input, init) => {
    init?.signal?.throwIfAborted()
    sent.push(String(input))
    if (answer) return Promise.resolve(answer())
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    })
  })
  vi.stubGlobal('fetch', fetcher)
  return { fetcher, sent }
}

/** The readers the browser's code (src/components and src/hooks) uses, found from the source. */
function readersTheBrowserUses(): Set<string> {
  const readers = findReaders()
  const used = new Set<string>()
  for (const file of [...sourcesUnder(join(SRC, 'components')), ...sourcesUnder(join(SRC, 'hooks'))]) {
    const source = parse(file)
    const bindings = bindingsOf(source, file.path)
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && bindings.names.has(node.text) && !ts.isImportSpecifier(node.parent)) {
        const id = idOf(node, bindings)
        if (id && readers.has(id)) used.add(id)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return used
}

describe("a Bendystraw read's signal", () => {
  it('stops a server read under way, and does not retry it', async () => {
    const { fetcher } = network()
    const page = new AbortController()
    const read = getProject(8453, 11, { signal: page.signal }).catch((error: unknown) => error)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    const left = new Error('left the page')
    page.abort(left)

    expect(await read).toBe(left)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('stops a browser read under way, and does not retry it', async () => {
    vi.stubGlobal('window', {})
    const { fetcher } = network()
    const page = new AbortController()
    const read = getProject(8453, 11, { signal: page.signal }).catch((error: unknown) => error)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    expect(fetcher.mock.calls[0][0]).toBe('/api/bendystraw/mainnet/query')
    const left = new Error('left the page')
    page.abort(left)

    expect(await read).toBe(left)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  const ACCOUNT = '0x1111111111111111111111111111111111111111' as const
  const POOL = `0x${'ab'.repeat(32)}`
  const readers: [string, (signal: AbortSignal) => Promise<unknown>][] = [
    ['@/lib/bendystraw#getProject', signal => getProject(8453, 11, { signal })],
    ['@/lib/bendystraw#getSuckerGroupProjects', signal => getSuckerGroupProjects('group', 8453, { signal })],
    ['@/lib/bendystraw#getProjectActivity', signal => getProjectActivity('group', 20, 8453, 0, { signal })],
    ['@/lib/bendystraw#getProjectActivityByProject', signal => getProjectActivityByProject(8453, 11, 20, 0, { signal })],
    ['@/lib/bendystraw#getAccountActivity', signal => getAccountActivity(ACCOUNT, { signal })],
    ['@/lib/bendystraw#getProjectsOwnedBy', signal => getProjectsOwnedBy([ACCOUNT], { signal })],
    ['@/lib/bendystraw#getPermissionHoldersAcrossDeployments', signal =>
      getPermissionHoldersAcrossDeployments([{ chainId: 8453, projectId: 11, authority: ACCOUNT }], { signal })],
    ['@/lib/bendystraw#getRevnetOperator', signal => getRevnetOperator(8453, 11, { signal })],
    ['@/lib/bendystraw#getProjectPayers', signal => getProjectPayers([[8453, 11]], { signal })],
    ['@/lib/bendystraw#getSuckerGroupMoments', signal => getSuckerGroupMoments('group', { signal })],
    ['@/lib/bendystraw#getSuckerGroupAddToBalance', signal => getSuckerGroupAddToBalance('group', { signal })],
    ['@/lib/lp-positions-queries#fetchIndexedLpPositions', signal => fetchIndexedLpPositions({ chainId: 8453, poolId: POOL, signal })],
    ['@/lib/lp-positions-queries#fetchIndexedPoolLiquidityEvents', signal =>
      fetchIndexedPoolLiquidityEvents({ chainId: 8453, poolId: POOL, signal })],
    ['@/lib/pending-payments#fetchPendingPayments', signal => fetchPendingPayments(8453, 11, { signal })],
  ]

  it('covers every reader the browser uses', () => {
    expect(readers.map(([id]) => id).sort()).toEqual([...readersTheBrowserUses()].sort())
  })

  it.each(readers)('%s sends nothing once its caller has left, and says so', async (_name, read) => {
    vi.stubGlobal('window', {})
    const { sent } = network(() => response({}, 400))
    const page = new AbortController()
    const left = new Error('left the page')
    page.abort(left)

    await expect(read(page.signal)).rejects.toBe(left)
    expect(sent).toEqual([])
  })
})
