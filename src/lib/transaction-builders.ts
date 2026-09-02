import {
  JBCoreContracts,
  NATIVE_TOKEN,
  RevnetCoreContracts,
  jbBuybackHookAbi,
  jbBuybackHookRegistryAbi,
  jb721TiersHookAbi,
  jbControllerAbi,
  jbContractAddress,
  jbMultiTerminalAbi,
  jbProjectsAbi,
  jbRouterTerminalRegistryAbi,
  revOwnerAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  UNISWAP_PERMIT2_ADDRESS,
  buildQueueRulesetsTx,
  buildSetPermissionsTx,
  buildSetSplitGroupsTx,
} from '@bananapus/nana-sdk-core/v6'
import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  type Abi,
  type Address,
  type ContractFunctionArgs,
  type Hex,
} from 'viem'
import type { AuthorityCall } from '@/lib/authority'

type AdjustTiersArgs = ContractFunctionArgs<
  typeof jb721TiersHookAbi,
  'nonpayable',
  'adjustTiers'
>

type Mint721TierArgs = ContractFunctionArgs<
  typeof jb721TiersHookAbi,
  'nonpayable',
  'mintFor'
>

const permit2ApproveAbi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
    ],
    outputs: [],
  },
] as const

const positionManagerAbi = [
  {
    type: 'function',
    name: 'modifyLiquidities',
    stateMutability: 'payable',
    inputs: [
      { name: 'unlockData', type: 'bytes' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const

function buildAuthorityCall({
  chainId,
  authority,
  target,
  abi,
  functionName,
  args,
  contractName,
  gas,
  label,
}: {
  chainId: JBChainId
  authority: Address
  target: Address
  abi: Abi
  functionName: string
  args: readonly unknown[]
  contractName: string
  gas?: bigint
  label: string
}): AuthorityCall {
  return {
    chainId,
    authority,
    target,
    data: encodeFunctionData({ abi, functionName, args }),
    abi,
    functionName,
    args,
    contractName,
    ...(gas === undefined ? {} : { gas }),
    label,
  }
}

/** Exact ERC-20 allowance request shared by pay, loans, bridging, and LP flows. */
export function buildErc20ApproveRequest({
  chainId,
  token,
  spender,
  amount,
}: {
  chainId: JBChainId
  token: Address
  spender: Address
  amount: bigint
}) {
  return {
    chainId,
    address: token,
    abi: erc20Abi,
    functionName: 'approve' as const,
    args: [spender, amount] as const,
  }
}

/** Exact terminal balance top-up request, including the native msg.value. */
export function buildAddToBalanceRequest({
  chainId,
  terminal,
  projectId,
  token,
  amount,
  memo = '',
  metadata = '0x',
}: {
  chainId: JBChainId
  terminal: Address
  projectId: bigint
  token: Address
  amount: bigint
  memo?: string
  metadata?: `0x${string}`
}) {
  return {
    chainId,
    address: terminal,
    abi: jbMultiTerminalAbi,
    functionName: 'addToBalanceOf' as const,
    args: [projectId, token, amount, false, memo, metadata] as const,
    value:
      token.toLowerCase() === NATIVE_TOKEN.toLowerCase() ? amount : undefined,
  }
}

/** Exact live-shop tier adjustment; callers must pin metadata before building. */
export function buildAdjustTiersRequest({
  chainId,
  hook,
  tiers,
  tierIdsToRemove = [],
}: {
  chainId: JBChainId
  hook: Address
  tiers: AdjustTiersArgs[0]
  tierIdsToRemove?: AdjustTiersArgs[1]
}) {
  return {
    chainId,
    address: hook,
    abi: jb721TiersHookAbi,
    functionName: 'adjustTiers' as const,
    args: [tiers, tierIdsToRemove] as const,
  }
}

/** Exact owner/operator free mint. Repeated tier ids mint that quantity. */
export function buildMint721TierRequest({
  chainId,
  hook,
  tierIds,
  beneficiary,
}: {
  chainId: JBChainId
  hook: Address
  tierIds: Mint721TierArgs[0]
  beneficiary: Mint721TierArgs[1]
}) {
  if (tierIds.length === 0) throw new Error('Choose at least one item to mint.')
  if (tierIds.length > 50) throw new Error('Mint at most 50 items at once.')
  if (
    tierIds.some(
      tierId =>
        !Number.isSafeInteger(Number(tierId)) ||
        Number(tierId) < 1 ||
        Number(tierId) > 65_535,
    )
  ) {
    throw new Error('Every item tier ID must fit uint16 and be greater than zero.')
  }
  return {
    chainId,
    address: hook,
    abi: jb721TiersHookAbi,
    functionName: 'mintFor' as const,
    args: [tierIds, beneficiary] as const,
  }
}

/**
 * Replace one tier's media. Empty strings and the hook's own address are the
 * contract's "leave unchanged" sentinels for everything but the tier URI.
 */
export function buildSet721TierMediaRequest({
  chainId,
  hook,
  tierId,
  encodedIpfsUri,
}: {
  chainId: JBChainId
  hook: Address
  tierId: number
  encodedIpfsUri: Hex
}) {
  if (!Number.isSafeInteger(tierId) || tierId < 1 || tierId > 65_535) {
    throw new Error('The item tier ID must fit uint16 and be greater than zero.')
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(encodedIpfsUri)) {
    throw new Error('The pinned media must be a bytes32-encoded IPFS CID.')
  }
  return {
    chainId,
    address: hook,
    abi: jb721TiersHookAbi,
    functionName: 'setMetadata' as const,
    args: ['', '', '', '', hook, BigInt(tierId), encodedIpfsUri] as const,
  }
}

export function buildSendPayoutsRequest({
  chainId,
  terminal,
  projectId,
  token,
  amount,
  currency,
  minTokensPaidOut,
}: {
  chainId: JBChainId
  terminal: Address
  projectId: bigint
  token: Address
  amount: bigint
  currency: bigint
  minTokensPaidOut: bigint
}) {
  return {
    chainId,
    address: terminal,
    abi: jbMultiTerminalAbi,
    functionName: 'sendPayoutsOf' as const,
    args: [projectId, token, amount, currency, minTokensPaidOut] as const,
  }
}

export function buildUseAllowanceRequest({
  chainId,
  terminal,
  projectId,
  token,
  amount,
  currency,
  minTokensPaidOut,
  beneficiary,
  feeBeneficiary = beneficiary,
  memo = '',
}: {
  chainId: JBChainId
  terminal: Address
  projectId: bigint
  token: Address
  amount: bigint
  currency: bigint
  minTokensPaidOut: bigint
  beneficiary: Address
  feeBeneficiary?: Address
  memo?: string
}) {
  return {
    chainId,
    address: terminal,
    abi: jbMultiTerminalAbi,
    functionName: 'useAllowanceOf' as const,
    args: [
      projectId,
      token,
      amount,
      currency,
      minTokensPaidOut,
      beneficiary,
      feeBeneficiary,
      memo,
    ] as const,
  }
}

/** Exact anyone-can-call distribution of a project's pending reserved tokens. */
export function buildSendReservedTokensRequest({
  chainId,
  controller,
  projectId,
}: {
  chainId: JBChainId
  controller: Address
  projectId: bigint
}) {
  return {
    chainId,
    address: controller,
    abi: jbControllerAbi,
    functionName: 'sendReservedTokensToSplitsOf' as const,
    args: [projectId] as const,
  }
}

/** Exact project-token metadata change routed through its verified authority. */
export function buildTokenMetadataAuthorityCall({
  chainId,
  authority,
  controller,
  projectId,
  name,
  symbol,
  gas = 200_000n,
  label = 'Set token metadata',
}: {
  chainId: JBChainId
  authority: Address
  controller: Address
  projectId: bigint
  name: string
  symbol: string
  gas?: bigint
  label?: string
}): AuthorityCall {
  return buildAuthorityCall({
    chainId,
    authority,
    target: controller,
    abi: jbControllerAbi,
    functionName: 'setTokenMetadataOf',
    args: [projectId, name, symbol],
    contractName: 'JBController',
    gas,
    label,
  })
}

/**
 * Exact `JBController.deployERC20For` routed through the project's authority.
 *
 * The salt is REQUIRED and must be the same across every chain of one deploy:
 * it is what makes the token land on the same address everywhere (see
 * `omnichainTokenSalt`). A zero salt would deploy a nonce-keyed clone —
 * a different address per chain, irreversibly.
 */
export function buildDeployTokenAuthorityCall({
  chainId,
  authority,
  controller,
  projectId,
  name,
  symbol,
  salt,
  gas = 500_000n,
  label = 'Deploy ERC-20',
}: {
  chainId: JBChainId
  authority: Address
  controller: Address
  projectId: bigint
  name: string
  symbol: string
  salt: Hex
  gas?: bigint
  label?: string
}): AuthorityCall {
  return buildAuthorityCall({
    chainId,
    authority,
    target: controller,
    abi: jbControllerAbi,
    functionName: 'deployERC20For',
    args: [projectId, name, symbol, salt],
    contractName: 'JBController',
    gas,
    label,
  })
}

/** Exact JBProjects NFT ownership transfer routed through the current owner. */
export function buildProjectOwnershipAuthorityCall({
  chainId,
  authority,
  projectId,
  destination,
  label = 'Transfer ownership',
}: {
  chainId: JBChainId
  authority: Address
  projectId: bigint
  destination: Address
  label?: string
}): AuthorityCall {
  return buildAuthorityCall({
    chainId,
    authority,
    target: jbContractAddress['6'][JBCoreContracts.JBProjects][chainId],
    abi: jbProjectsAbi,
    functionName: 'transferFrom',
    args: [authority, destination, projectId],
    contractName: 'JBProjects',
    label,
  })
}

/** Exact revnet operator transfer routed through the current operator. */
export function buildRevnetOperatorAuthorityCall({
  chainId,
  authority,
  revnetId,
  operator,
  label = 'Transfer operator',
}: {
  chainId: JBChainId
  authority: Address
  revnetId: bigint
  operator: Address
  label?: string
}): AuthorityCall {
  return buildAuthorityCall({
    chainId,
    authority,
    target: jbContractAddress['6'][RevnetCoreContracts.REVOwner][chainId],
    abi: revOwnerAbi,
    functionName: 'setOperatorOf',
    args: [revnetId, operator],
    contractName: 'REVOwner',
    label,
  })
}

/** Behavior-preserving wrapper for the ruleset-gated owner power catalogue. */
export function buildProjectPowerAuthorityCall({
  chainId,
  authority,
  target,
  abi,
  functionName,
  args,
  contractName,
  gas,
  label,
}: {
  chainId: JBChainId
  authority: Address
  target: Address
  abi: Abi
  functionName: string
  args: readonly unknown[]
  contractName: string
  gas: bigint
  label: string
}): AuthorityCall {
  return buildAuthorityCall({
    chainId,
    authority,
    target,
    abi,
    functionName,
    args,
    contractName,
    gas,
    label,
  })
}

export function buildBuybackHookAuthorityCall({
  chainId,
  authority,
  registry,
  projectId,
  hook,
  gas = 200_000n,
  label = 'Set buyback hook',
}: {
  chainId: JBChainId
  authority: Address
  registry: Address
  projectId: bigint
  hook: Address
  gas?: bigint
  label?: string
}): AuthorityCall {
  return buildAuthorityCall({
    chainId,
    authority,
    target: registry,
    abi: jbBuybackHookRegistryAbi,
    functionName: 'setHookFor',
    args: [projectId, hook],
    contractName: 'JBBuybackHookRegistry',
    gas,
    label,
  })
}

export function buildRouterTerminalAuthorityCall({
  chainId,
  authority,
  registry,
  projectId,
  terminal,
  gas = 200_000n,
  label = 'Set router terminal',
}: {
  chainId: JBChainId
  authority: Address
  registry: Address
  projectId: bigint
  terminal: Address
  gas?: bigint
  label?: string
}): AuthorityCall {
  return buildAuthorityCall({
    chainId,
    authority,
    target: registry,
    abi: jbRouterTerminalRegistryAbi,
    functionName: 'setTerminalFor',
    args: [projectId, terminal],
    contractName: 'JBRouterTerminalRegistry',
    gas,
    label,
  })
}

export function buildInitializeBuybackPoolAuthorityCall({
  chainId,
  authority,
  registry,
  projectId,
  fee,
  tickSpacing,
  twapWindow,
  pairToken,
  sqrtPriceX96,
  gas = 500_000n,
  label = 'Initialize buyback pool',
}: {
  chainId: JBChainId
  authority: Address
  registry: Address
  projectId: bigint
  fee: number
  tickSpacing: number
  twapWindow: bigint
  pairToken: Address
  sqrtPriceX96: bigint
  gas?: bigint
  label?: string
}): AuthorityCall {
  return buildAuthorityCall({
    chainId,
    authority,
    target: registry,
    abi: jbBuybackHookRegistryAbi,
    functionName: 'initializePoolFor',
    args: [projectId, fee, tickSpacing, twapWindow, pairToken, sqrtPriceX96],
    contractName: 'JBBuybackHookRegistry',
    gas,
    label,
  })
}

/**
 * `setTwapWindowOf` lives on the buyback hook itself — the registry has no
 * forwarder — so this targets the project's resolved hook, not a registry.
 */
export function buildSetBuybackTwapAuthorityCall({
  chainId,
  authority,
  hook,
  projectId,
  terminalToken,
  twapWindow,
  gas = 150_000n,
  label = 'Set TWAP window',
}: {
  chainId: JBChainId
  authority: Address
  hook: Address
  projectId: bigint
  terminalToken: Address
  twapWindow: bigint
  gas?: bigint
  label?: string
}): AuthorityCall {
  return buildAuthorityCall({
    chainId,
    authority,
    target: hook,
    abi: jbBuybackHookAbi,
    functionName: 'setTwapWindowOf',
    args: [projectId, terminalToken, twapWindow],
    contractName: 'JBBuybackHook',
    gas,
    label,
  })
}

/** Exact Permit2 allowance used immediately before a PositionManager mint. */
export function buildPermit2ApproveRequest({
  chainId,
  token,
  positionManager,
  amount,
  expiration,
}: {
  chainId: JBChainId
  token: Address
  positionManager: Address
  amount: bigint
  expiration: number
}) {
  return {
    chainId,
    address: UNISWAP_PERMIT2_ADDRESS,
    abi: permit2ApproveAbi,
    functionName: 'approve' as const,
    args: [token, positionManager, amount, expiration] as const,
  }
}

/** Exact final Uniswap V4 PositionManager call with frozen mint bytes/value. */
/** v4-periphery `Actions`: BURN_POSITION, DECREASE_LIQUIDITY, TAKE_PAIR. */
const ACTION_BURN_POSITION = '03'
const ACTION_TAKE_PAIR = '11'

/**
 * Full-exit remove: BURN_POSITION(tokenId) + TAKE_PAIR(c0, c1, recipient).
 *
 * Both sides carry a 95% floor derived from the amounts the caller just
 * displayed, so a large adverse price move reverts instead of returning
 * materially less than was reviewed. No approval is needed — the NFT owner
 * burns their own position.
 */
export function buildRemoveLiquidityUnlockData({
  tokenId,
  currency0,
  currency1,
  recipient,
  amount0Min,
  amount1Min,
}: {
  tokenId: bigint
  currency0: Address
  currency1: Address
  recipient: Address
  amount0Min: bigint
  amount1Min: bigint
}): Hex {
  const burnParams = encodeAbiParameters(
    [
      { type: 'uint256' },
      { type: 'uint128' },
      { type: 'uint128' },
      { type: 'bytes' },
    ],
    [tokenId, amount0Min, amount1Min, '0x'],
  )
  const takeParams = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
    [currency0, currency1, recipient],
  )
  return encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [`0x${ACTION_BURN_POSITION}${ACTION_TAKE_PAIR}`, [burnParams, takeParams]],
  )
}

const ACTION_MINT_POSITION = '02'
const ACTION_CLOSE_CURRENCY = '12'
const ACTION_SWEEP = '14'
const ACTION_INCREASE_LIQUIDITY = '00'
const ACTION_DECREASE_LIQUIDITY = '01'

const MODIFY_LIQUIDITY_PARAMS = [
  { type: 'uint256' },
  { type: 'uint256' },
  { type: 'uint128' },
  { type: 'uint128' },
  { type: 'bytes' },
] as const

/**
 * Top up an existing position in place: INCREASE_LIQUIDITY(tokenId) +
 * CLOSE_CURRENCY(c0) + CLOSE_CURRENCY(c1) [+ SWEEP(native, recipient)]. The
 * closes settle what the added liquidity needs from the caller (Permit2 for
 * ERC-20s, msg.value for native) net of the position's unclaimed fees, and
 * the sweep refunds unused native value. The maxima cap the principal pulled.
 */
export function buildIncreaseLiquidityUnlockData({
  tokenId,
  liquidity,
  currency0,
  currency1,
  amount0Max,
  amount1Max,
  sweep,
}: {
  tokenId: bigint
  liquidity: bigint
  currency0: Address
  currency1: Address
  amount0Max: bigint
  amount1Max: bigint
  /** Refund unused native value (sent as msg.value) to this recipient. */
  sweep?: { currency: Address; recipient: Address }
}): Hex {
  const increaseParams = encodeAbiParameters(MODIFY_LIQUIDITY_PARAMS, [
    tokenId,
    liquidity,
    amount0Max,
    amount1Max,
    '0x',
  ])
  const close0 = encodeAbiParameters([{ type: 'address' }], [currency0])
  const close1 = encodeAbiParameters([{ type: 'address' }], [currency1])
  const parts: Hex[] = [increaseParams, close0, close1]
  let actions = `0x${ACTION_INCREASE_LIQUIDITY}${ACTION_CLOSE_CURRENCY}${ACTION_CLOSE_CURRENCY}`
  if (sweep) {
    parts.push(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }],
        [sweep.currency, sweep.recipient],
      ),
    )
    actions += ACTION_SWEEP
  }
  return encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [actions as Hex, parts],
  )
}

