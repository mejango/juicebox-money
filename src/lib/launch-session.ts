/**
 * Multichain launch progress persisted to localStorage (the Relayr
 * pending-session pattern in relayr.ts). A multichain launch prepares one
 * call per chain around ONE shared salt — the salt pairs the suckers
 * and pins the deterministic token address — so a refresh between chains
 * must resume with the SAME salt and pinned metadata. Re-launching from
 * scratch would mint a duplicate project on the already-launched chains and
 * break the sucker mesh.
 *
 * The record holds everything a resume needs to submit the REMAINING chains
 * byte-compatibly with the already-launched ones: the salt, the pinned
 * project URI and store (item metadata already on IPFS), the exact
 * per-chain launch plans (shared deploy start, resolved recipients), and
 * each chain's progress. Relayr launches additionally preserve the original
 * signer, payment chain, exact authorizations, and funding/recovery journal.
 */

import type { LaunchPlan } from '@/lib/launch'
import type { Address } from 'viem'
import type { LaunchRelayrJournal } from '@/lib/launch-relayr'
import { DRAFT_KEY } from '@/lib/draft'

export const LAUNCH_SESSION_KEY = 'jbm-launch-pending-v1'

const PHASES = [
  'pending',
  'signing',
  'confirming',
  'uncertain',
  'done',
  'failed',
] as const

export type LaunchChainStatus = {
  phase: (typeof PHASES)[number]
  txHash?: `0x${string}`
  safeProposalHash?: `0x${string}`
  projectId?: number
  /**
   * Restored from `signing`: a wallet may have broadcast after the page reloaded, so this
   * chain COULD already be launched with no hash to prove it. Resuming re-sends, which would
   * mint a duplicate — surface a check-your-wallet warning before retrying.
   */
  unverifiedSend?: true
}

export type LaunchSession = {
  /** Absent on legacy sessions, which always resume through direct transactions. */
  transport?: 'direct' | 'relayr'
  account?: Address
  paymentChainId?: number
  relayr?: LaunchRelayrJournal
  /** The launch id: the create2/sucker salt shared by every chain. */
  salt: `0x${string}`
  /** The pinned project metadata URI (shared by every chain). */
  projectUri: string
  /** The pinned store — item metadata URIs already on IPFS. */
  store: LaunchPlan['store']
  /** The exact per-chain plans the run was built with. A resume must reuse
   *  them verbatim: rebuilding would drift the shared deploy start and any
   *  ENS-resolved recipients away from the already-launched chains. */
  plans: Record<number, LaunchPlan>
  /** Every chain in the launch set, in launch order. */
  chains: number[]
  statuses: Record<number, LaunchChainStatus>
  createdAt: number
}

// Store items carry bigints (prices, split project ids); JSON can't. Tag
// them as digit strings so the round trip is exact and unambiguous.
const BIGINT_TAG = '#bigint'

function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? `${value}${BIGINT_TAG}` : value
}

function reviver(_key: string, value: unknown): unknown {
  return typeof value === 'string' && /^-?\d+#bigint$/.test(value)
    ? BigInt(value.slice(0, -BIGINT_TAG.length))
    : value
}

export function saveLaunchSession(session: LaunchSession): boolean {
  if (typeof window === 'undefined') return false
  try {
    const existing = window.localStorage.getItem(LAUNCH_SESSION_KEY)
    if (existing) {
      const salt = (JSON.parse(existing) as { salt?: unknown }).salt
      if (typeof salt === 'string' && salt !== session.salt) return false
    }
    window.localStorage.setItem(
      LAUNCH_SESSION_KEY,
      JSON.stringify(session, replacer),
    )
    return true
  } catch {
    // Storage may be unavailable; the in-memory state still drives the run.
    return false
  }
}

/**
 * The persisted session, shape-checked and coerced to a resume-safe view: a
 * chain interrupted mid-signature (no transaction hash to wait on) resumes
 * as `pending` so it re-sends; a submitted transaction keeps its hash so
 * the resume waits on it instead of sending again.
 */
