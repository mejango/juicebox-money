import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const directories: string[] = []
type Finding = { severity: string; via: unknown[] }
const severityNames = ['info', 'low', 'moderate', 'high', 'critical']
const ELLIPTIC = 'https://github.com/advisories/GHSA-848j-6mx2-7j84'
const NODE_FORGE = 'https://github.com/advisories/GHSA-86w9-cpqp-85rv'

function report(vulnerabilities: Record<string, Finding> = {}) {
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: {
    ...Object.fromEntries(severityNames.map(severity => [severity,
      Object.values(vulnerabilities).filter(finding => finding.severity === severity).length])),
    total: Object.keys(vulnerabilities).length,
  } } }
}

/** The production findings npm reports for Para 3.15.0: elliptic and node-forge, reached only through Para. */
function paraFindings(): Record<string, Finding> {
  return {
    elliptic: { severity: 'low', via: [{ severity: 'low', url: ELLIPTIC }] },
    'node-forge': { severity: 'high', via: [{ severity: 'high', url: NODE_FORGE }] },
    '@ethersproject/signing-key': { severity: 'low', via: ['elliptic'] },
    '@ethersproject/transactions': { severity: 'low', via: ['@ethersproject/signing-key'] },
    '@ethersproject/abstract-provider': { severity: 'low', via: ['@ethersproject/transactions'] },
    '@ethersproject/abstract-signer': { severity: 'low', via: ['@ethersproject/abstract-provider'] },
    '@ethersproject/hash': { severity: 'low', via: ['@ethersproject/abstract-signer'] },
    '@ethersproject/abi': { severity: 'low', via: ['@ethersproject/hash'] },
    'web3-eth-abi': { severity: 'low', via: ['@ethersproject/abi'] },
    '@celo/utils': { severity: 'low', via: ['web3-eth-abi'] },
    '@getpara/core-sdk': { severity: 'high', via: ['@celo/utils', 'elliptic', 'node-forge'] },
    '@getpara/web-sdk': { severity: 'high', via: ['@getpara/core-sdk', 'node-forge'] },
    '@getpara/react-common': { severity: 'high', via: ['@getpara/web-sdk'] },
    '@getpara/react-core': { severity: 'low', via: ['@getpara/core-sdk'] },
    '@getpara/react-sdk-lite': { severity: 'high', via: ['@getpara/react-common', '@getpara/react-core', '@getpara/web-sdk'] },
    '@getpara/viem-v2-integration': { severity: 'low', via: ['@getpara/core-sdk'] },
    '@getpara/wagmi-v2-connector': { severity: 'high', via: ['@getpara/viem-v2-integration', '@getpara/web-sdk'] },
  }
}

const PARA_SOURCE_FILES = [
  'core-sdk/package.json',
  'core-sdk/dist/cjs/index.js',
  'core-sdk/dist/esm/utils/formatting.js',
  'core-sdk/dist/cjs/ParaCore.js',
  'core-sdk/dist/esm/ParaCore.js',
  'core-sdk/dist/cjs/cryptography/utils.js',
  'core-sdk/dist/esm/cryptography/utils.js',
  'core-sdk/dist/cjs/shares/KeyContainer.js',
  'core-sdk/dist/esm/shares/KeyContainer.js',
  'web-sdk/dist/cryptography/webAuth.js',
]

/** A copy of this project holding the script and only the files its source checks read, so a test can change Para's code. */
function paraProject() {
  const directory = mkdtempSync(join(tmpdir(), 'money-audit-para-'))
  directories.push(directory)
  for (const file of ['scripts/audit-production.mjs', 'package.json', 'package-lock.json',
    ...PARA_SOURCE_FILES.map(file => `node_modules/@getpara/${file}`)]) {
    mkdirSync(dirname(join(directory, file)), { recursive: true })
    cpSync(file, join(directory, file))
  }
  return directory
}

/** Add code to a Para file in a copied project, creating the file when it is new. */
function addParaCode(project: string, file: string, code: string) {
  const path = join(project, 'node_modules/@getpara', file)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, code)
}

