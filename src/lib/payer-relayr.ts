'use client'

import { getAccount } from '@wagmi/core'
import { JBCoreContracts, jbV6ContractAddress, jbProjectsAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { buildDeployProjectPayerTx, JB_PROJECT_PAYER_DEPLOYER, jbProjectPayerDeployerAbi } from '@bananapus/nana-sdk-core/v6'
import { decodeEventLog, decodeFunctionData, decodeFunctionResult, encodeFunctionData, isAddress, isAddressEqual, zeroAddress, type Address, type Hex } from 'viem'
import { wagmiConfig, SUPPORTED_CHAINS } from '@/providers/Providers'
import { publicClient } from '@/lib/wallet-core'
import { captureWalletContext } from '@/lib/wallet-context'
import { assertNoViewAs } from '@/lib/viewAs'
import { simulateStateChangingTransaction, writeIntentKey, type ReviewedCall, type ReviewedPlan, type SavedAttempt, type WriteHoldClient } from '@bananapus/nana-sdk-core/review'
import { recoverSaved, requireHeldSettlement, SavedAttemptShownError, strictRetirable, writeHolds } from '@/lib/write-holds'
import { loadReviewEngine } from '@/lib/preload-review'
import { reviewedSendDeps } from '@/lib/reviewed-send'
import { isSafeConnection, SAFE_NONCE_GUIDANCE, waitForSafeExecutionHash } from '@/lib/safe-connector'
import { SAFE_EXEC_ABI, safeExecutionResult } from '@bananapus/nana-sdk-core/safe-service'
import { isSafeExecutionSuccessLog } from '@/lib/safe'
import { withRelayrScopeLock } from '@/lib/relayr'
import { relayrDestinationHash, relayrPaymentChains, relayrRecordChain, relayrSentPaymentsSnapshot, relayrSupportsChains, type RelayrEntry, type RelayrQuote, type RelayrSentPayment, type RelayrTransactionRecord } from '@bananapus/nana-sdk-core/review/relayr'
import { runRawRelayrLifecycle } from '@/lib/raw-relayr-lifecycle'

const PREFIX = 'jb-payer-deploy-v1:'
const MAX_JOURNAL_BYTES = 100_000
const DEPLOY_GAS = 1_000_000n
const HASH = /^0x[0-9a-f]{64}$/iu
const FACTORY_READ_ABI = [
  { type: 'function', name: 'DIRECTORY', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'IMPLEMENTATION', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const
const memory = new Map<string, PayerDeploymentSession>()
const memoryAuthoritative = new Set<string>()

export type PayerDeploymentCall = {
  chainId: JBChainId
  projectId: number
  beneficiary: Address
  owner: Address
  memo: string
  addToBalance: boolean
  data: Hex
}

type PayerDeploymentOutcome = {
  chainId: JBChainId
  state: 'ready' | 'sending' | 'submitted' | 'verified' | 'failed'
  hash?: Hex
  safeProposalHash?: Hex
  /** Durable block floor captured before a Safe proposal can be submitted. */
  fromBlock?: string
  payer?: Address
  error?: string
  failedHashes?: Hex[]
  /** The SDK settled it as a success: followed until verified, never failed or deployed again. */
  settled?: true
}

/** Raw permissionless factory calls have no replay nonce: one journal owns the entire attempt. */
export type PayerDeploymentSession = {
  version: 1
  id: string
  archived?: boolean
  /** The SDK retired its saved send (the user's check or exit): archived unresolved, so a new review may replace it. */
  retired?: true
  scope: string
  account: Address
  transport: 'direct' | 'safe' | 'relayr'
  calls: PayerDeploymentCall[]
  outcomes: PayerDeploymentOutcome[]
  /** `payment-reverted`: the latest payment canonically reverted; only the SDK's retry rule lets the quote be paid again. */
  phase: 'reviewed' | 'publishing' | 'quoted' | 'payment-sending' | 'payment-reverted' | 'executing' | 'complete'
  createdAt: number
  quote?: RelayrQuote
  paymentHash?: Hex
  paymentChainId?: number
  /** Every payment sent for the quote, as relayrPaymentDetails authenticated it, under the hash it was mined. */
  payments?: RelayrSentPayment[]
  records: RelayrTransactionRecord[]
}

/** One chain's payer deployment of one attempt: held by the attempt and chain. No SDK builder covers it. */
const payerNamespace = (id: string, chainId: number) => writeIntentKey('payer-deploy', { attempt: id, chainId })

/**
 * How a saved deployment is proven: from its sender, and through its Safe proposal when the journal has it. A
 * Safe execution whose proposal the journal never saw (the hold proved the Safe ran this exact call) is proven by
 * its clone alone.
 */
function proofOf(session: PayerDeploymentSession, outcome: Pick<PayerDeploymentOutcome, 'safeProposalHash'>): [Address | undefined, boolean, Hex | undefined] {
  if (session.transport === 'relayr') return [undefined, false, undefined]
  return [session.account, session.transport === 'safe', outcome.safeProposalHash]
}

/** The SDK hold over one chain's direct or Safe payer deployment. */
function payerHold(session: PayerDeploymentSession, call: PayerDeploymentCall) {
  return writeHolds.open({ chainId: call.chainId, account: session.account, safe: session.transport === 'safe', namespace: payerNamespace(session.id, call.chainId),
    call: { to: JB_PROJECT_PAYER_DEPLOYER, data: call.data, value: 0n } })
}

/**
 * A chain's saved payer deployment as the SDK's saved-attempt recovery reads
 * it: only what the journal saved. Its domain check is the exact factory call's
 * verified clone; the journal's strict re-read is the final say before a check
 * or exit retires it.
 */
export function payerAttemptOf(session: PayerDeploymentSession, index: number): SavedAttempt<Address> {
  const call = session.calls[index]
  const outcome = session.outcomes[index]
  const safe = session.transport === 'safe'
  const attempt: SavedAttempt<Address> = {
    chainId: call.chainId,
    account: session.account,
    safe,
    namespaces: [payerNamespace(session.id, call.chainId)],
    call: { to: JB_PROJECT_PAYER_DEPLOYER, data: call.data, value: 0n },
    saved: {
      started: true,
      ...(safe && outcome.safeProposalHash ? { safeTxHash: outcome.safeProposalHash } : outcome.hash ? { hash: outcome.hash } : {}),
    },
    async authenticate(hash) {
      if (!hash) return { result: 'unknown' }
      try {
        // A Safe execution the journal never saw the proposal of: the hold proved the Safe ran this exact call, so its clone is checked alone.
        const proposal = safe ? outcome.safeProposalHash : undefined
        return { result: 'proven', value: await verifyPayerDeployment(call, hash, ...proofOf(session, { ...outcome, safeProposalHash: proposal })) }
      } catch (error) {
        return { result: 'unknown', reason: error instanceof Error ? error.message : undefined }
      }
    },
    // A strict, fresh read: storage that can't be read refuses (but under the warned exit).
    confirmRetirable: strictRetirable(() => attempt, () => {
      const now = readJournal(session.id)
      return !!now && !now.archived && now.outcomes[index]?.state !== 'verified'
    }),
  }
  return attempt
}

export function payerDeploymentScope(projects: readonly (readonly [number, number])[]): string {
  return `project-payers:${[...projects].sort(([a], [b]) => a - b).map(([chain, project]) => `${chain}:${project}`).join('|')}`
}

export function payerDeploymentRequest(call: PayerDeploymentCall) {
  return buildDeployProjectPayerTx({
    chainId: call.chainId, projectId: BigInt(call.projectId), beneficiary: call.beneficiary,
    owner: call.owner, memo: call.memo, addToBalance: call.addToBalance, metadata: '0x',
  })
}

function assertCall(call: PayerDeploymentCall): void {
  if (!SUPPORTED_CHAINS.some(chain => chain.id === call.chainId) ||
      !Number.isSafeInteger(call.projectId) || call.projectId < 1 ||
      !isAddress(call.beneficiary) || !isAddress(call.owner) ||
      typeof call.memo !== 'string' || call.memo.length > 256 || typeof call.addToBalance !== 'boolean') {
    throw new Error('The saved payer deployment has invalid settings. Keep the original attempt pending.')
  }
  const request = payerDeploymentRequest(call)
  if (encodeFunctionData(request).toLowerCase() !== call.data.toLowerCase()) {
    throw new Error('The saved payer deployment calldata changed. Keep the original attempt pending.')
  }
}

function snapshot(session: PayerDeploymentSession): PayerDeploymentSession {
  const value = JSON.parse(JSON.stringify(session)) as PayerDeploymentSession
  if (value.version !== 1 || !/^[0-9a-f-]{36}$/iu.test(value.id) || !isAddress(value.account) ||
      !Array.isArray(value.calls) || value.calls.length < 1 || value.calls.length > 8 ||
      new Set(value.calls.map(call => call.chainId)).size !== value.calls.length ||
      !['direct', 'safe', 'relayr'].includes(value.transport) ||
      !['reviewed', 'publishing', 'quoted', 'payment-sending', 'payment-reverted', 'executing', 'complete'].includes(value.phase) ||
      !Array.isArray(value.outcomes) || value.outcomes.length !== value.calls.length ||
      !Array.isArray(value.records)) throw new Error('The saved payer deployment is malformed. Keep it pending.')
  value.calls.forEach(assertCall)
  if (value.archived && !value.retired && (value.phase !== 'complete' || !value.outcomes.every(outcome => outcome.state === 'verified'))) {
    throw new Error('An unresolved payer deployment cannot be archived.')
  }
  if (value.transport === 'relayr' && (value.calls.length < 2 || !relayrSupportsChains(value.calls.map(call => call.chainId)))) {
    throw new Error('The saved payer relay contains unsupported destination chains.')
  }
  if ((value.phase === 'quoted' || value.phase === 'publishing') && value.paymentHash) {
    throw new Error('The original payer payment state is inconsistent. Keep it pending.')
  }
  if (value.payments !== undefined && !relayrSentPaymentsSnapshot(value.payments)) {
    throw new Error('The saved payer payments are malformed. Keep it pending.')
  }
  for (let index = 0; index < value.calls.length; index++) {
    const outcome = value.outcomes[index]
    if (outcome.chainId !== value.calls[index].chainId ||
        !['ready', 'sending', 'submitted', 'verified', 'failed'].includes(outcome.state) ||
        (outcome.hash && !HASH.test(outcome.hash)) || (outcome.safeProposalHash && !HASH.test(outcome.safeProposalHash)) ||
        (outcome.fromBlock !== undefined && (!/^\d{1,20}$/u.test(outcome.fromBlock) || BigInt(outcome.fromBlock) > 0xffffffffffffffffn)) ||
        (outcome.failedHashes && (outcome.failedHashes.length > 16 || outcome.failedHashes.some(hash => !HASH.test(hash)))) ||
        (outcome.state === 'verified' && (!outcome.hash || !outcome.payer || !isAddress(outcome.payer)))) {
      throw new Error('The saved payer deployment outcomes changed. Keep the original attempt pending.')
    }
  }
  return value
}

function aliases(session: Pick<PayerDeploymentSession, 'scope' | 'calls'>): string[] {
  return [...new Set([session.scope, ...session.calls.map(call => payerDeploymentScope([[call.chainId, call.projectId]]))])].sort()
}

function readJournal(id: string): PayerDeploymentSession | null {
  if (memoryAuthoritative.has(id) || typeof window === 'undefined') return memory.get(id) ?? null
  let raw: string | null
  try { raw = window.localStorage.getItem(`${PREFIX}journal:${id}`) }
  catch { return memory.get(id) ?? null }
  if (!raw) return memory.get(id) ?? null
  if (raw.length > MAX_JOURNAL_BYTES) throw new Error('The saved payer deployment is too large. Keep it pending.')
  const saved = snapshot(JSON.parse(raw) as PayerDeploymentSession)
  if (saved.id !== id) throw new Error('The saved payer attempt identity changed.')
  return saved
}

function readAlias(scope: string): PayerDeploymentSession | null {
  if (typeof window === 'undefined') return null
  const id = window.localStorage.getItem(`${PREFIX}alias:${scope}`)
  if (!id) return null
  const saved = readJournal(id)
  if (!saved || !aliases(saved).includes(scope)) throw new Error('The original payer deployment recovery data is incomplete. Keep it pending.')
  return saved
}

export function loadPayerDeployment(scope: string): PayerDeploymentSession | null {
  const exact = readAlias(scope)
  if (exact && !exact.archived) return exact
  const candidates = new Map<string, PayerDeploymentSession>()
  for (const tuple of scope.replace(/^project-payers:/u, '').split('|')) {
    if (!/^\d+:\d+$/u.test(tuple)) throw new Error('The payer project scope is invalid.')
    const saved = readAlias(`project-payers:${tuple}`)
    if (saved && !saved.archived) candidates.set(saved.id, saved)
  }
  if (candidates.size > 1) throw new Error('These linked projects have multiple saved payer attempts. Resume their original deployment reviews before combining them.')
  return [...candidates.values()][0] ?? null
}

/** Pre-write calls require durable storage; post-send writes preserve the newest hash in memory on failure. */
function save(session: PayerDeploymentSession, beforeWrite = false): PayerDeploymentSession {
  const saved = snapshot(session)
  const serialized = JSON.stringify(saved)
  if (serialized.length > MAX_JOURNAL_BYTES) throw new Error('The payer deployment recovery record is too large.')
  try {
    if (typeof window === 'undefined') throw new Error('Browser storage is unavailable.')
    for (const alias of aliases(saved)) {
      const existing = readAlias(alias)
      if (existing && existing.id !== saved.id && !existing.archived) {
        throw new Error('Another payer deployment already owns one of these project chains.')
      }
    }
    const journalKey = `${PREFIX}journal:${saved.id}`
    // Attach a new reviewed journal before its aliases. On later writes,
    // verify the aliases first so an alias failure cannot leave a fake send
    // window in storage when the wallet was never opened.
    if (!window.localStorage.getItem(journalKey)) {
      window.localStorage.setItem(journalKey, serialized)
      if (window.localStorage.getItem(journalKey) !== serialized) throw new Error('Storage verification failed.')
    }
    for (const alias of aliases(saved)) {
      window.localStorage.setItem(`${PREFIX}alias:${alias}`, saved.id)
      if (window.localStorage.getItem(`${PREFIX}alias:${alias}`) !== saved.id) throw new Error('Alias verification failed.')
    }
    window.localStorage.setItem(journalKey, serialized)
    if (window.localStorage.getItem(journalKey) !== serialized) throw new Error('Storage verification failed.')
  } catch (error) {
    if (!beforeWrite) { memory.set(saved.id, saved); memoryAuthoritative.add(saved.id) }
    if (error instanceof Error && /already owns/u.test(error.message)) throw error
    throw new Error('Allow browser storage to preserve this payer deployment before continuing.')
  }
  memory.set(saved.id, saved)
  memoryAuthoritative.delete(saved.id)
  return saved
}

async function locked<T>(keys: string[], run: () => Promise<T>, index = 0): Promise<T> {
  return index === keys.length ? run() : withRelayrScopeLock(`payer-deployment:${keys[index]}`, () => locked(keys, run, index + 1))
}

export function buildPayerDeploymentReview({ projects, selectedChainIds, account, beneficiary, owner, memo, addToBalance }: {
  projects: readonly (readonly [number, number])[]
  selectedChainIds: readonly number[]
  account: Address
  beneficiary: Address
  owner: Address
  memo: string
  addToBalance: boolean
}): PayerDeploymentSession {
  if (!selectedChainIds.length || new Set(selectedChainIds).size !== selectedChainIds.length) {
    throw new Error('Choose at least one project chain for the payer addresses.')
  }
  const calls = selectedChainIds.map(chainId => {
    const matches = projects.filter(([id]) => id === chainId)
    if (matches.length !== 1) throw new Error('The selected chain has no unique linked project.')
    const call = { chainId: chainId as JBChainId, projectId: matches[0][1], beneficiary, owner, memo, addToBalance, data: '0x' as Hex }
    call.data = encodeFunctionData(payerDeploymentRequest(call))
    assertCall(call)
    return call
  })
  const safe = isSafeConnection(wagmiConfig)
  return snapshot({
    version: 1, id: crypto.randomUUID(), scope: payerDeploymentScope(projects), account,
    transport: safe ? 'safe' : calls.length > 1 && relayrSupportsChains(calls.map(call => call.chainId)) ? 'relayr' : 'direct',
    calls, outcomes: calls.map(call => ({ chainId: call.chainId, state: 'ready' })),
    phase: 'reviewed', createdAt: Date.now(), records: [],
  })
}

function entryOf(call: PayerDeploymentCall): RelayrEntry {
  return { chain: call.chainId, target: JB_PROJECT_PAYER_DEPLOYER, data: call.data, value: '0' }
}

/**
 * A factory call as reviewed, with the gas the wallet sends. Relayr executes
 * its bundle with its own gas. A Safe app signs the sent gas as safeTxGas,
 * so a Safe sends 0 and a failed deployment reverts instead of using the nonce.
 */
/** A deployment's exact call; a direct send fixes its gas, a Safe app proposes with safeTxGas 0. */
function reviewedDeployment(call: PayerDeploymentCall, transport: PayerDeploymentSession['transport']): ReviewedCall {
  return { chainId: call.chainId, to: JB_PROJECT_PAYER_DEPLOYER, value: 0n, data: call.data,
    ...(transport === 'direct' ? { gas: DEPLOY_GAS } : {}),
    abi: jbProjectPayerDeployerAbi, functionName: 'deployProjectPayer', args: payerDeploymentRequest(call).args,
    label: `Deploy payer for project #${call.projectId}`, contractName: 'JBProjectPayerDeployer' }
}

function assertAccount(session: PayerDeploymentSession) {
  assertNoViewAs()
  const account = getAccount(wagmiConfig).address
  if (!account || !isAddressEqual(account, session.account) ||
      isSafeConnection(wagmiConfig) !== (session.transport === 'safe')) {
    throw new Error('Connect the wallet that reviewed these payer addresses before continuing.')
  }
}

async function preflight(call: PayerDeploymentCall, from: Address): Promise<void> {
  assertCall(call)
  const client = publicClient(call.chainId)
  const directory = await client.readContract({ address: JB_PROJECT_PAYER_DEPLOYER, abi: FACTORY_READ_ABI, functionName: 'DIRECTORY' })
  if (!isAddressEqual(directory, jbV6ContractAddress[JBCoreContracts.JBDirectory][call.chainId])) {
    throw new Error('The payer factory does not use this chain’s canonical Juicebox directory.')
  }
  await client.readContract({ address: jbV6ContractAddress[JBCoreContracts.JBProjects][call.chainId], abi: jbProjectsAbi, functionName: 'ownerOf', args: [BigInt(call.projectId)] })
  const result = await simulateStateChangingTransaction(client, { from, to: JB_PROJECT_PAYER_DEPLOYER, data: call.data, gas: DEPLOY_GAS })
  const predicted = decodeFunctionResult({ abi: jbProjectPayerDeployerAbi, functionName: 'deployProjectPayer', data: result })
  if (!isAddress(predicted) || isAddressEqual(predicted, zeroAddress)) throw new Error('The payer deployment simulation did not return a new address.')
}

/** Prove the exact factory call, canonical inclusion, emitted settings, and EIP-1167 clone. */
export async function verifyPayerDeployment(call: PayerDeploymentCall, hash: Hex, account?: Address, safe = false, safeProposalHash?: Hex): Promise<Address> {
  assertCall(call)
  if (!HASH.test(hash)) throw new Error('The payer destination hash is invalid.')
  const client = publicClient(call.chainId)
  const [transaction, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })])
  if (receipt.status !== 'success' || transaction.hash !== hash || receipt.transactionHash !== hash ||
      transaction.chainId !== call.chainId || !receipt.blockHash || typeof receipt.blockNumber !== 'bigint' ||
      transaction.blockHash !== receipt.blockHash || transaction.blockNumber !== receipt.blockNumber || transaction.value !== 0n) {
    throw new Error('The original payer deployment does not have a verified successful receipt. Keep it pending.')
  }
  const canonical = await client.getBlock({ blockNumber: receipt.blockNumber })
  if (canonical.hash !== receipt.blockHash) throw new Error('The payer deployment receipt is no longer canonical.')
  if (safe) {
    // Without a saved proposal, the Safe's exact execTransaction and the clone event it emitted (caller = the Safe) are the proof.
    if (!account || (safeProposalHash && safeExecutionResult(receipt, account, safeProposalHash).status !== 'success')) {
      throw new Error('The receipt does not prove the exact original Safe payer proposal executed successfully.')
    }
    if (!account || !transaction.to || !isAddressEqual(transaction.to, account)) throw new Error('The payer deployment did not execute through the reviewed Safe.')
    const decoded = decodeFunctionData({ abi: SAFE_EXEC_ABI, data: transaction.input })
    if (decoded.functionName !== 'execTransaction' || !isAddressEqual(decoded.args[0], JB_PROJECT_PAYER_DEPLOYER) ||
        decoded.args[1] !== 0n || decoded.args[2].toLowerCase() !== call.data.toLowerCase() || decoded.args[3] !== 0) {
      throw new Error('The Safe executed a different payer deployment call.')
    }
  } else if (!transaction.to || !isAddressEqual(transaction.to, JB_PROJECT_PAYER_DEPLOYER) ||
      transaction.input.toLowerCase() !== call.data.toLowerCase() ||
      (account && !isAddressEqual(transaction.from, account))) {
    throw new Error('The payer deployment transaction differs from its reviewed factory call.')
  }
  const matches = receipt.logs.flatMap(log => {
    if (!isAddressEqual(log.address, JB_PROJECT_PAYER_DEPLOYER)) return []
    try {
      const { args } = decodeEventLog({ abi: jbProjectPayerDeployerAbi, eventName: 'DeployProjectPayer', data: log.data, topics: log.topics, strict: true })
      return args.defaultProjectId === BigInt(call.projectId) && isAddressEqual(args.defaultBeneficiary, call.beneficiary) &&
        args.defaultMemo === call.memo && args.defaultMetadata === '0x' && args.defaultAddToBalance === call.addToBalance &&
        isAddressEqual(args.owner, call.owner) && isAddressEqual(args.directory, jbV6ContractAddress[JBCoreContracts.JBDirectory][call.chainId]) &&
        isAddressEqual(args.caller, safe ? account! : transaction.from) && !isAddressEqual(args.projectPayer, zeroAddress)
        ? [args.projectPayer] : []
    } catch { return [] }
  })
  if (matches.length !== 1) throw new Error('The receipt does not contain one exact payer deployment event.')
  const [implementation, code] = await Promise.all([
    client.readContract({ address: JB_PROJECT_PAYER_DEPLOYER, abi: FACTORY_READ_ABI, functionName: 'IMPLEMENTATION', blockNumber: receipt.blockNumber }),
    client.getBytecode({ address: matches[0], blockNumber: receipt.blockNumber }),
  ])
  const expectedCode = `0x363d3d373d3d3d363d73${implementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`
  if (isAddressEqual(implementation, zeroAddress) || code?.toLowerCase() !== expectedCode) {
    throw new Error('The deployed payer is not the factory’s expected clone.')
  }
  return matches[0]
}

