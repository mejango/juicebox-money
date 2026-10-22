import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/components/create/CreateForm.tsx', 'utf8')

/**
 * The wizard is not renderable under this suite. A Safe app signs a sent gas
 * limit as the proposal's safeTxGas: the direct launch goes through core's
 * reviewed send, which reviews and sends Safe gas 0 through a Safe app and the
 * measured limit otherwise, so the form sets no gas of its own.
 */
describe('direct launch gas', () => {
  it("takes core's reviewed send and sets no gas of its own", () => {
    expect(source).toContain('await sendReviewedWrite({')
    expect(source).not.toContain('safeTxGas')
    expect(source).not.toContain('gasWithHeadroom')
    expect(source).not.toContain('writeContractAsync')
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
    // A saved proposal's recovery is the SDK's; only a fresh send waits for its execution, under the page's signal.
    expect(source.match(/waitForSafeExecutionHash\(/g)).toHaveLength(1)
    expect(source).toContain('hash = await waitForSafeExecutionHash(chainId, proposal, { signal });')
    expect(source).toMatch(/prepareLaunchMultisigs\(\{[\s\S]*?\n\s+signal,\n\s+\}\)\.catch\(/)
  })
})


describe('direct launch submission and recovery boundaries', () => {
  it('freezes Safe review/gas/tracking and pins the simulated chain', () => {
    const run = source.slice(source.indexOf('const runDirectChains ='), source.indexOf('const finishLaunch ='))
    expect(run.match(/isSafeConnection\(config\)/g)).toHaveLength(2)
    expect(run).toContain('const viaSafe = isSafeConnection(config);')
    expect(run).toMatch(/calls: \[\{\s*chainId, \.\.\.launchCall,/)
    expect(run).toContain('proposal = viaSafe ? hash : undefined;')
    expect(run).toMatch(/beforeWallet: \(\) => \{[\s\S]*?phase: "signing", directSafeCall/)
    expect(run).toContain('onUnsent: () => {')
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

  it('puts the launch under the SDK hold: the reservation right before the wallet, and the hold deciding a resume', () => {
    // A saved launch is recovered by the SDK first; a fresh one is sent under the hold of its launch key.
    expect(source).toContain('const outcome = await savedAttempts.recover(attempt, client as never);')
    expect(source).toContain('namespace: launchNamespace(launch), call: launchCall,')
    // Core reserves the hold under the launch key before `beforeWallet`, and journals the hash it returns.
    expect(source).toContain('intent: launchNamespace(launch),')
    expect(source).toMatch(/onSubmitted: \(_call, _step, submitted\) => \{\s*hash = submitted;[\s\S]*?updateStatus\(chainId, \{ phase: "confirming", txHash: submitted/)
    expect(source).not.toContain('This launch may already have been submitted. Recover the original wallet request before trying again.')
  })
})
