import { expect, test } from '@playwright/test'
import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core'
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, keccak256, multicall3Abi, parseAbi, parseAbiParameters, toHex, zeroAddress, zeroHash, type Hex } from 'viem'
import registry from '../../src/lib/bendystraw-operation-registry.json'
import { routerGatewayAbi } from '../../src/lib/router-gateway-abi'

const GATEWAY = '0x4a56aef5b6a5b9742abb02ca67c5a85ba183d901'
const ACCOUNT = '0x1111111111111111111111111111111111111111'
const NOW = 1_789_185_600n
const BLOCK = '0x123456'
const ERROR = `0x${'ab'.repeat(32)}` as Hex
const readAbi = [...routerGatewayAbi, ...parseAbi([
  'function RETRY_DELAY() view returns (uint256)',
  'function FINALIZATION_FAILURE_COUNT() view returns (uint256)',
])] as const
const parameters = parseAbiParameters('(uint256 amount, bool preferAddToBalance, bool shouldReturnHeldFees, address beneficiary, uint256 projectId, address refundTo, uint256 sourceProjectId, address token), string, bytes')
const payments = [125_000_000_000_000_000n, 250_000_000_000_000_000n, 375_000_000_000_000_000n].map((amount, index) => {
  const call = { amount, preferAddToBalance: false, shouldReturnHeldFees: false, beneficiary: ACCOUNT,
    projectId: 1n, refundTo: ACCOUNT, sourceProjectId: 1n, token: NATIVE_TOKEN } as const
  const memo = 'Retained protocol fee'
  const metadata = '0x1234' as const
  return { ...call, amount: amount.toString(), projectId: 1, sourceProjectId: 1,
    chainId: 1, version: 6, gateway: GATEWAY, pendingCallId: toHex(index + 1, { size: 32 }),
    retainedAmount: amount.toString(), memo, metadata,
    callCommitment: keccak256(encodeAbiParameters(parameters, [call, memo, metadata])),
    status: index === 0 ? 'queued' : 'retried' }
})
type RpcRequest = { jsonrpc: string; id: number; method: string; params?: unknown[] }