async function requireCanonicalDirectRevert(call: PayerDeploymentCall, hash: Hex, account: Address): Promise<void> {
  const client = publicClient(call.chainId)
  const [transaction, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })])
  if (receipt.status !== 'reverted' || receipt.transactionHash !== hash || transaction.hash !== hash ||
      transaction.chainId !== call.chainId || transaction.blockHash !== receipt.blockHash ||
      typeof receipt.blockNumber !== 'bigint' || transaction.blockNumber !== receipt.blockNumber ||
      !receipt.blockHash || transaction.value !== 0n || !transaction.to ||
      !isAddressEqual(transaction.to, JB_PROJECT_PAYER_DEPLOYER) || !isAddressEqual(transaction.from, account) ||
      transaction.input.toLowerCase() !== call.data.toLowerCase()) {
    throw new Error('The original payer deployment has not been proven to revert. Keep it pending.')
  }
  if ((await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) {
    throw new Error('The original payer deployment revert is no longer canonical.')
  }
}

/** The Safe service is a discovery aid; canonical Safe logs also recover unhosted chains. */
async function findSafePayerExecution(call: PayerDeploymentCall, outcome: PayerDeploymentOutcome, account: Address): Promise<Hex | null> {
  if (!outcome.safeProposalHash || outcome.fromBlock === undefined) return null
  const client = publicClient(call.chainId)
  const latest = await client.getBlockNumber()
  for (let start = BigInt(outcome.fromBlock); start <= latest; start += 10_000n) {
    const end = start + 9_999n < latest ? start + 9_999n : latest
    const logs = await client.getLogs({ address: account, fromBlock: start, toBlock: end })
    const match = logs.find(log => isSafeExecutionSuccessLog(log, account, outcome.safeProposalHash!))
    if (match?.transactionHash) return match.transactionHash
  }
  return null
}

