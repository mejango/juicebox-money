import ts from 'typescript'

/** Modifiers under which nothing runs, or nothing proves an action: a skipped, conditional or expected-to-fail test or suite. */
const NOT_PROVING = new Set(['skip', 'todo', 'skipIf', 'runIf', 'fails'])

/** A test call's function and modifiers: `it.skipIf(cond)('…')` → { name: 'it', modifiers: ['skipIf'] }. */
function testCall(callee) {
  const modifiers = []
  let node = callee
  for (;;) {
    if (ts.isCallExpression(node)) node = node.expression
    else if (ts.isPropertyAccessExpression(node)) {
      modifiers.push(node.name.text)
      node = node.expression
    } else break
  }
  return ts.isIdentifier(node) && ['describe', 'it', 'test'].includes(node.text)
    ? { name: node.text, modifiers }
    : null
}

/**
 * The words of every it/test title in a test file's source, `.each` tables
 * included. A describe title proves nothing, and nothing under a skipped,
 * conditional or expected-to-fail test or suite counts.
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
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const call = testCall(node.expression)
      if (call?.modifiers.some(modifier => NOT_PROVING.has(modifier))) return
      const [title] = node.arguments
      if (
        call &&
        call.name !== 'describe' &&
        title &&
        (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))
      ) {
        for (const word of title.text.split(/\s+/)) words.add(word)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return words
}
