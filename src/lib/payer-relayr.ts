'use client'

import { getAccount } from '@wagmi/core'
import { JBCoreContracts, jbContractAddress, jbProjectsAbi, type JBChainId } from '@bananapus/nana-sdk-core'
import { buildDeployProjectPayerTx, JB_PROJECT_PAYER_DEPLOYER, jbProjectPayerDeployerAbi } from '@bananapus/nana-sdk-core/v6'
import { decodeEventLog, decodeFunctionData, decodeFunctionResult, encodeFunctionData, isAddress, isAddressEqual, zeroAddress, type Address, type Hex } from 'viem'
import { wagmiConfig, SUPPORTED_CHAINS } from '@/providers/Providers'
import { connectedWallet, publicClient } from '@/lib/wallet-core'
import { assertNoViewAs } from '@/lib/viewAs'
import { simulateStateChangingTransaction } from '@/lib/transaction-simulation'
import { requireFundingChainSelection, requireTransactionReview } from '@/lib/transaction-review'
import { isSafeConnection, waitForSafeExecutionHash } from '@/lib/safe-connector'
import { receiptHasSafeExecutionSuccess, SAFE_EXEC_ABI } from '@/lib/safe'
import { relayrDestinationHash, relayrErrorIsDefiniteNoSubmission, relayrPay, relayrPaymentLabel, relayrPaymentOptions, relayrPoll, relayrPostBundle, relayrRecordChain, relayrSupportsChain, withRelayrScopeLock, type RelayrEntry, type RelayrQuote, type RelayrTransactionRecord } from '@/lib/relayr'

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
}

/** Raw permissionless factory calls have no replay nonce: one journal owns the entire attempt. */
export type PayerDeploymentSession = {
  version: 1
  id: string
  archived?: boolean
  scope: string
  account: Address
  transport: 'direct' | 'safe' | 'relayr'
  calls: PayerDeploymentCall[]
  outcomes: PayerDeploymentOutcome[]
  phase: 'reviewed' | 'publishing' | 'quoted' | 'payment-sending' | 'executing' | 'complete'
  createdAt: number
  quote?: RelayrQuote
  paymentHash?: Hex
  paymentChainId?: number
  records: RelayrTransactionRecord[]
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
      !['reviewed', 'publishing', 'quoted', 'payment-sending', 'executing', 'complete'].includes(value.phase) ||
      !Array.isArray(value.outcomes) || value.outcomes.length !== value.calls.length ||
      !Array.isArray(value.records)) throw new Error('The saved payer deployment is malformed. Keep it pending.')
  value.calls.forEach(assertCall)
  if (value.archived && (value.phase !== 'complete' || !value.outcomes.every(outcome => outcome.state === 'verified'))) {
    throw new Error('An unresolved payer deployment cannot be archived.')
  }
  if (value.transport === 'relayr' && (value.calls.length < 2 || !value.calls.every(call => relayrSupportsChain(call.chainId)))) {
    throw new Error('The saved payer relay contains unsupported destination chains.')
  }
  if ((value.phase === 'quoted' || value.phase === 'publishing') && value.paymentHash) {
    throw new Error('The original payer payment state is inconsistent. Keep it pending.')
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
    transport: safe ? 'safe' : calls.length > 1 && calls.every(call => relayrSupportsChain(call.chainId)) ? 'relayr' : 'direct',
    calls, outcomes: calls.map(call => ({ chainId: call.chainId, state: 'ready' })),
    phase: 'reviewed', createdAt: Date.now(), records: [],
  })
}

