import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET as health } from '@/app/api/healthz/route'
import {
  assertDeploymentEnv,
  deploymentEnvErrors,
} from '../../scripts/check-deployment-env.mjs'

const buildEnv = {
  NEXT_PUBLIC_BENDYSTRAW_URL: 'https://bendystraw.example/graphql',
  NEXT_PUBLIC_LEGACY_SUBGRAPH_URL: 'https://legacy.example/graphql',
  NEXT_PUBLIC_TESTNET: 'false',
  NEXT_PUBLIC_PARA_API_KEY: 'public-para-key',
  NEXT_PUBLIC_PARA_ENV: 'PROD',
  NEXT_PUBLIC_INFURA_ID: 'public-infura-id',
  NEXT_PUBLIC_VERSION: 'abcdef1234567890',
}
const ingressToken = 'ingress-token-with-at-least-32-characters'

afterEach(() => vi.unstubAllEnvs())

describe('deployment configuration', () => {
  it('accepts a mainnet build and intentionally disabled runtime pinning', () => {
    expect(() => assertDeploymentEnv(buildEnv, 'build')).not.toThrow()
    expect(() =>
      assertDeploymentEnv({ IPFS_PINNING_ENABLED: 'false' }, 'runtime'),
    ).not.toThrow()
  })

  it('rejects test fixtures and a non-production Para environment on mainnet', () => {
    const errors = deploymentEnvErrors(
      {
        ...buildEnv,
        NEXT_PUBLIC_PARA_ENV: 'BETA',
        NEXT_PUBLIC_DETERMINISTIC_BROWSER: 'true',
      },
      'build',
    )
    expect(errors).toContain('mainnet builds require NEXT_PUBLIC_PARA_ENV=PROD')
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

  it('requires edge protection, a strong ingress token, and credentials', () => {
    const errors = deploymentEnvErrors(
      { IPFS_PINNING_ENABLED: 'true' },
      'runtime',
    )
    expect(errors).toEqual(
      expect.arrayContaining([
        'enabled IPFS pinning requires edge quota protection',
        'IPFS_PINNING_INGRESS_TOKEN must be at least 32 characters',
        'INFURA_IPFS_PROJECT_ID is required',
        'INFURA_IPFS_API_SECRET is required',
      ]),
    )
  })

  it('accepts a complete enabled pinning boundary and rejects short tokens', () => {
    const runtimeEnv = {
      IPFS_PINNING_ENABLED: 'true',
      IPFS_PINNING_EDGE_PROTECTED: 'true',
      IPFS_PINNING_INGRESS_TOKEN: ingressToken,
      INFURA_IPFS_PROJECT_ID: 'project-id',
      INFURA_IPFS_API_SECRET: 'project-secret',
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
    vi.stubEnv('INFURA_IPFS_PROJECT_ID', 'project-id')
    vi.stubEnv('INFURA_IPFS_API_SECRET', 'project-secret')
    expect(health().status).toBe(200)

    vi.stubEnv('IPFS_PINNING_INGRESS_TOKEN', 'too-short')
    expect(health().status).toBe(503)
  })
})
