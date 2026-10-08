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
    expect(source).toContain('...(viaSafe ? { safeTxGas: 0n } : {}),')
  })

  it('sends gas 0 through a Safe app and the measured limit otherwise', () => {
    expect(source).toContain('gas: viaSafe ? 0n : gasWithHeadroom(estimate),')
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
    expect(source).toMatch(/waitForSafeExecutionHash\(\s*chainId,\s*proposal,\s*\{ signal \},\s*\)/)
    expect(source).toContain('hash = await waitForSafeExecutionHash(chainId, proposal, { signal });')
    expect(source).toMatch(/prepareLaunchMultisigs\(\{[\s\S]*?\n\s+signal,\n\s+\}\);/)
  })
})


describe('direct launch submission and recovery boundaries', () => {
  it('freezes Safe review/gas/tracking and pins the simulated chain', () => {
    const run = source.slice(source.indexOf('const runDirectChains ='), source.indexOf('const finishLaunch ='))
    expect(run.match(/isSafeConnection\(config\)/g)).toHaveLength(2)
    expect(run).toContain('const viaSafe = isSafeConnection(config);')
    expect(run).toMatch(/\.\.\.simulated,\s*chainId,/)
    expect(run).toContain('proposal = viaSafe ? hash : undefined;')
    expect(run).toMatch(/beforeWrite: \(\) => \{[\s\S]*?phase: "signing", directSafeCall/)
    expect(run).toContain('onBeforeWriteAborted: () => {')
  })

  it('retains original Safe call/proposal until authenticated inner proof and then verifies the project', () => {
    const run = source.slice(source.indexOf('const runDirectChains ='), source.indexOf('const finishLaunch ='))
    expect(run).toContain('let directSafeCall = priorStatus?.directSafeCall;')
    expect(run).toContain('if (!directSafeCall) throw new Error(SAFE_PROPOSAL_UNCONFIRMED);')
    expect(run).toContain('client, receipt, safe, proposalHash: proposal, calls: [call], batch: false,')
    expect(run).toContain('if (status !== "success") throw new Error(SAFE_PROPOSAL_UNCONFIRMED);')
    expect(run.indexOf('await readSafeAppExecution(')).toBeLessThan(run.indexOf('projectIdFromReceipt(receipt'))
    expect(run).toMatch(/if \(status === "failed"\) \{\s*await requireFinalizedLaunchFailure\(client, receipt, hash!\);\s*provenReverted = true;/)
    expect(run).toMatch(/else if \(receipt.status !== "success"\)/)
    expect(run).toContain('safeProposalHash: proposal,')
  })

  it('retains unknown admitted sends and requires durable storage before the wallet boundary', () => {
    expect(source).toContain('if (!persisted) throw new Error("Launch progress could not be saved.')
    expect(source).toContain('walletInvoked && !isDefiniteWalletRejection(e)')
    expect(source).toContain('status?.unverifiedSend || status?.txHash || status?.safeProposalHash')
    expect(source).toContain('live.unverifiedSend || live.txHash || live.safeProposalHash')
    expect(source).toContain('phase: "signing", unverifiedSend: true')
    expect(source).toContain('!canAbandonDirectLaunch(session)')
    expect(source).toContain(': canAbandonDirectLaunch(activeLaunchSession)')
  })
})