function entryOf(call: PayerDeploymentCall): RelayrEntry {
  return { chain: call.chainId, target: JB_PROJECT_PAYER_DEPLOYER, data: call.data, value: '0' }
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
  if (!isAddressEqual(directory, jbContractAddress['6'][JBCoreContracts.JBDirectory][call.chainId])) {
    throw new Error('The payer factory does not use this chain’s canonical Juicebox directory.')
  }
  await client.readContract({ address: jbContractAddress['6'][JBCoreContracts.JBProjects][call.chainId], abi: jbProjectsAbi, functionName: 'ownerOf', args: [BigInt(call.projectId)] })
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
    if (!account || !safeProposalHash || !receiptHasSafeExecutionSuccess(receipt, account, safeProposalHash)) {
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
        isAddressEqual(args.owner, call.owner) && isAddressEqual(args.directory, jbContractAddress['6'][JBCoreContracts.JBDirectory][call.chainId]) &&
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

function assertQuoteBindings(session: PayerDeploymentSession): void {
  const bindings = session.quote?.expectedTransactions
  if (!bindings || bindings.length !== session.calls.length || new Set(bindings.map(item => item.txUuid)).size !== bindings.length) {
    throw new Error('The original payer quote has no complete transaction bindings. Keep it pending.')
  }
  bindings.forEach((binding, index) => {
    const expected = entryOf(session.calls[index])
    if (binding.chain !== expected.chain || binding.entry.chain !== expected.chain ||
        !isAddressEqual(binding.entry.target, expected.target) || binding.entry.data.toLowerCase() !== expected.data.toLowerCase() ||
        BigInt(binding.entry.value) !== 0n || (binding.entry.virtual_nonce ?? 0) !== 0) {
      throw new Error('The original payer quote changed a reviewed deployment.')
    }
  })
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
    const match = logs.find(log => receiptHasSafeExecutionSuccess({ logs: [log] }, account, outcome.safeProposalHash!))
    if (match?.transactionHash) return match.transactionHash
  }
  return null
}

/** Resolve existing outcomes only; never submit replacement clones when a send is uncertain. */
export async function runPayerDeployments(review: PayerDeploymentSession, onUpdate: (session: PayerDeploymentSession) => void): Promise<PayerDeploymentSession> {
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
    if (!original && !active) {
      await requireTransactionReview({
        kind: session.transport === 'direct' ? 'transaction' : 'authorization',
        title: 'Review payer address deployments',
        description: 'Deploy one payer address for each selected project. Each address uses the beneficiary, admin, and behavior shown in its exact factory call.',
        calls: session.calls.map(call => ({ chainId: call.chainId, to: JB_PROJECT_PAYER_DEPLOYER, value: 0n, data: call.data,
          abi: jbProjectPayerDeployerAbi, functionName: 'deployProjectPayer', args: payerDeploymentRequest(call).args,
          label: `Deploy payer for project #${call.projectId}`, contractName: 'JBProjectPayerDeployer' })),
      })
      assertAccount(session)
      persist(true)
    }
    if (session.phase === 'complete') {
      for (let index = 0; index < session.calls.length; index++) {
        await verifyPayerDeployment(session.calls[index], session.outcomes[index].hash!, session.transport === 'relayr' ? undefined : session.account, session.transport === 'safe', session.outcomes[index].safeProposalHash)
      }
      return session
    }
    if (session.transport === 'relayr') {
      if (session.phase === 'reviewed') {
        for (const call of session.calls) await preflight(call, zeroAddress)
        assertAccount(session)
        session.phase = 'publishing'
        persist(true)
        const quote = await relayrPostBundle(session.calls.map(entryOf))
        session.quote = quote
        assertQuoteBindings(session)
        session.phase = 'quoted'
        persist()
      }
      if (!session.quote) throw new Error('The original payer quote response is unavailable. Keep this attempt pending; requesting another bundle could deploy duplicate addresses.')
      assertQuoteBindings(session)
      if (session.phase === 'quoted') {
        const payments = relayrPaymentOptions(session.quote)
        const fundingChain = await requireFundingChainSelection(payments.map(payment => ({ chainId: payment.chain, label: relayrPaymentLabel(payment) })))
        const payment = payments.find(item => item.chain === fundingChain)
        if (!payment) throw new Error('Choose one of the quoted funding chains.')
        const reverify = async () => {
          assertAccount(session)
          for (const call of session.calls) await preflight(call, zeroAddress)
        }
        try {
          const hash = await relayrPay(payment, session.account, session.quote.bundle_uuid, hash => {
            session.paymentHash = hash
            session.phase = 'executing'
            persist()
          }, reverify, () => {
            session.phase = 'payment-sending'
            session.paymentChainId = payment.chain
            persist(true)
          })
          session.paymentHash = hash
          session.phase = 'executing'
          persist()
        } catch (error) {
          if (!session.paymentHash && relayrErrorIsDefiniteNoSubmission(error)) {
            session.phase = 'quoted'
            persist()
          }
          throw error
        }
      }
      let pollError: unknown
      try {
        await relayrPoll(session.quote.bundle_uuid, session.calls.length, records => {
          session.records = records
          persist()
        }, 2_500, 60_000)
      } catch (error) { pollError = error }
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
        const binding = session.quote.expectedTransactions![index]
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
        await verifyPayerDeployment(call, outcome.hash!, session.account, session.transport === 'safe', outcome.safeProposalHash)
        continue
      }
      if (outcome.state === 'sending') throw new Error('The wallet may have sent this payer deployment without returning a hash. Check its activity before continuing.')
      if (outcome.state === 'failed') {
        if (session.transport !== 'direct' || !outcome.hash || (outcome.failedHashes?.length ?? 0) >= 16) {
          throw new Error('The original payer deployment must be resolved before creating another address.')
        }
        await requireCanonicalDirectRevert(call, outcome.hash, session.account)
      }
      if (outcome.state === 'ready' || outcome.state === 'failed') {
        await requireTransactionReview({ title: 'Review payer deployment', calls: [{ chainId: call.chainId, to: JB_PROJECT_PAYER_DEPLOYER, value: 0n, data: call.data,
          abi: jbProjectPayerDeployerAbi, functionName: 'deployProjectPayer', args: payerDeploymentRequest(call).args, contractName: 'JBProjectPayerDeployer' }] })
        const { wallet } = await connectedWallet(call.chainId, { expected: session.account, changedError: 'The payer deployment wallet changed.' })
        assertAccount(session)
        await preflight(call, session.account)
        assertAccount(session)
        const beforeSend = outcome
        const fromBlock = session.transport === 'safe' ? (await publicClient(call.chainId).getBlockNumber()).toString() : undefined
        assertAccount(session)
        outcome = session.outcomes[index] = { chainId: call.chainId, state: 'sending', failedHashes: beforeSend.failedHashes, fromBlock }
        persist(true)
        try {
          const hash = await wallet.sendTransaction({ account: session.account, to: JB_PROJECT_PAYER_DEPLOYER, data: call.data, value: 0n, gas: DEPLOY_GAS })
          outcome = session.outcomes[index] = session.transport === 'safe'
            ? { ...outcome, state: 'submitted', safeProposalHash: hash }
            : { ...outcome, state: 'submitted', hash }
          persist()
        } catch (error) {
          if (outcome.state === 'sending' && relayrErrorIsDefiniteNoSubmission(error)) {
            session.outcomes[index] = beforeSend
            persist()
          }
          throw error
        }
      }
      if (!outcome.hash && outcome.safeProposalHash) {
        const onchainHash = await findSafePayerExecution(call, outcome, session.account).catch(() => null)
        const hash = onchainHash ?? await waitForSafeExecutionHash(call.chainId, outcome.safeProposalHash, { signal: AbortSignal.timeout(60_000) })
        outcome = session.outcomes[index] = { ...outcome, hash }
        persist()
      }
      if (!outcome.hash) throw new Error('The original payer deployment hash is unavailable.')
      await publicClient(call.chainId).waitForTransactionReceipt({ hash: outcome.hash, timeout: 60_000 })
      let payer: Address
      try {
        payer = await verifyPayerDeployment(call, outcome.hash, session.account, session.transport === 'safe', outcome.safeProposalHash)
      } catch (error) {
        if (session.transport === 'direct') {
          try {
            await requireCanonicalDirectRevert(call, outcome.hash, session.account)
            session.outcomes[index] = { ...outcome, state: 'failed', failedHashes: [...(outcome.failedHashes ?? []), outcome.hash],
              error: 'The original deployment reverted. Review this chain again to retry; no payer was created.' }
            persist()
          } catch { /* An unavailable proof never permits another clone deployment. */ }
        }
        throw error
      }
      session.outcomes[index] = { ...outcome, state: 'verified', payer }
      persist()
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
      await verifyPayerDeployment(session.calls[index], session.outcomes[index].hash!,
        session.transport === 'relayr' ? undefined : session.account, session.transport === 'safe', session.outcomes[index].safeProposalHash)
    }
    // Keep a permanent attempt tombstone. New reviews may replace its aliases;
    // a stale tab holding this attempt can never recreate its transaction sends.
    save({ ...session, archived: true }, true)
  })
}
