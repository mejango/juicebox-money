import type { Metadata } from 'next'
import Link from 'next/link'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { GuideSections, type GuideSection } from '@/components/GuideSections'

export const dynamic = 'force-static'

export const metadata: Metadata = {
  title: 'Your first Juicebox payment: learn, build, and inspect',
  description: 'Read a test project, preview a payment, then make a small test payment and check the result.',
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
        'Read project 1 on Base Sepolia, preview a payment, then try it in the app. Base Sepolia is a practice network that uses test ETH.',
        'Paying usually funds a project and creates tokens for you. Some projects can instead buy existing tokens from a market. They can also set aside a share of new tokens for other recipients. Tokens alone do not promise ownership, votes, or profit.',
        'Before paying, check how many tokens you receive, who else receives tokens, how you can exchange them for project funds, and what the owner can change. Project 1 is a working test project, so its terms and balances can change.',
      ],
      blocks: [
        { type: 'links', items: [
          { href: '/basesep:1', label: 'Open Base Sepolia project 1' },
          { href: '/learn#learn-before-you-pay', label: 'What to check before paying' },
          { href: '/learn#learn-glossary', label: 'Glossary' },
          { href: 'https://revnet.money/learn#three-prices', label: 'Why buying, trading, and cashing out have different prices' },
        ] },
      ],
    },
    {
      id: 'read', part: 'Build', title: 'Read the project',
      paragraphs: [
        'Use Node.js 22 or newer. In a new folder, install the packages below, download read-project.mjs, and run it. This step only reads public data.',
        'The script finds the contract that manages the project’s rules and tokens, called its controller. It reads the active terms, called a ruleset, from one recorded block of chain history. It checks the network and block again so the result refers to one consistent observation.',
      ],
      blocks: [
        { type: 'code', label: 'Set up and read', code: 'mkdir juicebox-first-payment\ncd juicebox-first-payment\nnpm init -y\nnpm install --save-exact @bananapus/nana-sdk-core@2.3.2 viem@2.55.19\ncurl --fail -O https://juicebox.money/examples/read-project.mjs\nnode read-project.mjs' },
        { type: 'links', items: [{ href: '/examples/read-project.mjs', label: 'Read or save read-project.mjs' }] },
        { type: 'code', label: 'Complete read-project.mjs', code: readExample },
        { type: 'table', label: 'What success looks like', rows: [
          ['Identity', 'protocolVersion is 6, chainId is 84532, and projectId is "1".'],
          ['Evidence', 'blockNumber and blockHash identify when the data was read. controller is the managing contract found through JBDirectory.'],
          ['Terms', 'ruleset.id is nonzero. In metadata, reservedPercent is the share of new tokens set aside for others; cashOutTaxRate shapes how much stays for remaining holders; pausePay stops payments. dataHook names any extension that can change a payment or cash out. Compare these fields with the project’s Terms view.'],
          ['Units', 'Large whole numbers print as strings. reservedPercent and cashOutTaxRate use a scale of 10,000: 6200 means 62%. weight gives new tokens per unit of the project’s pricing currency, before setting aside the reserved share. Divide it by 10^18 for the displayed rate.'],
        ] },
        { type: 'text', text: 'Set JB_PROJECT_ID to read another Base Sepolia project. Set BASE_SEPOLIA_RPC_URL to use another service for reading that network. Always compare both the network and project ID.' },
      ],
    },
    {
      id: 'preview', part: 'Build', title: 'Preview a payment',
      paragraphs: [
        'This step prepares a payment of 0.000001 test ETH. It finds the project’s payment contract, called a terminal, and requests a quote that includes any configured extensions. It sets a minimum of 99% of the quoted tokens, then runs a trial of that exact request, called a simulation. Enter only your public wallet address, never a private key.',
        'The trial does not send a payment. It shows how this request would run against current chain data. The app may find a different way to buy tokens, so review its fresh quote when you pay.',
      ],
      blocks: [
        { type: 'code', label: 'Download and simulate with your public address', code: 'curl --fail -O https://juicebox.money/examples/preview-payment.mjs\n# Replace this placeholder with your public wallet address.\nJB_PAYER=0xYourPublicWalletAddress node preview-payment.mjs' },
        { type: 'links', items: [{ href: '/examples/preview-payment.mjs', label: 'Read or save preview-payment.mjs' }] },
        { type: 'code', label: 'Complete preview-payment.mjs', code: previewExample },
        { type: 'text', text: 'Expected output: state is "simulated-only", decoded.functionName is "pay", and nativeValue is "1000000000000" wei. Wei is ETH’s smallest unit; divide by 10^18 to get ETH. The output shows the tokens for you and other recipients, the minimum you would accept, the trial result, and the encoded request (calldata). Divide token amounts by 10^18 for displayed amounts.' },
        { type: 'info', text: 'Checked on September 11, 2026 with the Juicebox software library (SDK) 2.3.2 and viem 2.55.19. The read used Base Sepolia block 46687567, hash 0x605e8e9c2af20659dde61a3c20f0c13020b549107e6ac1150f42a1f1d7a1d7ec. The payment was simulated only. Run the examples again to get current results.' },
      ],
    },
    {
      id: 'pay', part: 'Try it', title: 'Make a small test payment in the app',
      paragraphs: [
        'To try the payment, connect a wallet with Base Sepolia test ETH. Keep some test ETH for the network’s cost of processing the transaction, called gas. Use the app’s payment form to get a fresh quote and review it before signing.',
      ],
      blocks: [
        { type: 'steps', items: [
          'Open Base Sepolia project 1. Check the network, project ID, and current and upcoming terms.',
          'Connect your test wallet on Base Sepolia. Choose ETH and enter 0.000001. If the form cannot accept it, check the reason and stay on the test network.',
          'Review where the money goes, who receives tokens, the expected and minimum token amounts, and the total cost. Paying with ETH needs no separate permission to spend tokens. Other assets may need that approval.',
          'Read the form’s fresh trial result and transaction details. Sign only the matching wallet request.',
          'Save the transaction’s unique ID, called its hash. Wait for its receipt to show success. If you use a shared Safe wallet, the proposal still needs the required approvals and execution.',
        ] },
        { type: 'links', items: [
          { href: '/basesep:1', label: 'Open the test payment form' },
          { href: 'https://docs.base.org/get-started/get-funds#testnet-base-sepolia', label: 'Get free Base Sepolia test ETH from the official faucet guide' },
        ] },
      ],
    },
    {
      id: 'inspect', part: 'Inspect', title: 'Check what happened',
      paragraphs: [
        'Open Base Sepolia project 1 in Juicescan. Keep your transaction hash and the token recipient’s address handy. The receipt shows whether the payment succeeded; the transaction details show where the money and tokens went.',
      ],
      blocks: [
        { type: 'links', items: [
          { href: 'https://juicebox.center/inspect/basesep/1', label: 'Inspect Base Sepolia project 1 in Juicescan' },
          { href: 'https://sepolia.basescan.org/', label: 'Look up your transaction hash on Base Sepolia' },
        ] },
        { type: 'steps', items: [
          'Find your transaction by its hash. Check the network, success status, sender, destination, amount, and action.',
          'Read its recorded events to check the project, recipient, and tokens received. Buying existing tokens can send money to a market instead of adding it all to the project.',
          'Check the recipient’s total holdings. Include tokens tracked inside Juicebox, called credits, and any tokens in a separate ERC-20 contract. Other payments can also change balances; use your transaction’s events to explain this change.',
          'Compare the network and project ID with the tutorial output. Terms and balances may have changed since the earlier read. Activity lists can take time to catch up; keep the receipt while you wait.',
        ] },
        { type: 'text', text: 'You are done when you can explain where your payment went and show the tokens received. Exchanging tokens for project funds, called cashing out, is a separate action that depends on the project’s terms and available funds.' },
      ],
    },
    {
      id: 'recover', part: 'Recover', title: 'If something goes wrong',
      blocks: [
        { type: 'table', label: 'Check the existing operation first', rows: [
          ['Wrong chain or missing project', 'Check network 84532 and project 1. A failed connection does not mean the project is missing. Try another Base Sepolia read service.'],
          ['Preview or simulation failed', 'Refresh the payment contract, terms, quote, and recipient. Payments may be paused, an extension may need more information, or the quote may have changed. Keep the minimum token amount protected.'],
          ['Wallet rejected', 'Rejecting the wallet request does not approve a payment. Check for an earlier transaction hash before trying again.'],
          ['Safe proposal', 'Wait for the shared wallet’s required approvals and execution. A proposal alone does not send funds.'],
          ['Pending or unknown result', 'Check the existing transaction hash or operation ID. A timeout does not prove failure. Find the result before paying again.'],
          ['Transaction failed', 'The payment did not take effect, though it may have spent gas. Check the reason, then get a fresh quote before trying again.'],
          ['Successful receipt, missing activity', 'Check the transaction directly on the chain and let the activity list catch up. A delayed list is not a reason to pay again.'],
        ] },
        { type: 'links', items: [
          { href: '/build#apps-transaction-boundary', label: 'Build the review and confirmation flow' },
          { href: 'https://juicebox.center/api/docs/transactions', label: 'How Center handles plans and confirmations' },
          { href: 'https://revnet.money/build#choosing-the-numbers', label: 'Next: choose a revnet’s terms' },
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
