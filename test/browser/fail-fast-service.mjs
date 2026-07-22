import { createServer } from 'node:http'
import {
  ETH_CURRENCY_ID,
  JBBuybackHookContracts,
  JBCoreContracts,
  JBRouterTerminalContracts,
  RevnetCoreContracts,
  USDC_ADDRESSES,
  jbBuybackHookRegistryAbi,
  jbContractAddress,
  jbControllerAbi,
  jbDirectoryAbi,
  jbMultiTerminalAbi,
  jbProjectsAbi,
  jbRouterTerminalRegistryAbi,
  jbTerminalStoreAbi,
  jbTokensAbi,
  revOwnerAbi,
} from '@bananapus/nana-sdk-core'
import {
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  multicall3Abi,
  zeroAddress,
} from 'viem'

const portIndex = process.argv.indexOf('--port')
const port = Number(
  portIndex >= 0
    ? process.argv[portIndex + 1]
    : (process.env.PLAYWRIGHT_FIXTURE_PORT ?? 4399),
)

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid deterministic fixture port: ${port}`)
}

const CHAIN_ID = 1
const PROJECT_ID = 1
const USDC = USDC_ADDRESSES[CHAIN_ID]
const OWNER = '0x1111111111111111111111111111111111111111'
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'
const addressOf = contract => jbContractAddress['6'][contract]?.[CHAIN_ID]
const CONTROLLER = addressOf(JBCoreContracts.JBController)
const DIRECTORY = addressOf(JBCoreContracts.JBDirectory)
const MULTI_TERMINAL = addressOf(JBCoreContracts.JBMultiTerminal)
const TERMINAL_STORE = addressOf(JBCoreContracts.JBTerminalStore)
const TOKENS = addressOf(JBCoreContracts.JBTokens)
const REV_OWNER = addressOf(RevnetCoreContracts.REVOwner)
const BUYBACK_REGISTRY = addressOf(
  JBBuybackHookContracts.JBBuybackHookRegistry,
)
const ROUTER_REGISTRY = addressOf(
  JBRouterTerminalContracts.JBRouterTerminalRegistry,
)

if (
  !USDC ||
  !CONTROLLER ||
  !DIRECTORY ||
  !MULTI_TERMINAL ||
  !TERMINAL_STORE ||
  !TOKENS ||
  !REV_OWNER ||
  !BUYBACK_REGISTRY ||
  !ROUTER_REGISTRY
) {
  throw new Error('The deterministic project fixture requires mainnet V6 addresses')
}

const projectFields = `
  projectId chainId version name logoUri projectTagline volume volumeUsd balance
  paymentsCount contributorsCount createdAt suckerGroupId token tokenSymbol
  decimals currency isRevnet owner metadataUri
