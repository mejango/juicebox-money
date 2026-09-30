import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  NEXT_PUBLIC_VERSION: 'abcdef1234567890',
}

const root = fileURLToPath(new URL('../..', import.meta.url))

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

  it('does not put environment values into validation errors', () => {
    const secret = 'do-not-echo-this-value'
    const errors = deploymentEnvErrors(
      { ...buildEnv, NEXT_PUBLIC_BENDYSTRAW_URL: secret },
      'build',
    )
    expect(errors.join('\n')).not.toContain(secret)
  })
})

describe('starting the server', () => {
  // Runs the container's start script with exactly this environment. It stops on an invalid one before it loads the app.
  function start(env: Record<string, string>) {
    const { status, stderr } = spawnSync(
      process.execPath,
      [join(root, 'scripts', 'start-production.mjs')],
      {
        env: env as NodeJS.ProcessEnv,
        encoding: 'utf8',
        timeout: 10_000,
        killSignal: 'SIGKILL',
      },
    )
    return {
      status,
      stderr,
      refused: stderr.includes('Invalid all deployment configuration'),
    }
  }

  const { NEXT_PUBLIC_VERSION: _revision, ...withoutVersion } = buildEnv

  it('takes the revision from Railway when no version is set', () => {
    // The app is not there to load, so a start that gets past the check fails on that, not on the configuration.
    expect(
      start({ ...withoutVersion, RAILWAY_GIT_COMMIT_SHA: '0123456789abcdef' })
        .refused,
    ).toBe(false)
  })

  it('keeps the version it is given over the one from Railway', () => {
    const result = start({
      ...withoutVersion,
      NEXT_PUBLIC_VERSION: 'unknown',
      RAILWAY_GIT_COMMIT_SHA: '0123456789abcdef',
    })
    expect(result.refused).toBe(true)
    expect(result.stderr).toContain(
      '- NEXT_PUBLIC_VERSION must identify the built revision',
    )
  })

  it.each([
    ['no Railway revision', {}],
    ['a blank Railway revision', { RAILWAY_GIT_COMMIT_SHA: '  ' }],
  ])('stops with %s, and never takes the text "undefined" for a revision', (_case, railway) => {
    const result = start({ ...withoutVersion, ...railway })
    expect(result.refused).toBe(true)
    expect(result.stderr).toContain('- NEXT_PUBLIC_VERSION is required')
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
