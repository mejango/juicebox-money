import { webcrypto } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import registry from '@/lib/bendystraw-operation-registry.json'
import { bendystrawOperationId } from '@/lib/bendystraw-operation-id'
import { resolvePersistedBendystrawRequest } from '@/lib/bendystraw-proxy'
import { POST } from '@/app/api/bendystraw/[net]/query/route'

describe('persisted Bendystraw browser operations', () => {
  const originalCrypto = globalThis.crypto

  beforeAll(() => {
    vi.stubGlobal('crypto', webcrypto)
  })

  afterAll(() => {
    vi.stubGlobal('crypto', originalCrypto)
  })

  it('uses the document SHA-256 as its registered operation ID', async () => {
    const [operation, query] = Object.entries(registry)[0]
    expect(await bendystrawOperationId(query)).toBe(operation)
  })

  it('rejects unknown IDs, raw documents, extra fields, and malformed variables', () => {
    const [operation, query] = Object.entries(registry)[0]
    expect(resolvePersistedBendystrawRequest({ operation, variables: {} })).toEqual({
      query,
      variables: {},
    })
    expect(
      resolvePersistedBendystrawRequest({
        operation,
        variables: {},
        query: 'query Attacker { projects { totalCount } }',
      }),
    ).toBeNull()
    expect(
      resolvePersistedBendystrawRequest({
        operation: '0'.repeat(64),
        variables: {},
      }),
    ).toBeNull()
    expect(
      resolvePersistedBendystrawRequest({ operation, variables: [] }),
    ).toBeNull()
  })

  it('rejects unknown networks, operations, and streamed oversized bodies at the BFF', async () => {
    const params = { params: Promise.resolve({ net: 'mainnet' }) }
    const unknown = await POST(
      new Request('https://juicebox.money/api/bendystraw/mainnet/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: '0'.repeat(64),
          variables: {},
        }),
      }),
      params,
    )
    expect(unknown.status).toBe(400)

    const unsupported = await POST(
      new Request('https://juicebox.money/api/bendystraw/staging/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      { params: Promise.resolve({ net: 'staging' }) },
    )
    expect(unsupported.status).toBe(404)

    const oversized = await POST(
      new Request('https://juicebox.money/api/bendystraw/mainnet/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: '0'.repeat(64), variables: { value: 'x'.repeat(33_000) } }),
      }),
      params,
    )
    expect(oversized.status).toBe(413)
  })
})
