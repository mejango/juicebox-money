import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const directories: string[] = []
const script = resolve('scripts/audit-production.mjs')
type Finding = { severity: string; via: unknown[] }
const severityNames = ['info', 'low', 'moderate', 'high', 'critical']

function report(vulnerabilities: Record<string, Finding> = {}) {
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: {
    ...Object.fromEntries(severityNames.map(severity => [severity,
      Object.values(vulnerabilities).filter(finding => finding.severity === severity).length])),
    total: Object.keys(vulnerabilities).length,
  } } }
}

/** Exercise the real script with a local npm stub; no registry request is possible. */
function audit(payload: unknown, status = 0, options: { signal?: boolean; missingNpm?: boolean; sourceOnly?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'money-audit-report-'))
  directories.push(directory)
  if (!options.missingNpm) {
    const stub = join(directory, 'npm')
    writeFileSync(stub, `#!${process.execPath}\n` +
      (options.signal ? 'process.kill(process.pid, "SIGTERM");\n' :
        `process.stdout.write(${JSON.stringify(JSON.stringify(payload))});\nprocess.exit(${status});\n`))
    chmodSync(stub, 0o755)
  }
  const result = spawnSync(process.execPath, [script, ...(options.sourceOnly ? ['--source-only'] : [])], {
    cwd: resolve('.'), env: { ...process.env, PATH: directory }, encoding: 'utf8', timeout: 10_000,
  })
  if (result.error) throw result.error
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('production audit gate', () => {
  it('accepts a complete clean audit', () => {
    expect(audit(report())).toEqual(expect.objectContaining({ status: 0, output: expect.stringContaining('audit passed') }))
  })

  it('accepts exit 1 only with the scoped elliptic finding and its dependent package', () => {
    const result = audit(report({
      elliptic: { severity: 'low', via: [{ severity: 'low', url: 'https://github.com/advisories/GHSA-848j-6mx2-7j84' }] },
      '@getpara/core-sdk': { severity: 'low', via: ['elliptic'] },
    }), 1)
    expect(result.status).toBe(0)
    expect(result.output).toContain('one fail-closed Para exception')
  })

  it('rejects a valid audit containing an unexpected vulnerability', () => {
    const result = audit(report({ unsafe: { severity: 'high', via: [{ severity: 'high', url: 'https://example.com/advisory' }] } }), 1)
    expect(result.status).toBe(1)
    expect(result.output).toContain('unsafe: high')
  })

  it.each([
    ['registry error', { error: { code: 'ENOAUDIT', summary: 'Registry unavailable' } }, 1],
    ['empty JSON', {}, 0],
    ['missing findings', { auditReportVersion: 2, metadata: report().metadata }, 0],
    ['wrong findings shape', { ...report(), vulnerabilities: [] }, 0],
    ['inconsistent counts', { ...report(), metadata: { vulnerabilities: { ...report().metadata.vulnerabilities, total: 1 } } }, 0],
    ['malformed finding', report({ invalid: { severity: 'low', via: [null] } }), 1],
    ['unknown process status', report(), 2],
    ['failed process with empty findings', report(), 1],
  ])('does not report a passed audit for %s', (_name, payload, status) => {
    const result = audit(payload, status as number)
    expect(result.status).toBe(1)
    expect(result.output).not.toMatch(/audit passed/i)
  })

  it.each([{ missingNpm: true }, { signal: true }])('rejects an audit subprocess that could not finish: %j', options => {
    const result = audit(report(), 0, options)
    expect(result.status).toBe(1)
    expect(result.output).toContain('could not run to completion')
  })

  it('keeps the source-only check independent of npm and the registry', () => {
    const result = audit(null, 1, { missingNpm: true, sourceOnly: true })
    expect(result.status).toBe(0)
    expect(result.output).toContain('usage invariants verified')
  })
})
