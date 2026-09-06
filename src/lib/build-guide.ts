import type { GuideSection } from '@/components/GuideSections'
import { LEGACY_BUILD_SECTIONS } from '@/lib/build-guide-legacy'

const REPO = 'https://github.com/mejango/juicebox-money/blob/main'
const CORE = 'https://github.com/Bananapus/nana-core-v6/blob/main/src'
const SKILLS = 'https://github.com/mejango/juicebox-skills/tree/main/plugins/juicebox-v6/skills'

const legacy = (id: string, overrides: Partial<GuideSection>): GuideSection => {
  const section = LEGACY_BUILD_SECTIONS.find(candidate => candidate.id === id)
  if (!section) throw new Error(`Unknown legacy build section: ${id}`)
  const source = id.startsWith('build-revnet')
    ? 'https://github.com/rev-net/revnet-core-v6'
    : id === 'build-bendystraw'
      ? `${REPO}/src/lib/bendystraw.ts`
      : id === 'build-clients'
        ? 'https://github.com/mejango/juicebox-money'
        : 'https://github.com/Bananapus/version-6'
  return {
    ...section,
    ...overrides,
    blocks: [
      ...(overrides.blocks ?? section.blocks ?? []),
      { type: 'links', items: [{ href: source, label: 'Source reference' }] },
    ],
  }
}

/**
 * The Build guide, in order. New sections carry the audience tracks; reference sections retain their stable links and are checked against the V6 contracts.
 */
