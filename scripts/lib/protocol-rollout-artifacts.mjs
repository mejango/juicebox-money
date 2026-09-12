/** Fail closed on proposal-only, failed, or mismatched deployment records. */
export function executedDeploymentAddress(artifact, chainId, name) {
  if (!artifact) return null
  const receipt = artifact.receipt
  let matchesChain = false
  let successful = false
  try {
    matchesChain = BigInt(artifact.chainId) === BigInt(chainId)
    successful = BigInt(receipt?.status) === 1n && BigInt(receipt?.blockNumber) > 0n
  } catch { /* Missing execution evidence is invalid. */ }
  if (
    artifact.contractName !== name || !matchesChain || !successful ||
    !/^0x[0-9a-fA-F]{40}$/.test(artifact.address) || /^0x0{40}$/i.test(artifact.address) ||
    !/^0x[0-9a-fA-F]{64}$/.test(receipt?.transactionHash) ||
    !/^0x[0-9a-fA-F]{64}$/.test(receipt?.blockHash)
  ) throw new Error(`Unverified executed deployment: ${name} on chain ${chainId}`)
  return artifact.address.toLowerCase()
}