export function loadLaunchSession({ strict = false }: { strict?: boolean } = {}): LaunchSession | null {
  if (typeof window === 'undefined') {
    if (strict) throw new Error('Saved launch authorizations could not be read. Restore browser storage before signing another action.')
    return null
  }
  try {
    const raw = window.localStorage.getItem(LAUNCH_SESSION_KEY)
    if (raw === null) return null
    const value = JSON.parse(raw, reviver) as Partial<LaunchSession>
    if (
      typeof value.salt !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(value.salt) ||
      typeof value.projectUri !== 'string' ||
      !value.projectUri ||
      typeof value.store !== 'object' ||
      value.store === null ||
      !Array.isArray(value.chains) ||
      value.chains.length === 0 ||
      !value.chains.every(
        chainId =>
          typeof chainId === 'number' &&
          Number.isSafeInteger(chainId) &&
          chainId > 0,
      ) ||
      typeof value.plans !== 'object' ||
      value.plans === null ||
      !value.chains.every(
        chainId =>
          typeof (value.plans as Record<number, unknown>)[chainId] ===
            'object' &&
          (value.plans as Record<number, unknown>)[chainId] !== null,
      ) ||
      typeof value.statuses !== 'object' ||
      value.statuses === null ||
      typeof value.createdAt !== 'number'
    ) {
      if (strict) throw new Error()
      return null
    }
    if (strict && value.relayr !== undefined) {
      const journal = value.relayr
      const signed = [...(journal.signed ?? []), ...(journal.superseded ?? [])]
      if (typeof journal !== 'object' || !Array.isArray(journal.signed) ||
          (journal.superseded !== undefined && !Array.isArray(journal.superseded)) ||
          !Array.isArray(journal.records) || typeof journal.account !== 'string' || !/^0x[0-9a-fA-F]{40}$/u.test(journal.account) ||
          !['signing', 'quoting', 'quoted', 'payment-signing', 'submitted', 'executing'].includes(journal.phase) ||
          (journal.phase !== 'signing' && journal.published !== true) ||
          (journal.published !== undefined && journal.published !== true) ||
          (journal.abandonable !== undefined && journal.abandonable !== true) ||
          signed.some(item => !item || !Number.isSafeInteger(item.chainId) || !value.chains!.includes(item.chainId) ||
            !Number.isSafeInteger(item.deadline) || item.deadline < 1 || typeof item.nonce !== 'string' || !/^\d+$/u.test(item.nonce) ||
            !item.entry || item.entry.chain !== item.chainId || typeof item.entry.target !== 'string' || !/^0x[0-9a-fA-F]{40}$/u.test(item.entry.target) ||
            typeof item.entry.data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(item.entry.data) || typeof item.entry.value !== 'string' || !/^\d+$/u.test(item.entry.value))) throw new Error()
    }
    // A pinned plan without `projectName` launched its chains with the store
    // name as the revnet description name; a resume must re-encode
    // byte-identically, so backfill from the store instead of leaving the
    // field undefined.
    for (const chainId of value.chains) {
      const plan = (value.plans as Record<number, Partial<LaunchPlan>>)[chainId]
      if (typeof plan.projectName !== 'string') {
        plan.projectName = plan.store?.name ?? ''
      }
    }
    const statuses: Record<number, LaunchChainStatus> = {}
    for (const chainId of value.chains) {
      const status = (value.statuses as Record<number, unknown>)[chainId]
      statuses[chainId] = coerceStatus(status)
    }
    return {
      ...(value.transport === 'relayr' || value.transport === 'direct' ? { transport: value.transport } : {}),
      ...(value.account ? { account: value.account } : {}),
      ...(value.paymentChainId ? { paymentChainId: value.paymentChainId } : {}),
      ...(value.relayr ? { relayr: value.relayr } : {}),
      salt: value.salt as `0x${string}`,
      projectUri: value.projectUri,
      store: value.store,
      plans: value.plans,
      chains: value.chains,
      statuses,
      createdAt: value.createdAt,
    }
  } catch {
    if (strict) throw new Error('Saved launch authorizations could not be read. Restore browser storage and recover the original launch before signing another action.')
    return null
  }
}

