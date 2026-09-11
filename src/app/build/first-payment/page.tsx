import type { Metadata } from 'next'
import Link from 'next/link'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { GuideSections, type GuideSection } from '@/components/GuideSections'

export const dynamic = 'force-static'

export const metadata: Metadata = {
  title: 'Your first Juicebox payment: learn, build, and inspect',
  description: 'Read a live Base Sepolia project without a wallet, simulate a payment, then use the app to make and verify a small test payment.',
  alternates: { canonical: '/build/first-payment' },
}

export default async function FirstPaymentPage() {
  // Display the exact downloadable, executable files, not separately maintained snippets.
  const [readExample, previewExample] = await Promise.all([
    readFile(path.join(process.cwd(), 'public/examples/read-project.mjs'), 'utf8'),
    readFile(path.join(process.cwd(), 'public/examples/preview-payment.mjs'), 'utf8'),
  ])
  const sections: GuideSection[] = [
    {
      id: 'understand', part: 'Learn', title: 'Know what a payment does',
      paragraphs: [
        'Follow Base Sepolia project 1 through a read, a simulated native ETH payment, and an optional payment in the app. Base Sepolia is a test network: use test ETH only. You can read this guide and the project without connecting a wallet.',
        'A payment can issue project tokens and fund the project, or use a configured market route to buy existing tokens. A reserved share can allocate some newly issued tokens to other recipients. Project tokens do not automatically grant equity, voting rights, or a promised return.',
        'Read the active and upcoming terms before paying. Issuance, reserved allocations, cash out rules, owner powers, and hooks affect the outcome. The example project is a live protocol test project; its current state can change. It is an example to inspect, not a recommendation of economic terms.',
      ],
      blocks: [
        { type: 'links', items: [
          { href: '/basesep:1', label: 'Open Base Sepolia project 1' },
          { href: '/learn#learn-before-you-pay', label: 'What to check before paying' },
          { href: 'https://revnet.money/learn#three-prices', label: 'Compare issuance, market, and cash out prices' },
        ] },
      ],
    },
    {
      id: 'read', part: 'Build', title: 'Read the project without a wallet',
      paragraphs: [
        'Use Node.js 22 or newer. Install the exact dependency versions below in a new folder, download read-project.mjs, and run it there. No account, wallet, API key, or test ETH is required for this step.',
        'The script checks the RPC network, resolves the project’s current controller through JBDirectory, and reads the ruleset and metadata at one block. It then checks that the block hash still matches. It stops if the project is missing or has no active ruleset.',
      ],
      blocks: [
        { type: 'code', label: 'Set up and read', code: 'mkdir juicebox-first-payment\ncd juicebox-first-payment\nnpm init -y\nnpm install --save-exact @bananapus/nana-sdk-core@2.3.2 viem@2.55.19\ncurl --fail -O https://juicebox.money/examples/read-project.mjs\nnode read-project.mjs' },
        { type: 'links', items: [{ href: '/examples/read-project.mjs', label: 'Read or save read-project.mjs' }] },
        { type: 'code', label: 'Complete read-project.mjs', code: readExample },
        { type: 'table', label: 'What success looks like', rows: [
          ['Identity', 'protocolVersion is 6, chainId is 84532, and projectId is "1".'],
          ['Evidence', 'blockNumber and blockHash identify the observation. controller is the address resolved from JBDirectory.'],
          ['Terms', 'ruleset.id is nonzero. metadata includes reservedPercent, cashOutTaxRate, pausePay, and any enabled data hook. Compare these with the project’s Rulesets or Terms view.'],
          ['Units', 'Large integers print as decimal strings. reservedPercent and cashOutTaxRate use a scale of 10,000: 6200 means 62%. weight uses 18-decimal project-token units per base-currency unit, before reserves; it is not a market price.'],
        ] },
        { type: 'text', text: 'To read another Base Sepolia project, set JB_PROJECT_ID. To use your own endpoint, set BASE_SEPOLIA_RPC_URL. The script deliberately rejects a different network. Keep the chain and project ID together when comparing views.' },
      ],
    },
    {
      id: 'preview', part: 'Build', title: 'Preview and simulate a payment',
      paragraphs: [
        'This optional developer step prepares a direct terminal payment of 0.000001 test ETH. It requires only your public wallet address. Never paste a private key. The script resolves the current terminal, gets its hook-aware preview, sets a 1% minimum-output tolerance, decodes the same request, and simulates it as that address.',
        'A terminal preview is not a comparison of every market route. The app can choose a different route and must show its own fresh quote. A simulation does not establish wallet ownership, sufficient gas funding, future execution, or a confirmed payment.',
      ],
      blocks: [
        { type: 'code', label: 'Download and simulate with your public address', code: 'curl --fail -O https://juicebox.money/examples/preview-payment.mjs\n# Replace this placeholder with your public wallet address.\nJB_PAYER=0xYourPublicWalletAddress node preview-payment.mjs' },
        { type: 'links', items: [{ href: '/examples/preview-payment.mjs', label: 'Read or save preview-payment.mjs' }] },
        { type: 'code', label: 'Complete preview-payment.mjs', code: previewExample },
        { type: 'text', text: 'Expected output: state is "simulated-only", decoded.functionName is "pay", and nativeValue is "1000000000000" wei. The output also includes quoted payer and reserved token amounts, minimum output, simulated return, and calldata. All token amounts are raw 18-decimal project-token units. No wallet request or transaction hash is produced.' },
        { type: 'info', text: 'Both scripts were checked with SDK 2.3.2 and viem 2.55.19 on September 11, 2026. The sample read was observed at Base Sepolia block 46687567, hash 0x605e8e9c2af20659dde61a3c20f0c13020b549107e6ac1150f42a1f1d7a1d7ec. The direct terminal call was simulated, not signed or broadcast. Run the examples again for current state; token outputs are not fixed fixtures.' },
      ],
    },
    {
      id: 'pay', part: 'Try it', title: 'Make a small test payment in the app',
      paragraphs: [
        'Only this step needs a connected wallet and Base Sepolia test ETH for both the payment and gas. If you are learning the SDK, you can stop after simulation. If you continue, use the existing payment form so the current quote, review, and wallet flow stay together.',
      ],
      blocks: [
        { type: 'steps', items: [
          'Open Base Sepolia project 1. Confirm the network and project ID, then read its current and upcoming terms.',
          'Connect your test wallet on Base Sepolia. Select native ETH and enter 0.000001. If the current form cannot accept that amount or route, inspect the reason; do not switch to mainnet to complete this tutorial.',
          'Review the route, recipient, expected tokens, minimum output, and gas. A native terminal payment needs no ERC-20 approval. A different payment asset or route may have additional requirements.',
          'Use the form’s fresh simulation and decoded review. Approve only the wallet request matching the action you intend. The earlier script output is not a transaction to sign later.',
          'Save the transaction hash and wait for a successful receipt. A Safe proposal still needs execution before it is a payment. Continue to inspection after execution, not merely after a signature.',
        ] },
        { type: 'links', items: [
          { href: '/basesep:1', label: 'Open the test payment form' },
          { href: 'https://docs.base.org/get-started/get-funds#testnet-base-sepolia', label: 'Get free Base Sepolia test ETH from the official faucet guide' },
        ] },
      ],
    },
    {
      id: 'inspect', part: 'Inspect', title: 'Verify what actually happened',
      paragraphs: [
        'Open the same Base Sepolia project in Juicescan. Center’s inspection link follows its current published explorer while preserving basesep:1. Keep your transaction hash and public beneficiary address available. A successful receipt is evidence of execution; the decoded call, events, and resulting balances explain its effect.',
      ],
      blocks: [
        { type: 'links', items: [
          { href: 'https://juicebox.center/inspect/basesep/1', label: 'Inspect Base Sepolia project 1 in Juicescan' },
          { href: 'https://sepolia.basescan.org/', label: 'Look up your transaction hash on Base Sepolia' },
        ] },
        { type: 'steps', items: [
          'Check the receipt’s network, success status, sender, destination, native value, and decoded method. Use the hash from your submitted operation.',
          'Check the payment or swap events for the actual route, project, beneficiary, and returned tokens. A market route can send money to a pool instead of adding all of it to the project balance.',
          'Compare the beneficiary’s project-token holdings, including protocol credits and ERC-20 balances where applicable. Other activity can change balances too; use this transaction’s events to attribute the change.',
          'Re-read the current terms and compare the chain-specific identity with the tutorial output. Later rules or balances can differ from an earlier block. If activity has not appeared in the index yet, retain the receipt and show indexing as pending.',
        ] },
        { type: 'text', text: 'You have completed the journey when you can identify the actual operation, explain where the funds went, and show the token outcome. A cash out is a separate action under current surplus, tax, hook, and fee rules; a payment does not guarantee an immediate exit.' },
      ],
    },
    {
      id: 'recover', part: 'Recover', title: 'Resolve a missing or uncertain result',
      blocks: [
        { type: 'table', label: 'Check the existing operation first', rows: [
          ['Wrong chain or missing project', 'Check 84532 and project 1. An RPC error is not evidence that the project does not exist. Retry the read through a Base Sepolia endpoint.'],
          ['Preview or simulation failed', 'Re-read the current terminal, terms, route, and beneficiary. Paused payments, hook requirements, or a changed quote can prevent this example from working. Do not remove minimum-output protection to force it through.'],
          ['Wallet rejected', 'A rejected signature request has not authorized that payment. Check whether an earlier operation already has a hash before starting another.'],
          ['Safe proposal', 'Inspect the proposal and wait for its required approvals and execution. Proposing alone does not change project balances.'],
          ['Pending or unknown broadcast', 'Keep the existing transaction hash or operation identifier and inspect its status. A timeout is not evidence of failure and is not a reason to pay again.'],
          ['Receipt reverted', 'That transaction did not apply its payment effects; gas can still be spent. Inspect the reason, then obtain a fresh quote and review before another attempt.'],
          ['Successful receipt, missing activity', 'Inspect the transaction onchain and allow the indexer to catch up. Do not repeat a successful payment because an activity view is delayed.'],
        ] },
        { type: 'links', items: [
          { href: '/build#apps-transaction-boundary', label: 'Build a complete transaction boundary' },
          { href: 'https://juicebox.center/api/docs/transactions', label: 'Center plans, retries, and confirmations' },
          { href: 'https://revnet.money/build#choosing-the-numbers', label: 'Next: model a revnet’s terms' },
        ] },
      ],
    },
  ]
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
      <header className="mb-10 max-w-3xl">
        <h1 className="font-agrandir-wide text-4xl font-bold sm:text-6xl">Your first Juicebox payment.</h1>
        <p className="mt-4 text-base leading-relaxed text-smoke-700 sm:text-lg">
          Understand the terms, read a live test project, try a small payment, and inspect its result.
          Start without a wallet. Connect only when you choose to make the test payment.
        </p>
        <nav aria-label="First payment resources" className="mt-6 flex flex-wrap gap-4 underline underline-offset-4">
          <Link href="/learn">Learn Juicebox</Link>
          <Link href="/build">Build reference</Link>
          <a href="https://juicebox.center/inspect/basesep/1">Inspect the example</a>
        </nav>
      </header>
      <GuideSections sections={sections} ariaLabel="First payment" />
    </div>
  )
}
