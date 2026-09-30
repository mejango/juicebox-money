import { webcrypto } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import registry from '@/lib/bendystraw-operation-registry.json'
import { bendystrawOperationId } from '@bananapus/nana-sdk-core/bendystraw-operations'
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

describe('the relay when the indexer fails', () => {
  const [operation] = Object.entries(registry)[0]
  const params = { params: Promise.resolve({ net: 'mainnet' }) }
  const relay = () =>
    POST(
      new Request('https://juicebox.money/api/bendystraw/mainnet/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation,
          variables: { chainId: 1, projectId: 11 },
        }),
      }),
      params,
    )
  // Every request gets a fresh response: a Response body can be read once.
  const indexerAnswers = (body: unknown) =>
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(
        async () =>
          new Response(JSON.stringify(body), {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    )

  // The relay logs why it failed. Silencing the log keeps the run's output clean, and the spy lets a test read it.
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('answers 502 and only that, and logs the cause once', async () => {
    indexerAnswers({ errors: [{ message: 'relation "secret_table" does not exist' }] })

    const response = await relay()

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'Bendystraw unavailable' })
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      'Bendystraw relay failed:',
      'BendystrawRequestError: relation "secret_table" does not exist',
    )
  })

  it('logs a cause on one line, without the control characters a terminal or a log viewer would act on', async () => {
    // A line break could forge a log line, ESC starts a terminal sequence, and NUL cuts a line in some viewers. U+0085 (NEL), U+009B (CSI) and DEL are controls that `\s` does not match.
    indexerAnswers({
      errors: [
        {
          message:
            'first line\r\n2026-09-29 ERROR forged line\n\tindented \u001b[31mred\u001b[0m\u0000nul \u0085 nel \u009b csi \u007f del',
        },
      ],
    })

    const response = await relay()

    expect(await response.json()).toEqual({ error: 'Bendystraw unavailable' })
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      'Bendystraw relay failed:',
      'BendystrawRequestError: first line 2026-09-29 ERROR forged line indented [31mred [0m nul nel csi del',
    )
  })

  it('logs nothing when the relay answers', async () => {
    indexerAnswers({ data: { project: null } })

    expect((await relay()).status).toBe(200)
    expect(console.error).not.toHaveBeenCalled()
  })
})
