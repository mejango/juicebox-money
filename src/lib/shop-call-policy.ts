import { erc2771ForwarderAbi, jb721TiersHookAbi, jb721TiersHookProjectDeployerAbi, jbOmnichainDeployerAbi, revDeployerAbi } from '@bananapus/nana-sdk-core'
import { multiSendCallsOf } from '@bananapus/nana-sdk-core/safe'
import { SAFE_EXEC_ABI } from '@bananapus/nana-sdk-core/safe-service'
import { ReviewLineError } from '@bananapus/nana-sdk-core/review'
import { decodeFunctionData, type Abi, type Address, type Hex } from 'viem'
import { reservedSupplyOk } from '@/lib/shop-reserves'

type Tiers = readonly { flags: { useVotingUnits: boolean }; initialSupply: number; reserveFrequency: number }[]
type Hook = { tiersConfig?: { tiers: Tiers } }
const policyAbi: Abi = [...jb721TiersHookAbi, ...erc2771ForwarderAbi, ...SAFE_EXEC_ABI, ...jb721TiersHookProjectDeployerAbi, ...jbOmnichainDeployerAbi, ...revDeployerAbi]

/** New authorizations only. Existing signed/funded bytes remain available for passive recovery. */
export function assertShopCallPolicy(data: Hex, to?: Address, operation = 0): void {
  const batch = multiSendCallsOf({ data, to, operation })
  if (batch) {
    for (const call of batch) assertShopCallPolicy(call.data, call.to)
    return
  }
  let decoded
  try { decoded = decodeFunctionData({ abi: policyAbi, data }) }
  catch { return } // Unrelated contract calls are outside this policy.
  const args = decoded.args ?? []
  let tiers: Tiers = []
  if (decoded.functionName === 'adjustTiers') tiers = args[0] as Tiers
  else if (decoded.functionName === 'launchProjectFor') {
    tiers = (args[1] as Hook).tiersConfig?.tiers ??
      (args[2] as { deployTiersHookConfig?: Hook }).deployTiersHookConfig?.tiersConfig?.tiers ?? []
  } else if (decoded.functionName === 'deployFor' && args.length === 6) {
    tiers = (args[4] as { baseline721HookConfiguration?: Hook }).baseline721HookConfiguration?.tiersConfig?.tiers ?? []
  }
  for (const tier of tiers) {
    if (tier.flags.useVotingUnits) throw new ReviewLineError('Rebuild price-based items; keep authorizations for recovery.')
    if (!reservedSupplyOk(tier.initialSupply, tier.reserveFrequency)) throw new ReviewLineError('Reserved inventory needs at least 2 items on every selected chain.')
  }
  if (decoded.functionName === 'execTransaction') {
    assertShopCallPolicy(args[2] as Hex, args[0] as Address, Number(args[3]))
  } else if (decoded.functionName === 'execute') {
    const request = args[0] as { data: Hex; to: Address }
    assertShopCallPolicy(request.data, request.to)
  }
}