/** Exercise the real script with a local npm stub; no registry request is possible. */
function audit(payload: unknown, status = 0, options: {
  signal?: boolean; missingNpm?: boolean; sourceOnly?: boolean; project?: string
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'money-audit-report-'))
  directories.push(directory)
  if (!options.missingNpm) {
    const stub = join(directory, 'npm')
    writeFileSync(stub, `#!${process.execPath}\n` +
      (options.signal ? 'process.kill(process.pid, "SIGTERM");\n' :
        `process.stdout.write(${JSON.stringify(JSON.stringify(payload))});\nprocess.exit(${status});\n`))
    chmodSync(stub, 0o755)
  }
  const project = options.project ?? resolve('.')
  const result = spawnSync(process.execPath, [join(project, 'scripts/audit-production.mjs'),
    ...(options.sourceOnly ? ['--source-only'] : [])], {
    cwd: project, env: { ...process.env, PATH: directory }, encoding: 'utf8', timeout: 10_000,
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
      elliptic: { severity: 'low', via: [{ severity: 'low', url: ELLIPTIC }] },
      '@getpara/core-sdk': { severity: 'low', via: ['elliptic'] },
    }), 1)
    expect(result.status).toBe(0)
    expect(result.output).toContain('fail-closed Para exceptions')
    expect(result.output).toContain('GHSA-848j-6mx2-7j84')
    expect(result.output).not.toContain('GHSA-86w9-cpqp-85rv')
  })

  it('accepts the elliptic and node-forge advisories when they reach production only through Para', () => {
    const result = audit(report(paraFindings()), 1)
    expect(result.status).toBe(0)
    expect(result.output).toContain('GHSA-848j-6mx2-7j84')
    expect(result.output).toContain('GHSA-86w9-cpqp-85rv')
  })

  it('still rejects an unknown advisory alongside the Para exceptions, and names only it', () => {
    const result = audit(report({
      ...paraFindings(),
      'source-map-js': { severity: 'high', via: [{ severity: 'high', url: 'https://github.com/advisories/GHSA-68fv-2mgg-jv7q' }] },
    }), 1)
    expect(result.status).toBe(1)
    expect(result.output).toContain('Unexpected production vulnerabilities')
    expect(result.output).toContain('source-map-js: high')
    expect(result.output).not.toContain('@getpara')
    expect(result.output).not.toMatch(/audit passed/i)
  })

  it.each([
    ['node-forge advisory at another severity', {
      'node-forge': { severity: 'critical', via: [{ severity: 'critical', url: NODE_FORGE }] },
    }],
    ['second advisory on node-forge', {
      'node-forge': { severity: 'high', via: [
        { severity: 'high', url: NODE_FORGE },
        { severity: 'high', url: 'https://github.com/advisories/GHSA-0000-0000-0000' },
      ] },
    }],
    ['Para package rated above the advisories it reaches', {
      '@getpara/core-sdk': { severity: 'critical', via: ['@celo/utils', 'elliptic', 'node-forge'] },
    }],
    ['elliptic chain package rated at the node-forge severity', {
      '@celo/utils': { severity: 'high', via: ['web3-eth-abi'] },
    }],
  ])('rejects a %s', (_name, change) => {
    const result = audit(report({ ...paraFindings(), ...change }), 1)
    expect(result.status).toBe(1)
    expect(result.output).toContain('Unexpected production vulnerabilities')
    expect(result.output).toContain(Object.keys(change)[0])
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

describe("Para's audited node-forge usage", () => {
  it('passes a copy holding only the installed Para files the check reads', () => {
    const result = audit(report(paraFindings()), 1, { project: paraProject() })
    expect(result.status).toBe(0)
    expect(result.output).toContain('GHSA-86w9-cpqp-85rv')
  })

  it.each([
    ['a verify call on any Para object', 'react-common/dist/check.js',
      'export const check = (key, digest, signature) => key.verify(digest, signature);\n'],
    ['a node-forge API outside the audited set', 'core-sdk/dist/esm/cryptography/utils.js',
      'forge.pki.verifyCertificateChain(caStore, chain);\n'],
    ['the same API change in the CommonJS build', 'core-sdk/dist/cjs/cryptography/utils.js',
      'import_node_forge.default.pki.certificateFromPem(pem);\n'],
    ['a second use of an aliased forge module', 'core-sdk/dist/esm/ParaCore.js',
      'const certificates = pki.createCaStore();\n'],
    ['the forge module passed on whole', 'web-sdk/dist/cryptography/webAuth.js',
      'export const library = forge;\n'],
    ['another Para file importing node-forge', 'web-sdk/dist/cryptography/random.js',
      'import forge from "node-forge";\nexport const bytes = forge.random.getBytesSync(16);\n'],
  ])('fails closed on %s, before npm runs', (_name, file, code) => {
    const project = paraProject()
    addParaCode(project, file, code)
    const result = audit(report(paraFindings()), 1, { project })
    expect(result.status).toBe(1)
    expect(result.output).toContain('Reassess GHSA-86w9-cpqp-85rv')
    expect(result.output).toContain(file)
    expect(result.output).not.toMatch(/audit passed/i)
  })

  it('fails closed when a production package outside Para depends on node-forge', () => {
    const project = paraProject()
    const path = join(project, 'package-lock.json')
    const lockfile = JSON.parse(readFileSync(path, 'utf8'))
    lockfile.packages['node_modules/certificate-checker'] = { version: '1.0.0', dependencies: { 'node-forge': '^1.4.0' } }
    writeFileSync(path, JSON.stringify(lockfile))
    const result = audit(null, 1, { missingNpm: true, sourceOnly: true, project })
    expect(result.status).toBe(1)
    expect(result.output).toContain('node_modules/certificate-checker')
    expect(result.output).toContain('Reassess GHSA-86w9-cpqp-85rv')
  })

  it('ignores a development-only package that depends on node-forge', () => {
    const project = paraProject()
    const path = join(project, 'package-lock.json')
    const lockfile = JSON.parse(readFileSync(path, 'utf8'))
    lockfile.packages['node_modules/self-signed-dev-server'] = { version: '1.0.0', dev: true, dependencies: { 'node-forge': '^1.4.0' } }
    writeFileSync(path, JSON.stringify(lockfile))
    const result = audit(null, 1, { missingNpm: true, sourceOnly: true, project })
    expect(result.status).toBe(0)
    expect(result.output).toContain('usage invariants verified')
  })
})
