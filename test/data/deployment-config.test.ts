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

afterEach(() => vi.unstubAllEnvs())

describe('deployment configuration', () => {
  it('accepts the complete browser build and needs no IPFS runtime secrets', () => {
    expect(() => assertDeploymentEnv(buildEnv, 'build')).not.toThrow()
    expect(() => assertDeploymentEnv({}, 'runtime')).not.toThrow()
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
  it('does not depend on webclient-owned IPFS credentials', async () => {
    vi.stubEnv('NEXT_PUBLIC_VERSION', 'test-sha')
    const response = health()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      version: 'test-sha',
    })
  })
})
