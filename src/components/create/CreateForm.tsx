'use client'

import { JB_CHAINS, type JBChainId } from '@bananapus/nana-sdk-core'
import { getProjectCreationFee } from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { BaseError, parseUnits, type Address, type PublicClient } from 'viem'
import { useConfig, useSwitchChain, useWriteContract } from 'wagmi'
import { getPublicClient, waitForTransactionReceipt } from 'wagmi/actions'
import { useWallet } from '@/hooks/useWallet'
import { formatTokenAmount, truncateAddress } from '@/lib/format'
import { cidV0ToBytes32 } from '@/lib/ipfs-cid'
import { resolvedAddress } from '@/lib/ens'
import {
  FOREVER_SECONDS,
  buildLaunchRequest,
  projectIdFromReceipt,
  type ApprovalDeadline,
  type LaunchPlan,
  type SplitConfig,
  type StageRules,
  type StoreItem,
  type TreasuryCurrency,
} from '@/lib/launch'
import { splitOk, type DraftSplit } from './SplitsEditor'
import {
  StageRulesEditor,
  newDraftStage,
  stageDurationSeconds,
  stageOk,
  stageSummary,
  type DraftStage,
} from './StageRulesEditor'
import { CheckIcon, SubSection } from './ui'
import { chainChipClass } from '@/components/ChainBadge'
import { chainName, toUrn } from '@/lib/urn'
import { SUPPORTED_CHAINS } from '@/providers/Providers'
import {
  StoreEditor,
  itemOk,
  type DraftItem,
} from './StoreEditor'

type SupportedChainId = (typeof SUPPORTED_CHAINS)[number]['id']

const MAX_LOGO_BYTES = 1024 * 1024

type ChainStatus = {
  phase: 'pending' | 'signing' | 'confirming' | 'done' | 'failed'
  txHash?: `0x${string}`
  projectId?: number
  error?: string
  indexed?: boolean
}

function friendlyError(e: unknown): string {
  const message =
    e instanceof BaseError
      ? e.shortMessage
      : e instanceof Error
        ? e.message
        : 'Something went wrong.'
  return /reject|denied|cancel/i.test(message)
    ? 'You cancelled in your wallet.'
    : message
}

function deriveSymbol(name: string): string {
  const words = name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
  const initials = words.map(w => w[0]).join('')
  const symbol = (initials.length >= 2 ? initials : (words[0] ?? '')).slice(0, 8)
  return symbol || 'ITEMS'
}

function randomSalt(): `0x${string}` {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return `0x${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`
}

const STEP_TILES = [
  'bg-split-400 text-ink',
  'bg-bluebs-400 text-ink',
  'bg-grape-400 text-ink',
  'bg-melon-400 text-ink',
]

const WIZARD_STEPS = ['Basics', 'Rules', 'Store', 'Launch']

