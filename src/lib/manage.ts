import {
  JBCoreContracts,
  jbContractAddress,
  jbControllerAbi,
  type JBChainId,
} from '@bananapus/nana-sdk-core'
import {
  buildDeployErc20Tx,
  type V6DeployErc20TxRequest,
} from '@bananapus/nana-sdk-core/v6'
import { keccak256, toHex, type Address, type Hex } from 'viem'

/**
 * Pure owner-management plumbing shared by the OwnerPanel client island and
 * the verification scripts: `setUriOf` and `deployERC20For` tx-request
 * assembly. No wallet, no network — directly testable via `simulateContract`.
 */

/** A prepared `setUriOf` transaction request. */
export interface V6SetUriTxRequest {
  chainId: JBChainId
  address: Address
  abi: typeof jbControllerAbi
  functionName: 'setUriOf'
  args: readonly [bigint, string]
}

/**
 * Whether a project's `JBDirectory.controllerOf` is a controller these
 * builders can drive. Owner actions must target the project's own controller —
 * calling one that isn't attached reverts with
 * `JBControlled_ControllerUnauthorized` — and a custom controller may not
 * speak `setUriOf`/`deployERC20For` at all, so the panel hides for those.
 */
export function isKnownController(
  chainId: JBChainId,
  controller: Address | undefined,
): boolean {
  if (!controller) return false
  const canonical = jbContractAddress['6'][JBCoreContracts.JBController][
    chainId
  ] as Address | undefined
  return !!canonical && controller.toLowerCase() === canonical.toLowerCase()
}

/**
 * Assemble the `JBController.setUriOf(projectId, uri)` request pointing the
 * project at freshly pinned metadata. Owner (or SET_PROJECT_URI permission)
 * only — the panel gates on `JBProjects.ownerOf`.
 *
 * @param args.controller The project's controller per
 * `JBDirectory.controllerOf`. Defaults to the canonical v6 JBController.
 */
export function buildSetUriTx({
  chainId,
  projectId,
  projectUri,
  controller,
}: {
  chainId: JBChainId
  projectId: bigint
  /** The pinned metadata URI, e.g. `ipfs://<cid>`. */
  projectUri: string
  controller?: Address
}): V6SetUriTxRequest {
  const address =
    controller ??
    (jbContractAddress['6'][JBCoreContracts.JBController][chainId] as
      | Address
      | undefined)
  if (!address) {
    throw new Error(`No v6 JBController deployed on chain ${chainId}.`)
  }
  return {
    chainId,
    address,
    abi: jbControllerAbi,
    functionName: 'setUriOf',
    args: [projectId, projectUri],
  }
}

/** Token symbols: 1–8 uppercase letters/digits. */
export const TOKEN_SYMBOL_RE = /^[A-Z0-9]{1,8}$/

/** A random CREATE2 salt (32 bytes). */
export function randomSalt(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)))
}

/**
 * The CREATE2 salt an omnichain ERC-20 deploy must reuse on every chain.
 *
 * `JBController.deployERC20For` hashes `(caller, salt)` and hands that to
 * `JBTokens`, which clones deterministically only when the salt is non-zero —
 * a zero salt falls back to a nonce-keyed clone, i.e. a DIFFERENT token
 * address on every chain, permanently. Since the controller, the token
 * implementation and `JBTokens` share one address across chains, the same
 * signer plus the same salt lands the token on the same address everywhere,
 * which is what the ecosystem's same-address ERC-20 convention assumes.
 *
 * Deriving it from the token's name and symbol (rather than a random value,
 * which the launch flow can afford because it pins one salt in a resumable
 * session) keeps the salt stable across retries, reloads, and a later deploy
 * onto a chain the project was extended to.
 */
export function omnichainTokenSalt(name: string, symbol: string): Hex {
  return keccak256(toHex(`jb-erc20:${name.trim()}:${symbol.trim()}`))
}

/**
 * Assemble the `JBController.deployERC20For` request that turns supporters'
 * internal credits into a claimable ERC-20. Validates the inputs the form
 * collects; the salt defaults to a fresh random value (non-omnichain v1 —
 * same-address cross-chain deploys need the same salt from the same caller).
 *
 * @param args.controller The project's controller per
 * `JBDirectory.controllerOf`. Defaults to the canonical v6 JBController.
 */
export function buildDeployTokenRequest({
  chainId,
  projectId,
  name,
  symbol,
  salt,
  controller,
}: {
  chainId: JBChainId
  projectId: bigint
  name: string
  symbol: string
  salt?: Hex
  controller?: Address
}): V6DeployErc20TxRequest {
  const trimmedName = name.trim()
  if (!trimmedName) throw new Error('Give your token a name.')
  if (!TOKEN_SYMBOL_RE.test(symbol)) {
    throw new Error('Symbols are 1–8 uppercase letters or digits.')
  }
  const request = buildDeployErc20Tx({
    chainId,
    projectId,
    name: trimmedName,
    symbol,
    salt: salt ?? randomSalt(),
  })
  return controller ? { ...request, address: controller } : request
}