/**
 * Free part of a position: DECREASE_LIQUIDITY(tokenId) + TAKE_PAIR(c0, c1,
 * recipient). The freed principal and the position's unclaimed fees both go
 * to the recipient; the minimums floor the principal alone.
 */
export function buildDecreaseLiquidityUnlockData({
  tokenId,
  liquidity,
  currency0,
  currency1,
  recipient,
  amount0Min,
  amount1Min,
}: {
  tokenId: bigint
  liquidity: bigint
  currency0: Address
  currency1: Address
  recipient: Address
  amount0Min: bigint
  amount1Min: bigint
}): Hex {
  const decreaseParams = encodeAbiParameters(MODIFY_LIQUIDITY_PARAMS, [
    tokenId,
    liquidity,
    amount0Min,
    amount1Min,
    '0x',
  ])
  const takeParams = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
    [currency0, currency1, recipient],
  )
  return encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [`0x${ACTION_DECREASE_LIQUIDITY}${ACTION_TAKE_PAIR}`, [decreaseParams, takeParams]],
  )
}

/**
 * One-transaction band move: BURN_POSITION(old) + MINT_POSITION(new) +
 * CLOSE_CURRENCY(c0) + CLOSE_CURRENCY(c1). The burn's credit funds the mint
 * inside the same unlock — no Permit2, no msg.value — and the closes return
 * unclaimed fees plus whatever the new band doesn't consume to the caller.
 * `mintUnlockData` is a standard add-liquidity unlock whose MINT parameters
 * are lifted out verbatim; its own closes/sweep are dropped because the
 * composed closes settle everything at the end. When the new band is sized
 * beyond the burn's credit, the caller funds the difference (Permit2 for
 * ERC-20s, msg.value for native) and `sweep` refunds unused native value.
 */