export const BUILD_SECTIONS: readonly GuideSection[] = [
  // ------------------------------------------------------------------ Start here
  {
    id: 'start-pick-the-model',
    part: 'Start here',
    title: 'Pick the model, and who this guide is for',
    paragraphs: [
      'Juicebox gives you a project with a balance, programmable rules, and project tokens. Owners can change permitted terms subject to ruleset timing and approval. A revnet commits its core economic schedule at launch and retains a limited set of operator controls.',
      'This guide has paths for three kinds of builder, with audience tags on the sections specific to each path. Project builders launch and run a project from this site without writing code. App builders connect a product to Juicebox with the SDK and the indexer. Contract builders extend the protocol with hooks and their own contracts. The parts overlap; read the tags and skip what is not yours.',
    ],
    blocks: [
      {
        type: 'compare',
        label: 'Pick the model',
        columns: ['You need to', 'Use'],
        rows: [
          ['Pay a team a budget each cycle, from revenue or donations', 'Project (payout limits)'],
          ['Keep the option to change rules, add tokens, or migrate later', 'Project (rulesets, superpowers)'],
          ['Sell NFTs or memberships and treat the sales as revenue', 'Either, with a shop'],
          ['Commit an issuance schedule and cash out terms at launch', 'Revnet (stages; inspect retained operator controls)'],
          ['Let holders cash out against surplus', 'Project or revnet, when the terms allow it'],
          ['Let holders borrow using project tokens as collateral', 'Revnet (loans, subject to available funds and terms)'],
        ],
      },
      {
        type: 'links',
        items: [
          { href: '/learn', label: 'Learn how Juicebox works' },
          { href: 'https://revnet.money/build', label: 'Building specifically with revnets' },
        ],
      },
    ],
  },
  {
    id: 'start-your-first-build',
    part: 'Start here',
    title: 'Choose your first useful result',
    paragraphs: [
      'You do not need to read this entire reference in order. Pick one result, follow its path, and return to the operation map when you need another feature. The Learn glossary explains terms such as ruleset, terminal, indexer, and SDK.',
    ],
    blocks: [
      {
        type: 'steps',
        items: [
          'Launch a project without code: open the wizard, choose testnet, configure a small example, review the terms, and complete a test payment and payout before launching on mainnet.',
          'Build an app: install the SDK, read a testnet project with the example below, then add indexed discovery and a quoted transaction flow.',
          'Build a contract: inspect the V6 interfaces and deployed addresses, implement one hook or integration, and verify it against the local workflow and a pinned fork.',
        ],
      },
      {
        type: 'links',
        items: [
          { href: '#founders-launch-from-the-wizard', label: 'Project builder path' },
          { href: '#apps-set-up-the-sdk', label: 'App builder quickstart' },
          { href: '#contracts-install-and-launch', label: 'Contract builder path' },
          { href: '/learn#learn-glossary', label: 'Plain-language glossary' },
        ],
      },
    ],
  },
  {
    id: 'start-operation-map',
    part: 'Start here',
    title: 'Every operation, in one table',
    paragraphs: [
      'Start with the user action, then identify its contract entrypoint. Some flows require multiple transactions, such as approving an ERC-20 before paying or claiming a cross-chain transfer. SDK helper names are listed where available; the call outlines below are reference shapes, with placeholders to replace before use.',
    ],
    blocks: [
      {
        type: 'table',
        label: 'User action → contract call',
        rows: [
          ['Launch a project', 'JBController.launchProjectFor, or the 721 / omnichain deployers — buildLaunchProjectTx / buildOmnichainLaunchProjectTx'],
          ['Launch a revnet', 'REVDeployer.deployFor — buildDeployRevnetTx'],
          ['Pay', 'JBMultiTerminal.pay — buildPayTx'],
          ['Buy a shop item', 'JBMultiTerminal.pay with 721 metadata — build721PayMetadata'],
          ['Add funds, no tokens', 'JBMultiTerminal.addToBalanceOf'],
          ['Cash out', 'JBMultiTerminal.cashOutTokensOf — prepareHookAwareCashOut'],
          ['Send payouts', 'JBMultiTerminal.sendPayoutsOf'],
          ['Withdraw surplus allowance', 'JBMultiTerminal.useAllowanceOf'],
          ['Send reserved tokens to splits', 'JBController.sendReservedTokensToSplitsOf'],
          ['Queue a ruleset', 'JBController.queueRulesetsOf — buildQueueRulesetsTx'],
          ['Edit splits', 'JBController.setSplitGroupsOf — buildSetSplitGroupsTx'],
          ['Deploy the ERC-20', 'JBController.deployERC20For — buildDeployErc20Tx'],
          ['Claim credits as ERC-20', 'JBController.claimTokensFor — buildClaimTokensTx'],
          ['Mint', 'JBController.mintTokensOf — buildMintTokensTx'],
          ['Grant an operator', 'JBPermissions.setPermissionsFor — buildSetPermissionsTx'],
          ['Manage the shop', 'JB721TiersHook.adjustTiers / mintFor'],
          ['Move tokens to another chain', 'sucker.prepare → toRemote → claim'],
          ['Set the buyback pool', 'JBBuybackHookRegistry.initializePoolFor / setHookFor'],
          ['Deploy a payer address', 'JBProjectPayerDeployer — buildDeployProjectPayerTx'],
        ],
      },
      {
        type: 'text',
        text: 'Amounts are bigint in the token’s own decimals until the display boundary. A project’s identity is chain ID plus project ID; a sucker group links the chains but never makes their addresses, balances, or ruleset IDs interchangeable.',
      },
    ],
  },
  {
    id: 'start-the-contracts',
    part: 'Start here',
    title: 'The contracts, and where their addresses live',
    paragraphs: [
      'Shared protocol deployments are listed by chain in deploy-all-v6 artifacts, including their address and ABI. The SDK’s address map follows those deployments. Project-specific tokens, hooks, terminals, and bridge instances can have their own addresses: resolve a project’s current controller and terminals through JBDirectory before composing a transaction.',
    ],
    blocks: [
      {
        type: 'table',
        label: 'Who does what',
        rows: [
          ['JBProjects', 'The project NFT; whoever holds it owns the project. Charges the creation fee'],
          ['JBController', 'Rulesets, token issuance, reserved splits, metadata URI'],
          ['JBMultiTerminal', 'Takes payments, holds balances, sends payouts and allowances, executes cash outs, charges fees'],
          ['JBRulesets, JBSplits, JBFundAccessLimits, JBTokens, JBTerminalStore', 'The storage each of the above reads and writes'],
          ['JBDirectory', 'Which controller and terminals a project uses'],
          ['JBPermissions', 'Operator grants, by permission ID'],
          ['JBPrices', 'Currency conversion for issuance and payout limits'],
          ['JB721TiersHook + deployer', 'The shop, and a launcher that sets it up as the data hook'],
          ['JBBuybackHookRegistry + JBBuybackHook', 'Routes a payment to a Uniswap V4 pool when that beats issuing'],
          ['JBSucker + JBSuckerRegistry, JBOmnichainDeployer', 'Multichain projects and the launcher that links them'],
          ['JBRouterTerminalRegistry', 'Accepts tokens a project does not hold and swaps them in'],
          ['REVDeployer, REVOwner, REVLoans', 'Revnets'],
        ],
      },
      {
        type: 'points',
        items: [
          { key: 'Chains', text: 'Ethereum, Optimism, Base, Arbitrum, plus Sepolia and the three L2 Sepolias. The SDK’s SUPPORTED_CHAINS and JB_CHAINS carry the list.' },
          { key: 'Source', text: 'the repos ending in -v6 are current. Older Juicebox versions are not interchangeable with them, and this site redirects unknown routes to the legacy app for those.' },
        ],
      },
      {
        type: 'links',
        items: [
          { href: 'https://github.com/Bananapus/deploy-all-v6', label: 'deploy-all-v6 (addresses)' },
          { href: 'https://github.com/Bananapus/nana-core-v6', label: 'nana-core-v6' },
          { href: 'https://github.com/Bananapus/version-6', label: 'Every V6 repo' },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Project builders
  {
    id: 'founders-launch-from-the-wizard',
    part: 'Project builders',
    audience: ['founders'],
    title: 'Launch from the wizard',
    paragraphs: [
      'The create page walks through five steps: Flavor, Look and feel, Rules (Stages for a revnet), Shop, Launch. The simple flavor skips Rules and launches with sensible defaults. Later rulesets can replace permitted project terms subject to the active timing and approval requirements. Revnet stage economics are committed at launch; metadata and other permitted operator controls remain editable.',
    ],
    blocks: [
      {
        type: 'table',
        label: 'The steps',
        rows: [
          ['Flavor', 'Simple, project, or revnet. Production or testnet. Which chains, whether to link them (suckers, over CCIP, the native bridge, or both). Accounting tokens: ETH, USDC, or a custom ERC-20 at the same address on every chain; “Accept any token” adds the router terminal. Owner: your connected wallet, another address, or per-chain addresses; turning “Allow changes” off hands ownership to a dead address'],
          ['Look and feel', 'Name (100), ticker, tagline, description in markdown (10,000), logo and cover (25 MB), links, tags, a payment notice. Pinned to IPFS as one metadata file when you launch'],
          ['Rules', 'The first ruleset, described in the next section, plus what happens afterwards (wait, terminate, cycle, or a custom follow-up) and the rule-change notice (an approval hook of 3 hours to 7 days, or none)'],
          ['Shop', 'Optional items priced in the token, ETH, or USD, each with supply (per chain if you like), media, category, sale splits, discount, reserve inventory, voting, and flags. A shop contract deploys even with zero items'],
          ['Launch', 'One transaction per chain, signed in sequence: simulate, review the decoded call, sign, wait. A Safe connected through the Safe App proposes instead of sending'],
        ],
      },
      {
        type: 'info',
        text: 'Drafts autosave in your browser, and the whole form imports and exports as a .jb file. Any live project’s Extras tab exports one reconstructed from the chain, which is how you diff what you launched against what you meant to.',
      },
      {
        type: 'links',
        items: [
          { href: '/create', label: 'Open the wizard' },
          { href: `${REPO}/src/lib/launch.ts`, label: 'How the form becomes a launch call' },
          { href: `${REPO}/src/lib/draft.ts`, label: 'Draft format' },
        ],
      },
    ],
  },
  {
    id: 'founders-rules-field-by-field',
    part: 'Project builders',
    audience: ['founders'],
    title: 'The rules, field by field',
    paragraphs: [
      'A ruleset defines project terms and can repeat across multiple cycles. These are the fields the wizard exposes, what they mean, and the units the contracts hold them in.',
    ],
    blocks: [
      {
        type: 'table',
        label: 'Rules step',
        rows: [
          ['Duration', 'How long the cycle lasts before the next queued ruleset can take over: presets from 1 day to a year, Flexible (0, replaced whenever you queue), or Forever. A cycle with a duration repeats itself until replaced'],
          ['Issuance', 'Tokens issued per unit of the base currency paid, priced in ETH or USD. Default 10,000. Leave blank on a later ruleset to inherit the previous one’s decayed rate'],
          ['Issuance cut', 'A percentage the rate drops by each cycle (a revnet says “cut X% every N days” instead)'],
          ['Reserved split', 'The share of every issuance that goes to your reserved recipients instead of the payer. Set by adding recipients; the percent is their total'],
          ['Cash outs', 'Off, or on with a tax: 0, 10, 30, 50%, or any value below 100. Off is written as a 100% tax. A revnet commits its tax schedule and may also have an initial cash out delay'],
          ['Payouts', 'None; flexible (payouts can send the owner the amount within the configured limit); or routed to recipients as percentages or fixed amounts, per accounting token. Limits are per cycle and per chain'],
          ['Surplus allowance', 'Whether the owner may also withdraw from the surplus above the payout limit: unlimited or capped'],
          ['Hold fees', 'Delay eligible payout and allowance fee processing for 28 days; adding funds back with the return-held-fees option can restore a matching amount'],
          ['Accept payments', 'Off pauses paying'],
          ['Owner can mint any time', 'The allowOwnerMinting flag'],
          ['Superpowers', 'Whether this ruleset lets the owner set terminals, set the controller, migrate terminals, set a custom token, add accounting contexts, or add price feeds. These actions require the relevant flag while that ruleset is active; check whether an owner can queue a later ruleset that enables it'],
          ['Afterwards, notice', 'What follows this ruleset, and how much notice a rule change needs: an approval hook of 3 hours, 1 day, 3 days, or 7 days, or none'],
        ],
      },
      {
        type: 'info',
        text: 'The shop is always the project’s data hook, so you do not set one by hand. The cash out tax is the only number here that shapes a curve; the Learn guide has the formula and a worked example.',
      },
      {
        type: 'links',
        items: [
          { href: `${REPO}/src/components/create/StageRulesEditor.tsx`, label: 'Rules editor' },
          { href: '/learn#learn-rulesets', label: 'Rulesets, in the Learn guide' },
          { href: `${SKILLS}/jb-ruleset/SKILL.md`, label: 'jb-ruleset skill' },
        ],
      },
    ],
  },
  {
    id: 'founders-what-deploy-does',
    part: 'Project builders',
    audience: ['founders', 'frontend'],
    title: 'What happens when you launch',
    blocks: [
      {
        type: 'points',
        items: [
          { key: 'Which contract', text: 'a revnet goes through REVDeployer.deployFor; a linked multichain project through JBOmnichainDeployer.launchProjectFor, which also deploys the chain’s suckers; anything else through JB721TiersHookProjectDeployer.launchProjectFor, which sets up the shop as the data hook. This site never calls JBController.launchProjectFor directly.' },
          { key: 'Creation fee', text: 'read from JBProjects.creationFee() right before each send and passed as the transaction value. JBProjects forwards it to the configured fee receiver; when routed as a project payment, token rewards go to the resolved fee payer.' },
          { key: 'One transaction per chain', text: 'signed in sequence, with a shared salt kept in your session so a linked project gets matching sucker addresses. The same wallet must sign on every chain.' },
          { key: 'Afterwards', text: 'each chain has its own project ID; the page lives at /<chain>:<id>. The Rulesets (or Terms) tab shows the terms as the contracts hold them.' },
        ],
      },
      {
        type: 'links',
        items: [
          { href: `${REPO}/src/lib/launch.ts`, label: 'buildLaunchRequest' },
          { href: `${SKILLS}/jb-project/SKILL.md`, label: 'jb-project skill' },
          { href: `${SKILLS}/jb-omnichain-ui/SKILL.md`, label: 'jb-omnichain-ui skill' },
        ],
      },
    ],
  },
  {
    id: 'founders-running-a-project',
    part: 'Project builders',
    audience: ['founders'],
    title: 'Running it: the owner’s tabs',
    paragraphs: [
      'The project page groups available management actions into tabs. What you can use depends on the connected account, project rules, and installed extensions.',
    ],
    blocks: [
      {
        type: 'table',
        label: 'Project page',
        rows: [
          ['Rulesets', 'See the current and queued cycles. Queue a new ruleset to replace the current one, follow it, or start right away; the approval hook decides when it may take effect'],
          ['Funds', 'Send payouts to the configured splits, withdraw surplus allowance, add to balance'],
          ['Owners', 'Holders and balances; send reserved tokens to their splits; auto issuance for revnets'],
          ['Shop', 'Add items, mint reserved copies, replace media, redeem items'],
          ['Admin', 'Operators and permissions, transfer ownership, the ENS handle, metadata and links, deploy the ERC-20, token metadata, the ruleset-gated powers (mint, set terminals, and the rest), the buyback router and pool'],
          ['Extras', 'Export a .jb of the live terms; deploy a payer address; liquidity positions'],
        ],
      },
      {
        type: 'info',
        text: 'A queued ruleset takes effect at the next cycle boundary of a timed ruleset, or as soon as the notice period passes for a flexible one. A change that would start before the notice period has run fails its approval and is skipped.',
      },
      {
        type: 'links',
        items: [
          { href: `${REPO}/src/components/project/QueueRulesetFlow.tsx`, label: 'Queue ruleset flow' },
          { href: `${REPO}/src/lib/permissions.ts`, label: 'Permission catalogue' },
        ],
      },
    ],
  },
  {
    id: 'founders-fees',
    part: 'Project builders',
    audience: ['founders'],
    title: 'The fees',
    paragraphs: [
      'The core protocol generally charges 2.5% on payouts, allowance withdrawals, and eligible cash out value. Exceptions depend on the route and fee-exempt addresses. Fees fund the Juicebox fee project, with its token rewards going to the operation’s designated beneficiary when processed as a payment. Network gas and extension or swap fees are separate.',
    ],
    blocks: [
      {
        type: 'table',
        label: 'Fees to expect',
        rows: [
          ['Launch', 'JBProjects.creationFee(), at most 0.001 ETH, per chain'],
          ['Payments in', 'No core protocol fee; a swap or extension can add costs'],
          ['Payouts', '2.5% on each payout, except to another Juicebox project through the same terminal and to feeless addresses'],
          ['Surplus allowance', '2.5%, skipped if the owner or beneficiary is feeless'],
          ['Cash outs, tax above 0%', '2.5% on the value returned'],
          ['Cash outs, 0% tax', '2.5% only on the fee-free surplus portion, which is often zero'],
          ['Held fees', 'With holdFees on, payout and allowance fees wait 28 days and can be returned by adding funds back; cash out fees are never held'],
          ['Revnets', 'Add a 2.5% revnet fee on the tokens burned by a taxed cash out, and loan fees'],
        ],
      },
      {
        type: 'links',
        items: [
          { href: `${CORE}/JBMultiTerminal.sol`, label: 'JBMultiTerminal.sol' },
          { href: `${SKILLS}/jb-protocol-fees/SKILL.md`, label: 'jb-protocol-fees skill' },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ App builders
  {
    id: 'apps-set-up-the-sdk',
    part: 'App builders',
    audience: ['frontend'],
    title: 'Set up the SDK',
    paragraphs: [
      '@bananapus/nana-sdk-core carries the ABIs, the addresses, the reads, and pure transaction builders. Do not hand-maintain selectors or addresses in product code. The root entry exports every ABI, jbContractAddress, the chain list, the bendystraw helpers, and project-metadata reads; the /v6 entry exports the reads and builders.',
      'Builders are pure: validated input in, a { chainId, address, abi, functionName, args, value } request out. Keep reads on a public client for the target chain and writes on a wallet client connected to that same chain.',
    ],
    blocks: [
      {
        type: 'code',
        label: 'Create a small JavaScript project',
        code: [
          'mkdir juicebox-starter',
          'cd juicebox-starter',
          'npm init -y',
          'npm install @bananapus/nana-sdk-core viem',
        ].join('\n'),
      },
      {
        type: 'text',
        text: 'Create a V6 project on Base Sepolia with the wizard, or use a known V6 test project on that network. Its URL contains the project ID. Save this as read-project.mjs; it reads chain state and needs no wallet or private key.',
      },
      {
        type: 'code',
        label: 'read-project.mjs — read a Base Sepolia project',
        code: [
          'import { createPublicClient, http } from "viem";',
          'import { baseSepolia } from "@bananapus/nana-sdk-core/chains";',
          'import { getCurrentRuleset } from "@bananapus/nana-sdk-core/v6";',
          '',
          'const projectIdText = process.env.JB_PROJECT_ID;',
          'if (!projectIdText || !/^[1-9][0-9]*$/.test(projectIdText)) {',
          '  throw new Error("Set JB_PROJECT_ID to your Base Sepolia project ID.");',
          '}',
          '',
          'const client = createPublicClient({',
          '  chain: baseSepolia,',
          '  transport: http(process.env.BASE_SEPOLIA_RPC_URL),',
          '});',
          'const result = await getCurrentRuleset(client, {',
          '  chainId: baseSepolia.id,',
          '  projectId: BigInt(projectIdText),',
          '});',
          'if (result.ruleset.id === 0) {',
          '  throw new Error("No active V6 ruleset: check the network and project ID.");',
          '}',
          'console.dir(result, { depth: null });',
        ].join('\n'),
      },
      {
        type: 'code',
        label: 'Run the read example',
        code: [
          '# Replace 123 with your Base Sepolia project ID.',
          'JB_PROJECT_ID=123 node read-project.mjs',
          '# Set BASE_SEPOLIA_RPC_URL as well to use your own RPC endpoint.',
        ].join('\n'),
      },
      {
        type: 'text',
        text: 'A successful read prints ruleset and metadata, including issuance, timing, and cash out settings. Compare them with the project’s Rulesets tab. If the RPC fails, retry through a configured endpoint; if the ID is wrong or no V6 ruleset is active, the example stops with an explanation.',
      },
      {
        type: 'table',
        label: '/v6 exports, grouped',
        rows: [
          ['Reads', 'getAccountingContexts, resolvePaymentTerminal, getCurrentRuleset, getUpcomingRuleset, getAllRulesets, previewPay, chooseBestPayRoute, getCashOutQuote, getHookAwareCashOutQuote, getV6SuckerPairs, getSuckerMovements, getTokenAddress, getCreditBalance, getProjectCreationFee, getProject721Shop, hasPermissions, getBorrowableAmount'],
          ['Builders', 'buildLaunchProjectTx, buildOmnichainLaunchProjectTx, buildDeployRevnetTx, buildPayTx, buildCashOutTx, buildQueueRulesetsTx, buildOmnichainQueueRulesetsTx, buildSetSplitGroupsTx, buildSetPermissionsTx, buildDeployErc20Tx, buildClaimTokensTx, buildTransferCreditsTx, buildMintTokensTx, buildBurnTokensTx, buildDeployProjectPayerTx, buildBridgePrepareTx, buildToRemoteTx, buildBridgeClaimTx, buildSyncAccountingDataTx, buildDirectPaySwapTx, buildPermit2ApproveTx, buildBorrowTx, buildRepayLoanTx'],
          ['Config builders', 'buildRulesetConfiguration, buildRulesetMetadata, buildAccountingContext, buildTerminalConfigurations, buildSplit, fillSplitPercents, buildTierMetadata, build721RulesetMetadata, build721PayMetadata, buildRevnetStageConfig'],
          ['Constants', 'slippageFloor, RULESET_WEIGHT_INHERIT, STANDARD_FEE, MAX_FEE, MAX_RESERVED_PERCENT, MAX_CASH_OUT_TAX_RATE, SPLITS_TOTAL_PERCENT, RESERVED_TOKEN_SPLIT_GROUP_ID, payoutSplitGroupId, NATIVE_TOKEN, USDC_ADDRESSES, PERMIT2_ADDRESS, the uniswapV4* math family'],
          ['Sub-entries', '/v6/loans, /v6/cash-out, /v6/permit2, /v6/direct-pay, /v6/uniswap-v4, /chains, /jbcenter'],
        ],
      },
      {
        type: 'code',
        label: 'TypeScript imports and address lookup (chainId supplied by your app)',
        code: [
          'import {',
          '  buildPayTx, buildQueueRulesetsTx, buildRulesetConfiguration, buildRulesetMetadata,',
          '  buildSetSplitGroupsTx, getCurrentRuleset, previewPay, slippageFloor,',
          '} from "@bananapus/nana-sdk-core/v6";',
          '',
          'import {',
          '  getJBContractAddress, JBCoreContracts, jbMultiTerminalAbi, type JBChainId,',
          '} from "@bananapus/nana-sdk-core";',
          '',
          'const terminal = getJBContractAddress(JBCoreContracts.JBMultiTerminal, 6, chainId);',
        ].join('\n'),
      },
      {
        type: 'links',
        items: [
          { href: 'https://www.npmjs.com/package/@bananapus/nana-sdk-core', label: 'V6 SDK package' },
          { href: 'https://github.com/Bananapus/juice-sdk-v4', label: 'SDK source (repository name is historical; includes V6)' },
          { href: 'https://github.com/Bananapus/juice-sdk-v4/blob/main/packages/core/src/v6/rulesets.ts', label: 'Ruleset reader source' },
          { href: '/create', label: 'Create a testnet project' },
        ],
      },
    ],
  },
  {
    id: 'apps-read-a-project',
    part: 'App builders',
    audience: ['frontend'],
    title: 'Read a project',
    paragraphs: [
      'Use the index (next section) to find and display projects. Use the chain for anything a signature depends on, and read it again right before signing.',
    ],
    blocks: [
      {
        type: 'table',
        label: 'What to read, and where',
        rows: [
          ['Controller, terminals', 'JBDirectory.controllerOf / terminalsOf / primaryTerminalOf'],
          ['Current, next, queued rulesets', 'JBController.currentRulesetOf / upcomingRulesetOf / latestQueuedRulesetOf / allRulesetsOf'],
          ['Accepted tokens', 'JBMultiTerminal.accountingContextsOf'],
          ['Balance and surplus', 'JBTerminalStore.balanceOf / currentSurplusOf / usedPayoutLimitOf / usedSurplusAllowanceOf'],
          ['Limits', 'JBFundAccessLimits.payoutLimitOf / surplusAllowanceOf'],
          ['Supply and balances', 'JBTokens.totalSupplyOf / totalBalanceOf / creditBalanceOf / tokenOf'],
          ['Splits', 'JBSplits.splitsOf(projectId, rulesetId, groupId)'],
          ['Pending reserved tokens', 'JBController.pendingReservedTokenBalanceOf'],
          ['Cash out quote', 'JBMultiTerminal.previewCashOutFrom'],
          ['Permissions', 'JBPermissions.hasPermission / hasPermissions'],
          ['Chains', 'JBSuckerRegistry.suckerPairsOf'],
        ],
      },
      {
        type: 'info',
        text: 'Show cached names, logos, and facts while the chain refreshes. Treat state you could not read as unknown, never as zero, empty, or permitted.',
      },
    ],
  },
  legacy('build-bendystraw', {
    id: 'apps-indexed-data',
    aliases: ['build-bendystraw'],
    part: 'App builders',
    audience: ['frontend'],
    title: 'Indexed data: Bendystraw',
  }),
  {
    id: 'apps-wallets-safe-relayr',
    part: 'App builders',
    audience: ['frontend'],
    title: 'Wallets, Safes, Relayr, and Permit2',
    paragraphs: [
      'Four kinds of signing show up in a Juicebox app: a plain wallet write, a Safe proposal, a Relayr bundle for many chains at once, and a Permit2 signature for pool swaps. This site routes every owner action through one dispatcher that picks the path from who is connected.',
    ],
    blocks: [
      {
        type: 'table',
        label: 'Signing paths in this site',
        rows: [
          ['Wallet write', 'submitReviewedContractWrite: review the decoded call → switch chain → simulate as the connected account → sign → wait for the receipt'],
          ['Authority calls', 'runAuthorityCalls decides: an EOA signs directly; an ERC-2771-capable account signs forward requests that Relayr executes as one prepaid bundle across chains; a Safe gets proposals queued in its transaction service'],
          ['Safe', 'Propose, confirm, execute; a same-address Safe can be deployed on a new chain; L1 and L2 singletons are allowlisted separately, so a Safe’s authority is checked per chain'],
          ['Permit2', 'Only for direct Uniswap V4 swaps; pay uses a plain approve for the exact amount'],
        ],
      },
      {
        type: 'text',
        text: 'RPC goes through Juicebox Center, an origin-allowlisted provider with no client-side key. Wallets connect through injected and EIP-6963 wallets, WalletConnect, Coinbase, the Safe App connector when framed, and an embedded Para wallet that also provides the card on-ramp.',
      },
      {
        type: 'links',
        items: [
          { href: `${REPO}/src/lib/authority.ts`, label: 'runAuthorityCalls' },
          { href: `${REPO}/src/lib/relayr.ts`, label: 'Relayr' },
          { href: `${REPO}/src/lib/safe.ts`, label: 'Safe' },
          { href: `${SKILLS}/jb-relayr/SKILL.md`, label: 'Relayr integration skill' },
        ],
      },
    ],
  },
  {
    id: 'apps-metadata-and-ipfs',
    part: 'App builders',
    audience: ['frontend'],
    title: 'Metadata and IPFS',
    blocks: [
      {
        type: 'points',
        items: [
          { key: 'Shape', text: 'JBProjectMetadata: name, description, projectTagline, logoUri, coverImageUri, infoUri, payButton, payDisclosure, tags, twitter, telegram, discord, archived.' },
          { key: 'Read', text: 'getProjectMetadata(publicClient, { jbControllerAddress, projectId }) resolves the project’s uri and fetches it; ipfsUri and cidFromIpfsUri handle the encoding.' },
          { key: 'Pin', text: 'this site pins JSON, images (25 MB), and media (500 MB) straight from the browser to Juicebox Center, which is origin-allowlisted and guards against empty files. The gateway is juicebox.center/ipfs/.' },
          { key: 'Write', text: 'the owner updates the pointer with JBController.setUriOf (SET_PROJECT_URI).' },
        ],
      },
      {
        type: 'links',
        items: [
          { href: `${REPO}/src/lib/jbcenter-ipfs.ts`, label: 'Juicebox Center IPFS client' },
        ],
      },
    ],
  },
  {
    id: 'apps-transaction-boundary',
    part: 'App builders',
    audience: ['frontend'],
    title: 'One transaction boundary',
    paragraphs: [
      'The request you quote, simulate, decode, show, and submit must be the same object, not five reconstructions of it. Right before signing, refresh the reads that set bounds and permissions, rebuild, simulate with the real account, then decode the calldata and present it. After submission, keep wallet rejection, Safe proposal, inclusion, revert, and confirmed success as separate states.',
      'This site enforces it mechanically: the review step re-encodes the request after the user has seen it and aborts on any drift; simulation is a raw eth_call with a gas cap; a script fails the build if any write bypasses the three reviewed entry points, with the count of write sites pinned in a fixture.',
    ],
    blocks: [
      {
        type: 'diagram',
        label: 'Build → simulate → decode → review → write → confirm',
        description: 'Refresh chain state, build one request, simulate it for the actual account, decode and review it, then submit that same request. Report success only after a successful transaction receipt.',
        lines: [
          '  fresh reads',
          '    → pure builder',
          '      → simulateContract with the real account',
          '        → encode and decode the calldata, show it to the user',
          '          → writeContract',
          '            → waitForTransactionReceipt',
          '              → success only on receipt.status === "success"',
        ],
      },
      {
        type: 'links',
        items: [
          { href: `${REPO}/src/lib/transaction-review.ts`, label: 'Review' },
          { href: `${REPO}/src/lib/transaction-builders.ts`, label: 'Every write builder' },
          { href: `${REPO}/scripts/check-transaction-inventory.mjs`, label: 'Write-site inventory check' },
        ],
      },
    ],
  },
  {
    id: 'apps-run-this-site',
    part: 'App builders',
    audience: ['frontend'],
    title: 'Run this site locally',
    paragraphs: [
      'Use the Node.js and npm versions declared in package.json. Copy the example public configuration before starting. NEXT_PUBLIC values are shipped to the browser, so they must never contain private keys or secrets.',
    ],
    blocks: [
      {
        type: 'code',
        label: 'Clone, install, and start the reference app',
        code: [
          'git clone https://github.com/mejango/juicebox-money.git',
          'cd juicebox-money',
          'npm ci',
          'cp .env.example .env.local',
          'npm run dev',
        ].join('\n'),
      },
      {
        type: 'text',
        text: 'Open http://localhost:3001. Confirm the configured indexer, RPC service, wallet providers, and allowed origin work in your environment. Start with project reads, then connect a testnet wallet for transaction flows.',
      },
      {
        type: 'table',
        label: 'Commands',
        rows: [
          ['npm run dev', 'Next.js on port 3001'],
          ['npm run check', 'Full repository gate: dependencies, types, lint, source/deployment/schema checks, tests, production build, browser checks, and budgets'],
          ['npm test / npm run test:browser', 'Vitest, then Playwright against the built app with a fixture server'],
          ['npm run schema:check', 'Regenerates and verifies the Bendystraw operation registry'],
        ],
      },
      {
        type: 'points',
        items: [
          { key: 'Env', text: 'NEXT_PUBLIC_SITE_URL, NEXT_PUBLIC_BENDYSTRAW_URL, NEXT_PUBLIC_TESTNET_BENDYSTRAW_URL, NEXT_PUBLIC_PARA_API_KEY, NEXT_PUBLIC_PARA_ENV, NEXT_PUBLIC_VERSION; WalletConnect and the on-ramp provider are optional. No RPC or IPFS keys live in the client.' },
          { key: 'Tests', text: 'the fixture-based browser suite isolates external services; use the documented fork and live-service checks separately when validating an integration.' },
        ],
      },
      {
        type: 'links',
        items: [
          { href: 'https://github.com/mejango/juicebox-money', label: 'Repository' },
          { href: 'https://github.com/mejango/juicebox-money/blob/main/TESTING.md', label: 'TESTING.md' },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Life of a project (contract calls)
  legacy('build-launch', { part: 'Life of a project', audience: ['frontend', 'contracts'] }),
  legacy('build-configure', { part: 'Life of a project', audience: ['frontend', 'contracts'] }),
  legacy('build-fund', { part: 'Life of a project', audience: ['frontend', 'contracts'] }),
  legacy('build-tokens-mgmt', { part: 'Life of a project', audience: ['frontend', 'contracts'] }),
  legacy('build-distribute', { part: 'Life of a project', audience: ['frontend', 'contracts'] }),
  legacy('build-cashout', { part: 'Life of a project', audience: ['frontend', 'contracts'] }),
  legacy('build-evolve', { part: 'Life of a project', audience: ['frontend', 'contracts'] }),

  // ------------------------------------------------------------------ Life of a revnet
  legacy('build-revnet-what', { part: 'Life of a revnet' }),
  legacy('build-revnet-deploy', { part: 'Life of a revnet', audience: ['frontend', 'contracts'] }),
  legacy('build-revnet-stages', { part: 'Life of a revnet', audience: ['frontend', 'contracts'] }),
  legacy('build-revnet-fees', { part: 'Life of a revnet' }),
  {
    id: 'revnet-go-deeper',
    part: 'Life of a revnet',
    title: 'Go deeper on revnets',
    paragraphs: [
      'revnet.money carries the full revnet build guide: the wizard field by field, .jb drafts and agent launches, what deploy does, the operator’s nine permissions, loans from a contract, the extension points REVOwner allows and forbids, and the sharp edges. Use its linked source references to verify the configuration you plan to deploy.',
    ],
    blocks: [
      {
        type: 'links',
        items: [
          { href: 'https://revnet.money/build', label: 'revnet.money/build' },
          { href: 'https://revnet.money/learn', label: 'revnet.money/learn' },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Contract builders
  {
    id: 'contracts-install-and-launch',
    part: 'Contract builders',
    audience: ['contracts'],
    title: 'Install the code and launch from Solidity',
    paragraphs: [
      'The V6 repos ship as npm packages and import by package path; remappings.txt in every repo only maps forge-std, and node_modules resolves the rest. Solidity 0.8.28.',
    ],
    blocks: [
      {
        type: 'table',
        label: 'Packages',
        rows: [
          ['@bananapus/core-v6', 'Terminals, controller, tokens, splits, permissions, prices, the hook interfaces'],
          ['@bananapus/721-hook-v6', 'Shop tiers and the 721 project deployer'],
          ['@bananapus/omnichain-deployers-v6', 'Launch plus suckers in one call'],
          ['@bananapus/buyback-hook-v6, @bananapus/suckers-v6, @bananapus/router-terminal-v6', 'Pool routing, cross-chain, token routing'],
          ['@bananapus/project-payer-v6, @bananapus/project-handles-v6, @bananapus/distributor-v6', 'Payer addresses, ENS handles, distributor'],
          ['@bananapus/permission-ids-v6', 'The permission ID constants'],
          ['@rev-net/core-v6', 'Revnets'],
        ],
      },
      {
        type: 'table',
        label: 'launchProjectFor, field by field',
        rows: [
          ['JBController.launchProjectFor', '(address owner, string projectUri, JBRulesetConfig[] rulesetConfigurations, JBTerminalConfig[] terminalConfigurations, string memo) payable → projectId. msg.value must equal JBProjects.creationFee() exactly'],
          ['JBRulesetConfig', 'mustStartAtOrAfter (uint48; 0 = now), duration (uint32 seconds; 0 = until replaced), weight (uint112, 18-dec tokens per base-currency unit; 1 = inherit the decayed weight, 0 = no issuance), weightCutPercent (uint32, of 1e9), approvalHook, metadata, splitGroups[], fundAccessLimitGroups[]'],
          ['JBRulesetMetadata', 'reservedPercent (uint16, of 10,000), cashOutTaxRate (uint16, of 10,000; 10,000 = cash outs off), baseCurrency (uint32: 1 = ETH, 2 = USD, or uint32(uint160(token))), pausePay, pauseCreditTransfers, allowOwnerMinting, allowSetCustomToken, allowTerminalMigration, allowSetTerminals, allowSetController, allowAddAccountingContext, allowAddPriceFeed, ownerMustSendPayouts, holdFees, scopeCashOutsToLocalBalances, useDataHookForPay, useDataHookForCashOut, dataHook, metadata (uint16, 14 usable bits)'],
          ['JBFundAccessLimitGroup', 'terminal, token, payoutLimits[] and surplusAllowances[] as { amount (uint224, in the token’s decimals), currency (uint32) }, sorted by strictly increasing currency. Empty = no payouts; type(uint224).max = unlimited. Per chain, never aggregate'],
          ['JBTerminalConfig', 'terminal, accountingContextsToAccept[] of { token, decimals (uint8), currency (uint32) }. NATIVE_TOKEN is 0x…EEEe with currency 61166'],
          ['JBSplitGroup / JBSplit', 'groupId (1 = reserved tokens; uint256(uint160(token)) = payouts in that token), splits[] of { percent (uint32, of 1e9), projectId (uint64), beneficiary, preferAddToBalance, lockedUntil (uint48), hook }. Routing: hook, else projectId, else beneficiary'],
          ['JBOmnichainDeployer.launchProjectFor', '(owner, projectUri, JBOmnichain721Config, rulesetConfigurations, terminalConfigurations, memo, JBSuckerDeploymentConfig) payable → (projectId, hook, suckers[]). Also deploys this chain’s suckers; the sucker salt is keccak256(sender, salt), so the same sender must launch on every chain'],
          ['JB721TiersHookProjectDeployer.launchProjectFor', '(owner, JBDeploy721TiersHookConfig, JBLaunchProjectConfig, controller, salt) payable → (projectId, hook). Sets the hook as the data hook'],
        ],
      },
      {
        type: 'info',
        text: 'queueRulesetsOf timing: with a timed base ruleset the new one snaps to the next cycle boundary; with a flexible base it starts at mustStartAtOrAfter, clamped to at least the queue time plus the approval hook’s DURATION. A JBDeadline hook fails any ruleset queued with less notice than its duration, and currentRulesetOf only honours Approved or hook-less rulesets.',
      },
      {
        type: 'links',
        items: [
          { href: `${CORE}/JBController.sol`, label: 'JBController.sol' },
          { href: `${CORE}/structs/JBRulesetMetadata.sol`, label: 'JBRulesetMetadata.sol' },
          { href: `${CORE}/JBRulesets.sol`, label: 'JBRulesets.sol' },
          { href: `${SKILLS}/jb-fund-access-limits/SKILL.md`, label: 'jb-fund-access-limits skill' },
        ],
      },
    ],
  },
  legacy('build-hooks', {
    part: 'Contract builders',
    audience: ['contracts'],
    title: 'Custom hooks',
  }),
  {
    id: 'contracts-hook-mechanics',
    part: 'Contract builders',
    audience: ['contracts'],
    title: 'Hook mechanics: funds, metadata, minting, reentrancy',
    blocks: [
      {
        type: 'points',
        items: [
          { key: 'Installing a data hook', text: 'set metadata.dataHook and useDataHookForPay / useDataHookForCashOut on the ruleset. beforePayRecordedWith returns the weight to use and pay hook specifications; beforeCashOutRecordedWith returns the tax rate, count, supply, surplus, and cash out hook specifications.' },
          { key: 'Funds', text: 'native value arrives at a pay or cash out hook as msg.value; ERC-20 arrives as an allowance you must transferFrom during the call, revoked afterwards. Fee treatment depends on the operation and recipient; quote the net amount delivered to the hook. A specification with noop = true is informational and never called.' },
          { key: 'Two metadatas', text: 'hookMetadata is authored by the data hook, while payerMetadata / cashOutMetadata comes from the caller. Trust hookMetadata only after authenticating the calling terminal and the expected hook path; validate caller-supplied fields.' },
          { key: 'Metadata format', text: 'JBMetadataResolver: a reserved first word, then a table of 4-byte ids with word offsets, then 32-byte-aligned blobs. createMetadata(ids, datas), addToMetadata, getDataFor(id, metadata). Ids are getId(purpose, target) = bytes4(bytes20(target) ^ bytes20(keccak256(purpose))).' },
          { key: 'Minting from a hook', text: 'JBController.mintTokensOf lets the terminal, the ruleset’s data hook, or any address the data hook’s hasMintPermissionFor approves mint without a grant; everyone else needs MINT_TOKENS (10) and allowOwnerMinting.' },
          { key: 'Split hooks', text: 'a split whose hook field is set receives its share through processSplitWith. On the reserved-token path the controller approves an ERC-20 for the amount and burns whatever the hook leaves unspent; on payouts the terminal checks ERC-165 first.' },
          { key: 'Reentrancy', text: 'pay and cashOutTokensOf call hooks after recording state. Review every callback and protect your own state transitions against reentrancy; a blanket guard on core-dependent flows can also break intended composition. Use override(ERC165, IERC165) for supportsInterface.' },
        ],
      },
      {
        type: 'links',
        items: [
          { href: `${CORE}/interfaces/IJBRulesetDataHook.sol`, label: 'IJBRulesetDataHook.sol' },
          { href: `${CORE}/libraries/JBMetadataResolver.sol`, label: 'JBMetadataResolver.sol' },
          { href: `${SKILLS}/jb-pay-hook/SKILL.md`, label: 'jb-pay-hook skill' },
          { href: `${SKILLS}/jb-cash-out-hook/SKILL.md`, label: 'jb-cash-out-hook skill' },
          { href: `${SKILLS}/jb-split-hook/SKILL.md`, label: 'jb-split-hook skill' },
        ],
      },
    ],
  },
  legacy('build-permissions', { part: 'Contract builders', audience: ['contracts', 'frontend'] }),
  {
    id: 'contracts-test',
    part: 'Contract builders',
    audience: ['contracts'],
    title: 'Test against the real thing',
    blocks: [
      {
        type: 'table',
        label: 'Foundry',
        rows: [
          ['TestBaseWorkflow', '@bananapus/core-v6/test/helpers/TestBaseWorkflow.sol: deploys the full protocol locally with a mock USDC and two terminals, plus Permit2. Extend it for unit tests of hooks and integrations'],
          ['Fork tests', 'Pin a block, fork through foundry.toml rpc_endpoints, and run against the deploy-all-v6 addresses before shipping'],
          ['Sizes', 'forge build --sizes early; several V6 contracts sit near EIP-170 and were split or trimmed to fit. Plan for library extraction if you are close'],
          ['Bytecode parity', 'verify a deployment against the deploy-all-v6 artifacts rather than trusting a source match; linked libraries change the hash'],
        ],
      },
      {
        type: 'links',
        items: [
          { href: 'https://github.com/Bananapus/nana-core-v6/tree/main/test/helpers', label: 'TestBaseWorkflow' },
        ],
      },
    ],
  },
  {
    id: 'contracts-sharp-edges',
    part: 'Contract builders',
    audience: ['contracts', 'frontend'],
    title: 'Sharp edges',
    blocks: [
      {
        type: 'points',
        items: [
          { key: 'Who is the payer', text: 'context.payer is the terminal’s msg.sender. Through a router, project payer, or wrapper it is that contract, unless the contract exposes originalPayer() (IJBPayerTracker), which the router registry probes. Expose the original payer where the integration expects it, and set beneficiary/refund addresses explicitly so rewards or refunds are not accidentally credited to the intermediary.' },
          { key: 'Router terminal cold start', text: 'the router registry reverts accountingContextForTokenOf for projects below its threshold; it is not universally accepting. Probe with previewPayFor before assuming a route.' },
          { key: 'Buyback metadata is three words', text: 'the pay metadata under getId("pay") for the buyback hook decodes as (amountToSwapWith, minimumSwapAmountOut, skipSplits). Always encode all three.' },
          { key: 'Payouts to a project without a terminal', text: 'a payout split to a project that has no terminal for the token is caught, the balance is restored, and no fee is taken, but the payout limit is still consumed.' },
          { key: 'Permissions die with the NFT', text: 'every check asks whether the current owner granted the permission; grants by a previous owner stop authorizing anything when the project NFT moves.' },
          { key: 'Held fees', text: 'a failed processHeldFeesOf forgives the fee. Cash out fees are never held.' },
          { key: 'Sucker salt', text: 'the omnichain deployer derives sucker addresses from the sender and the salt, so a different wallet on another chain produces a project that cannot be linked.' },
        ],
      },
      {
        type: 'links',
        items: [
          { href: `${SKILLS}/jb-terminal-selection/SKILL.md`, label: 'jb-terminal-selection skill' },
          { href: 'https://github.com/Bananapus/nana-buyback-hook-v6', label: 'Buyback hook integration reference' },
          { href: `${SKILLS}/jb-suckers/SKILL.md`, label: 'jb-suckers skill' },
        ],
      },
    ],
  },

  // ------------------------------------------------------------------ Ecosystem tools
  legacy('build-nfts', { part: 'Ecosystem tools', audience: ['founders', 'frontend', 'contracts'] }),
  legacy('build-buyback', { part: 'Ecosystem tools', audience: ['frontend', 'contracts'] }),
  legacy('build-swap-terminal', { part: 'Ecosystem tools', audience: ['frontend', 'contracts'] }),
  legacy('build-payer', { part: 'Ecosystem tools', audience: ['founders', 'contracts'] }),
  legacy('build-handles', { part: 'Ecosystem tools', audience: ['founders', 'frontend'] }),
  legacy('build-distributor', { part: 'Ecosystem tools', audience: ['contracts'] }),

  // ------------------------------------------------------------------ Ship it safely
  {
    id: 'ship-test-what-can-surprise-you',
    part: 'Ship it safely',
    title: 'Test what can surprise you',
    blocks: [
      {
        type: 'points',
        items: [
          { key: 'Launch', text: 'the encoded configuration round-trips through the ABI; the creation fee is read at send time; the same sender and salt yield the same sucker addresses on a second chain.' },
          { key: 'Payments', text: 'the chosen route’s executable minimum is no worse than the alternatives shown; an empty pool falls back to issuance; a router route is probed, not assumed.' },
          { key: 'Cash outs', text: 'the terminal or hook enforces the same minimum the confirmation shows, including at 0% fee-free surplus.' },
          { key: 'Payouts', text: 'limits are per chain and per cycle; a recipient project without a terminal consumes the limit without paying; fees are held or not as the ruleset says.' },
          { key: 'Rulesets', text: 'a queue with too little notice fails its approval hook; an inherited weight is decayed, not copied.' },
          { key: 'Permissions', text: 'the narrowest ID is granted, scoped to the project; a Safe proposal is not success.' },
          { key: 'Hooks', text: 'reentrancy from a hostile hook or token, an under-pulling split hook, hostile payer metadata.' },
        ],
      },
      {
        type: 'text',
        text: 'Fork-test against the current deployments. Then publish the addresses, source, transaction map, and a human-readable ruleset schedule so users can check your product against the contracts themselves. The audit page has prompts for a whole-system review and for a single transaction.',
      },
      {
        type: 'links',
        items: [
          { href: '/audit', label: 'Audit prompts and source index' },
          { href: 'https://github.com/mejango/juicebox-money', label: 'Reference web client' },
        ],
      },
    ],
  },
  legacy('build-clients', { part: 'Ship it safely' }),
]
