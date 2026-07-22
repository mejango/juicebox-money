'use client'

import { JB_CHAINS, type JBChainId } from '@bananapus/nana-sdk-core'
import {
  getProjectCreationFee,
  RULESET_WEIGHT_INHERIT,
} from '@bananapus/nana-sdk-core/v6'
import { useQuery } from '@tanstack/react-query'
import Image from 'next/image'
import Link from 'next/link'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import congratsIllustration from '@/assets/illustrations/congrats.png'
import createIllustration from '@/assets/illustrations/create.png'
import {
  parseUnits,
  zeroAddress,
  type Address,
  type PublicClient,
} from 'viem'
import { useConfig, useSwitchChain, useWriteContract } from 'wagmi'
import { getPublicClient, waitForTransactionReceipt } from 'wagmi/actions'
import { useWallet } from '@/hooks/useWallet'
import { friendlyError } from '@/lib/errors'
import { formatTokenAmount, truncateAddress } from '@/lib/format'
import { cidV0ToBytes32 } from '@bananapus/nana-sdk-core'
import { randomSalt } from '@/lib/manage'
import { resolvedAddress } from '@/lib/ens'
import {
  DRAFT_KEY,
  draftFileName,
  parseDraft,
  warnOnDraftDrift,
  type CreateDraft,
} from '@/lib/draft'
import {
  DEFAULT_STORE_FLAGS,
  FOREVER_SECONDS,
  LP_SPLIT_HOOK,
  buildLaunchRequest,
  createSimpleProjectStage,
  nativeBridgeViable,
  projectIdFromReceipt,
  type ApprovalDeadline,
  type LaunchPlan,
  type SplitConfig,
  type StageRules,
  type StoreItem,
  type TreasuryCurrency,
} from '@/lib/launch'
import { erc20Abi } from 'viem'
import { splitOk, type DraftSplit } from './SplitsEditor'
import { AddressField } from './AddressField'
import {
  StageRulesEditor,
  newDraftStage,
  stageCashOutTax,
  stageDurationSeconds,
  stageOk,
  stageSummary,
  stageSummaryParts,
  type DraftStage,
} from './StageRulesEditor'
import {
  AddButton,
  CheckIcon,
  CheckRow,
  Chevron,
  ChipButton,
  OptionRow,
  Piped,
  SubSection,
} from './ui'
import { MultiChainSelect } from '@/components/ChainSelect'
import { ChainIcon } from '@/components/ChainIcon'
import {
  TransactionProgressImage,
  usePreloadTransactionAnimation,
} from '@/components/TransactionInProgress'
import { chainName, toUrn } from '@/lib/urn'
import { requireContractTransactionReview } from '@/lib/transaction-review'
import { SUPPORTED_CHAINS } from '@/providers/Providers'
import {
  StoreEditor,
  itemOk,
  type DraftItem,
} from './StoreEditor'

type SupportedChainId = (typeof SUPPORTED_CHAINS)[number]['id']

const MAX_LOGO_BYTES = 1024 * 1024

/**
 * Logo/cover file-input handler: revoke the old preview, validate, and swap
 * in the new file. `label` names the image kind in the too-big error.
 */
const makeImageHandler =
  (
    preview: string | null,
    setFile: (file: File | null) => void,
    setPreview: (preview: string | null) => void,
    setError: (error: string | null) => void,
    label: string,
  ) =>
  (file: File | null) => {
    setError(null)
    if (preview) URL.revokeObjectURL(preview)
    if (!file) {
      setFile(null)
      setPreview(null)
      return
    }
    if (!file.type.startsWith('image/')) {
      setError('Please pick an image file.')
      return
    }
    if (file.size > MAX_LOGO_BYTES) {
      setError(`${label} must be under 1MB.`)
      return
    }
    setFile(file)
    setPreview(URL.createObjectURL(file))
  }