for (const viewport of [{ name: 'mobile', width: 390, height: 844 }, { name: 'desktop', width: 1280, height: 900 }]) {
  test(`pending payments show verified retry, finalization and cooldown controls on ${viewport.name}`, async ({ context, page }) => {
    await page.setViewportSize(viewport)
    await context.route(/^https?:\/\//, async route => {
      if (['127.0.0.1', 'localhost', '::1'].includes(new URL(route.request().url()).hostname)) await route.continue()
      else await route.fulfill({ status: 503, body: 'External browser traffic is disabled' })
    })
    await context.routeWebSocket(url => !['127.0.0.1', 'localhost', '::1'].includes(url.hostname), socket => socket.close())
    const writes: string[] = []
    const verifiedCalls: string[] = []
    let blockReads = 0
    let releaseVerification = () => {}
    const verificationGate = new Promise<void>(resolve => { releaseVerification = resolve })

    await page.route('**/api/bendystraw/*/query', async route => {
      const request = route.request().postDataJSON() as { operation: string; variables: { chainId: number; sourceProjectId: number; gateway: string; offset: number; limit: number } }
      if (!(registry as Record<string, string>)[request.operation]?.startsWith('query PendingPayments(')) {
        await route.fallback()
        return
      }
      expect(request.variables).toEqual({ chainId: 1, sourceProjectId: 1, gateway: GATEWAY, limit: 100, offset: 0 })
      await route.fulfill({ json: { data: { routerPendingCalls: { items: payments, totalCount: payments.length } } } })
    })

    function gatewayRead(target: string, data: Hex): Hex | undefined {
      if (target.toLowerCase() === GATEWAY) {
        const decoded = decodeFunctionData({ abi: readAbi, data })
        verifiedCalls.push(decoded.functionName)
        if (decoded.functionName === 'RETRY_DELAY') return encodeFunctionResult({ abi: readAbi, functionName: decoded.functionName, result: 86_400n })
        if (decoded.functionName === 'FINALIZATION_FAILURE_COUNT') return encodeFunctionResult({ abi: readAbi, functionName: decoded.functionName, result: 3n })
        if (decoded.functionName === 'pendingCallCommitmentOf') {
          const payment = payments.find(item => item.pendingCallId === decoded.args[0])!
          expect(payment).toBeDefined()
          return encodeFunctionResult({ abi: readAbi, functionName: decoded.functionName, result: payment.callCommitment })
        }
        if (decoded.functionName === 'pendingCallFailureOf') {
          const id = BigInt(decoded.args[0])
          return encodeFunctionResult({ abi: readAbi, functionName: decoded.functionName, result: {
            errorHash: id === 1n ? zeroHash : ERROR, count: id === 1n ? 0 : id === 2n ? 3 : 1,
            lastFailureAt: id === 3n ? Number(NOW) : Number(NOW - 86_400n), highestGasLimit: id === 1n ? 0n : 5_000_000n,
          } })
        }
        throw new Error(`Pending panel attempted a non-read gateway operation: ${decoded.functionName}`)
      }
      if (target.toLowerCase() !== '0xca11bde05977b3631167028862be2a173976ca11') return undefined
      const decoded = decodeFunctionData({ abi: multicall3Abi, data })
      if (decoded.functionName !== 'aggregate3') return undefined
      const results = decoded.args[0].map(call => gatewayRead(call.target, call.callData))
      if (results.every(result => result === undefined)) return undefined
      expect(results.every(result => result !== undefined), 'Pinned gateway reads must stay separate from unrelated latest-block calls').toBe(true)
      return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results.map(returnData => ({ success: true, returnData: returnData! })) })
    }

    await page.route('**/rpc/mainnet', async route => {
      const payload = route.request().postDataJSON() as RpcRequest
      if (payload.method.startsWith('eth_send') || payload.method.startsWith('wallet_')) writes.push(payload.method)
      if (payload.method === 'eth_getBlockByNumber') {
        blockReads++
        await verificationGate
        await route.fulfill({ json: { jsonrpc: '2.0', id: payload.id, result: {
          number: BLOCK, hash: zeroHash, parentHash: zeroHash, timestamp: toHex(NOW), gasLimit: toHex(30_000_000n),
          gasUsed: '0x0', baseFeePerGas: '0x1', difficulty: '0x0', miner: zeroAddress, extraData: '0x', transactions: [],
        } } })
        return
      }
      if (payload.method === 'eth_call') {
        const call = payload.params?.[0] as { to: string; data: Hex }
        const result = gatewayRead(call.to, call.data)
        if (result !== undefined) {
          expect(payload.params?.[1]).toBe(BLOCK)
          await route.fulfill({ json: { jsonrpc: '2.0', id: payload.id, result } })
          return
        }
      }
      await route.fallback()
    })

    const browserErrors: string[] = []
    page.on('pageerror', error => browserErrors.push(error.message))
    await page.goto('/eth:1', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: 'Browser Fixture Project', exact: true })).toBeVisible()
    await expect.poll(() => blockReads).toBeGreaterThan(0)
    const panel = page.getByRole('region', { name: 'Payments awaiting routing', exact: true })
    await expect(panel).toHaveCount(0)
    expect(writes).toEqual([])
    releaseVerification()

    await expect(panel.getByRole('heading', { name: 'Payments awaiting routing' })).toBeVisible()
    const retry = panel.getByRole('listitem').filter({ hasText: '0.125 ETH' })
    const finalization = panel.getByRole('listitem').filter({ hasText: '0.25 ETH' })
    const cooling = panel.getByRole('listitem').filter({ hasText: '0.375 ETH' })
    await expect(retry.getByRole('button', { name: 'Retry payment', exact: true })).toBeEnabled()
    await expect(finalization.getByRole('button', { name: 'Route or return', exact: true })).toBeEnabled()
    await expect(cooling.getByRole('button', { name: 'Retry payment', exact: true })).toBeDisabled()
    await expect(cooling.getByText(/^Available /)).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Batch 2 available', exact: true })).toBeEnabled()
    expect(verifiedCalls.filter(name => name === 'pendingCallCommitmentOf')).toHaveLength(3)
    expect(verifiedCalls.filter(name => name === 'pendingCallFailureOf')).toHaveLength(3)

    if (viewport.name === 'mobile') await expect(page.getByRole('tab', { name: 'Activity', exact: true })).toHaveAttribute('aria-selected', 'true')
    const latest = page.getByRole('heading', { name: 'Latest', exact: true })
    await expect(latest).toBeVisible()
    expect(await panel.evaluate(element => {
      const latest = [...document.querySelectorAll('h2')].find(heading => heading.textContent?.trim() === 'Latest')
      return !!latest && !!(element.compareDocumentPosition(latest) & Node.DOCUMENT_POSITION_FOLLOWING)
    })).toBe(true)
    const dimensions = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }))
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1)
    // The deterministic build has no connected wallet. Both controls must
    // remain behind sign-in and the standard review instead of sending calls.
    await retry.getByRole('button', { name: 'Retry payment', exact: true }).click()
    await panel.getByRole('button', { name: 'Batch 2 available', exact: true }).click()
    expect(writes).toEqual([])
    expect(browserErrors).toEqual([])
    await panel.evaluate(element => element.scrollIntoView({ block: 'start' }))
    await page.evaluate(() => window.scrollBy(0, -120))
    const screenshotName = `money-pending-${viewport.name}.png`
    await page.screenshot({ path: process.env.PENDING_PAYMENTS_SCREENSHOT_DIR
      ? `${process.env.PENDING_PAYMENTS_SCREENSHOT_DIR}/${screenshotName}`
      : test.info().outputPath(screenshotName) })
  })
}