function StepBadge({ n }: { n: number }) {
  return (
    <span
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-agrandir text-sm font-medium ${
        STEP_TILES[(n - 1) % STEP_TILES.length]
      }`}
    >
      {n}
    </span>
  )
}

export function CreateForm() {
  const { isConnected, address, openSignIn } = useWallet()
  const config = useConfig()
  const { switchChainAsync } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()

  // Wallet state only exists client-side; render the signed-out shell on the
  // server so hydration always matches.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const connected = mounted && isConnected && !!address

  // --- 1: Identity + treasury + chains ---
  const [name, setName] = useState('')
  const [tagline, setTagline] = useState('')
  const [description, setDescription] = useState('')
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [logoPreview, setLogoPreview] = useState<string | null>(null)
  const [logoError, setLogoError] = useState<string | null>(null)
  const [coverFile, setCoverFile] = useState<File | null>(null)
  const [coverPreview, setCoverPreview] = useState<string | null>(null)
  const [coverError, setCoverError] = useState<string | null>(null)
  const [payNotice, setPayNotice] = useState('')
  const [links, setLinks] = useState({
    infoUri: '',
    twitter: '',
    discord: '',
    telegram: '',
    whatsapp: '',
    instagram: '',
  })
  const setLink = (key: keyof typeof links, value: string) =>
    setLinks(prev => ({ ...prev, [key]: value.slice(0, 300) }))
  const [currency, setCurrency] = useState<TreasuryCurrency>('eth')
  const [selected, setSelected] = useState<number[]>(
    SUPPORTED_CHAINS.map(chain => chain.id),
  )

  // --- 2: Rules (one entry per queued ruleset/stage) ---
  const [stages, setStages] = useState<DraftStage[]>([newDraftStage(true)])
  const [afterMode, setAfterMode] = useState<'wait' | 'terminal' | 'cycle'>(
    'wait',
  )
  const [approvalDeadline, setApprovalDeadline] =
    useState<ApprovalDeadline>('1day')
  const setStage = (id: number, next: DraftStage) =>
    setStages(prev => prev.map(s => (s.id === id ? next : s)))
  // Step 1's Basics starts open; everything else starts collapsed.
  const [openSection, setOpenSection] = useState<Record<string, boolean>>({
    basics: true,
  })
  const toggleSection = (key: string) =>
    setOpenSection(prev => ({ ...prev, [key]: !prev[key] }))

  // --- Wizard step (all sections stay mounted; inactive ones hide) ---
  const [step, setStep] = useState(0)
  const goToStep = (i: number) => {
    setStep(i)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // --- 3: Store ---
  const [items, setItems] = useState<DraftItem[]>([])

  // --- Launch state ---
  const [phase, setPhase] = useState<
    'form' | 'pinning' | 'launching' | 'failed' | 'done'
  >('form')
  const [statuses, setStatuses] = useState<Record<number, ChainStatus>>({})
  const statusesRef = useRef(statuses)
  statusesRef.current = statuses
  const [launchError, setLaunchError] = useState<string | null>(null)
  // Everything pinned + the assembled plan, once per run; retries reuse it
  // (inputs lock while busy). Building the plan up front also keeps its
  // validation throws inside launch()'s try.
  const pinnedRef = useRef<{
    projectUri: string
    store: LaunchPlan['store']
    salt: `0x${string}`
    plans: Record<number, LaunchPlan>
  } | null>(null)

  const busy = phase !== 'form'
  const isUsd = currency === 'usdc'
  const unitLabel = isUsd ? 'USD' : 'ETH'

  useEffect(
    () => () => {
      if (logoPreview) URL.revokeObjectURL(logoPreview)
      if (coverPreview) URL.revokeObjectURL(coverPreview)
    },
    [logoPreview, coverPreview],
  )

  const onLogoChange = (file: File | null) => {
    setLogoError(null)
    if (logoPreview) URL.revokeObjectURL(logoPreview)
    if (!file) {
      setLogoFile(null)
      setLogoPreview(null)
      return
    }
    if (!file.type.startsWith('image/')) {
      setLogoError('Please pick an image file.')
      return
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError('Logos must be under 1MB.')
      return
    }
    setLogoFile(file)
    setLogoPreview(URL.createObjectURL(file))
  }

  const onCoverChange = (file: File | null) => {
    setCoverError(null)
    if (coverPreview) URL.revokeObjectURL(coverPreview)
    if (!file) {
      setCoverFile(null)
      setCoverPreview(null)
      return
    }
    if (!file.type.startsWith('image/')) {
      setCoverError('Please pick an image file.')
      return
    }
    if (file.size > MAX_LOGO_BYTES) {
      setCoverError('Cover images must be under 1MB.')
      return
    }
    setCoverFile(file)
    setCoverPreview(URL.createObjectURL(file))
  }

  // Live creation fees, read per chain through the app's wagmi clients.
  const { data: fees } = useQuery({
    queryKey: ['creationFees'],
    staleTime: 60_000,
    queryFn: async () => {
      const results = await Promise.allSettled(
        SUPPORTED_CHAINS.map(chain =>
          getProjectCreationFee(
            getPublicClient(config, { chainId: chain.id }) as PublicClient,
            chain.id as JBChainId,
          ),
        ),
      )
      const byChain: Record<number, bigint | null> = {}
      SUPPORTED_CHAINS.forEach((chain, i) => {
        const r = results[i]
        byChain[chain.id] = r.status === 'fulfilled' ? r.value : null
      })
      return byChain
    },
  })

  const totalFee = useMemo(() => {
    if (!fees) return null
    let total = 0n
    for (const id of selected) {
      const fee = fees[id]
      if (fee === null || fee === undefined) return null
      total += fee
    }
    return total
  }, [fees, selected])

  const nameOk = name.trim().length > 0
  const stagesOk = stages.every((s, i) => stageOk(s, i === 0))
  // A 0-duration non-final stage never advances (website/'s badStageIndex).
  const badStage = stages.findIndex(
    (s, i) => i < stages.length - 1 && stageDurationSeconds(s) === 0,
  )
  const itemsOk = items.every(itemOk)
  const canLaunch =
    nameOk &&
    selected.length > 0 &&
    stagesOk &&
    badStage === -1 &&
    itemsOk &&
    (phase === 'form' || phase === 'failed')

  const toggleChain = (id: number) => {
    if (busy) return
    setSelected(prev =>
      prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id].sort(),
    )
  }

  const updateStatus = (chainId: number, patch: Partial<ChainStatus>) => {
    setStatuses(prev => ({
      ...prev,
      [chainId]: { ...(prev[chainId] ?? { phase: 'pending' }), ...patch },
    }))
  }

  /** Recipient half of a split row for one chain: an address (per-chain
   *  override → default; ENS already resolved into the sync cache), or a
   *  project id plus the beneficiary who receives that project's tokens. */
  const toRecipient = (row: DraftSplit, chainId: number) => {
    const override = row.perChain[chainId]?.trim() || ''
    if (row.kind === 'project') {
      const id = (override || row.projectId).trim().replace('#', '')
      return {
        projectId: BigInt(id),
        beneficiary: resolvedAddress(row.beneficiary)!,
      }
    }
    return {
      projectId: 0n,
      beneficiary: resolvedAddress(override || row.recipient)!,
    }
  }

  /** Percent-mode rows → SplitConfigs (percent out of 1e9). */
  const toSplitConfigs = (rows: DraftSplit[], chainId: number): SplitConfig[] =>
    rows
      .filter(s => splitOk(s, 'percent'))
      .map(row => ({
        percent: Math.round(Number(row.value) * 1e7),
        ...toRecipient(row, chainId),
      }))

  /** Routed payouts for one stage: '%' mode splits all funds (unlimited
   *  limit); 'amounts' mode fixes each recipient's amount — the payout
   *  limit is the sum and split percents are the amounts' shares of it
   *  (last row absorbs rounding so the limit is fully allocated). */
  const buildRoutedSplits = (
    stage: DraftStage,
    chainId: number,
  ): { splits: SplitConfig[]; limit: bigint | null } => {
    if (stage.routedMode === 'all') {
      return { splits: toSplitConfigs(stage.payoutSplits, chainId), limit: null }
    }
    const valid = stage.payoutSplits.filter(s => splitOk(s, 'amount'))
    const values = valid.map(row => parseUnits(row.value, isUsd ? 6 : 18))
    const total = values.reduce((a, b) => a + b, 0n)
    if (total === 0n) return { splits: [], limit: null }
    const percents = values.map(v => Number((v * 1_000_000_000n) / total))
    percents[percents.length - 1] =
      1_000_000_000 - percents.slice(0, -1).reduce((a, b) => a + b, 0)
    if (percents.some(p => p <= 0)) {
      throw new Error(
        'One payout amount is too small relative to the total — even out the amounts.',
      )
    }
    return {
      splits: valid.map((row, i) => ({
        percent: percents[i],
        ...toRecipient(row, chainId),
      })),
      limit: total,
    }
  }

  /** One draft stage → StageRules (the encoded plan shape). */
  const toStageRules = (
    stage: DraftStage,
    index: number,
    deployStart: number,
    chainId: number,
  ): StageRules => {
    const routed =
      stage.payouts === 'routed' ? buildRoutedSplits(stage, chainId) : null
    const routedAll = stage.payouts === 'routed' && stage.routedMode === 'all'
    const reservedOn =
      Number(stage.reservedPct) > 0 && Number(stage.reservedPct) <= 100
    return {
      duration: stageDurationSeconds(stage),
      // Stage 1 honors a scheduled start; multichain launches pin a shared
      // near-future start so every chain begins at the same moment. Later
      // stages chain automatically (encoded 0 in launch.ts).
      mustStartAtOrAfter:
        index === 0
          ? stage.scheduleOn && stage.schedule
            ? Math.floor(new Date(stage.schedule).getTime() / 1000)
            : selected.length > 1
              ? deployStart
              : 0
          : 0,
      // Empty rate on a later stage = keep the previous (cut) rate.
      weight:
        stage.issuanceRate.trim() === '' && index > 0
          ? 0n
          : parseUnits(stage.issuanceRate || '0', 18),
      weightCutPercent: Math.round(Number(stage.cutPct || '0') * 1e7),
      reservedPercent: Math.round(Number(stage.reservedPct || '0') * 100),
      reservedSplits: reservedOn
        ? toSplitConfigs(stage.reservedSplits, chainId)
        : [],
      payouts: stage.payouts,
      payoutSplits: routed?.splits ?? [],
      payoutLimitAmount: routed?.limit ?? null,
      holdFees: stage.payouts !== 'none' && stage.holdFees,
      cashOutTaxRate: stage.cashOuts && !routedAll ? stage.cashOutTax : null,
      allowOwnerMinting: stage.ownerMinting,
      pausePay: false,
    }
  }

  /** Per-chain launch plans (recipients can differ per chain), sharing one
   *  deployStart so multichain first rulesets begin together. */
  const buildPlans = (
    store: LaunchPlan['store'],
  ): Record<number, LaunchPlan> => {
    const deployStart = Math.floor(Date.now() / 1000) + 600
    return Object.fromEntries(
      selected.map(chainId => [
        chainId,
        {
          currency,
          stages: stages.map((stage, i) =>
            toStageRules(stage, i, deployStart, chainId),
          ),
          afterMode,
          approvalDeadline,
          store,
        },
      ]),
    )
  }

  const pinFile = async (file: File): Promise<string> => {
    const form = new FormData()
    form.append('file', file)
    const res = await fetch('/api/ipfs/pin-file', { method: 'POST', body: form })
    const json = (await res.json()) as { cid?: string; error?: string }
    if (!res.ok || !json.cid) {
      throw new Error(json.error ?? 'Image upload failed — try again.')
    }
    return `ipfs://${json.cid}`
  }

  /** Pin logo, project metadata, and store items. Returns everything the
   *  per-chain launches need. */
  const pinAll = async (): Promise<
    Omit<NonNullable<typeof pinnedRef.current>, 'plans'>
  > => {
    const logoUri = logoFile ? await pinFile(logoFile) : undefined
    const coverImageUri = coverFile ? await pinFile(coverFile) : undefined
    const res = await fetch('/api/ipfs/pin-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        projectTagline: tagline.trim() || undefined,
        description: description.trim() || undefined,
        logoUri,
        coverImageUri,
        payDisclosure: payNotice.trim() || undefined,
        infoUri: links.infoUri.trim() || undefined,
        twitter: links.twitter.trim().replace(/^@/, '') || undefined,
        discord: links.discord.trim() || undefined,
        telegram: links.telegram.trim() || undefined,
        whatsapp: links.whatsapp.trim() || undefined,
        instagram: links.instagram.trim().replace(/^@/, '') || undefined,
      }),
    })
    const json = (await res.json()) as { cid?: string; error?: string }
    if (!res.ok || !json.cid) {
      throw new Error(json.error ?? 'Saving project details failed — try again.')
    }
    const projectUri = `ipfs://${json.cid}`

    const pinned: StoreItem[] = []
    for (const item of items.filter(itemOk)) {
      const imageUri = item.imageFile ? await pinFile(item.imageFile) : undefined
      const itemRes = await fetch('/api/ipfs/pin-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: item.name.trim(),
          description: item.description.trim() || undefined,
          image: imageUri,
        }),
      })
      const itemJson = (await itemRes.json()) as { cid?: string; error?: string }
      if (!itemRes.ok || !itemJson.cid) {
        throw new Error(
          itemJson.error ?? `Saving "${item.name.trim()}" failed — try again.`,
        )
      }
      // parseUnits rounds sub-precision input to 0 — refuse accidental
      // free items (e.g. a 0.0000001 USD price against 6 decimals).
      const price = parseUnits(item.price, isUsd ? 6 : 18)
      if (price === 0n) {
        throw new Error(
          `The price of "${item.name.trim()}" is too small — it rounds to 0.`,
        )
      }
      // Split-sales rows: user enters % of the sale. splitPercent is the
      // summed share (of 1e9); each split's percent is its relative share of
      // that bucket, with the last row absorbing rounding.
      const splitRows = item.splits.filter(s => splitOk(s, 'percent'))
      const totalSplitPct = splitRows.reduce((s, r) => s + Number(r.value), 0)
      let splitPercent = 0
      let splits: SplitConfig[] = []
      if (totalSplitPct > 0) {
        splitPercent = Math.round((totalSplitPct / 100) * 1e9)
        const rel = splitRows.map(r =>
          Math.round((Number(r.value) / totalSplitPct) * 1e9),
        )
        rel[rel.length - 1] =
          1e9 - rel.slice(0, -1).reduce((a, b) => a + b, 0)
        // Store items are shared across chains — no per-chain overrides, so
        // any selected chain resolves the same recipients.
        splits = splitRows.map((r, i) => ({
          percent: rel[i],
          ...toRecipient(r, selected[0]),
        }))
      }
      const reserveOn = item.reserveN.trim() !== ''
      pinned.push({
        price,
        supply: item.supply.trim() === '' ? null : Number(item.supply),
        encodedIpfsUri: cidV0ToBytes32(itemJson.cid),
        splitPercent,
        splits,
        discountPercent: Math.round(Number(item.discountPct || '0') * 2),
        reserveFrequency: reserveOn ? Number(item.reserveN) : 0,
        reserveBeneficiary: reserveOn
          ? resolvedAddress(item.reserveBeneficiary)
          : null,
      })
    }
    // The store collection deploys with every launch (even empty) so the
    // project can stock it later without a ruleset change.
    const store: LaunchPlan['store'] = {
      name: name.trim(),
      symbol: deriveSymbol(name),
      items: pinned,
    }
    return { projectUri, store, salt: randomSalt() }
  }

  /**
   * One wallet transaction per chain, sequentially. Skips chains already
   * done, so a retry resumes exactly where the run stopped.
   */
  const runChains = async (pinned: NonNullable<typeof pinnedRef.current>) => {
    setPhase('launching')
    for (const chainId of selected) {
      if (statusesRef.current[chainId]?.phase === 'done') continue
      updateStatus(chainId, { phase: 'signing', error: undefined })
      try {
        await switchChainAsync({ chainId: chainId as SupportedChainId })
        const client = getPublicClient(config, {
          chainId: chainId as SupportedChainId,
        }) as PublicClient
        // Fees are dynamic and must match msg.value EXACTLY — re-read right
        // before sending, never reuse across chains.
        const creationFee = await getProjectCreationFee(
          client,
          chainId as JBChainId,
        )
        const request = buildLaunchRequest({
          chainId: chainId as JBChainId,
          owner: address!,
          projectUri: pinned.projectUri,
          creationFee,
          plan: pinned.plans[chainId],
          salt: pinned.salt,
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hash = await writeContractAsync(request as any)
        updateStatus(chainId, { phase: 'confirming', txHash: hash })
        const receipt = await waitForTransactionReceipt(config, {
          hash,
          chainId: chainId as SupportedChainId,
        })
        const projectId =
          receipt.status === 'success' ? projectIdFromReceipt(receipt) : null
        if (!projectId) throw new Error('Transaction failed on this chain.')
        updateStatus(chainId, { phase: 'done', projectId })
      } catch (e) {
        updateStatus(chainId, { phase: 'failed', error: friendlyError(e) })
        setPhase('failed')
        return // Stop here — retry resumes from this chain.
      }
    }
    if (selected.every(id => statusesRef.current[id]?.phase === 'done')) {
      setPhase('done')
    }
  }

  const launch = async () => {
    if (!connected) {
      openSignIn()
      return
    }
    if (!canLaunch) return
    setLaunchError(null)
    try {
      if (!pinnedRef.current) {
        setPhase('pinning')
        // Initialize the checklist before the first signature request.
        setStatuses(
          Object.fromEntries(selected.map(id => [id, { phase: 'pending' }])),
        )
        const pinned = await pinAll()
        pinnedRef.current = { ...pinned, plans: buildPlans(pinned.store) }
      }
      await runChains(pinnedRef.current)
    } catch (e) {
      setLaunchError(friendlyError(e))
      setPhase('form')
    }
  }

  const retry = () => {
    if (pinnedRef.current) void runChains(pinnedRef.current)
  }

  // Poll bendystraw for freshly launched projects until they're indexed.
  const doneUnindexed = Object.entries(statuses)
    .filter(([, s]) => s.phase === 'done' && s.projectId && !s.indexed)
    .map(([id]) => Number(id))
  useEffect(() => {
    if (doneUnindexed.length === 0) return
    const tick = async () => {
      for (const chainId of doneUnindexed) {
        const s = statusesRef.current[chainId]
        if (!s?.projectId || s.indexed) continue
        try {
          const res = await fetch(
            `/api/project-ready?chainId=${chainId}&projectId=${s.projectId}`,
          )
          const json = (await res.json()) as { found?: boolean }
          if (json.found) updateStatus(chainId, { indexed: true })
        } catch {
          // Transient — the next tick retries.
        }
      }
    }
    const t = setInterval(tick, 5000)
    void tick()
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneUnindexed.join(',')])

  // ---- Summaries (shown on collapsed subsections / review) ----
  const linkCount = Object.values(links).filter(v => v.trim()).length
  const linksSummary = linkCount > 0 ? `${linkCount} added` : 'None'
  const lastStage = stages[stages.length - 1]
  const lastDuration = stageDurationSeconds(lastStage)
  // "Afterwards" applies only when the last stage is timed (website/ parity).
  const afterApplies = lastDuration > 0 && lastDuration !== FOREVER_SECONDS
  // The approval condition is meaningless when rules end in a forever stage.
  const deadlineApplies =
    lastDuration !== FOREVER_SECONDS &&
    !(afterApplies && afterMode === 'terminal')

  // ---- Success view ----
  if (phase === 'done') {
    return (
      <div className="relative mx-auto max-w-2xl px-4 py-14 sm:px-6 sm:py-20">
        <div className="card p-8 text-center sm:p-10">
          <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-melon-400">
            <CheckIcon className="h-8 w-8 text-ink" />
          </span>
          <h1 className="mt-5 font-agrandir text-3xl font-medium sm:text-4xl">
            {name.trim()} is live!
          </h1>
          <p className="mt-2 text-sm text-smoke-700">
            Your project page is being indexed — it usually takes about a
            minute to show up everywhere.
          </p>

          <ul className="mt-8 space-y-3 text-left">
            {selected.map(chainId => {
              const s = statuses[chainId]
              if (!s?.projectId) return null
              const urn = toUrn(chainId, s.projectId)
              return (
                <li
                  key={chainId}
                  className="flex items-center justify-between gap-3 rounded-xl border border-smoke-200 bg-bone px-4 py-3.5"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-ink">
                      Project #{s.projectId} on {chainName(chainId)}
                    </p>
                    <p className="text-xs text-smoke-700">
                      {s.indexed ? 'Indexed and ready' : 'Indexing…'}
                    </p>
                  </div>
                  {s.indexed ? (
                    <Link
                      href={`/${urn}`}
                      className="btn-primary min-h-[40px] shrink-0 px-5 text-xs"
                    >
                      View project
                    </Link>
                  ) : (
                    <span className="inline-flex min-h-[40px] shrink-0 items-center gap-2 rounded-full border border-smoke-300 px-5 text-sm text-smoke-700">
                      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-smoke-300 border-t-smoke-700" />
                      {urn}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    )
  }

  // ---- Form + progress checklist ----
  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
      <h1 className="font-agrandir-wide text-4xl font-bold leading-tight sm:text-5xl">
        Start a project<span className="text-split-500">.</span>
      </h1>
      <p className="mt-3 max-w-lg text-base leading-relaxed text-smoke-700 sm:text-lg">
        Give it a name, answer a few questions, and launch. Live in minutes —
        you can change the rules any time.
      </p>

      {/* Horizontal stepper */}
      <nav aria-label="Create steps" className="mt-8 flex items-center gap-1.5">
        {WIZARD_STEPS.map((label, i) => (
          <Fragment key={label}>
            {i > 0 ? (
              <span
                aria-hidden
                className={`h-0.5 min-w-3 flex-1 rounded-full ${
                  i <= step ? 'bg-ink' : 'bg-smoke-300'
                }`}
              />
            ) : null}
            <button
              onClick={() => !busy && goToStep(i)}
              disabled={busy}
              aria-current={step === i ? 'step' : undefined}
              className="flex shrink-0 items-center gap-2 disabled:opacity-60"
            >
              <span
                className={`flex h-8 w-8 items-center justify-center rounded-full font-agrandir text-sm font-medium ${
                  step === i
                    ? STEP_TILES[i]
                    : i < step
                      ? 'bg-ink text-bone'
                      : 'border-2 border-smoke-300 bg-white text-smoke-500'
                }`}
              >
                {i < step ? <CheckIcon className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span
                className={`text-sm font-medium ${
                  step === i ? 'text-ink' : 'hidden text-smoke-500 sm:inline'
                }`}
              >
                {label}
              </span>
            </button>
          </Fragment>
        ))}
      </nav>

      {/* 1 — Identity + treasury + chains */}
      <section className={step === 0 ? 'card mt-6 p-6 sm:p-7' : 'hidden'}>
        <div className="flex items-center gap-3">
          <StepBadge n={1} />
          <h2 className="font-agrandir text-xl font-medium">
            What are you making?
          </h2>
        </div>

        <div className="mt-5">
          <SubSection
            label="Basics"
            summary={name.trim() || '—'}
            open={!!openSection.basics}
            onToggle={() => toggleSection('basics')}
          >
            <label className="block">
              <span className="field-label">
                Project name <span className="text-peel-500">*</span>
              </span>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value.slice(0, 100))}
                disabled={busy}
                placeholder="My juicy project"
                className="input-well mt-1.5 min-h-[52px] px-4 text-lg font-medium placeholder:font-normal disabled:opacity-60"
              />
            </label>

            <label className="mt-4 block">
              <span className="flex items-baseline justify-between">
                <span className="field-label">Tagline</span>
                <span className="text-xs text-smoke-500">{tagline.length}/100</span>
              </span>
              <input
                type="text"
                value={tagline}
                onChange={e => setTagline(e.target.value.slice(0, 100))}
                disabled={busy}
                placeholder="One line about your project (optional)"
                className="input-well mt-1.5 min-h-[48px] px-4 text-sm disabled:opacity-60"
              />
            </label>

            <label className="mt-4 block">
              <span className="field-label">Description</span>
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value.slice(0, 5000))}
                disabled={busy}
                rows={4}
                placeholder="Tell supporters what you're building and why it matters (optional)"
                className="input-well mt-1.5 resize-y px-4 py-3 text-sm leading-relaxed disabled:opacity-60"
              />
            </label>

            <div className="mt-4">
              <span className="field-label">Logo</span>
              <div className="mt-1.5 flex items-center gap-4">
                {logoPreview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={logoPreview}
                    alt="Logo preview"
                    className="h-20 w-20 rounded-lg border border-smoke-200 object-cover"
                  />
                ) : (
                  <span className="flex h-20 w-20 items-center justify-center rounded-lg border border-dashed border-smoke-300 text-2xl">
                    🧃
                  </span>
                )}
                <div>
                  <label className="btn-secondary min-h-[40px] cursor-pointer px-4 text-xs">
                    {logoFile ? 'Change image' : 'Upload image'}
                    <input
                      type="file"
                      accept="image/*"
                      disabled={busy}
                      className="sr-only"
                      onChange={e => onLogoChange(e.target.files?.[0] ?? null)}
                    />
                  </label>
                  {logoFile ? (
                    <button
                      onClick={() => onLogoChange(null)}
                      disabled={busy}
                      className="ml-3 text-xs font-medium text-smoke-700 underline underline-offset-2 hover:text-ink"
                    >
                      Remove
                    </button>
                  ) : null}
                  <p className="mt-1.5 text-xs text-smoke-700">
                    Square works best. Up to 1MB — optional.
                  </p>
                  {logoError ? (
                    <p className="mt-1 text-xs text-red-600">{logoError}</p>
                  ) : null}
                </div>
              </div>
            </div>
          </SubSection>

          <SubSection
            label="Cover image"
            summary={coverFile ? 'Added' : 'None'}
            open={!!openSection.cover}
            onToggle={() => toggleSection('cover')}
          >
            {coverPreview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={coverPreview}
                alt="Cover preview"
                className="h-24 w-full rounded-lg border border-smoke-200 object-cover"
              />
            ) : null}
            <div className="mt-2 flex items-center gap-3">
              <label className="btn-secondary min-h-[40px] cursor-pointer px-4 text-xs">
                {coverFile ? 'Change image' : 'Upload image'}
                <input
                  type="file"
                  accept="image/*"
                  disabled={busy}
                  className="sr-only"
                  onChange={e => onCoverChange(e.target.files?.[0] ?? null)}
                />
              </label>
              {coverFile ? (
                <button
                  onClick={() => onCoverChange(null)}
                  disabled={busy}
                  className="text-xs font-medium text-smoke-700 underline underline-offset-2 hover:text-ink"
                >
                  Remove
                </button>
              ) : null}
              <p className="text-xs text-smoke-700">
                Banner across your project page. Wide works best — optional.
              </p>
            </div>
            {coverError ? (
              <p className="mt-1 text-xs text-red-600">{coverError}</p>
            ) : null}
          </SubSection>

          <SubSection
            label="Links"
            summary={linksSummary}
            open={!!openSection.links}
            onToggle={() => toggleSection('links')}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {(
                [
                  ['infoUri', 'Website', 'https://…'],
                  ['twitter', 'X handle', '@handle'],
                  ['discord', 'Discord', 'https://discord.gg/…'],
                  ['telegram', 'Telegram', 'https://t.me/…'],
                  ['whatsapp', 'WhatsApp', 'https://wa.me/…'],
                  ['instagram', 'Instagram', '@handle'],
                ] as const
              ).map(([key, label, placeholder]) => (
                <label key={key} className="block">
                  <span className="text-xs text-smoke-700">{label}</span>
                  <input
                    type="text"
                    value={links[key]}
                    onChange={e => setLink(key, e.target.value)}
                    disabled={busy}
                    placeholder={placeholder}
                    className="input-well mt-1 min-h-[44px] px-3.5 text-sm disabled:opacity-60"
                  />
                </label>
              ))}
            </div>
          </SubSection>

          <SubSection
            label="Payment notice"
            summary={payNotice.trim() ? 'Added' : 'None'}
            open={!!openSection.notice}
            onToggle={() => toggleSection('notice')}
          >
            <p className="text-xs leading-relaxed text-smoke-700">
              Shown to supporters as they check out — a disclaimer, shipping
              note, or anything they should know before paying.
            </p>
            <textarea
              value={payNotice}
              onChange={e => setPayNotice(e.target.value.slice(0, 1000))}
              disabled={busy}
              rows={2}
              placeholder="Optional"
              className="input-well mt-2 resize-y px-4 py-3 text-sm leading-relaxed disabled:opacity-60"
            />
          </SubSection>

          <SubSection
            label="Treasury"
            summary={isUsd ? 'USDC' : 'ETH'}
            open={!!openSection.treasury}
            onToggle={() => toggleSection('treasury')}
          >
            <p className="text-xs leading-relaxed text-smoke-700">
              The token your project holds and accounts in. Payments in other
              tokens convert automatically.
            </p>
            <div className="mt-2.5 flex gap-2">
              {(
                [
                  ['eth', 'ETH'],
                  ['usdc', 'USDC'],
                ] as const
              ).map(([value, label]) => {
                const active = currency === value
                return (
                  <button
                    key={value}
                    onClick={() => !busy && setCurrency(value)}
                    disabled={busy}
                    aria-pressed={active}
                    className={
                      active
                        ? 'inline-flex min-h-[44px] items-center gap-2 rounded-full bg-split-100 px-5 text-sm font-medium text-ink ring-1 ring-ink transition-colors disabled:opacity-60'
                        : 'inline-flex min-h-[44px] items-center rounded-full border border-smoke-300 bg-white px-5 text-sm font-medium text-smoke-700 transition-colors hover:border-smoke-400 hover:text-ink disabled:opacity-60'
                    }
                  >
                    {active ? <CheckIcon className="h-4 w-4" /> : null}
                    {label}
                  </button>
                )
              })}
            </div>
          </SubSection>

          <SubSection
            label="Chains"
            summary={selected.map(id => chainName(id)).join(', ') || 'Pick one'}
            open={!!openSection.chains}
            onToggle={() => toggleSection('chains')}
          >
            <p className="text-xs leading-relaxed text-smoke-700">
              Your project gets the same ID space on every chain you pick.
              You&apos;ll confirm one transaction per chain.
            </p>
            <div className="mt-2.5 flex flex-wrap gap-2">
              {SUPPORTED_CHAINS.map(chain => {
                const active = selected.includes(chain.id)
                return (
                  <button
                    key={chain.id}
                    onClick={() => toggleChain(chain.id)}
                    disabled={busy}
                    aria-pressed={active}
                    className={
                      active
                        ? `inline-flex min-h-[44px] items-center gap-2 rounded-full px-5 text-sm font-medium ring-1 ring-ink transition-colors disabled:opacity-60 ${chainChipClass(chain.id)}`
                        : 'inline-flex min-h-[44px] items-center gap-2 rounded-full border border-smoke-300 bg-white px-5 text-sm font-medium text-smoke-700 transition-colors hover:border-smoke-400 hover:text-ink disabled:opacity-60'
                    }
                  >
                    {active ? <CheckIcon className="h-4 w-4" /> : null}
                    {chainName(chain.id)}
                  </button>
                )
              })}
            </div>
            {selected.length === 0 ? (
              <p className="mt-3 text-sm text-red-600">Pick at least one chain.</p>
            ) : null}
          </SubSection>
        </div>
      </section>

      {/* 2 — Rules: one card per queued ruleset (stage) */}
      <section className={step === 1 ? 'card mt-6 p-6 sm:p-7' : 'hidden'}>
        <div className="flex items-center gap-3">
          <StepBadge n={2} />
          <h2 className="font-agrandir text-xl font-medium">
            How should it work?
          </h2>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-smoke-700">
          The defaults make a simple, flexible project. Rules live in
          rulesets — give one a duration and you can queue what comes next.
        </p>

        <div className="mt-5">
          {stages.map((stage, i) => (
            <div
              key={stage.id}
              className="mt-4 rounded-xl border border-smoke-300 bg-bone first:mt-0"
            >
              <div className="flex items-center justify-between gap-3 px-4 py-3.5">
                <button
                  onClick={() =>
                    setStages(prev =>
                      prev.map(s =>
                        s.id === stage.id
                          ? { ...s, expanded: !s.expanded }
                          : { ...s, expanded: false },
                      ),
                    )
                  }
                  disabled={busy}
                  aria-expanded={stage.expanded}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block font-agrandir text-sm font-medium text-ink">
                    Ruleset #{i + 1}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-smoke-700">
                    {stageSummary(stage, i, unitLabel)}
                  </span>
                </button>
                {i > 0 ? (
                  <button
                    onClick={() =>
                      setStages(prev => prev.filter(s => s.id !== stage.id))
                    }
                    disabled={busy}
                    aria-label={`Remove ruleset ${i + 1}`}
                    className="shrink-0 text-xs font-medium text-smoke-700 underline underline-offset-2 hover:text-ink disabled:opacity-60"
                  >
                    Remove
                  </button>
                ) : null}
                <svg
                  viewBox="0 0 24 24"
                  className={`h-4 w-4 shrink-0 text-smoke-500 transition-transform ${stage.expanded ? 'rotate-180' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </div>
              {stage.expanded ? (
                <div className="px-4 pb-4">
                  <StageRulesEditor
                    stage={stage}
                    onChange={next => setStage(stage.id, next)}
                    isFirst={i === 0}
                    isLast={i === stages.length - 1}
                    index={i}
                    unitLabel={unitLabel}
                    disabled={busy}
                    chainIds={selected}
                  />
                </div>
              ) : null}
            </div>
          ))}

          {badStage !== -1 ? (
            <p className="mt-3 text-sm text-red-600">
              Ruleset #{badStage + 1} needs a duration so Ruleset #
              {badStage + 2} knows when to start.
            </p>
          ) : null}

          {afterApplies ? (
            <div className="mt-5 border-t border-smoke-200 pt-4">
              <span className="field-label">
                Afterwards — when Ruleset #{stages.length} ends
              </span>
              <div className="mt-2 flex flex-wrap items-center gap-2.5">
                <select
                  value={afterMode}
                  onChange={e => {
                    if (e.target.value === 'custom') {
                      setStages(prev => [
                        ...prev.map(s => ({ ...s, expanded: false })),
                        { ...newDraftStage(false), expanded: true },
                      ])
                      setAfterMode('wait')
                    } else {
                      setAfterMode(e.target.value as typeof afterMode)
                    }
                  }}
                  disabled={busy}
                  className="input-well select-caret min-h-[44px] w-full max-w-xs px-3.5 pr-9 text-sm disabled:opacity-60"
                >
                  <option value="wait">Wait</option>
                  <option value="terminal">Terminate</option>
                  <option value="cycle">Cycle</option>
                  <option value="custom">Custom…</option>
                </select>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-smoke-700">
                {afterMode === 'wait'
                  ? 'The project idles — payments and issuance pause until you queue more rules.'
                  : afterMode === 'terminal'
                    ? 'These terms are locked in forever — they can never be changed again.'
                    : 'The ruleset restarts each time it ends. Any issuance cut applies each cycle, and you can still queue changes.'}
              </p>
            </div>
          ) : null}

          {deadlineApplies ? (
            <div className="mt-5 border-t border-smoke-200 pt-4">
              <span className="field-label">Rule-change notice</span>
              <p className="mt-1 text-xs leading-relaxed text-smoke-700">
                The condition a queued rule change must satisfy before it
                takes effect, giving supporters time to review changes.
              </p>
              <select
                value={approvalDeadline}
                onChange={e =>
                  setApprovalDeadline(e.target.value as ApprovalDeadline)
                }
                disabled={busy}
                className="input-well select-caret mt-2 min-h-[44px] w-full max-w-xs px-3.5 pr-9 text-sm disabled:opacity-60"
              >
                <option value="3hours">3 hours</option>
                <option value="1day">1 day</option>
                <option value="3days">3 days</option>
                <option value="7days">7 days</option>
                <option value="none">No notice</option>
              </select>
              {approvalDeadline !== 'none' ? (
                <p className="mt-2 text-xs leading-relaxed text-smoke-700">
                  Queued changes take effect{' '}
                  {
                    {
                      '3hours': '3 hours',
                      '1day': '1 day',
                      '3days': '3 days',
                      '7days': '7 days',
                    }[approvalDeadline]
                  }{' '}
                  after they&apos;re proposed.
                </p>
              ) : null}
              {approvalDeadline === 'none' ? (
                <p className="mt-2 text-xs leading-relaxed text-peel-600">
                  No notice lets the owner make last-second edits before a
                  ruleset takes effect, which supporters may see as risky.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      {/* 3 — Store */}
      <section className={step === 2 ? 'card mt-6 p-6 sm:p-7' : 'hidden'}>
        <div className="flex items-center gap-3">
          <StepBadge n={3} />
          <h2 className="font-agrandir text-xl font-medium">Stock your store</h2>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-smoke-700">
          Sell things right from your project page. Each sale pays your
          treasury, and the buyer gets the item plus your project tokens.
          Optional — you can stock your store any time after launch.
        </p>
        <StoreEditor
          items={items}
          onChange={setItems}
          currencyLabel={unitLabel}
          disabled={busy}
        />
      </section>

      {/* 4 — Review & launch */}
      <section className={step === 3 ? 'card mt-6 p-6 sm:p-7' : 'hidden'}>
        <div className="flex items-center gap-3">
          <StepBadge n={4} />
          <h2 className="font-agrandir text-xl font-medium">
            Review &amp; launch
          </h2>
        </div>

        <dl className="mt-5 space-y-2.5 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-smoke-700">Owner</dt>
            <dd className="font-medium text-ink">
              {connected ? (
                <span>{truncateAddress(address!)}</span>
              ) : (
                <span className="text-smoke-700">Your connected wallet</span>
              )}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-smoke-700">Treasury</dt>
            <dd className="font-medium text-ink">
              {isUsd ? 'USDC' : 'ETH'} on{' '}
              {selected.map(id => chainName(id)).join(', ') || '—'}
            </dd>
          </div>
          {stages.map((stage, i) => (
            <div
              key={stage.id}
              className="flex items-start justify-between gap-3"
            >
              <dt className="shrink-0 text-smoke-700">Ruleset #{i + 1}</dt>
              <dd className="text-right font-medium text-ink">
                {stageSummary(stage, i, unitLabel)}
              </dd>
            </div>
          ))}
          {afterApplies ? (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-smoke-700">Afterwards</dt>
              <dd className="font-medium text-ink">
                {afterMode === 'wait'
                  ? 'Wait for new rules'
                  : afterMode === 'terminal'
                    ? 'Terminate — locked forever'
                    : 'Cycle — repeats'}
              </dd>
            </div>
          ) : null}
          {deadlineApplies ? (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-smoke-700">Rule changes</dt>
              <dd className="font-medium text-ink">
                {approvalDeadline === 'none'
                  ? 'Immediate'
                  : `${
                      { '3hours': '3 hours', '1day': '1 day', '3days': '3 days', '7days': '7 days' }[
                        approvalDeadline
                      ]
                    } notice`}
              </dd>
            </div>
          ) : null}
          {items.length > 0 ? (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-smoke-700">Store</dt>
              <dd className="font-medium text-ink">
                {items.length} item{items.length === 1 ? '' : 's'}
              </dd>
            </div>
          ) : null}
          {selected.map(chainId => (
            <div
              key={chainId}
              className="flex items-center justify-between gap-3"
            >
              <dt className="text-smoke-700">
                Creation fee · {chainName(chainId)}
              </dt>
              <dd className="font-medium tabular-nums text-ink">
                {fees?.[chainId] !== undefined && fees?.[chainId] !== null
                  ? `${formatTokenAmount(fees[chainId]!, 18, 6)} ${
                      JB_CHAINS[chainId as JBChainId]?.nativeTokenSymbol ?? 'ETH'
                    }`
                  : '…'}
              </dd>
            </div>
          ))}
          {selected.length > 1 ? (
            <div className="flex items-center justify-between gap-3 border-t border-smoke-200 pt-2.5">
              <dt className="font-medium text-ink">Total</dt>
              <dd className="font-bold tabular-nums text-ink">
                {totalFee !== null
                  ? `${formatTokenAmount(totalFee, 18, 6)} ETH`
                  : '…'}
              </dd>
            </div>
          ) : null}
        </dl>

        <button
          onClick={launch}
          disabled={connected && !canLaunch}
          className="btn-primary mt-5 min-h-[56px] w-full text-base"
        >
          {phase === 'pinning'
            ? 'Saving your project details…'
            : phase === 'launching'
              ? 'Launching…'
              : phase === 'failed'
                ? 'Try again'
                : !connected
                  ? 'Sign in to launch'
                  : selected.length > 1
                    ? `Launch on ${selected.length} chains`
                    : 'Launch project'}
        </button>

        {launchError ? (
          <p className="mt-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
            {launchError}
          </p>
        ) : null}

        {/* Per-chain progress checklist */}
        {phase === 'launching' ||
        Object.values(statuses).some(s => s.phase !== 'pending') ? (
          <ul className="mt-5 space-y-2" aria-live="polite">
            {selected.map(chainId => {
              const s = statuses[chainId] ?? { phase: 'pending' as const }
              const label =
                s.phase === 'pending'
                  ? 'Waiting'
                  : s.phase === 'signing'
                    ? 'Confirm in your wallet…'
                    : s.phase === 'confirming'
                      ? 'Confirming onchain…'
                      : s.phase === 'done'
                        ? `Launched — Project #${s.projectId}`
                        : (s.error ?? 'Failed')
              return (
                <li
                  key={chainId}
                  className="flex items-center gap-3 rounded-xl border border-smoke-200 bg-white px-4 py-3"
                >
                  {s.phase === 'done' ? (
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-melon-400">
                      <CheckIcon className="h-3.5 w-3.5 text-ink" />
                    </span>
                  ) : s.phase === 'failed' ? (
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 border-red-500 text-xs font-bold text-red-600">
                      !
                    </span>
                  ) : s.phase === 'pending' ? (
                    <span className="h-6 w-6 shrink-0 rounded-full border-2 border-smoke-300" />
                  ) : (
                    <span className="h-6 w-6 shrink-0 animate-spin rounded-full border-2 border-smoke-200 border-t-split-500" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">
                      {chainName(chainId)}
                    </p>
                    <p
                      className={`truncate text-xs ${s.phase === 'failed' ? 'text-red-600' : 'text-smoke-700'}`}
                    >
                      {label}
                    </p>
                  </div>
                  {s.phase === 'failed' && phase === 'failed' ? (
                    <button
                      onClick={retry}
                      className="btn-secondary shrink-0 px-4 py-1.5 text-xs"
                    >
                      Retry
                    </button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        ) : null}
      </section>

      {/* Back / Next wizard footer */}
      <div className="mt-6 flex items-center justify-between">
        <button
          onClick={() => goToStep(step - 1)}
          disabled={busy}
          className={`btn-secondary min-h-[44px] px-6 text-sm ${
            step === 0 ? 'invisible' : ''
          }`}
        >
          ← Back
        </button>
        {step < WIZARD_STEPS.length - 1 ? (
          <button
            onClick={() => goToStep(step + 1)}
            disabled={busy}
            className="btn-primary min-h-[44px] px-6 text-sm"
          >
            Next →
          </button>
        ) : null}
      </div>
    </div>
  )
}