/** What a look at a Safe payer proposal says when it ends before the Safe executes the proposal. */
export const SAFE_PAYER_PENDING = 'The Safe proposal is still pending. Execute it in Safe, then check the deployment status.'
/** A payer deployment the SDK settled as a success, whose receipt or clone can't be read yet. */
const PAYER_SETTLED_CONFIRMING = 'The payer deployment went through. It is still confirming.'

/**
 * Resolve existing outcomes only; never submit replacement clones when a send
 * is uncertain. `signal` is the flow's: when it aborts, a wait for a Safe to
 * execute a deployment ends, and the deployment stays submitted.
 */
export async function runPayerDeployments(review: PayerDeploymentSession, onUpdate: (session: PayerDeploymentSession) => void, signal: AbortSignal): Promise<PayerDeploymentSession> {
  const startChainId = getAccount(wagmiConfig).chainId
  const walletGuards = review.calls.map(call => captureWalletContext(wagmiConfig, { account: review.account, chainId: call.chainId }))
  return locked(aliases(review), async () => {
    if (typeof navigator === 'undefined' || !navigator.locks) throw new Error('This browser cannot coordinate payer deployments across tabs. Use a browser with Web Locks support.')
    const original = readJournal(review.id)
    if (original?.archived) throw new Error('This payer attempt was already completed. Open a new review to create more addresses.')
    const active = loadPayerDeployment(review.scope)
    let session = active ?? original ?? snapshot(review)
    if (session.id !== review.id || JSON.stringify(session.calls) !== JSON.stringify(review.calls)) {
      onUpdate(snapshot(session))
      throw new Error('A previous payer deployment already exists. Resume its saved settings before starting another attempt.')
    }
    const persist = (beforeWrite = false) => {
      session = save(session, beforeWrite)
      onUpdate(snapshot(session))
    }
    assertAccount(session)
    const viaSafe = session.transport === 'safe'
    // One review covers every deployment the wallet sends in this run.
    const engine = await loadReviewEngine()
    let plan: ReviewedPlan | undefined
    // A Relayr round's fee bound is on the wallet's chain, when Relayr takes payment there.
    const payOn = session.transport === 'relayr' && startChainId !== undefined &&
      relayrPaymentChains(session.calls.map(call => call.chainId)).includes(startChainId) ? startChainId : undefined
    if (!original && !active) {
      plan = await engine.reviewPlan({
        account: session.account,
        title: 'Review payer address deployments',
        description: `Deploy one payer address for each selected project. Each address uses the beneficiary, admin, and behavior shown in its exact factory call.${viaSafe ? ` ${SAFE_NONCE_GUIDANCE}` : ''}`,
        ...(viaSafe ? { confirmLabel: 'Agree & continue to Safe' } : {}),
        // A Relayr deployment runs from Relayr's own account, every one in one round under one fee bound.
        calls: session.calls.map(call => ({ ...reviewedDeployment(call, session.transport),
          ...(session.transport === 'relayr' ? { from: 'relayr' as const } : {}), ...(payOn ? { relayrRound: session.id } : {}) })),
        ...(payOn ? { relayrRounds: { [session.id]: { paymentChainId: payOn } } } : {}),
      }, reviewedSendDeps)
      assertAccount(session)
      persist(true)
    }
    if (session.phase === 'complete') {
      for (let index = 0; index < session.calls.length; index++) {
        await verifyPayerDeployment(session.calls[index], session.outcomes[index].hash!, ...proofOf(session, session.outcomes[index]))
      }
      return session
    }
    if (session.transport === 'relayr') {
      const pollError = await runRawRelayrLifecycle({
        session, entries: session.calls.map(entryOf), preferredPaymentChainId: startChainId,
        ...(plan && payOn ? { planned: { plan, round: session.id, chainId: payOn } } : {}),
        checked: {
          stillSaved: () => { const now = readJournal(session.id); return !!now && !now.archived && now.phase !== 'complete' },
          retired: () => {
            // The user checked this payment: the attempt is archived unresolved, so a new review may deploy again.
            session = save({ ...session, archived: true, retired: true }, true)
            onUpdate(snapshot(session))
            throw new Error('You checked this payment. Open a new review to deploy the payer addresses again.')
          },
        },
        changedCallMessage: 'The original payer quote changed a reviewed deployment.',
        lostQuoteMessage: 'The original payer quote response is unavailable. Keep this attempt pending; requesting another bundle could deploy duplicate addresses.',
        saveState: (next, beforeWrite) => { session = next; persist(beforeWrite) },
        assertAccount: () => assertAccount(session),
        reverify: async () => { for (const call of session.calls) await preflight(call, zeroAddress) },
      })
      const quote = session.quote!
      for (let index = 0; index < session.calls.length; index++) {
        const call = session.calls[index]
        const original = session.outcomes[index]
        if (original.hash) {
          try {
            const payer = await verifyPayerDeployment(call, original.hash)
            session.outcomes[index] = { ...original, state: 'verified', payer }
            persist()
            continue
          } catch (error) {
            session.outcomes[index] = { ...original, state: 'submitted', error: error instanceof Error ? error.message : 'The original payer deployment remains unverified.' }
            persist()
          }
        }
        const binding = quote.expectedTransactions[index]
        const matching = session.records.filter(record => record.tx_uuid?.toLowerCase() === binding.txUuid.toLowerCase() && relayrRecordChain(record) === call.chainId)
        if (matching.length !== 1) continue
        const record = matching[0]
        const entry = record.request
        const hash = relayrDestinationHash(record)
        if (!hash || (original.hash && hash.toLowerCase() !== original.hash.toLowerCase()) || !entry || entry.chain !== call.chainId || !isAddressEqual(entry.target, JB_PROJECT_PAYER_DEPLOYER) ||
            entry.data.toLowerCase() !== call.data.toLowerCase() || BigInt(entry.value) !== 0n || (entry.virtual_nonce ?? 0) !== 0) continue
        session.outcomes[index] = { ...session.outcomes[index], state: 'submitted', hash }
        persist()
        try {
          const payer = await verifyPayerDeployment(call, hash)
          session.outcomes[index] = { chainId: call.chainId, state: 'verified', hash, payer }
        } catch (error) {
          session.outcomes[index].error = error instanceof Error ? error.message : 'The payer address remains unverified.'
        }
        persist()
      }
      if (session.outcomes.every(outcome => outcome.state === 'verified')) {
        session.phase = 'complete'
        persist()
        return session
      }
      throw pollError ?? new Error('Some payer deployments remain unresolved. Check the saved bundle; do not deploy replacement addresses.')
    }

    for (let index = 0; index < session.calls.length; index++) {
      const call = session.calls[index]
      let outcome = session.outcomes[index]
      if (outcome.state === 'verified') {
        await verifyPayerDeployment(call, outcome.hash!, ...proofOf(session, outcome))
        continue
      }
      if (!outcome.settled && (outcome.state === 'sending' || (outcome.state === 'submitted' && !outcome.hash && !outcome.safeProposalHash))) {
        // Recovery runs first: the SDK recovers a send whose wallet reply was lost, before any preparation.
        const attempt = payerAttemptOf(session, index)
        const recovered = await recoverSaved(attempt, publicClient(call.chainId) as unknown as WriteHoldClient,
          'The wallet may have sent this payer deployment without returning a hash. Check its activity before continuing.')
        // A success another tab proved without its transaction: shown as confirming, never deployed again.
        if (recovered.status === 'done' && recovered.result === 'success' && !recovered.hash) throw new SavedAttemptShownError(attempt as SavedAttempt<unknown>, PAYER_SETTLED_CONFIRMING)
        if (recovered.status === 'done' && recovered.result === 'success' && recovered.hash) {
          // The settled hash is the transaction itself (a Safe's execution), followed from here.
          outcome = session.outcomes[index] = recovered.authenticated
            ? { ...outcome, state: 'verified', hash: recovered.hash, payer: recovered.value }
            : { ...outcome, state: 'submitted', hash: recovered.hash, settled: true }
          persist()
          if (outcome.state === 'verified') continue
        } else if (recovered.status === 'done' && recovered.result === 'failed') {
          outcome = session.outcomes[index] = { chainId: call.chainId, state: 'failed', hash: recovered.hash, failedHashes: outcome.failedHashes }
          persist()
        } else {
          // Retired (the user's exit or check, or a definite rejection): nothing is out.
          outcome = session.outcomes[index] = { chainId: call.chainId, state: 'ready', failedHashes: outcome.failedHashes }
          persist()
        }
      }
      if (outcome.state === 'failed') {
        if (session.transport !== 'direct' || !outcome.hash || (outcome.failedHashes?.length ?? 0) >= 16) {
          throw new Error('The original payer deployment must be resolved before creating another address.')
        }
        await requireCanonicalDirectRevert(call, outcome.hash, session.account)
      }
      if (outcome.state === 'ready' || outcome.state === 'failed') {
        const beforeSend = outcome
        const fromBlock = session.transport === 'safe' ? (await publicClient(call.chainId).getBlockNumber()).toString() : undefined
        // Core sends under the deployment's hold (a resumed attempt reviews it
        // first); a mined receipt, revert included, is proven below.
        try {
          await engine.sendReviewed({
            account: session.account,
            calls: [{ ...reviewedDeployment(call, session.transport), intent: payerNamespace(session.id, call.chainId) }],
            title: 'Review payer deployment',
            // Its receipt still confirming is followed; the outcome already reads as submitted.
            follow: {},
            ...(viaSafe ? { description: SAFE_NONCE_GUIDANCE, confirmLabel: 'Agree & continue to Safe' } : {}),
            ...(plan ? { plan } : {}),
            guard: assertNoViewAs,
            reverify: async () => {
              assertAccount(session)
              await preflight(call, session.account)
              assertAccount(session)
            },
            assertWriteState: () => {
              walletGuards[index]()
              assertAccount(session)
            },
            beforeWallet: () => {
              outcome = session.outcomes[index] = { chainId: call.chainId, state: 'sending', failedHashes: beforeSend.failedHashes, fromBlock }
              persist(true)
            },
            onUnsent: () => {
              outcome = session.outcomes[index] = beforeSend
              persist()
            },
            onSubmitted: (_sent, _step, hash) => {
              outcome = session.outcomes[index] = session.transport === 'safe'
                ? { ...outcome, state: 'submitted', safeProposalHash: hash }
                : { ...outcome, state: 'submitted', hash }
              persist()
            },
          }, reviewedSendDeps)
        } catch (error) {
          if (session.outcomes[index].state !== 'submitted' || !(error instanceof engine.ReviewedCallRevertedError || engine.isTransactionReceiptUnavailableError(error))) throw error
        }
      }
      if (!outcome.hash && outcome.safeProposalHash) {
        const onchainHash = await findSafePayerExecution(call, outcome, session.account).catch(() => null)
        // One look of up to a minute: when it ends first, the deployment stays submitted.
        const hash = onchainHash ?? await waitForSafeExecutionHash(call.chainId, outcome.safeProposalHash, { signal, lookMs: 60_000 })
          .catch((error: unknown) => {
            throw !signal.aborted && (error as { name?: unknown } | null)?.name === 'AbortError' ? new Error(SAFE_PAYER_PENDING) : error
          })
        outcome = session.outcomes[index] = { ...outcome, hash }
        persist()
      }
      if (!outcome.hash) throw new Error(outcome.settled ? PAYER_SETTLED_CONFIRMING : 'The original payer deployment hash is unavailable.')
      await publicClient(call.chainId).waitForTransactionReceipt({ hash: outcome.hash, timeout: 60_000 })
      let payer: Address
      try {
        payer = await verifyPayerDeployment(call, outcome.hash, ...proofOf(session, outcome))
      } catch (error) {
        // A settled success always wins: a read that disagrees is asked again, never a failure.
        if (outcome.settled) throw new Error(PAYER_SETTLED_CONFIRMING)
        // An unavailable revert proof never permits another clone deployment.
        if (session.transport === 'direct' && await requireCanonicalDirectRevert(call, outcome.hash, session.account).then(() => true, () => false)) {
          session.outcomes[index] = { ...outcome, state: 'failed', failedHashes: [...(outcome.failedHashes ?? []), outcome.hash],
            error: 'The original deployment reverted. Review this chain again to retry; no payer was created.' }
          persist()
          throw error
        }
        // A saved hash the app can't authenticate: the SDK decides (held, the one check, or its settlement).
        const recovered = await recoverSaved(payerAttemptOf(session, index), publicClient(call.chainId) as unknown as WriteHoldClient,
          error instanceof Error ? error.message : undefined)
        if (recovered.status === 'done' && recovered.result === 'success' && recovered.authenticated) {
          session.outcomes[index] = { ...outcome, state: 'verified', hash: recovered.hash ?? outcome.hash, payer: recovered.value }
          persist()
          continue
        }
        if (recovered.status === 'none') {
          // Retired by the user's check or exit: nothing is held, and the next run reviews it again.
          session.outcomes[index] = { chainId: call.chainId, state: 'ready', failedHashes: outcome.failedHashes }
          persist()
        }
        throw error
      }
      session.outcomes[index] = { ...outcome, state: 'verified', payer }
      persist()
      // Its proof reaches the hold, which settles it.
      const client = publicClient(call.chainId)
      const verified = await client.getTransactionReceipt({ hash: outcome.hash }).catch(() => null)
      if (verified) {
        await requireHeldSettlement(payerHold(session, call), client as unknown as WriteHoldClient, verified,
          viaSafe ? { calls: [{ to: JB_PROJECT_PAYER_DEPLOYER, data: call.data, value: 0n }] } : undefined).catch(() => null)
      }
    }
    session.phase = 'complete'
    persist()
    return session
  })
}

/** Explicitly start another deployment only after every original clone is proven. */
export async function finishPayerDeployment(scope: string, expectedId: string): Promise<void> {
  const displayed = readJournal(expectedId)
  if (!displayed || !aliases(displayed).includes(scope)) throw new Error('The displayed payer attempt changed. Reopen its saved deployment.')
  return locked(aliases(displayed), async () => {
    const session = readJournal(expectedId)
    const current = loadPayerDeployment(scope)
    if (!session || current?.id !== expectedId || session.phase !== 'complete' ||
        !session.outcomes.every(outcome => outcome.state === 'verified')) {
      throw new Error('Resolve the existing payer deployments before starting another attempt.')
    }
    for (let index = 0; index < session.calls.length; index++) {
      await verifyPayerDeployment(session.calls[index], session.outcomes[index].hash!, ...proofOf(session, session.outcomes[index]))
    }
    // Keep a permanent attempt tombstone. New reviews may replace its aliases;
    // a stale tab holding this attempt can never recreate its transaction sends.
    save({ ...session, archived: true }, true)
  })
}
