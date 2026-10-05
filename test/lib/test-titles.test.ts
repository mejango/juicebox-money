import { describe, expect, it } from 'vitest'

const libraryPath = '../../scripts/lib/test-titles.mjs'
const { provingTitleWords } = await import(libraryPath)

const marker = 'wallet-action:send'
const proves = (source: string) =>
  (provingTitleWords(source, 'proof.test.ts') as Set<string>).has(marker)

describe('test titles that can prove a wallet action', () => {
  it('counts it and test titles, .each tables included, under a running suite', () => {
    for (const source of [
      `describe('suite', () => { it('${marker} proves', () => {}) })`,
      `test('${marker} proves', () => {})`,
      `it.each([1, 2])('${marker} proves %s', () => {})`,
      `describe.each([1])('suite %s', () => { it.concurrent('${marker} proves', () => {}) })`,
      `suite('suite', () => { it('${marker} proves', () => {}) })`,
    ]) {
      expect(proves(source), source).toBe(true)
    }
  })

  it('counts a test that runs wherever it is written directly: nested suites, any callback form, any non-skipping context', () => {
    for (const source of [
      `describe('a', () => { describe('b', () => { it('${marker} proves', () => {}) }) })`,
      `describe('suite', function () { it('${marker} proves', function () {}) })`,
      `describe('suite', async () => { it('${marker} proves', async () => {}) })`,
      `it('${marker} proves', { timeout: 5_000 }, () => {})`,
      `it(\`${marker} proves\`, () => {})`,
      // A setup statement, an if without an early exit, or a return inside a helper function does not end the suite body.
      `describe('suite', () => { const helper = () => { return 1 }; it('${marker} proves', () => { helper() }) })`,
      `describe('suite', () => { if (ready) { prepare() } it('${marker} proves', () => {}) })`,
      `describe('suite', () => { beforeEach(() => { reset() }); it('${marker} proves', () => {}) })`,
      // Tables with at least one row, wrapped as TypeScript allows.
      `it.each([1, 2] as const)('${marker} proves %s', () => {})`,
      `it.each([{ id: 1 }] satisfies { id: number }[])('${marker} proves $id', ({ id }) => {})`,
      `it.each(([1]))('${marker} proves %s', () => {})`,
      `it.concurrent.each([[1, 2]])('${marker} proves %s', () => {})`,
      `it.for([1])('${marker} proves %s', (row, { expect }) => {})`,
      `it.each(<number[]>[1, 2])('${marker} proves %s', () => {})`,
      `it.each([...rows, 1])('${marker} proves %s', () => {})`,
      `describe.each([1])('suite %s', () => { it('${marker} proves', () => {}) })`,
      // A context that is read for something other than skip, or a local that merely shares its name.
      `it('${marker} proves', ({ expect }) => { expect(1).toBe(1) })`,
      `it('${marker} proves', (ctx) => { ctx.expect(1).toBe(1) })`,
      `it('${marker} proves', () => { const skip = 1; expect(skip).toBe(1) })`,
      `it('${marker} proves', async () => { await query({ skip: 0 }) })`,
      `it('${marker} proves', () => { page.skip() })`,
      `it.each([1])('${marker} proves %s', skip => { expect(skip).toBe(1) })`,
      `it.for([[1, 2]])('${marker} proves %s', ([first, skip]) => { expect(skip).toBe(2) })`,
      `it.for([[1]])('${marker} proves %s', row => { expect(row[0]).toBe(1) })`,
      `it('${marker} proves', () => { const { skip } = helpers; expect(skip).toBeDefined() })`,
      `describe('suite', () => { beforeEach((ctx) => { ctx.task.meta.ran = true }); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { if (ready) { beforeEach(() => { reset() }) } it('${marker} proves', () => {}) })`,
      `describe('suite', () => { beforeEach(setup); it('${marker} proves', () => {}) })`,
      // A skipping hook belongs to its own suite: it takes that suite's tests, not the tests beside or above it.
      `describe('outer', () => { describe('inner', () => { beforeEach((ctx) => { ctx.skip() }) }); it('${marker} proves', () => {}) })`,
      `describe('a', () => { beforeEach((ctx) => { ctx.skip() }) }); describe('b', () => { it('${marker} proves', () => {}) })`,
    ]) {
      expect(proves(source), source).toBe(true)
    }
  })

  it('ignores suite titles and anything skipped, conditional or expected to fail', () => {
    for (const source of [
      `describe('${marker} suite', () => { it('proves', () => {}) })`,
      `describe.skip('suite', () => { it('${marker} proves', () => {}) })`,
      `describe.skipIf(true)('suite', () => { it('${marker} proves', () => {}) })`,
      `describe.runIf(ci)('suite', () => { it('${marker} proves', () => {}) })`,
      `it.skip('${marker} proves', () => {})`,
      `it.todo('${marker} proves')`,
      `it.skipIf(true)('${marker} proves', () => {})`,
      `it.fails('${marker} proves', () => {})`,
      `test.skip.each([1])('${marker} proves %s', () => {})`,
      `suite('${marker} suite', () => { it('proves', () => {}) })`,
      `suite.skip('suite', () => { it('${marker} proves', () => {}) })`,
      `describe['skip']('suite', () => { it('${marker} proves', () => {}) })`,
      `it['skip']('${marker} proves', () => {})`,
    ]) {
      expect(proves(source), source).toBe(false)
    }
  })

  it('ignores a test in dead or conditional code, where nothing registers it', () => {
    for (const source of [
      `if (false) { it('${marker} proves', () => {}) }`,
      `if (false) it('${marker} proves', () => {})`,
      `describe('suite', () => { if (false) { it('${marker} proves', () => {}) } })`,
      `describe('suite', () => { if (enabled) it('${marker} proves', () => {}) })`,
      `describe('suite', () => { if (enabled) {} else { it('${marker} proves', () => {}) } })`,
      `describe('suite', () => { for (const row of rows) { it('${marker} proves', () => {}) } })`,
      `describe('suite', () => { while (false) { it('${marker} proves', () => {}) } })`,
      `describe('suite', () => { try { it('${marker} proves', () => {}) } catch {} })`,
      `describe('suite', () => { { it('${marker} proves', () => {}) } })`,
      `describe('suite', () => { switch (mode) { case 1: it('${marker} proves', () => {}) } })`,
      `describe('suite', () => { rows.forEach(() => { it('${marker} proves', () => {}) }) })`,
      `function register() { it('${marker} proves', () => {}) }`,
      `describe('suite', () => { const register = () => { it('${marker} proves', () => {}) } })`,
      `it('outer', () => { it('${marker} proves', () => {}) })`,
      `describe('suite', () => { describe('inner', () => { if (false) { it('${marker} proves', () => {}) } }) })`,
      `if (false) { describe('suite', () => { it('${marker} proves', () => {}) }) }`,
      // After a return or throw, or after a conditional one, the suite body never reaches the test.
      `describe('suite', () => { return; it('${marker} proves', () => {}) })`,
      `describe('suite', () => { throw new Error('stop'); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { if (!process.env.CI) return; it('${marker} proves', () => {}) })`,
      `describe('suite', () => { if (ready) { return } it('${marker} proves', () => {}) })`,
      `describe('suite', () => { for (const row of rows) { if (row) return } it('${marker} proves', () => {}) })`,
      `describe('outer', () => { describe('inner', () => { return; it('${marker} proves', () => {}) }) })`,
      `throw new Error('stop'); it('${marker} proves', () => {})`,
    ]) {
      expect(proves(source), source).toBe(false)
    }
  })

  it('ignores a test or suite whose .each or .for table is empty or not a literal array', () => {
    for (const source of [
      `it.each([])('${marker} proves %s', () => {})`,
      `test.each([])('${marker} proves %s', () => {})`,
      `it.for([])('${marker} proves %s', () => {})`,
      `it.each([] as const)('${marker} proves %s', () => {})`,
      `it.each(([]))('${marker} proves %s', () => {})`,
      `it.concurrent.each([])('${marker} proves %s', () => {})`,
      `it.each([...rows])('${marker} proves %s', () => {})`,
      `it.each([,])('${marker} proves %s', () => {})`,
      `it.each(rows)('${marker} proves %s', () => {})`,
      `it.each(rows.slice(1))('${marker} proves %s', () => {})`,
      `it.each(Object.keys(rows))('${marker} proves %s', () => {})`,
      `it.each()('${marker} proves', () => {})`,
      `it.each\`a\n\${1}\`('${marker} proves', () => {})`,
      `describe.each([])('suite %s', () => { it('${marker} proves', () => {}) })`,
      `describe.each(rows)('suite %s', () => { it('${marker} proves', () => {}) })`,
      `describe('suite', () => { it.each([])('${marker} proves %s', () => {}) })`,
      `describe.each([1])('suite %s', () => { it.each([])('${marker} proves %s', () => {}) })`,
    ]) {
      expect(proves(source), source).toBe(false)
    }
  })

  it('ignores a test that skips itself at run time through its context', () => {
    for (const source of [
      `it('${marker} proves', (ctx) => { ctx.skip() })`,
      `it('${marker} proves', (context) => { context.skip() })`,
      `it('${marker} proves', (ctx) => { ctx.skip(!ready, 'not ready') })`,
      `it('${marker} proves', async (ctx) => { if (!ready) ctx.skip(); await run() })`,
      `it('${marker} proves', (ctx) => { ctx.skip?.() })`,
      `it('${marker} proves', (ctx) => { ctx['skip']() })`,
      `it('${marker} proves', (ctx) => { const bail = () => ctx.skip(); bail() })`,
      `it('${marker} proves', (ctx) => { const bail = ctx.skip; bail() })`,
      `it('${marker} proves', function (ctx) { ctx.skip() })`,
      `it('${marker} proves', ({ skip }) => { skip() })`,
      `it('${marker} proves', ({ skip: stop }) => { stop() })`,
      `it('${marker} proves', ({ 'skip': stop }) => { stop() })`,
      `it('${marker} proves', ({ ['skip']: stop }) => { stop() })`,
      `it('${marker} proves', ({ expect, skip }) => { skip() })`,
      `it('${marker} proves', (ctx) => { const { skip } = ctx; skip() })`,
      `it('${marker} proves', (ctx) => { (ctx as Context).skip() })`,
      `it('${marker} proves', (ctx) => { (<Context>ctx).skip() })`,
      `it('${marker} proves', (ctx) => { ctx!.skip() })`,
      `it('${marker} proves', (ctx) => { const { skip } = ctx as Context; skip() })`,
      `it('${marker} proves', { timeout: 5_000 }, (ctx) => { ctx.skip() })`,
      `it.concurrent('${marker} proves', (ctx) => { ctx.skip() })`,
      `it.for([1])('${marker} proves %s', (row, ctx) => { ctx.skip() })`,
      `describe('suite', () => { it('${marker} proves', (ctx) => { ctx.skip() }) })`,
    ]) {
      expect(proves(source), source).toBe(false)
    }
  })

  it('ignores every test under a hook that skips at run time', () => {
    for (const source of [
      `beforeEach((ctx) => { ctx.skip() }); it('${marker} proves', () => {})`,
      `describe('suite', () => { beforeEach((ctx) => { ctx.skip() }); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { it('${marker} proves', () => {}); beforeEach(({ skip }) => { skip() }) })`,
      `describe('suite', () => { beforeEach((ctx) => { if (!ready) ctx.skip() }); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { afterEach((ctx) => { ctx.skip() }); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { aroundEach((runTest, ctx) => { ctx.skip() }); it('${marker} proves', () => {}) })`,
      `describe('suite', () => { if (!ready) { beforeEach((ctx) => { ctx.skip() }) } it('${marker} proves', () => {}) })`,
      `describe('suite', () => { for (const row of rows) beforeEach((ctx) => { ctx.skip() }); it('${marker} proves', () => {}) })`,
      `describe('outer', () => { beforeEach((ctx) => { ctx.skip() }); describe('inner', () => { it('${marker} proves', () => {}) }) })`,
    ]) {
      expect(proves(source), source).toBe(false)
    }
  })

  it('ignores a title that is not a plain string: a template with a substitution, a variable, a concatenation', () => {
    for (const source of [
      `it(\`${marker} \${suffix}\`, () => {})`,
      `it(title, () => {})`,
      `it('${marker} ' + suffix, () => {})`,
    ]) {
      expect(proves(source), source).toBe(false)
    }
  })

  it('ignores a test whose callback it cannot read: none (a todo), a named function, or a suite with an expression body', () => {
    for (const source of [
      `it('${marker} proves')`,
      `it('${marker} proves', runCase)`,
      `it.each([1])('${marker} proves %s')`,
      `describe('suite', () => it('${marker} proves', () => {}))`,
    ]) {
      expect(proves(source), source).toBe(false)
    }
  })
})
