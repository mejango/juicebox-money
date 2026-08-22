type FixtureStatus = {
  graphql: Record<string, number>
  rpc: Record<string, number>
  contracts: Record<string, number>
  multicallBatches: number
  unknown: { kind: string; detail: string }[]
}

function missingReads(
  actual: Record<string, number>,
  required: readonly string[],
) {
  return required.filter(key => !Number.isInteger(actual[key]) || actual[key] < 1)
}

export default async function globalTeardown() {
  const fixturePort = process.env.PLAYWRIGHT_FIXTURE_PORT ?? '4399'
  const fixtureOrigin =
    process.env.PLAYWRIGHT_FIXTURE_ORIGIN ??
    `http://127.0.0.1:${fixturePort}`
  const response = await fetch(`${fixtureOrigin}/__fixture/status`, {
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) {
    throw new Error(`Fixture audit endpoint returned HTTP ${response.status}`)
  }

  const status = (await response.json()) as FixtureStatus
  const missingGraphql = missingReads(status.graphql, [
    'project',
    'participants',
    'revnetOperator',
    'permissionHolders',
    'trending',
    'recentActivity',
  ])
  const missingContracts = missingReads(status.contracts, [
    'JBMultiTerminal.accountingContextsOf',
    'JBController.currentRulesetOf',
    'JBController.allRulesetsOf',
    'JBController.totalTokenSupplyWithReservedTokensOf',
    'JBController.uriOf',
    'JBDirectory.terminalsOf',
    'JBDirectory.controllerOf',
    'JBTokens.tokenOf',
    'JBTerminalStore.balanceOf',
    'JBTerminalStore.currentSurplusOf',
    'USDC.symbol',
    'REVOwner.tiered721HookOf',
    'JBProjectHandles.ensNamePartsOf',
    'JBProjectHandles.handleOf',
    'JBBuybackHookRegistry.defaultHook',
    'JBBuybackHookRegistry.hookOf',
    'JBRouterTerminalRegistry.defaultTerminal',
    'JBRouterTerminalRegistry.terminalOf',
    'JBProjects.creationFee',
  ])
  const failures = [
    status.unknown.length
      ? `unexpected fixture requests: ${JSON.stringify(status.unknown, null, 2)}`
      : '',
    missingGraphql.length
      ? `required GraphQL reads were not observed: ${missingGraphql.join(', ')}`
      : '',
    !status.rpc.eth_call ? 'required eth_call requests were not observed' : '',
    status.multicallBatches < 1
      ? 'required Multicall3 batching was not observed'
      : '',
    missingContracts.length
      ? `required ABI reads were not observed: ${missingContracts.join(', ')}`
      : '',
  ].filter(Boolean)

  if (failures.length) {
    throw new Error(`Deterministic fixture audit failed:\n${failures.join('\n')}`)
  }
}
