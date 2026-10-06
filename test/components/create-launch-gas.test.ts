import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/components/create/CreateForm.tsx', 'utf8')

/**
 * The wizard is not renderable under this suite. A Safe app signs a sent gas
 * limit as the proposal's safeTxGas, so pin the direct launch to review and
 * send Safe gas 0 through a Safe app, like every other Safe-app write.
 */
describe('direct launch gas', () => {
  it('reviews Safe gas 0 through a Safe app', () => {
    expect(source).toContain('...(isSafeConnection(config) ? { safeTxGas: 0n } : {}),')
  })

  it('sends gas 0 through a Safe app and the measured limit otherwise', () => {
    expect(source).toContain('gas: isSafeConnection(config) ? 0n : gasWithHeadroom(estimate),')
    expect(source).not.toMatch(/return \{ \.\.\.simulated, gas: gasWithHeadroom\(estimate\) \}/)
  })
})

/**
 * Leaving the create page ends a direct launch's waits for a Safe to execute
 * what it proposed: the Safe setup's, and the launch's own, both resumed and
 * new. The saved launch keeps each proposal.
 */
describe("direct launch Safe waits", () => {
  it("take the page's signal", () => {
    expect(source).toContain('const pageSignal = useUnmountSignal();')
    expect(source).toContain('const signal = pageSignal();')
    expect(source.match(/waitForSafeExecutionHash\(/g)).toHaveLength(2)
    expect(source).toMatch(/waitForSafeExecutionHash\(\s*chainId,\s*priorSafeProposalHash,\s*\{ signal \},\s*\)/)
    expect(source).toContain('hash = await waitForSafeExecutionHash(chainId, hash, { signal });')
    expect(source).toMatch(/prepareLaunchMultisigs\(\{[\s\S]*?\n\s+signal,\n\s+\}\);/)
  })
})
