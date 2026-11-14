import type { Metadata } from 'next'
import Link from 'next/link'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { GuideSections, type GuideSection } from '@/components/GuideSections'

export const dynamic = 'force-static'

const title = 'Your first Juicebox payment: learn, build, and inspect'
const description = 'Read a test project, preview a payment, then make a small test payment and check the result.'

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: '/build/first-payment' },
  openGraph: {
    title,
    description,
    url: '/build/first-payment',
    type: 'website',
    images: [{ url: '/assets/juicebox-social.png', alt: 'Juicebox' }],
  },
  twitter: { card: 'summary_large_image', title, description, images: ['/assets/juicebox-social.png'] },
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
        'Read project 1 on Base Sepolia, a practice network that uses test ETH. Preview a payment, then try it in the app.',
        'Paying usually funds a project and creates tokens for you. Some projects can instead buy existing tokens from a market. They can also set aside a share of new tokens for other recipients.',
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
        'The script finds the controller that manages the project’s rules and tokens. It reads the active ruleset from one recorded block of chain history. It checks the network and block again so the result refers to one consistent observation.',
      ],
      blocks: [
        { type: 'code', label: 'Set up and read', lang: 'bash', code: 'mkdir juicebox-first-payment\ncd juicebox-first-payment\nnpm init -y\nnpm install --save-exact @bananapus/nana-sdk-core@6.8.0 viem@2.55.19\ncurl --fail -O https://juicebox.money/examples/read-project.mjs\nnode read-project.mjs' },
        { type: 'links', items: [{ href: '/examples/read-project.mjs', label: 'Read or save read-project.mjs' }] },
        { type: 'code', label: 'Complete read-project.mjs', lang: 'ts', code: readExample },
        { type: 'table', label: 'What success looks like', rows: [
          ['Identity', 'protocolVersion is 6, chainId is 84532, and projectId is "1".'],
          ['Evidence', 'blockNumber and blockHash identify when the data was read. controller is the managing contract found through JBDirectory.'],
          ['Terms', 'ruleset.id is nonzero. In metadata, reservedPercent is the share of new tokens reserved for others; cashOutTaxRate shapes how much stays for remaining holders; pausePay stops payments. dataHook names any extension that can change a payment or cash out. Compare these fields with the project’s Terms view.'],
          ['Units', 'Large whole numbers print as strings. reservedPercent and cashOutTaxRate use a scale of 10,000: 6200 means 62% reserved or a cash out tax of 0.62. weight gives new tokens per unit of the project’s pricing currency, before setting aside the reserved share. Divide it by 10^18 for the displayed rate.'],
        ] },
        { type: 'text', text: 'Set JB_PROJECT_ID to read another Base Sepolia project. Set BASE_SEPOLIA_RPC_URL to use another service for reading that network. Always compare both the network and project ID.' },
      ],
    },
    {
      id: 'preview', part: 'Build', title: 'Preview a payment',
      paragraphs: [
        'This step prepares a payment of 0.000001 test ETH. It finds the terminal that takes the project’s payments and requests a quote that includes any configured extensions. It sets a minimum of 99% of the quoted tokens, or of the minted tokens if the market price can’t load, then simulates that exact request. Enter only your public wallet address, never a private key.',
        'The simulation does not send a payment. It shows how this request would run against current chain data. The app may find a different way to buy tokens, so review its fresh quote when you pay.',
      ],
      blocks: [
        { type: 'code', label: 'Download and simulate with your public address', lang: 'bash', code: 'curl --fail -O https://juicebox.money/examples/preview-payment.mjs\n# Replace this placeholder with your public wallet address.\nJB_PAYER=0xYourPublicWalletAddress node preview-payment.mjs' },
        { type: 'links', items: [{ href: '/examples/preview-payment.mjs', label: 'Read or save preview-payment.mjs' }] },
        { type: 'code', label: 'Complete preview-payment.mjs', lang: 'ts', code: previewExample },
        { type: 'text', text: 'Expected output: state is "simulated-only", decoded.functionName is "pay", and nativeValue is "1000000000000" in wei, ETH’s smallest unit. Divide by 10^18 to get ETH. The output shows the tokens for you and other recipients, the minimum you would accept, the simulation result, and the encoded calldata of the request. Divide token amounts by 10^18 for displayed amounts.' },
        { type: 'info', text: 'Examples are pinned with the Juicebox SDK 6.8.0 and viem 2.55.19. The live read and payment simulation were checked on November 14, 2026 using SDK 6.6.0. The read used Base Sepolia block 58394831, hash 0x6c2b75f4e70d92ffacccaa701c4faeef761bd5ab8323eab89d2677bddab75523. The payment was simulated only. Run the examples again to get current results.' },
      ],
    },
    {
      id: 'pay', part: 'Try it', title: 'Make a small test payment in the app',
      paragraphs: [
        'To try the payment, connect a wallet with Base Sepolia test ETH. Keep some test ETH to pay the network’s gas cost for the transaction. Use the app’s payment form to get a fresh quote and review it before signing.',
      ],
      blocks: [
        { type: 'steps', items: [
          'Open Base Sepolia project 1. Check the network, project ID, and current and upcoming terms.',
          'Connect your test wallet on Base Sepolia. Choose ETH and enter 0.000001. If the form cannot accept it, check the reason and stay on the test network.',
          'Review where the money goes, who receives tokens, the expected and minimum token amounts, and the total cost. Paying with ETH needs no separate permission to spend tokens. Other assets may need that approval.',
          'Read the form’s fresh trial result and transaction details. Sign only the matching wallet request.',
          'Save the transaction hash that identifies it. Wait for its receipt to show success. If you use a shared Safe wallet, the proposal still needs the required approvals and execution.',
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
        'Open Base Sepolia project 1. Keep your transaction hash and the token recipient’s address handy. The receipt shows whether the payment succeeded; the transaction details show where the money and tokens went.',
      ],
      blocks: [
        { type: 'links', items: [
          { href: '/basesep:1', label: 'Inspect Base Sepolia project 1' },
          { href: 'https://sepolia.basescan.org/', label: 'Look up your transaction hash on Base Sepolia' },
        ] },
        { type: 'steps', items: [
          'Find your transaction by its hash. Check the network, success status, sender, destination, amount, and action.',
          'Read its recorded events to check the project, recipient, and tokens received. Buying existing tokens can send money to a market instead of adding it all to the project.',
          'Check the recipient’s total holdings. Include credits tracked inside Juicebox and any tokens in a separate ERC-20 contract. Other payments can also change balances; use your transaction’s events to explain this change.',
          'Compare the network and project ID with the tutorial output. Terms and balances may have changed since the earlier read. Activity lists can take time to catch up; keep the receipt while you wait.',
        ] },
        { type: 'text', text: 'You are done when you can explain where your payment went and show the tokens received. Cashing out tokens for project funds is a separate action that depends on the project’s terms and available funds.' },
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
          { href: '/build#founders-launch-without-code', label: 'Next: launch your own project' },
          { href: 'https://revnet.money/build#choosing-the-numbers', label: 'Or choose a revnet’s terms' },
        ] },
      ],
    },
  ]
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
      <header className="mb-10 max-w-3xl">
        <h1 className="font-agrandir-wide text-4xl font-bold sm:text-6xl">Your first Juicebox payment</h1>
        <p className="mt-4 text-base leading-relaxed text-smoke-700 sm:text-lg">
          Understand the terms, read a live test project, try a small payment, and inspect its result.
        </p>
        <p className="mt-3 text-base leading-relaxed text-smoke-700 sm:text-lg">
          No code? Skip to <a className="underline underline-offset-4" href="#pay">Make a small test payment in the app</a>.
        </p>
        <nav aria-label="First payment resources" className="mt-6 flex flex-wrap gap-4 underline underline-offset-4">
          <Link href="/learn">Learn Juicebox</Link>
          <Link href="/build">Build reference</Link>
          <Link href="/basesep:1" prefetch={false}>Inspect the example</Link>
        </nav>
      </header>
      <GuideSections sections={sections} ariaLabel="First payment" />
    </div>
  )
}
