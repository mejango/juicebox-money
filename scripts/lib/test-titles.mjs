import ts from 'typescript'

/** Modifiers under which nothing runs, or nothing proves an action: a skipped, conditional or expected-to-fail test or suite. */
const NOT_PROVING = new Set(['skip', 'todo', 'skipIf', 'runIf', 'fails'])

/** Suites: their titles prove nothing. `suite` is Vitest's alias for `describe`. */
const SUITES = new Set(['describe', 'suite'])

/** Modifiers that register a test or suite once per row of the table they are called with, so an empty table registers nothing. */
const TABLES = new Set(['each', 'for'])

/** Hooks that receive the context of each test of their suite, and so can skip it. */
const HOOKS = new Set(['beforeEach', 'afterEach', 'aroundEach'])

/** An expression without the wrappers that leave its value alone: parentheses, `as`, `satisfies`, `<T>` and `!`. */
function unwrap(node) {
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    node = node.expression
  }
  return node
}

/**
 * A test call's function, modifiers and tables: `it.skipIf(cond).each(rows)('…')`
 * → { name: 'it', modifiers: ['each', 'skipIf'], tables: [rows] }. A bracketed
 * modifier (`describe['skip']`) is not read: it counts as one that proves nothing.
 */
function testCall(callee) {
  const modifiers = []
  const tables = []
  let node = callee
  for (;;) {
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression) && TABLES.has(node.expression.name.text)) {
        tables.push(node.arguments[0])
      }
      node = node.expression
    } else if (ts.isPropertyAccessExpression(node)) {
      modifiers.push(node.name.text)
      node = node.expression
    } else if (ts.isElementAccessExpression(node)) {
      modifiers.push('skip')
      node = node.expression
    } else break
  }
  return ts.isIdentifier(node) && (SUITES.has(node.text) || ['it', 'test'].includes(node.text))
    ? { name: node.text, modifiers, tables }
    : null
}

/** Whether a `.each` or `.for` table is an array literal with a row: an element that is neither a spread nor a hole. */
function hasRow(table) {
  const rows = table && unwrap(table)
  return (
    !!rows &&
    ts.isArrayLiteralExpression(rows) &&
    rows.elements.some(row => !ts.isSpreadElement(row) && !ts.isOmittedExpression(row))
  )
}

/** The function a call passes inline, wherever it sits among the arguments. A named function cannot be read here. */
function inlineCallback(call) {
  return call.arguments.find(argument => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))
}

const isSkipLiteral = node => ts.isStringLiteralLike(node) && node.text === 'skip'

/** Whether an object pattern takes `skip` out of its object: `{ skip }`, `{ skip: stop }`, `{ 'skip': stop }`. */
function takesSkip(pattern) {
  return (
    ts.isObjectBindingPattern(pattern) &&
    pattern.elements.some(element => {
      const key = element.propertyName ?? element.name
      if (ts.isIdentifier(key)) return key.text === 'skip'
      return isSkipLiteral(ts.isComputedPropertyName(key) ? key.expression : key)
    })
  )
}

/**
 * Whether a test or hook callback can skip at run time: it takes `skip` out of
 * one of its parameters (`ctx.skip`, `ctx['skip']`, `{ skip }` or
 * `const { skip } = ctx`).
 */
function skipsItself(callback) {
  const contexts = new Set()
  for (const { name } of callback.parameters) {
    if (ts.isIdentifier(name)) contexts.add(name.text)
    else if (takesSkip(name)) return true
  }
  let skips = false
  function visit(node) {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const named = ts.isPropertyAccessExpression(node)
        ? node.name.text === 'skip'
        : isSkipLiteral(node.argumentExpression)
      const object = unwrap(node.expression)
      if (named && ts.isIdentifier(object) && contexts.has(object.text)) skips = true
    }
    if (ts.isVariableDeclaration(node) && node.initializer && takesSkip(node.name)) {
      const object = unwrap(node.initializer)
      if (ts.isIdentifier(object) && contexts.has(object.text)) skips = true
    }
    ts.forEachChild(node, visit)
  }
  visit(callback.body)
  return skips
}

/** Whether a statement can end its enclosing body early: a return or throw, outside any nested function. */
function mayEnd(node) {
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true
  return !ts.isFunctionLike(node) && ts.forEachChild(node, mayEnd) === true
}

/**
 * Whether a node holds, outside any nested function, a hook call that can skip
 * the tests of its suite. A hook in a nested suite's callback belongs to that
 * suite, which is walked on its own.
 */
function hasSkippingHook(node) {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && HOOKS.has(node.expression.text)) {
    const callback = inlineCallback(node)
    if (callback && skipsItself(callback)) return true
  }
  return !ts.isFunctionLike(node) && ts.forEachChild(node, hasSkippingHook) === true
}

/**
 * The words of the titles of the tests that run, so a marker in one proves its
 * action. A test counts only when it is a statement written directly in a
 * describe body or at the top of the file, with nothing before it that can end
 * that body early (a return or throw). A describe title proves nothing. Nothing
 * counts that is skipped, conditional or expected to fail; that sits in a
 * `.each` or `.for` whose table is not a literal array with a row; that skips
 * itself or sits under a hook that skips; or that has no inline callback.
 */
export function provingTitleWords(text, fileName) {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const words = new Set()

  function register(call) {
    const test = testCall(call.expression)
    if (!test || test.modifiers.some(modifier => NOT_PROVING.has(modifier))) return
    if (!test.tables.every(hasRow)) return
    const callback = inlineCallback(call)
    if (!callback) return
    if (SUITES.has(test.name)) {
      if (ts.isBlock(callback.body)) walk(callback.body.statements)
      return
    }
    const [title] = call.arguments
    if (title && ts.isStringLiteralLike(title) && !skipsItself(callback)) {
      for (const word of title.text.split(/\s+/)) words.add(word)
    }
  }

  function walk(statements) {
    if (statements.some(hasSkippingHook)) return
    for (const statement of statements) {
      if (mayEnd(statement)) return
      if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
        register(statement.expression)
      }
    }
  }

  walk(source.statements)
  return words
}