export function buildMoveLiquidityUnlockData({
  tokenId,
  currency0,
  currency1,
  amount0Min,
  amount1Min,
  mintUnlockData,
  sweep,
}: {
  tokenId: bigint
  currency0: Address
  currency1: Address
  amount0Min: bigint
  amount1Min: bigint
  mintUnlockData: Hex
  sweep?: { currency: Address; recipient: Address }
}): Hex {
  const burnParams = encodeAbiParameters(
    [
      { type: 'uint256' },
      { type: 'uint128' },
      { type: 'uint128' },
      { type: 'bytes' },
    ],
    [tokenId, amount0Min, amount1Min, '0x'],
  )
  const [, mintParts] = decodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    mintUnlockData,
  )
  const close0 = encodeAbiParameters([{ type: 'address' }], [currency0])
  const close1 = encodeAbiParameters([{ type: 'address' }], [currency1])
  const parts: Hex[] = [burnParams, mintParts[0], close0, close1]
  let actions = `0x${ACTION_BURN_POSITION}${ACTION_MINT_POSITION}${ACTION_CLOSE_CURRENCY}${ACTION_CLOSE_CURRENCY}`
  if (sweep) {
    parts.push(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }],
        [sweep.currency, sweep.recipient],
      ),
    )
    actions += ACTION_SWEEP
  }
  return encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [actions as Hex, parts],
  )
}

