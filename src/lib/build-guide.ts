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
    aliases: ['build-revnet-what'],
    part: 'Start here',
    title: 'Choose a project or revnet',
    paragraphs: [
      'A Juicebox project collects money, shares tokens, and follows rules you set. Its owner can change the terms when those rules allow it. A revnet sets its core economic terms at launch and creates its transferable token then; its operator keeps a smaller set of controls.',
      'Project builders can launch and manage funds without code. App builders can connect their product to Juicebox. Contract builders can add new behavior. Start with the path you need and use the reference as you go.',
    ],
    blocks: [
      {
        type: 'compare',
        label: 'Pick the model',
        columns: ['You need to', 'Use'],
        rows: [
          ['Pay a team from revenue or donations on a schedule', 'Project with a spending limit'],
          ['Keep the option to change rules or contracts later', 'Project with those owner powers enabled'],
          ['Sell collectibles or memberships', 'Either, with a shop'],
          ['Set how new tokens and cash outs work at launch', 'Revnet; check the controls its operator keeps'],
          ['Let holders exchange tokens for available project funds', 'Project or revnet, when the terms allow it'],
          ['Let holders use tokens to borrow project funds', 'Revnet with funds available to lend'],
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
    aliases: ['founders-fees', 'build-revnet-fees'],
    part: 'Start here',
    title: 'Start with one working example',
    paragraphs: [
      'Choose one result below. Each path explains the tools you need as you use them. The Learn glossary is there when you need a definition.',
    ],
    blocks: [
      {
        type: 'steps',
        items: [
          'Launch a project: use the setup form on a test network. Review the terms, then try a small payment and payout before using real funds.',
          'Build an app: follow Your first test payment. Read a project, preview a payment, and check the result.',
          'Write a contract: choose one behavior to add. Read the V6 contract reference, build it, and test against a local copy of the chain.',
        ],
      },
      {
        type: 'links',
        items: [
          { href: '#founders-launch-from-the-wizard', label: 'Project builder path' },
          { href: '/build/first-payment', label: 'Your first test payment' },
          { href: '#contracts-install-and-launch', label: 'Contract builder path' },
          { href: '/learn#learn-glossary', label: 'Plain-language glossary' },
          { href: '/learn#learn-fees', label: 'How fees work and share revnet tokens with payers' },
        ],
      },
    ],
  },
  {
    id: 'start-the-contracts',
    part: 'Start here',
    title: 'Find the right contract',
    paragraphs: [
      'The deploy-all-v6 repository lists deployed contracts by chain. It includes each address and the format used to call it, called an ABI. The SDK includes the same address map. A project can use its own contracts, so use JBDirectory to find the contracts currently managing its rules and payments before building a transaction.',
    ],
    blocks: [
      {
        type: 'table',
        label: 'Who does what',
        rows: [
          ['JBProjects', 'Records each project’s owner using a unique token (NFT)'],
          ['JBController', 'Manages rules, creates project tokens, and records project details'],
          ['JBMultiTerminal', 'Receives payments, holds funds, sends payouts, and handles cash outs'],
          ['JBRulesets, JBSplits, JBFundAccessLimits, JBTokens, JBTerminalStore', 'Store rules, recipients, spending limits, tokens, and balances'],
          ['JBDirectory', 'Finds a project’s rules manager (controller) and payment contracts (terminals)'],
          ['JBPermissions', 'Records permission to act for another account'],
          ['JBPrices', 'Converts currencies when calculating new tokens and spending limits'],
          ['JB721TiersHook + deployer', 'Adds a shop to project payments'],
          ['JBBuybackHookRegistry + JBBuybackHook', 'Buys existing tokens on Uniswap V4 when that gives the payer more tokens'],
          ['JBSucker + JBSuckerRegistry, JBOmnichainDeployer', 'Links projects and moves tokens between chains'],
          ['JBRouterTerminalRegistry', 'Finds supported ways to convert a payment into an accepted token'],
          ['REVDeployer, REVOwner, REVLoans', 'Revnets'],
        ],
      },
      {
        type: 'points',
        items: [
          { key: 'Chains', text: 'Ethereum, Optimism, Base, and Arbitrum, plus their Sepolia test networks. Find the list in the SDK’s SUPPORTED_CHAINS and JB_CHAINS.' },
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
  {
    id: 'start-operation-map',
    part: 'Start here',
    title: 'Find a contract call',
    paragraphs: [
      'Use this table once you know the action you want to build. The second column names its contract call and any matching helper in the Juicebox software library (SDK). Examples later in this guide contain placeholders; replace them before use. Some actions need more than one transaction, such as approving token spending before paying.',
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
          ['Send tokens set aside for other recipients', 'JBController.sendReservedTokensToSplitsOf'],
          ['Schedule new terms', 'JBController.queueRulesetsOf — buildQueueRulesetsTx'],
          ['Edit recipients and shares', 'JBController.setSplitGroupsOf — buildSetSplitGroupsTx'],
          ['Create a transferable token contract (ERC-20)', 'JBController.deployERC20For — buildDeployErc20Tx'],
          ['Move tokens tracked in Juicebox into the ERC-20', 'JBController.claimTokensFor — buildClaimTokensTx'],
          ['Create more tokens', 'JBController.mintTokensOf — buildMintTokensTx'],
          ['Give someone permission', 'JBPermissions.setPermissionsFor — buildSetPermissionsTx'],
          ['Manage the shop', 'JB721TiersHook.adjustTiers / mintFor'],
          ['Move tokens to another chain', 'sucker.prepare → toRemote → claim'],
          ['Choose a market for buying existing tokens', 'JBBuybackHookRegistry.initializePoolFor / setHookFor'],
          ['Create an address that forwards payments', 'JBProjectPayerDeployer — buildDeployProjectPayerTx'],
        ],
      },
      {
        type: 'text',
        text: 'Store amounts as whole numbers in the token’s smallest unit, using bigint. Convert only for display. Identify each project by both chain ID and project ID. Linked projects share a group ID, called a sucker group, but keep separate addresses, balances, and rule IDs on each chain.',
      },
    ],
  },

  // ------------------------------------------------------------------ Project builders
  {
    id: 'founders-launch-from-the-wizard',
    part: 'Project builders',
    audience: ['founders'],
    title: 'Launch with the setup form',
    paragraphs: [
      'The setup form covers Flavor, Look and feel, Rules or Stages when needed, Shop, and Launch. The simple flavor skips Rules and uses preset terms. Other projects can schedule new terms when their rules allow it. A revnet fixes its main financial terms at launch, while its operator keeps a limited set of controls.',
    ],
    blocks: [
      {
        type: 'table',
        label: 'The steps',
        rows: [
          ['Flavor', 'Choose a project type, real or test networks, accepted assets, and owner. Link chains if needed. A custom token must use the same address on each chain. “Accept any token” adds support for asset conversion. Turning “Allow changes” off sends ownership to an address nobody can use'],
          ['Look and feel', 'Name (100 characters), token symbol, tagline, description (10,000 characters), logo and cover (25 MB each), links, tags, and payment notice. Saved when you launch to IPFS, a network that identifies files by their content'],
          ['Rules', 'Set the first terms, what follows them, and how much notice changes require. The next section explains each setting'],
          ['Shop', 'Add items with prices, supply, media, and categories. Choose who receives sales, discounts, reserved copies, and any voting rights. Launch creates a shop contract even with no items'],
          ['Launch', 'One transaction per chain: preview, review, sign, and wait. A shared Safe wallet creates a proposal that still needs approval and execution'],
        ],
      },
      {
        type: 'info',
        text: 'Drafts save in your browser. Import or export the form as a .jb file. A live project’s Extras tab can export its current settings so you can compare them with your draft.',
      },
      {
        type: 'links',
        items: [
          { href: '/create', label: 'Open the setup form' },
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
    title: 'Choose the project’s rules',
    paragraphs: [
      'A group of project terms is called a ruleset. It can repeat on a schedule, with each repeat called a cycle. These are the settings in the setup form.',
    ],
    blocks: [
      {
        type: 'table',
        label: 'Rules step',
        rows: [
          ['Duration', 'How long each cycle lasts: 1 day to a year, Flexible (0), or Forever. Timed cycles repeat until replaced. Flexible rules have no cycle boundary; notice and approval still apply'],
          ['Issuance', 'New tokens per ETH or USD paid, before reserved tokens. Default 10,000. Leave blank on a later ruleset to continue the previous rate after any scheduled cuts'],
          ['Issuance cut', 'How much the new-token rate falls each cycle. Revnets express this as “cut X% every N days”'],
          ['Reserved split', 'The share of new tokens set aside for other recipients. Add recipients to set the total'],
          ['Cash outs', 'Let holders exchange tokens for available project funds. The cash out tax controls how much stays for remaining holders: 0% gives a proportional share; 100% turns cash outs off. Revnets may also delay when cash outs begin'],
          ['Payouts', 'None, payments to the owner within a limit, or payments to named recipients. Set amounts or percentage shares for each accepted asset. Limits apply per cycle and per chain'],
          ['Surplus allowance', 'How much the owner can withdraw beyond the regular spending limit'],
          ['Accept payments', 'Off pauses paying'],
          ['Owner can mint any time', 'Whether the owner can create tokens without a payment (allowOwnerMinting)'],
          ['Superpowers', 'Launch contracts and settings the owner can change: payment contracts, rules manager, project token, accepted assets, and currency feeds. Check both the current powers and whether later rules can enable more'],
          ['Afterwards, notice', 'What follows these terms, and how much notice a change needs: 3 hours, 1 day, 3 days, 7 days, or none'],
        ],
      },
      {
        type: 'info',
        text: 'The form sets up the shop extension automatically. The Learn guide explains how the cash out tax changes the amount holders receive, with a worked example.',
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
          { key: 'Launch contract', text: 'the app uses REVDeployer.deployFor for revnets, JBOmnichainDeployer.launchProjectFor for linked chains, and JB721TiersHookProjectDeployer.launchProjectFor for other projects. These launchers set up the required extensions.' },
          { key: 'Transaction value', text: 'read JBProjects.creationFee() right before each launch and pass that exact amount as value. Show it in the review before signing.' },
          { key: 'One transaction per chain', text: 'sign each launch in order with the same wallet. The app keeps a shared value, called a salt, so linked bridge contracts get matching addresses.' },
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
    title: 'Manage your project',
    paragraphs: [
      'The project page groups available management actions into tabs. Available actions depend on your account, project rules, and extensions.',
    ],
    blocks: [
      {
        type: 'table',
        label: 'Project page',
        rows: [
          ['Rulesets', 'Read current and upcoming terms. Schedule a change under the project’s timing and approval rules'],
          ['Funds', 'Send funds to chosen recipients, use the owner’s extra withdrawal allowance, or add funds'],
          ['Owners', 'See holders and balances. Send tokens set aside for recipients, or create tokens scheduled by a revnet'],
          ['Shop', 'Add items, create reserved copies, replace media, and redeem items'],
          ['Admin', 'Manage permissions, ownership, names, links, and token details. Use the contract and market controls allowed by the current rules'],
          ['Extras', 'Export current terms as a .jb file, create a payment-forwarding address, and manage funds supplied to markets'],
        ],
      },
      {
        type: 'info',
        text: 'New terms must meet the start time, notice, and approval requirements. Timed rules also require an eligible cycle boundary. A change with too little notice is skipped.',
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
  // ------------------------------------------------------------------ App builders
  {
    id: 'apps-set-up-the-sdk',
    part: 'App builders',
    audience: ['frontend'],
    title: 'Use the Juicebox software library',
    paragraphs: [
      'The Juicebox software library (SDK), @bananapus/nana-sdk-core, helps you read projects and prepare transactions. It includes addresses and contract call formats (ABIs). Import shared addresses, formats, and project details from the package root; import V6 reads and transaction builders from /v6.',
      'A builder prepares a request without sending it: { chainId, address, abi, functionName, args, value }. Read with a public client and sign with a wallet client on the same chain.',
    ],
    blocks: [
      {
        type: 'links',
        items: [
          { href: '/build/first-payment#read', label: 'Start Your first test payment' },
          { href: '/examples/read-project.mjs', label: 'Download the tested read-project.mjs example' },
          { href: '/build/first-payment#preview', label: 'Next: preview, simulate, and inspect a payment' },
        ],
      },
      {
        type: 'text',
        text: 'The tutorial uses an existing project on the Base Sepolia test network. It includes the full working example, package versions, expected output, and help when a step fails.',
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
    aliases: ['build-configure'],
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
          ['Owner and project details', 'JBProjects.ownerOf / JBController.uriOf'],
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
    title: 'Search project data with Bendystraw',
  }),
  {
    id: 'apps-wallets-safe-relayr',
    part: 'App builders',
    audience: ['frontend'],
    title: 'Connect wallets and request approval',
    paragraphs: [
      'A wallet can send a transaction directly. A shared Safe wallet needs a proposal and approvals before execution. Relayr can send a group of approved calls across chains. Permit2 grants limited token spending for swaps. This site chooses the flow based on the connected account.',
    ],
    blocks: [
      {
        type: 'table',
        label: 'Signing paths in this site',
        rows: [
          ['Wallet write', 'submitReviewedContractWrite: review the decoded call → switch chain → simulate as the connected account → sign → wait for the receipt'],
          ['Actions on behalf of an owner', 'runAuthorityCalls selects the flow. A directly controlled wallet signs itself. An account that supports forwarded calls (ERC-2771) can approve a prepaid Relayr bundle. A Safe receives proposals in its transaction service'],
          ['Safe', 'Propose, approve, then execute. A Safe can use the same address on another chain, but its deployment and signing authority must be checked on each chain'],
          ['Permit2', 'Used for direct Uniswap V4 swaps. Other token payments use approve for the exact amount'],
        ],
      },
      {
        type: 'text',
        text: 'Chain requests (RPC) go through Juicebox Center, which allows approved website origins. Connections include browser wallets, WalletConnect, Coinbase, and Safe. Para provides an embedded wallet and card purchases.',
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
    title: 'Save names, descriptions, and media',
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
    title: 'Review, send, and confirm a transaction',
    paragraphs: [
      'Use one request from preview through submission. Just before signing, refresh balances, limits, and permissions. Prepare the request, run a trial with the actual account, and show what it does and the minimum it will return. After sending, distinguish a rejected wallet request, a shared-wallet proposal, a pending transaction, and a confirmed success or failure.',
      'The app checks that the encoded request still matches what the user reviewed. Its trial uses eth_call with a gas limit. A source check also verifies that every contract write uses one of the reviewed submission functions.',
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
  legacy('build-fund', { part: 'Life of a project', audience: ['frontend', 'contracts'] }),
  legacy('build-tokens-mgmt', { part: 'Life of a project', audience: ['frontend', 'contracts'] }),
  legacy('build-distribute', { part: 'Life of a project', audience: ['frontend', 'contracts'] }),
  legacy('build-cashout', { part: 'Life of a project', audience: ['frontend', 'contracts'] }),

  // ------------------------------------------------------------------ Life of a revnet
  legacy('build-revnet-deploy', { part: 'Life of a revnet', audience: ['frontend', 'contracts'] }),
  {
    id: 'revnet-go-deeper',
    part: 'Life of a revnet',
    title: 'Build with revnets',
    paragraphs: [
      'The Revnet build guide covers launch settings, saved drafts, operator controls, loans, and custom extensions. Use its source references to check the terms you plan to launch.',
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
    aliases: ['build-launch', 'build-evolve'],
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
          ['JBController.queueRulesetsOf', '(uint256 projectId, JBRulesetConfig[] rulesetConfigurations, string memo). Schedules new terms. The current timing and approval requirements decide when they can begin'],
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
    title: 'Add custom behavior with hooks',
  }),
  {
    id: 'contracts-hook-mechanics',
    part: 'Contract builders',
    audience: ['contracts'],
    title: 'Implement an extension',
    blocks: [
      {
        type: 'points',
        items: [
          { key: 'Installing a data hook', text: 'set metadata.dataHook and useDataHookForPay / useDataHookForCashOut on the ruleset. beforePayRecordedWith returns the weight to use and pay hook specifications; beforeCashOutRecordedWith returns the tax rate, count, supply, surplus, and cash out hook specifications.' },
          { key: 'Funds', text: 'native value arrives at a pay or cash out hook as msg.value; ERC-20 arrives as an allowance you must transferFrom during the call, revoked afterwards. Quote the amount the hook will actually receive. A specification with noop = true is informational and never called.' },
          { key: 'Two metadatas', text: 'hookMetadata is authored by the data hook, while payerMetadata / cashOutMetadata comes from the caller. Trust hookMetadata only after authenticating the calling terminal and the expected hook path; validate caller-supplied fields.' },
          { key: 'Metadata format', text: 'JBMetadataResolver: a reserved first word, then a table of 4-byte ids with word offsets, then 32-byte-aligned blobs. createMetadata(ids, datas), addToMetadata, getDataFor(id, metadata). Ids are getId(purpose, target) = bytes4(bytes20(target) ^ bytes20(keccak256(purpose))).' },
          { key: 'Minting from a hook', text: 'JBController.mintTokensOf lets the terminal, the ruleset’s data hook, or any address the data hook’s hasMintPermissionFor approves mint without a grant; everyone else needs MINT_TOKENS (10) and allowOwnerMinting.' },
          { key: 'Split hooks', text: 'a split whose hook field is set receives its share through processSplitWith. On the reserved-token path the controller approves an ERC-20 for the amount and burns whatever the hook leaves unspent; on payouts the terminal checks ERC-165 first.' },
          { key: 'Reentrancy', text: 'a hook can call back into your contract before its first call finishes, called reentrancy. Protect your state updates and test each callback. A guard that blocks every nested call can break intended flows. Use override(ERC165, IERC165) for supportsInterface.' },
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
    title: 'Test against deployed contracts',
    blocks: [
      {
        type: 'table',
        label: 'Foundry',
        rows: [
          ['TestBaseWorkflow', '@bananapus/core-v6/test/helpers/TestBaseWorkflow.sol: deploys the full protocol locally with a mock USDC and two terminals, plus Permit2. Extend it for unit tests of hooks and integrations'],
          ['Fork tests', 'Create a local copy of the chain at one fixed block, called a fork. Configure foundry.toml rpc_endpoints and test against the deploy-all-v6 addresses'],
          ['Sizes', 'forge build --sizes early; several V6 contracts sit near EIP-170 and were split or trimmed to fit. Plan for library extraction if you are close'],
          ['Bytecode parity', 'compare the deployed machine code with deploy-all-v6 artifacts. Matching source alone is insufficient because linked libraries change the resulting code'],
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
    title: 'Behavior to check carefully',
    blocks: [
      {
        type: 'points',
        items: [
          { key: 'Who is the payer', text: 'context.payer is the terminal’s msg.sender. Through a router, project payer, or wrapper it is that contract, unless the contract exposes originalPayer() (IJBPayerTracker), which the router registry probes. Expose the original payer where the integration expects it, and set beneficiary/refund addresses explicitly so rewards or refunds are not accidentally credited to the intermediary.' },
          { key: 'Router terminal cold start', text: 'the router registry reverts accountingContextForTokenOf for projects below its threshold; it is not universally accepting. Probe with previewPayFor before assuming a route.' },
          { key: 'Buyback metadata is three words', text: 'the pay metadata under getId("pay", hook) decodes as (amountToSwapWith, minimumSwapAmountOut, skipSplits). Always encode all three; two-word quotes revert. Buyback 1.4.0 falls back to minting when the TWAP floor cannot be filled.' },
          { key: 'Router gateway custody', text: 'resolve registry.terminalOf(projectId), then gateway.ROUTER() when the selected terminal is a gateway. Eligible failed fee routes remain held for retry, not paid or forgiven. Track QueuePendingCall, ProcessPendingCall, RecordTerminalCallFailure and RefundPendingCall; pendingCallCount is the lifetime count of issued IDs, not the number currently pending.' },
          { key: 'Per-chain rollout and prices', text: 'use canonical executed deployment records, preserving previous and v1 addresses for history. Mainnet proposals do not activate the new stack. JBRatioPriceFeed supplies project-zero defaults for USDC→NATIVE and USDC→ETH; addresses vary by chain and OP Sepolia has the feed without hook/router/gateway.' },
          { key: 'Payouts to a project without a terminal', text: 'if the recipient project has no payment contract for the asset, its payout fails and the balance is restored. The payout limit is still consumed.' },
          { key: 'Ownership changes reset permissions', text: 'permissions must come from the current owner. A previous owner’s grants stop working after ownership transfers.' },
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
          { key: 'Cash outs', text: 'the terminal or hook enforces the same minimum the confirmation shows, including zero-tax cash outs.' },
          { key: 'Payouts', text: 'limits apply per chain and cycle; a recipient project without a payment contract can consume the limit without receiving funds.' },
          { key: 'Rulesets', text: 'a queue with too little notice fails its approval hook; an inherited weight is decayed, not copied.' },
          { key: 'Permissions', text: 'the narrowest ID is granted, scoped to the project; a Safe proposal is not success.' },
          { key: 'Hooks', text: 'reentrancy from a hostile hook or token, an under-pulling split hook, hostile payer metadata.' },
        ],
      },
      {
        type: 'text',
        text: 'Test against a local copy of the current deployments. Publish the addresses, source, user actions, and schedule of terms so people can check how your product works. The audit page has prompts for reviewing a whole product or one transaction.',
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
