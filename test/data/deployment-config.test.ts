import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET as health } from '@/app/api/healthz/route'
import {
  assertDeploymentEnv,
  deploymentEnvErrors,
} from '../../scripts/check-deployment-env.mjs'

const buildEnv = {
  NEXT_PUBLIC_SITE_URL: 'https://juicebox.example',
  NEXT_PUBLIC_BENDYSTRAW_URL: 'https://bendystraw.example',
  NEXT_PUBLIC_TESTNET_BENDYSTRAW_URL: 'https://testnet.bendystraw.example',
  NEXT_PUBLIC_PARA_API_KEY: 'public-para-key',
  NEXT_PUBLIC_PARA_ENV: 'PROD',
  NEXT_PUBLIC_DWELLIR_API_KEY: 'public-dwellir-key',
  NEXT_PUBLIC_VERSION: 'abcdef1234567890',
}
const ingressToken = 'ingress-token-with-at-least-32-characters'

afterEach(() => vi.unstubAllEnvs())

describe('deployment configuration', () => {
  it('accepts a dual-environment build and disabled runtime pinning', () => {
    expect(() => assertDeploymentEnv(buildEnv, 'build')).not.toThrow()
    expect(() =>
      assertDeploymentEnv({ IPFS_PINNING_ENABLED: 'false' }, 'runtime'),
    ).not.toThrow()
  })

  it('rejects test fixtures and an invalid Para environment', () => {
    const errors = deploymentEnvErrors(
      {
        ...buildEnv,
        NEXT_PUBLIC_PARA_ENV: 'INVALID',
        NEXT_PUBLIC_DETERMINISTIC_BROWSER: 'true',
      },
      'build',
    )
    expect(errors).toContain('NEXT_PUBLIC_PARA_ENV is invalid')
    expect(errors).toContain('deterministic browser mode cannot be deployed')
  })

  it('requires an identifiable build revision', () => {
    expect(
      deploymentEnvErrors(
        { ...buildEnv, NEXT_PUBLIC_VERSION: 'unknown' },
        'build',
      ),
    ).toContain('NEXT_PUBLIC_VERSION must identify the built revision')
  })

  it('requires a URL-safe Dwellir browser key', () => {
    expect(
      deploymentEnvErrors(
        { ...buildEnv, NEXT_PUBLIC_DWELLIR_API_KEY: 'bad/key' },
        'build',
      ),
    ).toContain(
      'NEXT_PUBLIC_DWELLIR_API_KEY must be an 8-128 character URL-safe API key',
    )
  })

  it('requires a declared pinning mode and credentials', () => {
    const errors = deploymentEnvErrors(
      { IPFS_PINNING_ENABLED: 'true' },
      'runtime',
    )
    expect(errors).toEqual(
      expect.arrayContaining([
        'IPFS_PINNING_EDGE_PROTECTED must be explicitly true or false',
        'FILEBASE_IPFS_RPC_TOKEN is required',
        'PINATA_JWT is required',
      ]),
    )
  })

  it('accepts first-party pinning and refuses a token it would ignore', () => {
    const firstParty = {
      IPFS_PINNING_ENABLED: 'true',
      IPFS_PINNING_EDGE_PROTECTED: 'false',
      FILEBASE_IPFS_RPC_TOKEN: 'filebase-token',
      PINATA_JWT: 'pinata-jwt',
    }
    expect(deploymentEnvErrors(firstParty, 'runtime')).toEqual([])
    expect(
      deploymentEnvErrors(
        { ...firstParty, IPFS_PINNING_INGRESS_TOKEN: ingressToken },
        'runtime',
      ),
    ).toContain(
      'IPFS_PINNING_INGRESS_TOKEN is set while IPFS_PINNING_EDGE_PROTECTED is false: the app would ignore the token and budget callers itself',
    )
  })

  it('accepts a complete enabled pinning boundary and rejects short tokens', () => {
    const runtimeEnv = {
      IPFS_PINNING_ENABLED: 'true',
      IPFS_PINNING_EDGE_PROTECTED: 'true',
      IPFS_PINNING_INGRESS_TOKEN: ingressToken,
      FILEBASE_IPFS_RPC_TOKEN: 'filebase-token',
      PINATA_JWT: 'pinata-jwt',
    }
    expect(deploymentEnvErrors(runtimeEnv, 'runtime')).toEqual([])
    expect(
      deploymentEnvErrors(
        { ...runtimeEnv, IPFS_PINNING_INGRESS_TOKEN: 'too-short' },
        'runtime',
      ),
    ).toContain('IPFS_PINNING_INGRESS_TOKEN must be at least 32 characters')
  })

  it('does not put environment values into validation errors', () => {
    const secret = 'do-not-echo-this-value'
    const errors = deploymentEnvErrors(
      { ...buildEnv, NEXT_PUBLIC_BENDYSTRAW_URL: secret },
      'build',
    )
    expect(errors.join('\n')).not.toContain(secret)
  })
})

describe('health endpoint', () => {
  it('is ready when pinning is explicitly disabled', async () => {
    vi.stubEnv('IPFS_PINNING_ENABLED', 'false')
    vi.stubEnv('NEXT_PUBLIC_VERSION', 'test-sha')
    const response = health()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      version: 'test-sha',
    })
  })

  it('fails readiness for partial pinning configuration', async () => {
    vi.stubEnv('IPFS_PINNING_ENABLED', 'true')
    const response = health()
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      status: 'misconfigured',
    })
  })

  it('is ready only when enabled pinning includes the ingress secret', async () => {
    vi.stubEnv('IPFS_PINNING_ENABLED', 'true')
    vi.stubEnv('IPFS_PINNING_EDGE_PROTECTED', 'true')
    vi.stubEnv('IPFS_PINNING_INGRESS_TOKEN', ingressToken)
    vi.stubEnv('FILEBASE_IPFS_RPC_TOKEN', 'filebase-token')
    vi.stubEnv('PINATA_JWT', 'pinata-jwt')
    expect(health().status).toBe(200)

    vi.stubEnv('IPFS_PINNING_INGRESS_TOKEN', 'too-short')
    expect(health().status).toBe(503)
  })

  it('is ready for first-party pinning and unready with a stray token', async () => {
    vi.stubEnv('IPFS_PINNING_ENABLED', 'true')
    vi.stubEnv('IPFS_PINNING_EDGE_PROTECTED', 'false')
    vi.stubEnv('FILEBASE_IPFS_RPC_TOKEN', 'filebase-token')
    vi.stubEnv('PINATA_JWT', 'pinata-jwt')
    expect(health().status).toBe(200)

    vi.stubEnv('IPFS_PINNING_INGRESS_TOKEN', ingressToken)
    expect(health().status).toBe(503)
  })
})