`

const project = {
  projectId: PROJECT_ID,
  chainId: CHAIN_ID,
  version: 6,
  name: 'Browser Fixture Project',
  logoUri: null,
  projectTagline: 'A deterministic project for production-shape checks.',
  volume: '1250000000',
  volumeUsd: '1250000000000000000000',
  balance: '0',
  paymentsCount: 7,
  contributorsCount: 2,
  createdAt: 1_700_000_000,
  suckerGroupId: null,
  token: USDC,
  tokenSymbol: 'USDC',
  decimals: 6,
  currency: 2,
  isRevnet: true,
  owner: OWNER,
  // Keep this fixture wholly local: project metadata would otherwise be an
  // intentional IPFS gateway request made by the production server.
  metadataUri: null,
}

const participants = {
  items: [
    {
      address: '0x2222222222222222222222222222222222222222',
      balance: '250000000000000000000',
      chainId: CHAIN_ID,
      volumeUsd: '750000000000000000000',
    },
    {
      address: '0x3333333333333333333333333333333333333333',
      balance: '100000000000000000000',
      chainId: CHAIN_ID,
      volumeUsd: '500000000000000000000',
    },
  ],
  totalCount: 2,
}

const ruleset = {
  cycleNumber: 1n,
  id: 1n,
  basedOnId: 0n,
  start: 1_700_000_000n,
  duration: 0,
  weight: 1_000_000_000_000_000_000n,
  weightCutPercent: 0,
  approvalHook: zeroAddress,
  metadata: 0n,
}

const rulesetMetadata = {
  reservedPercent: 0,
  cashOutTaxRate: 0,
  baseCurrency: ETH_CURRENCY_ID,
  pausePay: false,
  pauseCreditTransfers: false,
  allowOwnerMinting: false,
  allowSetCustomToken: false,
  allowTerminalMigration: false,
  allowSetTerminals: false,
  allowSetController: false,
  allowAddAccountingContext: false,
  allowAddPriceFeed: false,
  ownerMustSendPayouts: false,
  holdFees: false,
  scopeCashOutsToLocalBalances: false,
  useDataHookForPay: false,
  useDataHookForCashOut: false,
  dataHook: zeroAddress,
  metadata: 0,
}

const state = {
  graphql: Object.create(null),
  rpc: Object.create(null),
  contracts: Object.create(null),
  multicallBatches: 0,
  preflights: 0,
  unknown: [],
}

function increment(bucket, key) {
  bucket[key] = (bucket[key] ?? 0) + 1
}

function recordUnknown(kind, detail) {
  if (state.unknown.length < 100) state.unknown.push({ kind, detail })
}

function comparable(value) {
  if (typeof value === 'bigint') return `bigint:${value}`
  if (typeof value === 'string') {
    return /^0x[0-9a-f]+$/i.test(value) ? value.toLowerCase() : value
  }
  if (Array.isArray(value)) return value.map(comparable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, comparable(item)]),
    )
  }
  return value
}

function exactValue(actual, expected) {
  return JSON.stringify(comparable(actual)) === JSON.stringify(comparable(expected))
}

const contractFixtures = [
  {
    name: 'JBMultiTerminal.accountingContextsOf',
    address: MULTI_TERMINAL,
    abi: jbMultiTerminalAbi,
    functionName: 'accountingContextsOf',
    args: [1n],
    result: [{ token: USDC, decimals: 6, currency: 2 }],
  },
  {
    name: 'JBController.currentRulesetOf',
    address: CONTROLLER,
    abi: jbControllerAbi,
    functionName: 'currentRulesetOf',
    args: [1n],
    result: [ruleset, rulesetMetadata],
  },
  {
    name: 'JBController.allRulesetsOf',
    address: CONTROLLER,
    abi: jbControllerAbi,
    functionName: 'allRulesetsOf',
    args: [1n, 0n, 50n],
    result: [{ ruleset, metadata: rulesetMetadata }],
  },
  {
    name: 'JBController.totalTokenSupplyWithReservedTokensOf',
    address: CONTROLLER,
    abi: jbControllerAbi,
    functionName: 'totalTokenSupplyWithReservedTokensOf',
    args: [1n],
    result: 0n,
  },
  {
    name: 'JBController.uriOf',
    address: CONTROLLER,
    abi: jbControllerAbi,
    functionName: 'uriOf',
    args: [1n],
    result: '',
  },
  {
    name: 'JBDirectory.terminalsOf',
    address: DIRECTORY,
    abi: jbDirectoryAbi,
    functionName: 'terminalsOf',
    args: [1n],
    result: [MULTI_TERMINAL],
  },
  {
    name: 'JBDirectory.controllerOf',
    address: DIRECTORY,
    abi: jbDirectoryAbi,
    functionName: 'controllerOf',
    args: [1n],
    result: CONTROLLER,
  },
  {
    name: 'JBTokens.tokenOf',
    address: TOKENS,
    abi: jbTokensAbi,
    functionName: 'tokenOf',
    args: [1n],
    result: zeroAddress,
  },
  {
    name: 'JBTerminalStore.balanceOf',
    address: TERMINAL_STORE,
    abi: jbTerminalStoreAbi,
    functionName: 'balanceOf',
    args: [MULTI_TERMINAL, 1n, USDC],
    result: 0n,
  },
  {
    name: 'JBTerminalStore.currentSurplusOf',
    address: TERMINAL_STORE,
    abi: jbTerminalStoreAbi,
    functionName: 'currentSurplusOf',
    args: [1n, [], [], 6n, 2n],
    result: 0n,
  },
  {
    name: 'USDC.symbol',
    address: USDC,
    abi: erc20Abi,
    functionName: 'symbol',
    args: [],
    result: 'USDC',
  },
  {
    name: 'REVOwner.tiered721HookOf',
    address: REV_OWNER,
    abi: revOwnerAbi,
    functionName: 'tiered721HookOf',
    args: [1n],
    result: zeroAddress,
  },
  {
    name: 'JBBuybackHookRegistry.defaultHook',
    address: BUYBACK_REGISTRY,
    abi: jbBuybackHookRegistryAbi,
    functionName: 'defaultHook',
    args: [],
    result: zeroAddress,
  },
  {
    name: 'JBBuybackHookRegistry.hookOf',
    address: BUYBACK_REGISTRY,
    abi: jbBuybackHookRegistryAbi,
    functionName: 'hookOf',
    args: [1n],
    result: zeroAddress,
  },
  {
    name: 'JBRouterTerminalRegistry.defaultTerminal',
    address: ROUTER_REGISTRY,
    abi: jbRouterTerminalRegistryAbi,
    functionName: 'defaultTerminal',
    args: [],
    result: zeroAddress,
  },
  {
    name: 'JBRouterTerminalRegistry.terminalOf',
    address: ROUTER_REGISTRY,
    abi: jbRouterTerminalRegistryAbi,
    functionName: 'terminalOf',
    args: [1n],
    result: zeroAddress,
  },
  {
    name: 'JBProjects.creationFee',
    address: addressOf(JBCoreContracts.JBProjects),
    abi: jbProjectsAbi,
    functionName: 'creationFee',
    args: [],
    result: 0n,
    chainIds: [1, 10, 8453, 42161],
  },
].map(fixture => ({
  ...fixture,
  address: fixture.address.toLowerCase(),
  chainIds: fixture.chainIds ?? [CHAIN_ID],
  encodedResult: encodeFunctionResult({
    abi: fixture.abi,
    functionName: fixture.functionName,
    result: fixture.result,
  }),
}))

const graphqlToken =
  /\.\.\.|[_A-Za-z][_0-9A-Za-z]*|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|"(?:\\.|[^"\\])*"|[!$&():=@[\]{|}]/g

function canonicalGraphql(document) {
  const source = document.replace(/#[^\r\n]*/g, '')
  const tokens = []
  let cursor = 0
  for (const match of source.matchAll(graphqlToken)) {
    if (!/^[\s,]*$/.test(source.slice(cursor, match.index))) {
      throw new Error('Unsupported token in GraphQL document')
    }
    tokens.push(match[0])
    cursor = match.index + match[0].length
  }
  if (!/^[\s,]*$/.test(source.slice(cursor))) {
    throw new Error('Unsupported token in GraphQL document')
  }
  return tokens.join(' ')
}

const graphqlFixtures = [
  {
    name: 'project',
    query: `query($chainId: Float!, $projectId: Float!) {
      project(chainId: $chainId, projectId: $projectId, version: 6) { ${projectFields} }
    }`,
    variables: { chainId: 1, projectId: 1 },
    data: { project },
  },
  {
    name: 'participants',
    query: `query($chainId: Int!, $projectId: Int!, $limit: Int!, $offset: Int!) {
      participants(
        where: { chainId: $chainId, projectId: $projectId, version: 6, balance_gt: "0" }
        orderBy: "balance"
        orderDirection: "desc"
        limit: $limit
        offset: $offset
      ) { items { address balance chainId volumeUsd } totalCount }
    }`,
    variables: { chainId: 1, projectId: 1, limit: 250, offset: 0 },
    data: { participants },
  },
  {
    name: 'revnetOperator',
    query: `query($chainId: Int!, $projectId: Int!) {
      permissionHolders(
        where: { chainId: $chainId, projectId: $projectId, version: 6, isRevnetOperator: true }
        limit: 10
      ) { items { operator permissions } }
    }`,
    variables: { chainId: 1, projectId: 1 },
    data: { permissionHolders: { items: [] } },
  },
  {
    name: 'permissionHolders',
    query: `query($chainId: Int!, $projectId: Int!) {
      permissionHolders(
        where: { chainId: $chainId, projectId: $projectId, version: 6 }
        limit: 100
      ) { items { chainId account operator permissions isRevnetOperator } }
    }`,
    variables: { chainId: 1, projectId: 1 },
    data: { permissionHolders: { items: [] } },
  },
  {
    name: 'trending',
    query: `query($limit: Int!) {
      suckerGroups(
        where: { version_in: [4, 5, 6] }
        orderBy: "trendingScore"
        orderDirection: "desc"
        limit: $limit
      ) {
        items {
          id version volume trendingScore paymentsCount
          projects(orderBy: "chainId", orderDirection: "asc", limit: 8) {
            items {
              projectId chainId name logoUri projectTagline tokenSymbol
              decimals suckerGroupId volume paymentsCount
            }
          }
        }
      }
    }`,
    variables: { limit: 12 },
    data: {
      suckerGroups: {
        items: [
          {
            id: 'browser-fixture-group',
            version: 6,
            volume: '1250000000',
            trendingScore: '1000000',
            paymentsCount: 7,
            projects: {
              items: [
                {
                  projectId: PROJECT_ID,
                  chainId: CHAIN_ID,
                  name: 'Browser Fixture Project',
                  logoUri: null,
                  projectTagline: 'Deterministic V6 trending card.',
                  tokenSymbol: 'USDC',
                  decimals: 6,
                  suckerGroupId: 'browser-fixture-group',
                  volume: '1250000000',
                  paymentsCount: 7,
                },
              ],
            },
          },
        ],
      },
    },
  },
  {
    name: 'recentActivity',
    query: `query($limit: Int!) {
      activityEvents(
        where: { version: 6, type_in: [payEvent, cashOutTokensEvent] }
        orderBy: "timestamp"
        orderDirection: "desc"
        limit: $limit
      ) {
        items {
          id chainId projectId timestamp txHash from
          project { name logoUri tokenSymbol decimals }
          payEvent { amount amountUsd beneficiary newlyIssuedTokenCount }
          cashOutTokensEvent {
            cashOutCount reclaimAmount reclaimAmountUsd beneficiary
          }
        }
      }
    }`,
    variables: { limit: 12 },
    data: {
      activityEvents: {
        items: [
          {
            id: 'browser-fixture-payment',
            chainId: CHAIN_ID,
            projectId: PROJECT_ID,
            timestamp: 1_700_000_100,
            txHash:
              '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            from: '0x2222222222222222222222222222222222222222',
            project: {
              name: 'Browser Fixture Project',
              logoUri: null,
              tokenSymbol: 'USDC',
              decimals: 6,
            },
            payEvent: {
              amount: '2500000',
              amountUsd: '2500000',
              beneficiary: '0x2222222222222222222222222222222222222222',
              newlyIssuedTokenCount: '5000000000000000000',
            },
            cashOutTokensEvent: null,
          },
        ],
      },
    },
  },
  {
    name: 'legacyProjects',
    query: `query($limit: Int!) {
      projects(
        orderBy: trendingScore
        orderDirection: desc
        where: { pv_in: ["1", "2"], trendingScore_gt: 0 }
        first: $limit
      ) { projectId pv handle metadataUri trendingScore volume paymentsCount }
    }`,
    variables: { limit: 12 },
    data: {
      projects: [
        {
          projectId: 2,
          pv: '2',
          handle: 'Legacy Browser Fixture',
          metadataUri: null,
          trendingScore: '900000',
          volume: '42000000000000000000',
          paymentsCount: 3,
        },
      ],
    },
  },
].map(fixture => ({ ...fixture, canonical: canonicalGraphql(fixture.query) }))

function localCorsHeaders(request) {
  const origin = request.headers.origin
  if (!origin) return {}

  try {
    const hostname = new URL(origin).hostname
    if (
      hostname !== '127.0.0.1' &&
      hostname !== 'localhost' &&
      hostname !== '::1'
    ) {
      return {}
    }
  } catch {
    return {}
  }

  return {
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-origin': origin,
    vary: 'origin',
  }
}

function sendJson(request, response, status, body) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    ...localCorsHeaders(request),
  })
  response.end(JSON.stringify(body))
}

async function readJson(request) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > 64 * 1024) {
      throw new Error('Fixture request body exceeded 64 KiB')
    }
    chunks.push(chunk)
  }
  if (bytes === 0) throw new Error('Fixture request body was empty')
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function hasJsonContentType(request) {
  return /^application\/json(?:\s*;|$)/i.test(
    String(request.headers['content-type'] ?? ''),
  )
}

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    exactValue(Object.keys(value).sort(), [...keys].sort())
  )
}

function rpcError(id, message, code = -32_004) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result }
}

function contractReadResult(chainId, to, data) {
  const candidates = contractFixtures.filter(
    fixture => fixture.address === to && fixture.chainIds.includes(chainId),
  )
  for (const fixture of candidates) {
    try {
      const decoded = decodeFunctionData({ abi: fixture.abi, data })
      if (decoded.functionName !== fixture.functionName) continue
      if (!exactValue(decoded.args ?? [], fixture.args)) {
        recordUnknown(
          'contract-arguments',
          `${fixture.name} received unsupported arguments`,
        )
        return null
      }
      increment(state.contracts, fixture.name)
      return fixture.encodedResult
    } catch {
      // The address can expose more functions than this focused fixture.
    }
  }
  recordUnknown('contract-read', `${to}:${data.slice(0, 10)}`)
  return null
}

function validRpcEnvelope(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
  if (payload.jsonrpc !== '2.0') return false
  if (typeof payload.id !== 'number' && typeof payload.id !== 'string') return false
  const keys = payload.params === undefined
    ? ['id', 'jsonrpc', 'method']
    : ['id', 'jsonrpc', 'method', 'params']
  return exactKeys(payload, keys)
}

function handleRpcCall(payload, chainId) {
  if (!validRpcEnvelope(payload)) {
    recordUnknown('rpc-envelope', 'Malformed JSON-RPC 2.0 request')
    return rpcError(payload?.id, 'Malformed deterministic JSON-RPC envelope', -32_600)
  }

  const { id, method, params } = payload
  increment(state.rpc, String(method))
  if (method === 'eth_chainId' || method === 'net_version' || method === 'eth_blockNumber') {
    if (params !== undefined && !exactValue(params, [])) {
      recordUnknown('rpc-parameters', `${method} requires no parameters`)
      return rpcError(id, `Invalid parameters for ${method}`, -32_602)
    }
    if (method === 'eth_chainId') return rpcResult(id, `0x${chainId.toString(16)}`)
    if (method === 'net_version') return rpcResult(id, String(chainId))
    return rpcResult(id, '0x123456')
  }

  if (method !== 'eth_call') {
    recordUnknown('rpc-method', String(method))
    return rpcError(id, `Deterministic fixture does not implement ${String(method)}`)
  }

  if (
    !Array.isArray(params) ||
    params.length !== 2 ||
    params[1] !== 'latest' ||
    !exactKeys(params[0], ['to', 'data']) ||
    typeof params[0].to !== 'string' ||
    !/^0x[0-9a-f]{40}$/i.test(params[0].to) ||
    typeof params[0].data !== 'string' ||
    !/^0x[0-9a-f]*$/i.test(params[0].data)
  ) {
    recordUnknown('rpc-parameters', 'eth_call requires {to,data} at latest')
    return rpcError(id, 'Invalid deterministic eth_call parameters', -32_602)
  }

  const to = params[0].to.toLowerCase()
  const data = params[0].data
  if (to !== MULTICALL3) {
    const directResult = contractReadResult(chainId, to, data)
    return directResult
      ? rpcResult(id, directResult)
      : rpcError(id, 'Deterministic fixture has no matching contract read')
  }

  try {
    const decoded = decodeFunctionData({ abi: multicall3Abi, data })
    if (decoded.functionName !== 'aggregate3' || !Array.isArray(decoded.args?.[0])) {
      throw new Error('Only aggregate3 is supported')
    }
    const calls = decoded.args[0]
    if (calls.length === 0 || calls.length > 64) {
      throw new Error('Multicall batch size is outside the fixture bounds')
    }
    state.multicallBatches += 1
    const results = calls.map(innerCall => {
      const returnData = contractReadResult(
        chainId,
        innerCall.target.toLowerCase(),
        innerCall.callData,
      )
      return returnData
        ? { success: true, returnData }
        : { success: false, returnData: '0x' }
    })
    return rpcResult(
      id,
      encodeFunctionResult({
        abi: multicall3Abi,
        functionName: 'aggregate3',
        result: results,
      }),
    )
  } catch (error) {
    recordUnknown(
      'multicall-envelope',
      error instanceof Error ? error.message : 'Malformed multicall',
    )
    return rpcError(id, 'Deterministic fixture rejected a malformed multicall')
  }
}

async function handleGraphql(request, response) {
  if (!hasJsonContentType(request)) {
    recordUnknown('graphql-content-type', String(request.headers['content-type']))
    sendJson(request, response, 415, {
      errors: [{ message: 'GraphQL fixture requires application/json' }],
    })
    return
  }

  const payload = await readJson(request)
  if (!exactKeys(payload, ['query', 'variables'])) {
    recordUnknown('graphql-envelope', 'Expected exactly query and variables')
    sendJson(request, response, 400, {
      errors: [{ message: 'Malformed deterministic GraphQL envelope' }],
    })
    return
  }

  let canonical
  try {
    canonical = canonicalGraphql(payload.query)
  } catch (error) {
    recordUnknown(
      'graphql-document',
      error instanceof Error ? error.message : 'Malformed document',
    )
    sendJson(request, response, 400, {
      errors: [{ message: 'Malformed deterministic GraphQL document' }],
    })
    return
  }

  const fixture = graphqlFixtures.find(
    candidate =>
      candidate.canonical === canonical &&
      exactValue(payload.variables, candidate.variables),
  )
  if (!fixture) {
    const knownDocument = graphqlFixtures.find(
      candidate => candidate.canonical === canonical,
    )
    recordUnknown(
      knownDocument ? 'graphql-variables' : 'graphql-document',
      knownDocument?.name ?? canonical.slice(0, 180),
    )
    sendJson(request, response, 503, {
      errors: [{ message: 'Deterministic fixture has no matching GraphQL query' }],
    })
    return
  }

  increment(state.graphql, fixture.name)
  sendJson(request, response, 200, { data: fixture.data })
}

const server = createServer(async (request, response) => {
  try {
    if (request.url === '/health' && request.method === 'GET') {
      response.writeHead(204).end()
      return
    }

    if (request.url === '/__fixture/status' && request.method === 'GET') {
      sendJson(request, response, 200, state)
      return
    }

    if (
      request.method === 'OPTIONS' &&
      (request.url === '/graphql' || request.url?.startsWith('/rpc/'))
    ) {
      state.preflights += 1
      response.writeHead(204, localCorsHeaders(request)).end()
      return
    }

    if (request.url === '/graphql' && request.method === 'POST') {
      await handleGraphql(request, response)
      return
    }

    const rpcChainIds = {
      '/rpc/mainnet': 1,
      '/rpc/optimism-mainnet': 10,
      '/rpc/base-mainnet': 8453,
      '/rpc/arbitrum-mainnet': 42161,
    }
    const rpcChainId = rpcChainIds[request.url]
    if (rpcChainId && request.method === 'POST') {
      if (!hasJsonContentType(request)) {
        recordUnknown('rpc-content-type', String(request.headers['content-type']))
        sendJson(request, response, 415, rpcError(null, 'RPC fixture requires application/json'))
        return
      }
      const payload = await readJson(request)
      if (Array.isArray(payload) && payload.length === 0) {
        recordUnknown('rpc-batch', 'Empty JSON-RPC batch')
        sendJson(request, response, 400, rpcError(null, 'Empty JSON-RPC batch', -32_600))
        return
      }
      const result = Array.isArray(payload)
        ? payload.map(item => handleRpcCall(item, rpcChainId))
        : handleRpcCall(payload, rpcChainId)
      sendJson(request, response, 200, result)
      return
    }

    recordUnknown('http-route', `${request.method} ${request.url}`)
    sendJson(request, response, 503, {
      errors: [{ message: 'Deterministic browser fixture: service unavailable' }],
    })
  } catch (error) {
    recordUnknown(
      'request-error',
      error instanceof Error ? error.message : 'Invalid fixture request',
    )
    sendJson(request, response, 400, {
      errors: [
        {
          message:
            error instanceof Error ? error.message : 'Invalid fixture request',
        },
      ],
    })
  }
})

server.listen(port, '127.0.0.1')

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