/** Keep 95% of a displayed amount as the on-chain floor; never floor to 0. */
export function retainedFloor(value: bigint): bigint {
  if (value <= 0n) return 0n
  const floor = (value * 9_500n) / 10_000n
  return floor > 0n ? floor : 1n
}

export function buildModifyLiquiditiesRequest({
  chainId,
  positionManager,
  unlockData,
  deadline,
  value,
}: {
  chainId: JBChainId
  positionManager: Address
  unlockData: Hex
  deadline: bigint
  value: bigint
}) {
  return {
    chainId,
    address: positionManager,
    abi: positionManagerAbi,
    functionName: 'modifyLiquidities' as const,
    args: [unlockData, deadline] as const,
    value,
  }
}

/** SDK-derived queue request with the live, already-verified controller target. */
export function buildQueueRulesetsRequest({
  controller,
  ...args
}: Parameters<typeof buildQueueRulesetsTx>[0] & { controller: Address }) {
  return { ...buildQueueRulesetsTx(args), address: controller }
}

/** SDK-derived queue request wrapped for Safe/Relayr authority routing, so a
 *  Safe-owned project's signer (or a QUEUE_RULESETS operator) can queue. */
export function buildQueueRulesetsAuthorityCall({
  authority,
  controller,
  gas = 1_500_000n,
  label,
  ...args
}: Parameters<typeof buildQueueRulesetsTx>[0] & {
  authority: Address
  controller: Address
  gas?: bigint
  label: string
}): AuthorityCall {
  const request = {
    ...buildQueueRulesetsTx(args),
    address: controller,
  }
  return {
    chainId: request.chainId,
    authority,
    target: request.address,
    data: encodeFunctionData(request),
    abi: request.abi,
    functionName: request.functionName,
    args: request.args,
    contractName: 'JBController',
    gas,
    label,
  }
}