type ChainStatus = {
  phase: 'pending' | 'signing' | 'confirming' | 'done' | 'failed'
  txHash?: `0x${string}`
  projectId?: number
  error?: string
  indexed?: boolean
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

/** Human labels for the fixed approval-deadline choices. */
const APPROVAL_LABELS: Record<
  Exclude<ApprovalDeadline, 'none' | 'custom'>,
  string
> = {
  '3hours': '3 hours',
  '1day': '1 day',
  '3days': '3 days',
  '7days': '7 days',
}

const TAG_OPTIONS = [
  'AI', 'Art', 'Brand', 'Business', 'Charity', 'Climate', 'Collectibles',
  'Community', 'Creator', 'DAO', 'DeFi', 'DeSci', 'Education', 'Events',
  'Film', 'Fundraising', 'Games', 'Grants', 'Hackathon', 'Media', 'Memes',
  'Music', 'NFT', 'Open Source', 'Podcast', 'Public Goods', 'Research',
  'Social', 'Software', 'Sports', 'Tooling', 'Writing',
]

const STEP_TILES = [
  'bg-peel-300 text-ink',
  'bg-split-400 text-ink',
  'bg-bluebs-400 text-ink',
  'bg-grape-400 text-ink',
  'bg-melon-400 text-ink',
]

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
  usePreloadTransactionAnimation()
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
  const [tags, setTags] = useState<string[]>([])
  const [tosAccepted, setTosAccepted] = useState(false)
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
  /** Standard accounting tokens (multi-select), or one custom ERC-20. */
  const [accepts, setAccepts] = useState<TreasuryCurrency[]>(['eth'])
  const [customOn, setCustomOn] = useState(false)
  const [customAddress, setCustomAddress] = useState('')
  const [customMeta, setCustomMeta] = useState<{
    decimals: number
    symbol: string
  } | null>(null)
  /** Issuance denomination; null = follow accounting. */
  const [issuanceBase, setIssuanceBase] = useState<'eth' | 'usd' | null>(null)
  const [bridge, setBridge] = useState<LaunchPlan['bridge']>('ccip')
  const [bridgeOpen, setBridgeOpen] = useState(false)
  /** Link selected chains with CCIP suckers (multichain launches). */
  const [ownerPerChain, setOwnerPerChain] = useState<Record<number, string>>({})
  const [ownerPerChainOpen, setOwnerPerChainOpen] = useState(false)
  const [approvalCustom, setApprovalCustom] = useState('')
  const [approvalPerChain, setApprovalPerChain] = useState<
    Record<number, string>
  >({})
  const [customChainError, setCustomChainError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number[]>(
    SUPPORTED_CHAINS.map(chain => chain.id),
  )

  // --- 0: Flavor ---
  const [flavor, setFlavor] = useState<CreateDraft['flavor']>('simple')
  /** Project owner (or revnet operator). Empty = the connected wallet. */
  const [owner, setOwner] = useState('')
  const [ticker, setTicker] = useState('')

  // --- 2: Rules (one entry per queued ruleset/stage) ---
  const [stages, setStages] = useState<DraftStage[]>([newDraftStage(true)])
  const [afterMode, setAfterMode] = useState<'wait' | 'terminal' | 'cycle'>(
    'wait',
  )
  const [approvalDeadline, setApprovalDeadline] =
    useState<ApprovalDeadline>('1day')
  const setStage = (id: string, next: DraftStage) =>
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
  const [storeCategories, setStoreCategories] = useState<
    { id: number; name: string }[]
  >([])
  /** null = follow the accounting context picked in Flavor. */
  const [storeCurrency, setStoreCurrency] = useState<
    'eth' | 'usd' | 'token' | null
  >(null)
  const [storeConfigOpen, setStoreConfigOpen] = useState(false)
  const [storeConfig, setStoreConfig] = useState({
    collectionName: '',
    collectionSymbol: '',
    ...DEFAULT_STORE_FLAGS,
  })

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
  const customActive = customOn && customMeta !== null
  const effectiveBase =
    issuanceBase ?? (accepts.includes('eth') ? 'eth' : 'usd')
  const unitLabel = customActive
    ? customMeta.symbol || 'TOKEN'
    : effectiveBase === 'eth'
      ? 'ETH'
      : 'USD'
  const effectiveStoreCurrency =
    storeCurrency ??
    (customOn ? 'token' : accepts.includes('eth') ? 'eth' : 'usd')
  const storeUsd = effectiveStoreCurrency === 'usd'
  const tokenLabel =
    flavor === 'revnet' && ticker.trim() ? `$${ticker.trim()}` : 'tokens'
  const multiToken = !customOn && accepts.length > 1
  const accountingDecimals = customActive
    ? customMeta.decimals
    : accepts.includes('eth')
      ? 18
      : 6
  const storePriceDecimals =
    effectiveStoreCurrency === 'token'
      ? (customMeta?.decimals ?? 18)
      : storeUsd
        ? 6
        : 18
  const storeCurrencyLabel =
    effectiveStoreCurrency === 'token'
      ? (customMeta?.symbol ?? 'TOKEN')
      : storeUsd
        ? 'USD'
        : 'ETH'

  // Verify the custom token on EVERY selected chain: it must exist at the
  // same address with matching decimals everywhere (website/ parity).
  useEffect(() => {
    setCustomMeta(null)
    setCustomChainError(null)
    const address = resolvedAddress(customAddress)
    if (!customOn || !address || selected.length === 0) return
    let stale = false
    const t = setTimeout(async () => {
      const results = await Promise.all(
        selected.map(async chainId => {
          try {
            const client = getPublicClient(config, {
              chainId: chainId as SupportedChainId,
            }) as PublicClient
            const [decimals, symbol] = await Promise.all([
              client.readContract({
                address,
                abi: erc20Abi,
                functionName: 'decimals',
              }),
              client
                .readContract({ address, abi: erc20Abi, functionName: 'symbol' })
                .catch(() => 'TOKEN'),
            ])
            return { chainId, decimals, symbol }
          } catch {
            return { chainId, decimals: null, symbol: null }
          }
        }),
      )
      if (stale) return
      const missing = results.filter(r => r.decimals === null)
      if (missing.length > 0) {
        setCustomChainError(
          `No token found on ${missing
            .map(r => chainName(r.chainId))
            .join(', ')} — it must exist at this address on every selected chain.`,
        )
        return
      }
      const decimalsSet = new Set(results.map(r => r.decimals))
      if (decimalsSet.size > 1) {
        setCustomChainError(
          'The token at this address differs between chains (mismatched decimals).',
        )
        return
      }
      setCustomMeta({
        decimals: results[0].decimals as number,
        symbol: (results[0].symbol as string) || 'TOKEN',
      })
    }, 400)
    return () => {
      stale = true
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customOn, customAddress, selected.join(',')])

  useEffect(
    () => () => {
      if (logoPreview) URL.revokeObjectURL(logoPreview)
      if (coverPreview) URL.revokeObjectURL(coverPreview)
    },
    [logoPreview, coverPreview],
  )

  const onLogoChange = makeImageHandler(
    logoPreview,
    setLogoFile,
    setLogoPreview,
    setLogoError,
    'Logos',
  )
  const onCoverChange = makeImageHandler(
    coverPreview,
    setCoverFile,
    setCoverPreview,
    setCoverError,
    'Cover images',
  )

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
  const isSimpleProject = flavor === 'simple'
  const rulesFlavor = flavor === 'revnet' ? 'revnet' : 'project'
  const anyCashOuts = !isSimpleProject && stages.some(s => s.cashOuts)
  const accountingOk = customOn
    ? resolvedAddress(customAddress) !== null && customMeta !== null
    : accepts.length > 0
  const ownerOk =
    (owner.trim() === '' || resolvedAddress(owner) !== null) &&
    Object.values(ownerPerChain).every(
      v => v.trim() === '' || resolvedAddress(v) !== null,
    )
  const approvalOk =
    isSimpleProject ||
    approvalDeadline !== 'custom' ||
    (resolvedAddress(approvalCustom) !== null &&
      Object.values(approvalPerChain).every(
        v => v.trim() === '' || resolvedAddress(v) !== null,
      ))
  const tickerOk = flavor !== 'revnet' || /^[A-Z0-9]{1,11}$/.test(ticker.trim())
  const stagesOk =
    isSimpleProject ||
    stages.every((s, i) => stageOk(s, i === 0, rulesFlavor, multiToken))
  // A 0-duration non-final stage never advances (website/'s badStageIndex).
  const badStage =
    flavor === 'revnet' || isSimpleProject
      ? -1
      : stages.findIndex(
          (s, i) => i < stages.length - 1 && stageDurationSeconds(s) === 0,
        )
  const itemsOk = items.every(itemOk)
  const bridgeOk =
    bridge !== 'native' ||
    selected.length < 2 ||
    nativeBridgeViable(selected, accepts, customOn)
  const canLaunch =
    nameOk &&
    tosAccepted &&
    accountingOk &&
    approvalOk &&
    ownerOk &&
    tickerOk &&
    bridgeOk &&
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

  /** Recipient tail of a split row for one chain: an address (per-chain
   *  override → default; ENS already resolved into the sync cache), a
   *  project id + token beneficiary, or a split hook. */
  const toRecipient = (row: DraftSplit, chainId: number) => {
    const override = row.perChain[chainId]?.trim() || ''
    const lockedUntil = row.lockedUntil
      ? Math.floor(new Date(row.lockedUntil).getTime() / 1000)
      : 0
    if (row.kind === 'hook') {
      const optionalId = row.projectId.trim().replace('#', '')
      return {
        projectId: optionalId ? BigInt(optionalId) : 0n,
        beneficiary: resolvedAddress(row.beneficiary) ?? zeroAddress,
        preferAddToBalance: false,
        lockedUntil,
        hook:
          row.hookKind === 'fundmarket'
            ? LP_SPLIT_HOOK
            : resolvedAddress(row.hookAddress)!,
      }
    }
    if (row.kind === 'project') {
      const id = (override || row.projectId).trim().replace('#', '')
      const beneficiary =
        row.perChainBeneficiary[chainId]?.trim() || row.beneficiary
      return {
        projectId: BigInt(id),
        beneficiary: row.preferAddToBalance
          ? (resolvedAddress(beneficiary) ?? zeroAddress)
          : resolvedAddress(beneficiary)!,
        preferAddToBalance: row.preferAddToBalance,
        lockedUntil,
        hook: zeroAddress,
      }
    }
    return {
      projectId: 0n,
      beneficiary: resolvedAddress(override || row.recipient)!,
      preferAddToBalance: false,
      lockedUntil,
      hook: zeroAddress,
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
    rows: DraftSplit[],
    routedMode: 'all' | 'amounts',
    decimals: number,
    chainId: number,
  ): { splits: SplitConfig[]; limit: bigint | null } => {
    if (routedMode === 'all') {
      return { splits: toSplitConfigs(rows, chainId), limit: null }
    }
    const valid = rows.filter(s => splitOk(s, 'amount'))
    const values = valid.map(row =>
      parseUnits(row.perChainAmount[chainId]?.trim() || row.value, decimals),
    )
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
      stage.payouts === 'routed'
        ? buildRoutedSplits(
            stage.payoutSplits,
            stage.routedMode,
            accountingDecimals,
            chainId,
          )
        : null
    const routedUsdc =
      stage.payouts === 'routed' && multiToken
        ? buildRoutedSplits(stage.payoutSplitsUsdc, stage.routedModeUsdc, 6, chainId)
        : null
    const routedAll =
      stage.payouts === 'routed' &&
      stage.routedMode === 'all' &&
      (!multiToken || stage.routedModeUsdc === 'all')
    const surplusOn =
      stage.payouts === 'flexible' ||
      (stage.payouts === 'routed' && !routedAll && stage.routedSurplusOn)
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
          ? RULESET_WEIGHT_INHERIT
          : parseUnits(stage.issuanceRate || '0', 18),
      weightCutPercent: Math.round(Number(stage.cutPct || '0') * 1e7),
      reservedPercent: Math.round(Number(stage.reservedPct || '0') * 100),
      reservedSplits: reservedOn
        ? toSplitConfigs(stage.reservedSplits, chainId)
        : [],
      payouts: stage.payouts,
      payoutSplits: routed?.splits ?? [],
      payoutLimitAmount: routed?.limit ?? null,
      payoutSplitsUsdc: routedUsdc?.splits ?? [],
      payoutLimitAmountUsdc: routedUsdc?.limit ?? null,
      surplusAllowanceOn: surplusOn,
      surplusAllowanceAmount:
        surplusOn && stage.surplusCapOn
          ? parseUnits(stage.surplusAmount || '0', accountingDecimals)
          : null,
      holdFees: stage.payouts !== 'none' && stage.holdFees,
      cashOutTaxRate: stage.cashOuts && !routedAll ? stageCashOutTax(stage) : null,
      allowOwnerMinting: stage.ownerMinting,
      pausePay: !stage.acceptPayments,
      pauseCreditTransfers: stage.pauseCreditTransfers,
      autoIssuances: [],
      allowSetTerminals: stage.powers.setTerminals,
      allowSetController: stage.powers.setController,
      allowTerminalMigration: stage.powers.terminalMigration,
      allowSetCustomToken: stage.powers.setCustomToken,
      allowAddAccountingContext: stage.powers.addAccountingContext,
      allowAddPriceFeed: stage.powers.addPriceFeed,
      issuanceCutFrequency: 0,
    }
  }

  /** Revnet stages: ABSOLUTE cumulative starts from one shared deployStart,
   *  later stages offset by daysAfter snapped UP to the previous stage's
   *  cut-cycle boundary (website/ parity). */
  const toRevnetStageRules = (
    stage: DraftStage,
    index: number,
    start: number,
    chainId: number,
  ): StageRules => {
    const cutOn = stage.cutOn && Number(stage.cutPct) > 0
    // Revnet splits: each row is a % of new issuance; splitPercent is their
    // sum and the bucket shares are the rows normalized to exactly 1e9.
    const rows = stage.reservedSplits.filter(s => splitOk(s, 'percent'))
    const rowTotal = rows.reduce((sum, r) => sum + Number(r.value), 0)
    const splitsPct = Math.min(100, rowTotal)
    let revnetSplits: SplitConfig[] = []
    if (rowTotal > 0) {
      const rel = rows.map(r => Math.floor((Number(r.value) / rowTotal) * 1e9))
      rel[rel.length - 1] = 1e9 - rel.slice(0, -1).reduce((a, b) => a + b, 0)
      revnetSplits = rows.map((r, i) => ({
        percent: rel[i],
        ...toRecipient(r, chainId),
      }))
    }
    return {
      duration: 0,
      mustStartAtOrAfter: start,
      // Empty rate on a later stage inherits the previous cut-adjusted rate.
      weight:
        stage.issuanceRate.trim() === '' && index > 0
          ? RULESET_WEIGHT_INHERIT
          : parseUnits(stage.issuanceRate || '0', 18),
      weightCutPercent: cutOn ? Math.round(Number(stage.cutPct) * 1e7) : 0,
      reservedPercent: Math.round(splitsPct * 100),
      reservedSplits: revnetSplits,
      payouts: 'none',
      payoutSplits: [],
      payoutLimitAmount: null,
      payoutSplitsUsdc: [],
      payoutLimitAmountUsdc: null,
      surplusAllowanceOn: false,
      surplusAllowanceAmount: null,
      holdFees: false,
      // Revnets can't disable cash outs entirely — 'off' is the maximum
      // allowed 99.99% tax.
      cashOutTaxRate: stage.cashOuts ? stageCashOutTax(stage) : 9_999,
      allowOwnerMinting: false,
      pausePay: false,
      pauseCreditTransfers: false,
      autoIssuances: stage.autoIssuances
        .filter(
          a =>
            Number(a.count) > 0 &&
            resolvedAddress(a.perChain[chainId]?.trim() || a.address) !== null,
        )
        .map(a => ({
          count: parseUnits(a.count, 18),
          beneficiary: resolvedAddress(
            a.perChain[chainId]?.trim() || a.address,
          )!,
        })),
      allowSetTerminals: false,
      allowSetController: false,
      allowTerminalMigration: false,
      allowSetCustomToken: false,
      allowAddAccountingContext: false,
      allowAddPriceFeed: false,
      issuanceCutFrequency: cutOn
        ? Math.round(Number(stage.cutFreqDays || '0') * 86_400)
        : 0,
    }
  }

  /** A later revnet stage's start: daysAfter rounded UP to a positive
   *  multiple of the previous stage's cut interval. */
  const revnetStageStart = (
    prevStart: number,
    prevStage: DraftStage,
    stage: DraftStage,
  ): number => {
    let days = Math.max(1, Math.round(Number(stage.daysAfter) || 1))
    const prevFreq =
      Number(prevStage.cutPct) > 0 ? Number(prevStage.cutFreqDays) || 0 : 0
    if (prevFreq >= 1) {
      days = Math.ceil(days / prevFreq) * prevFreq
    }
    return prevStart + days * 86_400
  }

  /** Per-chain launch plans (recipients can differ per chain), sharing one
   *  deployStart so multichain first rulesets begin together. */
  const buildPlans = (
    store: LaunchPlan['store'],
  ): Record<number, LaunchPlan> => {
    const deployStart = Math.floor(Date.now() / 1000) + 600
    return Object.fromEntries(
      selected.map(chainId => {
        let planStages: StageRules[]
        if (flavor === 'revnet') {
          planStages = []
          let start =
            stages[0].scheduleOn && stages[0].schedule
              ? Math.floor(new Date(stages[0].schedule).getTime() / 1000)
              : deployStart
          stages.forEach((stage, i) => {
            if (i > 0) start = revnetStageStart(start, stages[i - 1], stage)
            planStages.push(toRevnetStageRules(stage, i, start, chainId))
          })
        } else if (isSimpleProject) {
          planStages = [createSimpleProjectStage()]
        } else {
          planStages = stages.map((stage, i) =>
            toStageRules(stage, i, deployStart, chainId),
          )
        }
        return [
          chainId,
          {
            chains: selected,
            linkChains: true,
            bridge,
            issuanceBase,
            allowAnyToken: true,
            owner: resolvedAddress(
              ownerPerChain[chainId]?.trim() || owner,
            ),
            approvalCustomAddress:
              !isSimpleProject && approvalDeadline === 'custom'
                ? resolvedAddress(
                    approvalPerChain[chainId]?.trim() || approvalCustom,
                  )
                : null,
            accounting: {
              tokens: accepts,
              custom:
                customOn && customMeta && resolvedAddress(customAddress)
                  ? {
                      address: resolvedAddress(customAddress)!,
                      decimals: customMeta.decimals,
                    }
                  : null,
            },
            flavor: flavor === 'revnet' ? 'revnet' : 'project',
            operator: resolvedAddress(
              ownerPerChain[chainId]?.trim() || owner,
            ),
            ticker: ticker.trim(),
            stages: planStages,
            afterMode: isSimpleProject ? 'wait' : afterMode,
            approvalDeadline: isSimpleProject ? 'none' : approvalDeadline,
            store,
          },
        ]
      }),
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
        tags: tags.length > 0 ? tags : undefined,
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
      // Any media type pins as-is; images become `image`, everything else
      // `animation_url` (website/ parity).
      let imageUri: string | undefined
      let animationUri: string | undefined
      if (item.mediaFile) {
        const form = new FormData()
        form.append('file', item.mediaFile)
        const mediaRes = await fetch('/api/ipfs/pin-media', {
          method: 'POST',
          body: form,
        })
        const mediaJson = (await mediaRes.json()) as {
          cid?: string
          error?: string
        }
        if (!mediaRes.ok || !mediaJson.cid) {
          throw new Error(mediaJson.error ?? 'Media upload failed — try again.')
        }
        const uri = `ipfs://${mediaJson.cid}`
        if (item.mediaFile.type.startsWith('image/')) imageUri = uri
        else animationUri = uri
      }
      const itemRes = await fetch('/api/ipfs/pin-item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: item.name.trim(),
          description: item.description.trim() || undefined,
          image: imageUri,
          animation_url: animationUri,
          mediaType: item.mediaFile?.type || undefined,
          categoryName:
            storeCategories.find(c => c.id === item.category)?.name ||
            undefined,
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
      const price = parseUnits(item.price, storePriceDecimals)
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
      const perChainSupply: Record<number, number | null> = {}
      for (const [cid, v] of Object.entries(item.perChainSupply)) {
        const trimmed = v.trim()
        if (trimmed === '') continue
        perChainSupply[Number(cid)] =
          trimmed === 'unlimited' ? null : Number(trimmed)
      }
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
        category: item.category,
        votingUnits:
          item.votingUnits.trim() === '' ? 0 : Number(item.votingUnits),
        flags: {
          allowOwnerMint: item.allowOwnerMint,
          transfersPausable: item.transfersPausable,
          cantBeRemoved: item.cantBeRemoved,
          allowCredits: item.allowCredits,
          ownerCanEditDiscount: item.ownerCanEditDiscount,
        },
        perChainSupply,
      })
    }
    // The store collection deploys with every launch (even empty) so the
    // project can stock it later without a ruleset change.
    const store: LaunchPlan['store'] = {
      name: storeConfig.collectionName.trim() || name.trim(),
      symbol:
        storeConfig.collectionSymbol.trim() ||
        (flavor === 'revnet' ? ticker.trim() : '') ||
        deriveSymbol(name),
      currency: effectiveStoreCurrency,
      preventOverspending: storeConfig.preventOverspending,
      noNewTiersWithReserves: storeConfig.noNewTiersWithReserves,
      noNewTiersWithVotes: storeConfig.noNewTiersWithVotes,
      noNewTiersWithOwnerMinting: storeConfig.noNewTiersWithOwnerMinting,
      issueTokensForSplits: storeConfig.issueTokensForSplits,
      itemsRedeem: storeConfig.itemsRedeem && !anyCashOuts,
      operatorCanAdjustTiers: storeConfig.operatorCanAdjustTiers,
      operatorCanUpdateMetadata: storeConfig.operatorCanUpdateMetadata,
      operatorCanMint: storeConfig.operatorCanMint,
      operatorCanIncreaseDiscount: storeConfig.operatorCanIncreaseDiscount,
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
          owner: pinned.plans[chainId].owner ?? address!,
          projectUri: pinned.projectUri,
          creationFee,
          plan: pinned.plans[chainId],
          salt: pinned.salt,
        })
        await requireContractTransactionReview(
          { ...request, account: address },
          {
            title: `Review launch on ${chainName(chainId)}`,
            label: 'Launch project',
          },
        )
        await switchChainAsync({ chainId: chainId as SupportedChainId })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hash = await writeContractAsync(request as any)
        updateStatus(chainId, { phase: 'confirming', txHash: hash })
        const receipt = await waitForTransactionReceipt(config, {
          hash,
          chainId: chainId as SupportedChainId,
        })
        const projectId =
          receipt.status === 'success'
            ? projectIdFromReceipt(receipt, chainId as JBChainId)
            : null
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

  /** The serializable wizard state (.jb file + localStorage draft).
   *  Uploaded files can't serialize and are dropped. */
  const buildDraft = (): CreateDraft => ({
    v: 1,
    flavor,
    name,
    ticker,
    tagline,
    description,
    payNotice,
    tags,
    links,
    owner,
    ownerPerChain,
    allowAnyToken: true,
    approvalCustom,
    approvalPerChain,
    accepts,
    customAddress: customOn ? customAddress : '',
    issuanceBase,
    linkChains: true,
    bridge,
    chains: selected,
    stages,
    afterMode,
    approvalDeadline,
    storeCurrency,
    storeConfig,
    storeCategories,
    items: items.map(({ mediaFile, mediaPreview, ...rest }) => rest),
  })

  const applyDraft = (draft: CreateDraft) => {
    setFlavor(draft.flavor)
    setName(draft.name)
    setTicker(draft.ticker)
    setTagline(draft.tagline)
    setDescription(draft.description)
    setPayNotice(draft.payNotice)
    setTags(draft.tags)
    setLinks({
      infoUri: draft.links.infoUri ?? '',
      twitter: draft.links.twitter ?? '',
      discord: draft.links.discord ?? '',
      telegram: draft.links.telegram ?? '',
      whatsapp: draft.links.whatsapp ?? '',
      instagram: draft.links.instagram ?? '',
    })
    setOwner(draft.owner)
    setOwnerPerChain(draft.ownerPerChain)
    setApprovalCustom(draft.approvalCustom)
    setApprovalPerChain(draft.approvalPerChain)
    setAccepts(draft.accepts)
    setCustomOn(draft.customAddress !== '')
    setCustomAddress(draft.customAddress)
    setIssuanceBase(draft.issuanceBase)
    setBridge(draft.bridge)
    const validChains = draft.chains.filter(id =>
      SUPPORTED_CHAINS.some(chain => chain.id === id),
    )
    setSelected(
      validChains.length > 0
        ? validChains
        : SUPPORTED_CHAINS.map(chain => chain.id),
    )
    setStages(draft.stages)
    setAfterMode(draft.afterMode)
    setApprovalDeadline(draft.approvalDeadline)
    setStoreCurrency(draft.storeCurrency)
    setStoreConfig(draft.storeConfig)
    setStoreCategories(draft.storeCategories)
    setItems(
      draft.items.map(item => ({
        ...item,
        mediaFile: null,
        mediaPreview: null,
      })),
    )
    setStep(0)
  }

  const [importError, setImportError] = useState<string | null>(null)
  const importDraftFile = async (file: File | null) => {
    if (!file) return
    setImportError(null)
    try {
      applyDraft(parseDraft(await file.text()))
    } catch (e) {
      setImportError(e instanceof Error ? e.message : 'Import failed.')
    }
  }

  const exportDraft = () => {
    const blob = new Blob([JSON.stringify(buildDraft(), null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = draftFileName(name)
    a.click()
    URL.revokeObjectURL(url)
  }

  // Hydrate a saved draft once on mount, then persist (debounced) so a
  // refresh never loses work. Files don't persist.
  const hydratedRef = useRef(false)
  useEffect(() => {
    if (hydratedRef.current) return
    hydratedRef.current = true
    try {
      const saved = localStorage.getItem(DRAFT_KEY)
      if (saved) applyDraft(parseDraft(saved))
    } catch {
      // Corrupt draft — start fresh.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!hydratedRef.current || busy) return
    const t = setTimeout(() => {
      try {
        const draft = buildDraft()
        warnOnDraftDrift(draft)
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
      } catch {
        // Storage full/unavailable — drafts just won't persist.
      }
    }, 500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    flavor,
    name,
    ticker,
    tagline,
    description,
    payNotice,
    tags,
    links,
    owner,
    ownerPerChain,
    approvalCustom,
    approvalPerChain,
    accepts,
    customOn,
    customAddress,
    issuanceBase,
    bridge,
    selected,
    stages,
    afterMode,
    approvalDeadline,
    storeCurrency,
    storeConfig,
    storeCategories,
    items,
    busy,
  ])

  const wizardSteps = isSimpleProject
    ? ['Flavor', 'Look & Feel', 'Shop', 'Launch']
    : [
        'Flavor',
        'Look & Feel',
        flavor === 'revnet' ? 'Stages' : 'Rules',
        'Shop',
        'Launch',
      ]
  const storeStep = isSimpleProject ? 2 : 3
  const launchStep = isSimpleProject ? 3 : 4

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
          <div className="relative mx-auto w-fit" aria-hidden>
            <Image
              src={congratsIllustration}
              alt=""
              sizes="(min-width: 640px) 160px, 144px"
              className="h-36 w-36 object-contain sm:h-40 sm:w-40"
            />
            <span className="absolute bottom-1 right-1 flex h-10 w-10 items-center justify-center rounded-full border-2 border-white bg-melon-400 shadow-sm">
              <CheckIcon className="h-5 w-5 text-ink" />
            </span>
          </div>
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
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <div className="relative sm:pr-52">
        <h1 className="font-agrandir-wide text-4xl font-bold leading-tight sm:whitespace-nowrap sm:text-5xl">
          Start a project<span className="text-split-500">.</span>
        </h1>
        <p className="mt-3 max-w-xl text-base leading-relaxed text-smoke-700 sm:text-lg">
          Give it a name, answer a few questions, and launch. Live in minutes —
          rules stay flexible unless you lock&nbsp;them&nbsp;in.
        </p>
        <Image
          src={createIllustration}
          alt=""
          aria-hidden
          priority
          sizes="192px"
          className="pointer-events-none absolute right-0 top-1/2 hidden h-40 w-48 -translate-y-1/2 select-none object-contain sm:block"
        />
      </div>

      {/* Horizontal stepper */}
      <nav aria-label="Create steps" className="mt-8 flex min-w-0 items-center gap-1.5">
        {wizardSteps.map((label, i) => (
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
              className="flex min-w-0 shrink-0 items-center gap-2 disabled:opacity-60"
            >
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-full font-agrandir text-xs font-medium sm:h-8 sm:w-8 sm:text-sm ${
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
                className={`hidden text-sm font-medium sm:inline ${
                  step === i ? 'text-ink' : 'text-smoke-500'
                }`}
              >
                {label}
              </span>
            </button>
          </Fragment>
        ))}
      </nav>

      {/* 0 — Flavor: what kind of thing is this? */}
      <section className={step === 0 ? 'card mt-6 p-6 sm:p-7' : 'hidden'}>
        <div className="flex items-center gap-3">
          <StepBadge n={1} />
          <h2 className="font-agrandir text-xl font-medium">
            What are you launching?
          </h2>
        </div>

        <div className="mt-5">
          <span className="field-label">Flavor</span>
          <select
            value={flavor}
            onChange={e => {
              if (busy) return
              const next = e.target.value as CreateDraft['flavor']
              setFlavor(next)
              if (next === 'revnet') {
                // Revnets default to cash outs on with a 10% tax.
                setStages(prev =>
                  prev.map(s => ({
                    ...s,
                    cashOuts: true,
                    cashOutTax: s.cashOutTax === 0 ? 1000 : s.cashOutTax,
                  })),
                )
              }
            }}
            disabled={busy}
            className="input-well select-caret mt-2 min-h-[44px] w-full max-w-xs px-3.5 pr-9 text-sm disabled:opacity-60"
          >
            <option value="simple">Simple project</option>
            <option value="project">Custom project</option>
            <option value="revnet">Revnet</option>
          </select>
          <p className="mt-2 text-xs leading-relaxed text-smoke-700">
            {flavor === 'simple'
              ? 'Launch with flexible defaults that you can adjust at any time.'
              : flavor === 'revnet'
                ? 'Fixed rules that run forever, guaranteed. Tokens are always backed by revenues and funds raised, allowing for increasing price floors, loans, and predictability.'
                : 'You set the rules — payouts, cash outs, stages — and can change or lock them over time. The most flexible way to fund anything.'}
          </p>
        </div>

        <div className="mt-6">
          <span className="field-label">Chains</span>
          <p className="mt-1 text-xs leading-relaxed text-smoke-700">
            Your {flavor === 'revnet' ? 'revnet' : 'project'} lives on every
            chain you pick. You can add more chains later.
          </p>
          <MultiChainSelect
            options={SUPPORTED_CHAINS.map(chain => chain.id)}
            values={selected}
            onToggle={toggleChain}
            disabled={busy}
            className="mt-2.5"
          />
          {selected.length === 0 ? (
            <p className="mt-3 text-sm text-red-600">Pick at least one chain.</p>
          ) : null}
          {selected.length > 1 ? (
            <div className="mt-3">
              <p className="text-xs leading-relaxed text-smoke-700">
                Your {flavor === 'revnet' ? 'revnet' : 'project'} will exist on{' '}
                {selected.length} chains,{' '}
                <button
                  onClick={() => !busy && setBridgeOpen(o => !o)}
                  disabled={busy}
                  aria-expanded={bridgeOpen || bridge !== 'ccip'}
                  className="font-medium text-ink underline underline-offset-2 hover:text-smoke-700 disabled:opacity-60"
                >
                  linked
                </button>{' '}
                so your token{customOn ? '' : ' and treasury'} can move between
                them.
              </p>
              {bridgeOpen || bridge !== 'ccip' ? (
                <div className="mt-3">
                  <div className="flex items-center gap-3">
                    <span className="whitespace-nowrap text-sm text-smoke-700">
                      Connect chains via
                    </span>
                    <select
                      value={bridge}
                      onChange={e =>
                        !busy &&
                        setBridge(e.target.value as LaunchPlan['bridge'])
                      }
                      disabled={busy}
                      aria-label="Bridge infrastructure"
                      className="select-caret input-well min-h-[44px] !w-auto pl-3.5 pr-8 text-sm disabled:opacity-60"
                    >
                      <option value="ccip">CCIP</option>
                      <option value="native">Native bridges</option>
                      <option value="both">Native and CCIP</option>
                    </select>
                  </div>
                  {bridge !== 'ccip' ? (
                    <p className="mt-1.5 text-xs leading-relaxed text-smoke-700">
                      {bridge === 'native'
                        ? 'Ethereum’s own rollup bridges — strongest guarantees. Ethereum + one L2 only, ETH only, and moves back to Ethereum take ~7 days.'
                        : 'Both bridges on every pair of chains — whatever the native bridges can’t carry rides CCIP.'}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {!bridgeOk ? (
                <p className="mt-1.5 text-sm text-red-600">
                  Native bridges only connect Ethereum with one L2 and only
                  carry ETH — pick exactly Ethereum plus one L2 with ETH
                  accounting, or choose CCIP or Native and CCIP.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="mt-6">
          <span className="field-label">Accounting</span>
          <p className="mt-1 text-xs leading-relaxed text-smoke-700">
            The token(s) that make up your{' '}
            {flavor === 'revnet' ? 'revnet' : 'project'}&apos;s balance. Other
            payment tokens auto-swap as they&apos;re paid in. Accounting
            tokens cannot be removed later.
          </p>
          <div className="mt-2.5 grid gap-1 sm:grid-cols-3">
            {(
              [
                ['eth', 'ETH'],
                ['usdc', 'USDC'],
              ] as const
            ).map(([value, label]) => {
              const active = !customOn && accepts.includes(value)
              return (
                <CheckRow
                  key={value}
                  checked={active}
                  onToggle={() => {
                    if (busy) return
                    setCustomOn(false)
                    setAccepts(prev =>
                      prev.includes(value)
                        ? prev.length > 1
                          ? prev.filter(v => v !== value)
                          : prev
                        : [...prev, value],
                    )
                  }}
                  disabled={busy}
                  title={label}
                  blurb={
                    value === 'eth' ? 'Native currency' : 'Stable accounting'
                  }
                />
              )
            })}
            <CheckRow
              checked={customOn}
              onToggle={() => !busy && setCustomOn(on => !on)}
              disabled={busy}
              title="Custom token"
              blurb="Any ERC-20"
            />
          </div>
          {customOn ? (
            <div className="mt-3">
              <AddressField
                value={customAddress}
                onChange={setCustomAddress}
                disabled={busy}
                placeholder="0x… (ERC-20 token address)"
                ariaLabel="Custom accounting token"
              />
              {customMeta ? (
                <p className="mt-1.5 text-xs text-smoke-700">
                  ${customMeta.symbol} · {customMeta.decimals} decimals ·
                  verified on {selected.map(id => chainName(id)).join(', ')}
                </p>
              ) : customChainError ? (
                <p className="mt-1.5 text-xs text-red-600">
                  {customChainError}
                </p>
              ) : resolvedAddress(customAddress) ? (
                <p className="mt-1.5 text-xs text-smoke-500">
                  Checking the token on every selected chain…
                </p>
              ) : null}
              <p className="mt-2 text-xs leading-relaxed text-smoke-700">
                Must be deployed at the same address on every selected chain.
                Everything — issuance, payouts, store prices — is denominated
                in this token itself, so no price feed is needed. You can add
                a feed later to price in ETH or USD instead.
              </p>
            </div>
          ) : null}
        </div>

        <div className="mt-6">
          <span className="field-label">
            {flavor === 'revnet' ? 'Operator' : 'Owner'}
          </span>
          <p className="mt-1 text-xs leading-relaxed text-smoke-700">
            {flavor === 'revnet'
              ? 'The address that operates the few controls available in revnets.'
              : 'Receives the project and full control over its rules.'}{' '}
            Leave empty to use your connected wallet.
          </p>
          <AddressField
            value={owner}
            onChange={setOwner}
            disabled={busy}
            ariaLabel={flavor === 'revnet' ? 'Operator' : 'Owner'}
            className="mt-2"
          />
          {selected.length > 1 ? (
            <div className="mt-2">
              <button
                onClick={() => setOwnerPerChainOpen(o => !o)}
                disabled={busy}
                aria-expanded={ownerPerChainOpen}
                className="text-[11px] font-medium text-bluebs-600 hover:text-bluebs-700 disabled:opacity-60"
              >
                {ownerPerChainOpen
                  ? 'Same on every chain'
                  : `Set per chain — if the ${flavor === 'revnet' ? 'operator' : 'owner'} differs by chain`}
              </button>
              {ownerPerChainOpen ? (
                <div className="mt-2 space-y-2">
                  {selected.map(chainId => (
                    <div key={chainId} className="flex items-start gap-2">
                      <span className="mt-1.5 flex w-9 shrink-0 items-center justify-center">
                        <ChainIcon chainId={chainId} size={28} />
                      </span>
                      <AddressField
                        value={ownerPerChain[chainId] ?? ''}
                        onChange={v =>
                          setOwnerPerChain(prev => ({ ...prev, [chainId]: v }))
                        }
                        disabled={busy}
                        placeholder={owner.trim() || 'default'}
                        ariaLabel={`${flavor === 'revnet' ? 'Operator' : 'Owner'} on ${chainName(chainId)}`}
                        className="flex-1"
                        compact
                      />
                    </div>
                  ))}
                  <p className="text-[11px] leading-relaxed text-smoke-500">
                    Empty fields use the default above.
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      {/* 1 — Identity + treasury + chains */}
      <section className={step === 1 ? 'card mt-6 p-6 sm:p-7' : 'hidden'}>
        <div className="flex items-center gap-3">
          <StepBadge n={2} />
          <h2 className="font-agrandir text-xl font-medium">
            How should it appear?
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

            {flavor === 'revnet' ? (
              <div className="mt-4">
                <span className="field-label">
                  Token ticker
                  <span className="text-peel-500"> *</span>
                </span>
                <div className="mt-1.5 flex items-center gap-3">
                  <input
                    type="text"
                    value={ticker}
                    onChange={e =>
                      setTicker(
                        e.target.value
                          .toUpperCase()
                          .replace(/[^A-Z0-9]/g, '')
                          .slice(0, 11),
                      )
                    }
                    disabled={busy}
                    placeholder="TOKEN"
                    className="input-well min-h-[48px] w-40 px-4 text-sm disabled:opacity-60"
                  />
                  <p className="text-xs leading-relaxed text-smoke-700">
                    Names your revnet&apos;s token — supporters hold $
                    {ticker || 'TOKEN'}.
                  </p>
                </div>
              </div>
            ) : null}

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
            label="Tags"
            summary={tags.length > 0 ? tags.join(', ') : 'None'}
            open={!!openSection.tags}
            onToggle={() => toggleSection('tags')}
          >
            <p className="text-xs leading-relaxed text-smoke-700">
              Pick up to 3 so supporters can find you.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {TAG_OPTIONS.map(tag => {
                const active = tags.includes(tag)
                return (
                  <ChipButton
                    key={tag}
                    active={active}
                    onClick={() =>
                      setTags(prev =>
                        prev.includes(tag)
                          ? prev.filter(t => t !== tag)
                          : prev.length < 3
                            ? [...prev, tag]
                            : prev,
                      )
                    }
                    disabled={busy || (!active && tags.length >= 3)}
                  >
                    {tag}
                  </ChipButton>
                )
              })}
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
        </div>
      </section>

      {/* 2 — Rules: one card per queued ruleset (stage) */}
      <section
        className={
          !isSimpleProject && step === 2
            ? 'card mt-6 p-6 sm:p-7'
            : 'hidden'
        }
      >
        <div className="flex items-center gap-3">
          <StepBadge n={3} />
          <h2 className="font-agrandir text-xl font-medium">
            How should it work?
          </h2>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-smoke-700">
          {flavor === 'revnet'
            ? 'Revnet stages are locked in at launch and can never be changed — supporters know exactly what they get, forever.'
            : 'The defaults make a simple, flexible project. Rules live in rulesets — give one a duration and you can queue what comes next.'}
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
                    {flavor === 'revnet' ? 'Stage' : 'Ruleset'} #{i + 1}
                  </span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-smoke-700">
                    <Piped
                      text={stageSummary(stage, i, unitLabel, rulesFlavor)}
                    />
                  </span>
                </button>
                {i > 0 ? (
                  <button
                    onClick={() =>
                      setStages(prev => prev.filter(s => s.id !== stage.id))
                    }
                    disabled={busy}
                    aria-label={`Remove ${flavor === 'revnet' ? 'stage' : 'ruleset'} ${i + 1}`}
                    className="shrink-0 text-xs font-medium text-smoke-700 underline underline-offset-2 hover:text-ink disabled:opacity-60"
                  >
                    Remove
                  </button>
                ) : null}
                <Chevron open={stage.expanded} />
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
                    unitChoice={
                      !customOn
                        ? { value: effectiveBase, onChange: setIssuanceBase }
                        : undefined
                    }
                    disabled={busy}
                    chainIds={selected}
                    flavor={rulesFlavor}
                    tokenLabel={tokenLabel}
                    multiToken={multiToken}
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

          {flavor === 'revnet' ? (
            <div className="mt-4">
              <AddButton
                onClick={() =>
                  setStages(prev => [
                    ...prev.map(s => ({ ...s, expanded: false })),
                    { ...newDraftStage(false, 'revnet'), expanded: true },
                  ])
                }
                disabled={busy}
              >
                Add a stage
              </AddButton>
            </div>
          ) : null}

          {flavor !== 'revnet' && afterApplies ? (
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

          {flavor !== 'revnet' && deadlineApplies ? (
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
                <option value="custom">Custom contract…</option>
              </select>
              {approvalDeadline === 'custom' ? (
                <div className="mt-3">
                  <p className="mb-2 text-xs leading-relaxed text-smoke-700">
                    A JBRulesetApprovalHook contract that approves or rejects
                    queued changes. It must be deployed on every selected
                    chain.
                  </p>
                  <AddressField
                    value={approvalCustom}
                    onChange={setApprovalCustom}
                    disabled={busy}
                    placeholder="0x… approval hook"
                    ariaLabel="Custom approval hook"
                  />
                  {selected.length > 1 ? (
                    <div className="mt-2 space-y-2">
                      <p className="text-[11px] text-smoke-500">
                        Different address on some chains? Set per chain
                        (empty = the address above):
                      </p>
                      {selected.map(chainId => (
                        <div key={chainId} className="flex items-start gap-2">
                          <span className="mt-3 flex w-28 shrink-0 items-center gap-1.5 text-xs text-smoke-700">
                            <ChainIcon chainId={chainId} size={14} />
                            {chainName(chainId)}
                          </span>
                          <AddressField
                            value={approvalPerChain[chainId] ?? ''}
                            onChange={v =>
                              setApprovalPerChain(prev => ({
                                ...prev,
                                [chainId]: v,
                              }))
                            }
                            disabled={busy}
                            placeholder="default"
                            ariaLabel={`Approval hook on ${chainName(chainId)}`}
                            className="flex-1"
                            compact
                          />
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : approvalDeadline !== 'none' ? (
                <p className="mt-2 text-xs leading-relaxed text-smoke-700">
                  Queued changes take effect{' '}
                  {
                    APPROVAL_LABELS[
                      approvalDeadline as keyof typeof APPROVAL_LABELS
                    ]
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
      <section
        className={step === storeStep ? 'card mt-6 p-6 sm:p-7' : 'hidden'}
      >
        <div className="flex items-center gap-3">
          <StepBadge n={storeStep + 1} />
          <h2 className="font-agrandir text-xl font-medium">Stock your shop</h2>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-smoke-700">
          Sell things right from your project page. Each sale pays your
          treasury, and the buyer gets the item plus {tokenLabel}. Optional —
          you can stock your shop any time after launch.
        </p>
        <div className="mt-4">
          <span className="field-label">Pricing currency</span>
          <p className="mt-1 text-xs leading-relaxed text-smoke-700">
            The currency your items are priced in — buyers can still pay
            with anything.
          </p>
          <div
            role="radiogroup"
            aria-label="Pricing currency"
            className="mt-2.5 grid max-w-lg gap-1 sm:grid-cols-3"
          >
            {(
              [
                ...(customOn
                  ? ([
                      [
                        'token',
                        `$${customMeta?.symbol ?? 'TOKEN'}`,
                        'Project token',
                      ],
                    ] as const)
                  : []),
                ['eth', 'ETH', 'Ether'],
                ['usd', 'USD', 'US dollars'],
              ] as const
            ).map(([value, label, description]) => {
              const active = effectiveStoreCurrency === value
              return (
                <OptionRow
                  key={value}
                  checked={active}
                  onSelect={() => !busy && setStoreCurrency(value)}
                  disabled={busy}
                  title={label}
                  blurb={description}
                />
              )
            })}
          </div>
        </div>
        {customOn && effectiveStoreCurrency !== 'token' ? (
          <p className="mt-2 text-xs leading-relaxed text-peel-600">
            Pricing in ETH or USD with a custom accounting token needs a
            price feed added after launch.
          </p>
        ) : null}

        <StoreEditor
          items={items}
          onChange={setItems}
          currencyLabel={storeCurrencyLabel}
          disabled={busy}
          categories={storeCategories}
          onAddCategory={name => {
            const id =
              storeCategories.reduce((max, c) => Math.max(max, c.id), 0) + 1
            setStoreCategories(prev => [...prev, { id, name: name.slice(0, 40) }])
            return id
          }}
          chainIds={selected}
          isRevnet={flavor === 'revnet'}
        />

        <div className="mt-5">
          <button
            onClick={() => setStoreConfigOpen(o => !o)}
            aria-expanded={storeConfigOpen}
            className="text-sm font-medium text-bluebs-600 hover:text-bluebs-700"
          >
            Shop config {storeConfigOpen ? '▾' : '▸'}
          </button>
          {storeConfigOpen ? (
            <div className="mt-3 space-y-4 rounded-xl border border-smoke-200 bg-white p-4">
              <p className="text-xs leading-relaxed text-smoke-700">
                You can set or change most of these any time after launch.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="text-xs text-smoke-700">Collection name</span>
                  <input
                    type="text"
                    value={storeConfig.collectionName}
                    onChange={e =>
                      setStoreConfig(c => ({
                        ...c,
                        collectionName: e.target.value.slice(0, 100),
                      }))
                    }
                    disabled={busy}
                    placeholder={name.trim() || 'Collection name'}
                    className="input-well mt-1 min-h-[44px] px-3.5 text-sm disabled:opacity-60"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-smoke-700">Collection symbol</span>
                  <input
                    type="text"
                    value={storeConfig.collectionSymbol}
                    onChange={e =>
                      setStoreConfig(c => ({
                        ...c,
                        collectionSymbol: e.target.value
                          .toUpperCase()
                          .replace(/[^A-Z0-9]/g, '')
                          .slice(0, 11),
                      }))
                    }
                    disabled={busy}
                    placeholder={(flavor === 'revnet' && ticker.trim()) || deriveSymbol(name)}
                    className="input-well mt-1 min-h-[44px] px-3.5 text-sm disabled:opacity-60"
                  />
                </label>
              </div>
              <div className="space-y-2">
                {(
                  [
                    [
                      'preventOverspending',
                      'Require exact payment',
                      'Buyers must pay exactly the item price — no overpaying for extra credit.',
                    ],
                    [
                      'noNewTiersWithReserves',
                      'Lock reserved items after launch',
                      'New items added later can never set aside reserved inventory.',
                    ],
                    [
                      'noNewTiersWithVotes',
                      'Lock voting items after launch',
                      'New items added later can never carry custom voting power.',
                    ],
                    [
                      'noNewTiersWithOwnerMinting',
                      'Lock owner minting after launch',
                      'New items added later can never let the owner mint for free.',
                    ],
                    [
                      'issueTokensForSplits',
                      'Full token credit on split sales',
                      'Buyers get project tokens for their entire payment, even the portion an item routes to splits. When off, tokens are only issued for what stays in the project.',
                    ],
                  ] as const
                ).map(([key, title, blurb]) => (
                  <CheckRow
                    key={key}
                    checked={storeConfig[key]}
                    onToggle={() =>
                      setStoreConfig(c => ({ ...c, [key]: !c[key] }))
                    }
                    disabled={busy}
                    title={title}
                    blurb={blurb}
                  />
                ))}
                {anyCashOuts ? (
                  <p className="rounded-lg bg-smoke-75 px-3.5 py-2.5 text-xs leading-relaxed text-smoke-700">
                    Items can&apos;t cash out for surplus while token cash
                    outs are on — tokens and items can&apos;t both redeem.
                  </p>
                ) : (
                  <CheckRow
                    checked={storeConfig.itemsRedeem}
                    onToggle={() =>
                      setStoreConfig(c => ({
                        ...c,
                        itemsRedeem: !c.itemsRedeem,
                      }))
                    }
                    disabled={busy}
                    title="Give items cash out access to surplus"
                    blurb="Item holders can redeem their items for a share of the project's surplus."
                  />
                )}
              </div>
              {flavor === 'revnet' ? (
                <div className="space-y-2 border-t border-smoke-200 pt-4">
                  <span className="field-label">
                    What the operator can do after launch
                  </span>
                  {(
                    [
                      ['operatorCanAdjustTiers', 'Add & remove items'],
                      ['operatorCanUpdateMetadata', 'Update item metadata'],
                      ['operatorCanMint', 'Mint items for free'],
                      ['operatorCanIncreaseDiscount', 'Increase discounts'],
                    ] as const
                  ).map(([key, title]) => (
                    <CheckRow
                      key={key}
                      checked={storeConfig[key]}
                      onToggle={() =>
                        setStoreConfig(c => ({ ...c, [key]: !c[key] }))
                      }
                      disabled={busy}
                      title={title}
                      blurb=""
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      {/* 4 — Review & launch */}
      <section
        className={step === launchStep ? 'card mt-6 p-6 sm:p-7' : 'hidden'}
      >
        <div className="flex items-center gap-3">
          <StepBadge n={launchStep + 1} />
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
            <dt className="text-smoke-700">Launching</dt>
            <dd className="font-medium text-ink">
              {flavor === 'simple'
                ? 'Simple project'
                : flavor === 'revnet'
                  ? `Revnet${ticker.trim() ? ` — $${ticker.trim()}` : ''}`
                  : 'Project'}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-smoke-700">Accounting</dt>
            <dd className="font-medium text-ink">
              {customOn
                ? `$${customMeta?.symbol ?? 'TOKEN'}`
                : accepts
                    .map(t => (t === 'eth' ? 'ETH' : 'USDC'))
                    .join(' + ')}{' '}
              on {selected.map(id => chainName(id)).join(', ') || '—'}
            </dd>
          </div>
          {isSimpleProject ? (
            <div>
              <dt className="text-smoke-700">Rules</dt>
              <dd className="mt-1">
                <ul className="list-disc space-y-0.5 pl-5 font-medium text-ink">
                  <li>Starts at launch and lasts until changed</li>
                  <li>Issues 10,000 tokens per {unitLabel} paid</li>
                  <li>Unlimited owner withdrawals; cash outs off</li>
                  <li>All owner controls stay editable</li>
                  <li>Later rule changes can take effect immediately</li>
                </ul>
              </dd>
            </div>
          ) : (
            stages.map((stage, i) => (
              <div key={stage.id}>
                <dt className="text-smoke-700">
                  {flavor === 'revnet' ? 'Stage' : 'Ruleset'} #{i + 1}
                </dt>
                <dd className="mt-1">
                  <ul className="list-disc space-y-0.5 pl-5 font-medium text-ink">
                    {stageSummaryParts(stage, i, unitLabel, rulesFlavor).map(
                      part => (
                        <li key={part}>{part}</li>
                      ),
                    )}
                  </ul>
                </dd>
              </div>
            ))
          )}
          {!isSimpleProject && flavor !== 'revnet' && afterApplies ? (
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
          {!isSimpleProject && flavor !== 'revnet' && deadlineApplies ? (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-smoke-700">Rule changes</dt>
              <dd className="font-medium text-ink">
                {approvalDeadline === 'none'
                  ? 'Immediate'
                  : approvalDeadline === 'custom'
                    ? 'Custom approval contract'
                    : `${APPROVAL_LABELS[approvalDeadline]} notice`}
              </dd>
            </div>
          ) : null}
          {items.length > 0 ? (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-smoke-700">Shop</dt>
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
                Creation fee on {chainName(chainId)}
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

        <div className="mt-5">
          <CheckRow
            checked={tosAccepted}
            onToggle={() => !busy && setTosAccepted(t => !t)}
            disabled={busy}
            title="I understand the risks"
            blurb="Juicebox is experimental onchain software. Your project is controlled by its rules and owner — not by Juicebox — and launches are irreversible."
          />
        </div>

        <p className="mt-5 text-sm leading-relaxed text-smoke-700">
          {selected.length > 1
            ? `You’ll confirm one transaction per chain — ${selected.length} transactions total.`
            : 'You’ll confirm one transaction to launch.'}
        </p>

        <button
          onClick={launch}
          disabled={connected && !canLaunch}
          className="btn-primary mt-2 min-h-[56px] w-full text-base"
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
                    <TransactionProgressImage className="h-9 w-9" />
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
        {step < wizardSteps.length - 1 ? (
          <button
            onClick={() => goToStep(step + 1)}
            disabled={busy}
            className="btn-primary min-h-[44px] px-6 text-sm"
          >
            Next →
          </button>
        ) : null}
      </div>

      {/* Draft import/export — quiet utilities at the very bottom */}
      <div className="mt-8 flex flex-wrap items-center gap-2 border-t border-smoke-200 pt-4">
        <label className="inline-flex min-h-[28px] cursor-pointer items-center gap-1 rounded-full border border-smoke-200 px-3 text-[11px] font-medium text-smoke-500 transition-colors hover:border-smoke-400 hover:text-ink">
          <span aria-hidden>↑</span> Import .jb
          <input
            type="file"
            accept=".jb,application/json"
            disabled={busy}
            className="sr-only"
            onChange={e => {
              void importDraftFile(e.target.files?.[0] ?? null)
              e.target.value = ''
            }}
          />
        </label>
        <button
          onClick={exportDraft}
          disabled={busy}
          className="inline-flex min-h-[28px] items-center gap-1 rounded-full border border-smoke-200 px-3 text-[11px] font-medium text-smoke-500 transition-colors hover:border-smoke-400 hover:text-ink disabled:opacity-60"
        >
          <span aria-hidden>↓</span> Export
        </button>
        <span className="text-[11px] text-smoke-500">
          Your draft saves as you go.
        </span>
        {importError ? (
          <span className="text-[11px] text-red-600">{importError}</span>
        ) : null}
      </div>
    </div>
  )
}