/** Published signatures can still execute; never discard their recovery journal as an ordinary form reset. */
export function canAbandonRelayrLaunch(session: LaunchSession): boolean {
  return !session.relayr || session.relayr.abandonable === true ||
    (session.relayr.phase === 'signing' && !session.relayr.published && !session.relayr.retryNonces)
}

function coerceStatus(value: unknown): LaunchChainStatus {
  if (typeof value !== 'object' || value === null) return { phase: 'pending' }
  const status = value as Partial<LaunchChainStatus>
  const txHash =
    typeof status.txHash === 'string' && /^0x[0-9a-fA-F]+$/.test(status.txHash)
      ? (status.txHash as `0x${string}`)
      : undefined
  const safeProposalHash =
    typeof status.safeProposalHash === 'string' &&
    /^0x[0-9a-fA-F]+$/.test(status.safeProposalHash)
      ? (status.safeProposalHash as `0x${string}`)
      : undefined
  let phase = PHASES.includes(status.phase as (typeof PHASES)[number])
    ? (status.phase as LaunchChainStatus['phase'])
    : 'pending'
  // Nothing provably submitted — the resume must re-send.
  //
  // `signing` is the dangerous one: a mobile/WalletConnect wallet can broadcast AFTER the
  // dapp reloads, so there is no hash here even though a launch may be in flight. Re-sending
  // then mints a DUPLICATE project on that chain. The window is inherent (no hash exists to
  // check), so the flag below lets the UI warn before retrying instead of resuming silently.
  const wasSigning = phase === 'signing'
  if (phase === 'signing' || (phase === 'confirming' && !txHash)) {
    phase = 'pending'
  }
  return {
    phase,
    ...(wasSigning ? { unverifiedSend: true as const } : {}),
    ...(phase !== 'pending' && txHash ? { txHash } : {}),
    ...(phase !== 'pending' && safeProposalHash ? { safeProposalHash } : {}),
    ...(typeof status.projectId === 'number'
      ? { projectId: status.projectId }
      : {}),
  }
}

/** Fold one chain's progress into the persisted session (no-op when no
 *  launch session is active). */
export function recordLaunchChainStatus(
  chainId: number,
  status: LaunchChainStatus,
): void {
  const session = loadLaunchSession()
  if (!session || !session.chains.includes(chainId)) return
  saveLaunchSession({
    ...session,
    statuses: { ...session.statuses, [chainId]: status },
  })
}

/** The chains a resume still has to launch, in launch order. */
export function remainingLaunchChains(session: LaunchSession): number[] {
  return session.chains.filter(
    chainId => session.statuses[chainId]?.phase !== 'done',
  )
}

/** A fully-launched session leaves nothing to resume: drop the record and
 *  the saved form draft it was built from. */
export function completeLaunchSession(expectedSalt?: `0x${string}`): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (expectedSalt && loadLaunchSession()?.salt !== expectedSalt) return false
    window.localStorage.removeItem(LAUNCH_SESSION_KEY)
    window.localStorage.removeItem(DRAFT_KEY)
    return true
  } catch {
    // Storage may be unavailable. There is no sensitive payload to clean up.
    return false
  }
}

/**
 * Give up on a failed launch WITHOUT marking it complete: drop the pinned
 * session (its salt and plans will never be reused) but KEEP the saved form
 * draft — the user abandons a failed run to fix its configuration, and a
 * deterministically-reverting config would otherwise loop on Retry forever
 * with no exit short of hand-clearing localStorage.
 */
export function abandonLaunchSession(expectedSalt?: `0x${string}`): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (expectedSalt && loadLaunchSession()?.salt !== expectedSalt) return false
    window.localStorage.removeItem(LAUNCH_SESSION_KEY)
    return true
  } catch {
    // Storage may be unavailable. There is no sensitive payload to clean up.
    return false
  }
}