/** SDK-derived split request wrapped for Safe/Relayr authority routing. */
export function buildSplitGroupsAuthorityCall({
  authority,
  controller,
  gas = 600_000n,
  label,
  ...args
}: Parameters<typeof buildSetSplitGroupsTx>[0] & {
  authority: Address
  controller: Address
  gas?: bigint
  label: string
}): AuthorityCall {
  const request = {
    ...buildSetSplitGroupsTx(args),
    address: controller,
  }
  return {
    chainId: request.chainId,
    authority,
    target: request.address,
    data: encodeFunctionData(request),
    abi: request.abi,
    functionName: request.functionName,
    args: request.args,
    contractName: 'JBController',
    gas,
    label,
  }
}

/** SDK-derived permission request wrapped for Safe/Relayr authority routing. */
export function buildPermissionsAuthorityCall({
  authority,
  gas = 200_000n,
  label,
  ...args
}: Parameters<typeof buildSetPermissionsTx>[0] & {
  authority: Address
  gas?: bigint
  label: string
}): AuthorityCall {
  const request = buildSetPermissionsTx(args)
  return {
    chainId: request.chainId,
    authority,
    target: request.address,
    data: encodeFunctionData(request),
    abi: request.abi,
    functionName: request.functionName,
    args: request.args,
    contractName: 'JBPermissions',
    gas,
    label,
  }
}
