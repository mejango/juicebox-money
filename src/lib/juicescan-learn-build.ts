/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-unused-vars, no-var */
// @ts-nocheck -- adapted DOM renderer; Juicescan remains the protocol-content source of truth.
// Mirrored from webclients/juicescan/src/learn-build.js. Client-specific guidance may diverge.
// src/learn-build.js
// Learn & Build tab content — engaging walkthrough of the Juicebox protocol

export function renderLearnTab() {
  var container = document.getElementById('tab-learn');
  container.innerHTML = '';

  var wrap = document.createElement('div');
  wrap.className = 'guide-wrap';

  // --- Table of Contents ---
  var toc = document.createElement('nav');
  toc.className = 'guide-toc';
  toc.innerHTML =
    '<div class="guide-toc-title">TABLE OF CONTENTS</div>' +
    '<div class="guide-toc-group-label">The Basics</div>' +
    '<a class="guide-toc-link" href="#learn-what">1. What is Juicebox?</a>' +
    '<a class="guide-toc-link" href="#learn-how">2. How It Works</a>' +
    '<a class="guide-toc-link" href="#learn-projects">3. Projects</a>' +
    '<a class="guide-toc-link" href="#learn-revnets">4. Revnets</a>' +
    '<div class="guide-toc-group-label" style="margin-top:8px">Going Deeper</div>' +
    '<a class="guide-toc-link" href="#learn-rulesets">5. Rulesets</a>' +
    '<a class="guide-toc-link" href="#learn-tokens">6. Tokens</a>' +
    '<a class="guide-toc-link" href="#learn-splits">7. Splits &amp; Payouts</a>' +
    '<a class="guide-toc-link" href="#learn-fees">8. Fees</a>' +
    '<div class="guide-toc-group-label" style="margin-top:8px">Under the Hood</div>' +
    '<a class="guide-toc-link" href="#learn-architecture">9. Architecture</a>' +
    '<a class="guide-toc-link" href="#learn-hooks">10. Hooks &amp; Extensions</a>' +
    '<a class="guide-toc-link" href="#learn-omnichain">11. Omnichain</a>' +
    '<a class="guide-toc-link" href="#learn-prices">12. Price Feeds</a>' +
    '<div class="guide-toc-group-label" style="margin-top:8px">The Ecosystem</div>' +
    '<a class="guide-toc-link" href="#learn-permissions">13. Permissions</a>' +
    '<a class="guide-toc-link" href="#learn-nfts">14. NFT Rewards</a>' +
    '<a class="guide-toc-link" href="#learn-croptop">15. Croptop</a>' +
    '<a class="guide-toc-link" href="#learn-buyback">16. Buyback Hook</a>' +
    '<a class="guide-toc-link" href="#learn-loans">17. Loans</a>' +
    '<a class="guide-toc-link" href="#learn-migration">18. Migration</a>' +
    '<a class="guide-toc-link" href="#learn-distributor">19. Distributor</a>' +
    '<a class="guide-toc-link" href="#learn-handles">20. Project Handles</a>' +
    '<a class="guide-toc-link" href="#learn-payer">21. Payer Address</a>';
  wrap.appendChild(toc);

  // ============================================
  // THE BASICS — normie-friendly, no jargon
  // ============================================

  var basicsHeader = document.createElement('div');
  basicsHeader.className = 'guide-part-header';
  basicsHeader.textContent = 'THE BASICS';
  wrap.appendChild(basicsHeader);

  wrap.appendChild(guideSection('learn-what', '1. WHAT IS JUICEBOX?', [
    'Juicebox is a programmable money engine for the open web. Anyone can create a project, accept payments, and distribute funds according to rules they define — all without middlemen.',
    'People who pay into a project get tokens in return. Those tokens represent their stake. If the project has money beyond what it needs for payouts, token holders can cash out their tokens to reclaim a portion of that extra money (called "surplus").',
    'Projects can accept any currency, operate across multiple blockchains, and customize every aspect of how money flows in and out. Tokens can be programmed to serve any purpose — governance votes, membership access, revenue shares, or just a way to track participation.'
  ], []));

  wrap.appendChild(guideSection('learn-how', '2. HOW IT WORKS', [
    'There are really only two core actions: pay and cash out. Everything else is configuration around those two things.'
  ], [
    diagram('THE BASIC LOOP', [
      '  1. Someone PAYS into a project',
      '     └─▶ They receive project tokens',
      '',
      '  2. The project DISTRIBUTES payouts',
      '     └─▶ To team members, partners, other projects',
      '',
      '  3. Token holders can CASH OUT',
      '     └─▶ Burn tokens, reclaim a share of what’s left',
      '',
      '  surplus = project balance - payout commitments',
      '  cash out value = your tokens’ share of the surplus',
    ]),
    textBlock('The project owner configures rules that determine how much to pay out, how many tokens to issue per payment, and what the cash out terms look like. These rules can evolve over time through "rulesets" — scheduled configurations that automatically take effect.'),
    textBlock('Each step is infinitely customizable via pay hooks, cash out hooks, and split hooks — contracts that run custom logic whenever payments come in, tokens are redeemed, or funds are distributed.'),
    textBlock('A 2.5% fee is charged on payouts and certain cash outs. This fuels the protocol’s own revenue network, which fee payers automatically participate in — it runs on Juicebox itself.')
  ]));

  wrap.appendChild(guideSection('learn-projects', '3. PROJECTS', [
    'A Juicebox project is like a bank account with programmable rules. Each project is represented by an NFT — whoever holds the NFT controls the project.',
    'Projects can accept any token (ETH, stablecoins, etc.) and can operate on multiple chains simultaneously. The project owner sets the rules, but the protocol enforces them automatically — no trust required.',
    'Anyone can create a project. There are no gatekeepers and no approval processes.'
  ], [
    diagram('WHAT A PROJECT DOES', [
      '  ┌───────────────────────────────────────────────┐',
      '  │  YOUR PROJECT                                  │',
      '  │                                                │',
      '  │  accepts payments ──▶ issues tokens            │',
      '  │  holds funds      ──▶ distributes payouts      │',
      '  │  tracks surplus   ──▶ enables cash outs        │',
      '  │                                                │',
      '  │  rules set by owner, enforced by protocol      │',
      '  └───────────────────────────────────────────────┘',
    ])
  ]));

  wrap.appendChild(guideSection('learn-revnets', '4. REVNETS', [
    'A revnet (revenue network) is a special kind of project where the economics are permanently locked at launch. Nobody — not even the creator — can change issuance, cuts, cash out taxes, or stage timing.',
    'This makes revnets ideal for protocols, tokens, and any situation where trust needs to be minimized. The token price, issuance schedule, and cash out terms are all predetermined and immutable.',
    'Revnets progress through "stages" — think of them as chapters in a financial lifecycle. Early stages might issue lots of tokens to attract participation, later stages tighten supply to create scarcity.'
  ], [
    diagram('PROJECT vs REVNET', [
      '  PROJECT                          REVNET',
      '  ───────                          ──────',
      '  owner controls rules             rules locked forever',
      '  flexible governance              zero trust required',
      '  good for: DAOs, collectives      good for: protocols, tokens',
    ]),
    textBlock('Under the hood, revnets are just Juicebox projects owned by a contract (REVOwner) that refuses to change the economics. An operator keeps a short list of non-economic powers: metadata, split recipients, buyback pool, sucker safety. All the same pay and cash out mechanics apply.')
  ]));

  // ============================================
  // GOING DEEPER — concepts with some jargon
  // ============================================

  var deeperHeader = document.createElement('div');
  deeperHeader.className = 'guide-part-header';
  deeperHeader.textContent = 'GOING DEEPER';
  wrap.appendChild(deeperHeader);

  wrap.appendChild(guideSection('learn-rulesets', '5. RULESETS', [
    'Rulesets are the heartbeat of a project. Each ruleset defines how things work for a period of time: how many tokens per payment, how much can be paid out, and what the cash out terms are.',
    'When a ruleset’s duration expires, it automatically cycles — same rules, but with an optional decay applied to the token issuance rate. This means early supporters naturally get more tokens per payment than later ones.',
    'The project owner can queue a new ruleset to take effect at the next cycle boundary. If an approval hook is configured, changes must be approved before activating.'
  ], [
    propertyTable('KEY PARAMETERS', [
      ['duration', 'How long the ruleset lasts. 0 = forever (must be explicitly replaced).'],
      ['weight', 'Tokens issued per unit paid. This is the "exchange rate."'],
      ['weightCutPercent', 'How much the weight decreases each cycle (the decay rate).'],
      ['reservedPercent', 'Share of minted tokens set aside for the team/splits.'],
      ['cashOutTaxRate', 'How much cash outs are taxed. Higher = more incentive to hold.'],
      ['baseCurrency', 'Accounting currency (ETH or USD).'],
    ]),
    diagram('RULESET LIFECYCLE', [
      '  queue ruleset    approval hook     cycle boundary',
      '       │              checks              │',
      '       ▼                │                  ▼',
      '   QUEUED ──────▶ APPROVED ──────▶ ACTIVE ──cycles──▶ ACTIVE...',
      '       │                                   ▲',
      '       └── if no approval hook ────────────┘',
    ])
  ]));

  wrap.appendChild(guideSection('learn-tokens', '6. TOKENS', [
    'When someone pays a project, they receive project tokens. Tokens record participation, define each holder’s share of the surplus that can be cashed out, and can be used by extensions or outside apps as the project’s own asset. The exchange rate is set by the ruleset weight — for example, 1,000 tokens per ETH.',
    'A portion of tokens can be reserved for the project team. If reservedPercent is 20%, then for every payment, 80% of tokens go to the payer and 20% are set aside for the team’s configured splits.',
    'Tokens start as internal "credits" — lightweight balances tracked by the protocol. The project can deploy a full ERC-20 token at any time, and token holders can convert their credits into real tokens.'
  ], [
    diagram('TOKEN FLOW EXAMPLE', [
      '  payment: 2 ETH',
      '  weight:  500 tokens per ETH',
      '  reserved: 20%',
      '',
      '  total minted = 1,000 tokens',
      '       │',
      '  ┌────┴─────────────────┐',
      '  │                      │',
      '  ▼                      ▼',
      '  800 tokens          200 tokens',
      '  (to payer)          (to team splits)',
    ])
  ]));

  wrap.appendChild(guideSection('learn-splits', '7. SPLITS & PAYOUTS', [
    'Splits control where money and reserved tokens go. Each split directs a percentage to a wallet, another project, or a custom contract.',
    'Payout limits cap how much the project can distribute per cycle. Everything beyond the payout limit is "surplus" — and that’s what token holders can cash out against.',
    'Splits can be locked until a specific date. Once locked, they can’t be changed or removed until the lock expires — only the lock can be extended, and other splits can be added alongside. This protects team members and partners from having their share cut.'
  ], [
    diagram('FUND FLOW', [
      '  project balance',
      '       │',
      '  ┌────┴──────────────────────┐',
      '  │                           │',
      '  ▼                           ▼',
      '  payout limit             surplus',
      '  (distributed to splits)  (available for cash outs)',
    ])
  ]));

  wrap.appendChild(guideSection('learn-fees', '8. FEES', [
    'The protocol charges a 2.5% fee on payouts and surplus withdrawals. Cash outs also pay it: with a tax rate above 0% the fee applies to the whole reclaimed amount, and with a 0% tax rate it still applies to min(reclaimed, feeFreeSurplusOf) — the portion of surplus that arrived fee-free from a payout or allowance withdrawal, which stops a round trip from escaping the fee. That portion is often zero, but never assume it is.',
    'If the holdFees ruleset flag is enabled, fees are held for 28 days before being processed. During this window, if funds are added back through addToBalanceOf with shouldReturnHeldFees set, the matching held fees are returned. After 28 days, the held fees can be forwarded to the Juicebox protocol’s own project — processed via processHeldFeesOf(), or by a later ruleset/operation (it isn’t automatic at the 28-day mark). If holdFees is off, fees are processed immediately.',
    'Some addresses can be designated as fee-exempt — they pay zero fees on all transactions.'
  ], [
    diagram('FEE EXAMPLE', [
      '  100 ETH payout',
      '     └─▶ 2.5 ETH fee',
      '     └─▶ 97.5 ETH distributed to splits',
      '',
      '  if holdFees is on:  fee held 28 days, refundable',
      '  if holdFees is off: fee processed immediately',
    ])
  ]));

  // ============================================
  // UNDER THE HOOD — technical details
  // ============================================

  var hoodHeader = document.createElement('div');
  hoodHeader.className = 'guide-part-header';
  hoodHeader.textContent = 'UNDER THE HOOD';
  wrap.appendChild(hoodHeader);

  wrap.appendChild(guideSection('learn-architecture', '9. ARCHITECTURE', [
    'Everything you’ve read about so far — projects, rulesets, tokens, splits, fees — each lives in its own smart contract. These contracts are organized in layers.',
    'Surface contracts are what users interact with: the controller orchestrates project operations, and the terminal handles money in and out. Core contracts store the underlying data: who owns what, what the rules are, where funds go. Omnichain contracts move tokens and funds across blockchains.'
  ], [
    diagram('CONTRACT LAYERS', [
      '┌──────────────────────────────────────────────────────────────┐',
      '│  SURFACE — what users interact with                          │',
      '│  JBController · JBMultiTerminal · JBTerminalStore            │',
      '├──────────────────────────────────────────────────────────────┤',
      '│  CORE — stores protocol state                                │',
      '│  JBProjects · JBDirectory · JBPermissions · JBTokens         │',
      '│  JBRulesets · JBSplits · JBPrices · JBFundAccessLimits       │',
      '│  JBFeelessAddresses                                          │',
      '├──────────────────────────────────────────────────────────────┤',
      '│  OMNICHAIN — cross-chain connectivity                        │',
      '│  JBSucker · JBSuckerDeployer · JBSuckerRegistry              │',
      '└──────────────────────────────────────────────────────────────┘',
    ]),
    propertyTable('WHAT EACH CONTRACT DOES', [
      ['JBController', 'The orchestrator. Deploys projects, queues rulesets, mints and burns tokens.'],
      ['JBMultiTerminal', 'Handles money: pay, cash out, distribute payouts, add funds. Accepts any token.'],
      ['JBTerminalStore', 'The bookkeeper. Tracks balances, payout limits, surplus, and cash out math.'],
      ['JBProjects', 'Each project is an NFT. Whoever holds the NFT controls the project.'],
      ['JBDirectory', 'A phonebook that maps projects to their controller and terminals.'],
      ['JBPermissions', 'Fine-grained access control. Grant specific abilities to other addresses.'],
      ['JBTokens', 'Manages the dual token system: lightweight internal credits + optional full ERC-20 token.'],
      ['JBRulesets', 'Stores and schedules rulesets. Handles cycling, decay, and approval hooks.'],
      ['JBSplits', 'Stores payout and reserved token distribution rules.'],
      ['JBPrices', 'Converts between currencies (e.g. ETH to USD) using price feeds.'],
      ['JBFundAccessLimits', 'Enforces payout limits and surplus allowances.'],
      ['JBFeelessAddresses', 'Registry of addresses exempt from protocol fees.'],
    ])
  ]));

  wrap.appendChild(guideSection('learn-hooks', '10. HOOKS & EXTENSIONS', [
    'A "hook" is a custom contract that plugs into the protocol at a specific moment — like a callback. When a payment comes in, when tokens are cashed out, or when a ruleset changes, the protocol can call your hook to run custom logic.',
    'Projects can add features like NFT rewards, automatic market buybacks, content publishing, and approval gates without modifying the core protocol. Hooks are optional and composable.'
  ], [
    propertyTable('TYPES OF HOOKS', [
      ['Data hook', 'Intercepts payments or cash outs BEFORE they happen. Can modify amounts, redirect funds, or override behavior.'],
      ['Pay hook', 'Runs AFTER a payment is recorded. Good for side effects like minting NFTs or sending notifications.'],
      ['Cash out hook', 'Runs AFTER tokens are burned and funds transferred. Good for cleanup or analytics.'],
      ['Split hook', 'Runs when a payout split sends funds to a contract instead of a wallet. Good for auto-investing.'],
      ['Approval hook', 'Gates queued rulesets — the hook must approve changes before they can activate.'],
    ]),
    propertyTable('BUILT-IN EXTENSIONS', [
      ['Buyback hook', 'Automatically buys tokens from a DEX when the market price is better than the mint price.'],
      ['721 tiers hook', 'Distributes tiered NFTs to contributors based on payment amount.'],
      ['Swap terminal', 'Routes an incoming token to the project through the best available path — V4/V5 framing called this "the project’s preferred token", but V6’s JBRouterTerminal has no fixed preferred token (see §18).'],
      ['Project handles', 'Gives projects human-readable names via ENS (Ethereum Name Service).'],
    ])
  ]));

  wrap.appendChild(guideSection('learn-omnichain', '11. OMNICHAIN', [
    'A single project can operate across multiple blockchains — Ethereum, Optimism, Arbitrum, and more. The same project tokens work everywhere, and funds move proportionally between chains.',
    'This works through "suckers" — bridge contracts that connect a project’s funds across chains. When tokens are bridged from one chain to another, the sucker moves a proportional share of the funds to match. Each chain pair has its own sucker using the native bridge (Optimism bridge, Arbitrum bridge, or Chainlink CCIP).',
    'Once tokens have been bridged through a sucker, the token mapping between chains becomes permanent — it can’t be changed, only disabled. This protects token holders from having their cross-chain tokens invalidated.',
    'If a bridge ever stops working, token holders aren’t stranded: the project can deprecate the sucker (with a built-in delay so in-flight transfers still arrive) and enable an emergency hatch that lets holders withdraw their backing funds locally on the chain they deposited from.'
  ], [
    diagram('CROSS-CHAIN FLOW', [
      '  Ethereum funds ◄──── sucker ────► Optimism funds',
      '       │                                    │',
      '       └── tokens bridged ──────────────────┘',
      '           funds move proportionally',
    ])
  ]));

  wrap.appendChild(guideSection('learn-prices', '12. PRICE FEEDS', [
    'JBPrices normalizes price feeds between currencies, enabling projects to account in USD while managing ETH.',
    'Price feeds are immutable once set — a feed cannot be replaced, only added. Inverse prices are auto-calculated (ETH→USD gives you USD→ETH for free).',
    'Projects can set project-specific feeds that override protocol defaults. JBPrices tries each configured feed in order (project-specific, then the protocol default, in both directions) and only reverts when none returns a usable price — so a single feed reverting doesn’t block the operation. When it can’t resolve any price, the dependent operation reverts: a safe failure mode (no fund loss, just temporary unavailability).',
    'On L2s (Optimism, Arbitrum, Base) the protocol uses a sequencer-aware feed that withholds prices while the chain’s sequencer is down or inside its grace period after a restart — preventing operations from acting on a stale price during an outage.'
  ], []));

  // ============================================
  // THE ECOSYSTEM — ecosystem tools & patterns
  // ============================================

  var ecoHeader = document.createElement('div');
  ecoHeader.className = 'guide-part-header';
  ecoHeader.textContent = 'THE ECOSYSTEM';
  wrap.appendChild(ecoHeader);

  wrap.appendChild(guideSection('learn-permissions', '13. PERMISSIONS', [
    'The project owner doesn’t have to do everything themselves. They can grant specific abilities to other addresses — like "you can trigger payouts" or "you can queue new rulesets" — without giving away full control.',
    'Each ability has a number (a "permission ID"). Granting permission #5 (SEND_PAYOUTS) to an address lets it distribute funds, but nothing else. There’s also a special "ROOT" permission (#1) that grants everything — use with care.',
    'Permissions are per-project. Granting someone access to project #5 doesn’t give them any access to project #6. Granting with project ID 0 is the wildcard: it applies to every project the GRANTING account controls on that chain — not to every project the operator touches.'
  ], [
    propertyTable('COMMON PERMISSIONS', [
      ['ROOT', 'Full control over all operations. Like giving someone the project NFT, but revocable.'],
      ['QUEUE_RULESETS', 'Can schedule new rulesets for the project.'],
      ['MINT_TOKENS', 'Can mint tokens on-demand (if the ruleset allows it).'],
      ['SET_SPLIT_GROUPS', 'Can change how payouts and reserved tokens are distributed.'],
      ['SET_PROJECT_URI', 'Can update the project’s name, description, and logo.'],
      ['SEND_PAYOUTS', 'Can trigger payout distributions.'],
      ['SET_TERMINALS', 'Can replace the project’s terminal list (ADD_TERMINALS only appends).'],
    ]),
    infoBox('Permissions are granted by a specific account, and every check asks whether the CURRENT owner granted them. If the project NFT moves to a new owner, operators the old owner granted lose their power over the project; the old grants only linger under the old owner’s account.')
  ]));

  wrap.appendChild(guideSection('learn-nfts', '14. NFT REWARDS', [
    'Projects can reward contributors with NFTs organized into tiers. Each tier has a price threshold, a limited supply, and a category. When someone pays enough, they receive an NFT from the matching tier — like membership cards at different levels.',
    'Tiers are grouped by category, and categories must be defined in ascending order. Each tier can also have governance weight (voting power per NFT), reserved NFTs that accrue to a reserve beneficiary as others are minted, and, if the tier allows it, owner minting without payment.',
    'The NFT artwork and metadata can live on IPFS (a decentralized file system) or onchain. This system is powered by a pay hook called JB721TiersHook that automatically mints NFTs when payments come in.'
  ], [
    propertyTable('WHAT EACH TIER DEFINES', [
      ['price', 'Minimum payment to receive this tier’s NFT.'],
      ['supply', 'How many NFTs are available in this tier. Once sold out, it’s gone.'],
      ['category', 'A grouping number. Tiers must be submitted with categories in ascending order.'],
      ['reserve frequency', 'Automatically reserve 1 NFT for the project every N minted. 0 = no reserves.'],
      ['voting power', 'How much governance weight each NFT in this tier carries.'],
      ['metadata', 'A link to the NFT’s artwork and description (usually an IPFS content hash).'],
    ]),
    infoBox('NFT tiers are set up at project launch and can be adjusted later. The project owner can add new tiers, remove existing ones (unless locked), and mint reserved NFTs.')
  ]));

  wrap.appendChild(guideSection('learn-croptop', '15. CROPTOP', [
    'Croptop turns any Juicebox project into a content platform. Anyone can publish content (images, text, links) to a project’s NFT collection — the content becomes a mintable NFT that supporters can collect.',
    'The project owner sets rules for what can be posted: minimum price, supply limits, and optionally an allowlist of who can post. Within those rules, posting is open to everyone. Each post creates a new NFT tier, and supporters mint copies by paying into the project.',
    'A 5% fee goes to the Croptop protocol on each post. The rest flows to the project’s funds. If the same content is posted twice, the existing NFT tier is reused instead of creating a duplicate.'
  ], [
    diagram('HOW CROPTOP WORKS', [
      '  someone publishes content + pays the mint price',
      '     │',
      '     ├─▶ content validated against project’s posting rules',
      '     ├─▶ new NFT tier created for this content',
      '     ├─▶ 5% fee to Croptop protocol',
      '     └─▶ remaining payment → project funds',
      '         └─▶ poster receives the first NFT',
    ]),
    textBlock('Croptop works alongside all other Juicebox features. A revnet with Croptop becomes a self-sustaining content platform where creators publish, supporters collect, and funds flow to the project automatically.')
  ]));

  wrap.appendChild(guideSection('learn-buyback', '16. BUYBACK HOOK', [
    'When someone pays a project, the protocol normally mints new tokens. But what if buying tokens on the open market would give the payer more tokens for their money? The buyback hook automatically checks and picks the better deal.',
    'Here’s how it works: when a payment comes in, the hook compares two prices — the project’s minting rate versus the current market price on a Uniswap V4 trading pool. If the market offers more tokens, the hook swaps instead of minting. If minting is the better deal, it mints normally. The payer always gets the best rate without having to think about it.',
    'The same logic works in reverse for cash outs. If selling tokens on the market returns more than the bonding curve reclaim, the hook routes the cash out through the pool instead.'
  ], [
    diagram('BUYBACK DECISION', [
      '  incoming payment',
      '     │',
      '     ├─ market gives more tokens than minting?',
      '     │  └─▶ swap on the trading pool',
      '     │      └─▶ any leftover amount still minted normally',
      '     │',
      '     └─ minting gives equal or more tokens?',
      '        └─▶ normal mint (no swap needed)',
    ]),
    textBlock('Slippage protection (how much the price can move during the swap) is calculated automatically — it’s not something the payer needs to set. Advanced users can also provide their own price quote in the payment metadata to bypass the automatic check.')
  ]));

  wrap.appendChild(guideSection('learn-loans', '17. LOANS', [
    'Revnet token holders who need cash don’t have to sell. They can take out a loan against their tokens instead — keeping their position while accessing liquidity.',
    'When you borrow, your collateral tokens are burned (removed from supply) and you receive funds from the project. The loan itself is represented as an NFT, so it can be transferred or sold. When you repay, your tokens are re-minted and returned to you.',
    'Loans cost three fees up front: 2.5% to the revnet, 1% to the REV revnet, and a prepaid fee the borrower picks (up to 50%) that buys a period of extra-cost-free repayment, on top of the 2.5% protocol fee. If a loan isn’t repaid within 10 years, anyone can liquidate it — the collateral tokens stay burned permanently and the loan is written off. This actually benefits remaining token holders, since there are now fewer tokens sharing the same funds.'
  ], [
    diagram('LOAN LIFECYCLE', [
      '  borrow',
      '     └─▶ your tokens are burned as collateral',
      '     └─▶ funds sent to you from the project (minus fees)',
      '     └─▶ you receive a loan NFT as your receipt',
      '',
      '  repay (before 10-year expiry)',
      '     └─▶ return the funds + any time-based fee',
      '     └─▶ your collateral tokens are re-minted back to you',
      '',
      '  liquidation (after 10 years)',
      '     └─▶ loan written off — collateral stays burned',
      '     └─▶ remaining token holders benefit from reduced supply',
    ]),
    textBlock('At high cash out tax rates, loan fees can be cheaper than the tax you’d lose by cashing out — making loans a more capital-efficient way to access liquidity while keeping your position.')
  ]));

  wrap.appendChild(guideSection('learn-migration', '18. MIGRATION', [
    'As the protocol evolves, projects can upgrade to newer versions of its core contracts — without losing their funds, tokens, or history. Think of it like moving to a new office: same business, better infrastructure.',
    'There are two kinds of migration. A controller migration moves the project’s management logic (how rulesets work, how tokens are minted) to a new controller. A terminal migration moves funds and accounting to a new terminal. Both follow a safe handoff process where the old contract and the new contract each run checks to ensure nothing is lost.',
    'Only the project owner (or someone they’ve granted permission to) can trigger a migration. Switching controllers is done through JBDirectory.setControllerOf, which registers the new controller as part of the same call.'
  ], [
    diagram('MIGRATION FLOW', [
      '  CONTROLLER',
      '  1. JBDirectory.setControllerOf(newController)',
      '  2. new controller runs its "before receive" check',
      '  3. old controller hands its state over (migrate)',
      '  4. new controller runs its "after receive" check',
      '',
      '  TERMINAL',
      '  1. JBMultiTerminal.migrateBalanceOf(to)',
      '  2. balance moves to a terminal that accepts the same token',
      '     (2.5% fee unless the new terminal is feeless)',
    ]),
    textBlock('The new controller checks the handoff on both sides, so a controller migration only completes if the receiver accepts it. Terminal migration is a plain balance move.')
  ]));

  wrap.appendChild(guideSection('learn-distributor', '19. DISTRIBUTOR', [
    'The distributor is an optional add-on a project can deploy (it isn’t part of the core protocol deployment). It’s a reward system that automatically shares revenue (or any tokens) among project participants. Think of it like a dividend: funds go into the distributor, and participants collect their fair share over time.',
    'Distribution happens in rounds. At the start of each round, a snapshot captures how much each participant holds. Their share of the round’s rewards is proportional to their holdings at that moment. Rewards don’t unlock all at once — they vest gradually over a set number of rounds, encouraging long-term participation.',
    'There are two flavors: one for regular token holders (based on voting power), and one for NFT owners (based on their NFT tiers). Both work the same way — fund it, and each fixed-length round takes a snapshot; participants collect as their rewards vest over the following rounds.'
  ], [
    diagram('HOW DISTRIBUTION WORKS', [
      '  funds deposited into the distributor',
      '     │',
      '     ▼',
      '  round starts → snapshot of all holdings',
      '     │',
      '     ▼',
      '  participants begin vesting their share',
      '     └─▶ share = your holdings / total holdings',
      '     └─▶ rewards unlock gradually over time',
      '     │',
      '     ▼',
      '  collect unlocked rewards as rounds pass',
    ]),
    textBlock('If an NFT is burned while rewards are still vesting, anyone can release the forfeited portion back into the current round — it doesn’t disappear. Unclaimed rounds do expire.')
  ]));

  wrap.appendChild(guideSection('learn-handles', '20. PROJECT HANDLES', [
    'Instead of referring to projects by number ("project #47"), you can give yours a human-readable name like "myproject.eth" using ENS — the Ethereum Name Service, which works like a phonebook for blockchain addresses.',
    'To set up a handle, you need two things: an ENS name you own, and a text record on that name pointing to your project. This two-way link proves that the name owner actually wants the association — anyone can propose a name for a project, but it only counts if the ENS name confirms it.',
    'Multiple people can propose different names for the same project. Frontends (apps and websites) decide which proposer to trust. This open design means no single gatekeeper controls naming.'
  ], [
    diagram('SETTING UP A HANDLE', [
      '  1. own an ENS name (e.g. "myproject.eth")',
      '  2. add a "juicebox" text record: "1:42"  (chain:project)',
      '  3. register the name onchain for your project',
      '  4. apps verify the ENS record matches',
      '  5. your project now shows as "myproject.eth"',
    ]),
    textBlock('Subdomains work too, stored innermost-last: "sub.myproject.eth" is stored as ["myproject", "sub"] — the contract joins the parts in reverse and appends .eth, then verifies the result against the ENS registry.')
  ]));

  wrap.appendChild(guideSection('learn-payer', '21. PAYER ADDRESS', [
    'A payer address is a dedicated native-token (ETH) deposit address for your project. Native ETH sent directly to it is automatically forwarded into your project — no extra steps for the sender. ERC-20 tokens sent directly to the address do not trigger a payment.',
    'You can configure it in two modes. In the default mode, payments mint project tokens for the sender (just like paying the project directly). In "add to balance" mode, funds go straight into the project’s balance without minting tokens — useful for revenue deposits, donations, or any scenario where token issuance isn’t desired.',
    'The payer address automatically finds the right terminal to route funds to. If your project migrates to a new terminal later, the payer address follows it automatically — no reconfiguration needed.'
  ], [
    diagram('HOW THE PAYER ADDRESS WORKS', [
      '  someone sends ETH to the payer address',
      '     │',
      '     ▼',
      '  payer address looks up the project’s current terminal',
      '     │',
      '     ├─ default mode',
      '     │  └─▶ pays the project → tokens minted for sender',
      '     │',
      '     └─ "add to balance" mode',
      '        └─▶ adds funds to balance → no tokens minted',
    ]),
    textBlock('This is especially useful for integrations. Any contract, wallet, or payment flow that can send ETH to an address can now fund your project — they don’t need to know anything about Juicebox.')
  ]));

  container.appendChild(wrap);
  initSmoothScroll(container);
}

export function renderBuildTab() {
  var container = document.getElementById('tab-build');
  container.innerHTML = '';

  var wrap = document.createElement('div');
  wrap.className = 'guide-wrap';

  // --- Table of Contents ---
  var toc = document.createElement('nav');
  toc.className = 'guide-toc';
  toc.innerHTML =
    '<div class="guide-toc-title">TABLE OF CONTENTS</div>' +
    '<div class="guide-toc-group-label">Life of a Project</div>' +
    '<a class="guide-toc-link" href="#build-launch">1. Launch</a>' +
    '<a class="guide-toc-link" href="#build-configure">2. Configure</a>' +
    '<a class="guide-toc-link" href="#build-fund">3. Get Funded</a>' +
    '<a class="guide-toc-link" href="#build-tokens-mgmt">4. Manage Tokens</a>' +
    '<a class="guide-toc-link" href="#build-distribute">5. Distribute</a>' +
    '<a class="guide-toc-link" href="#build-cashout">6. Cash Out</a>' +
    '<a class="guide-toc-link" href="#build-evolve">7. Evolve</a>' +
    '<div class="guide-toc-group-label" style="margin-top:8px">Life of a Revnet</div>' +
    '<a class="guide-toc-link" href="#build-revnet-what">8. What’s a Revnet?</a>' +
    '<a class="guide-toc-link" href="#build-revnet-deploy">9. Deploy</a>' +
    '<a class="guide-toc-link" href="#build-revnet-stages">10. Stages</a>' +
    '<a class="guide-toc-link" href="#build-revnet-fees">11. Revnet Fees</a>' +
    '<div class="guide-toc-group-label" style="margin-top:8px">Ecosystem Tools</div>' +
    '<a class="guide-toc-link" href="#build-permissions">12. Permissions</a>' +
    '<a class="guide-toc-link" href="#build-nfts">13. NFT Tiers</a>' +
    '<a class="guide-toc-link" href="#build-hooks">14. Custom Hooks</a>' +
    '<a class="guide-toc-link" href="#build-distributor">15. Distributor</a>' +
    '<a class="guide-toc-link" href="#build-handles">16. Project Handles</a>' +
    '<a class="guide-toc-link" href="#build-payer">17. Payer Address</a>' +
    '<a class="guide-toc-link" href="#build-swap-terminal">18. Router Terminal</a>' +
    '<a class="guide-toc-link" href="#build-buyback">19. Buyback Hook</a>' +
    '<div class="guide-toc-group-label" style="margin-top:8px">Build Your Own</div>' +
    '<a class="guide-toc-link" href="#build-bendystraw">20. Indexed Data</a>' +
    '<a class="guide-toc-link" href="#build-clients">21. Build From This Client</a>';
  wrap.appendChild(toc);

  // --- Life of a Project ---

  var projectHeader = document.createElement('div');
  projectHeader.className = 'guide-part-header';
  projectHeader.textContent = 'LIFE OF A PROJECT';
  wrap.appendChild(projectHeader);

  wrap.appendChild(guideSection('build-launch', '1. LAUNCH', [
    'Everything starts with JBController.launchProjectFor(). This single call:',
  ], [
    stepList([
      'Mints an ERC-721 project NFT to the owner address',
      'Configures initial rulesets (payout limits, token weights, reserved percents, etc.)',
      'Sets up terminal configurations (which tokens the project accepts)',
      'Registers the project in JBDirectory',
    ]),
    codeBlock(
      'JBController.launchProjectFor',
      'launchProjectFor(\n' +
      '  owner,                    // receives the project NFT\n' +
      '  projectUri,               // metadata (name, description, logo)\n' +
      '  rulesetConfigurations[],  // operational parameters\n' +
      '  terminalConfigurations[], // payment processing setup\n' +
      '  memo                      // transaction description\n' +
      ')'
    ),
    infoBox('For omnichain projects, use JBOmnichainDeployer.launchProjectFor() instead — it launches the project and its local suckers in one transaction. Run it on each chain the project should live on.')
  ]));

  wrap.appendChild(guideSection('build-configure', '2. CONFIGURE', [
    'After launch, inspect and understand your project’s configuration:'
  ], [
    fnRefTable('READING PROJECT STATE', [
      ['JBProjects.ownerOf(projectId)', 'Who owns the project NFT'],
      ['JBController.uriOf(projectId)', 'Metadata link (name, description, logo)'],
      ['JBController.currentRulesetOf(projectId)', 'Active ruleset and its metadata'],
      ['JBController.upcomingRulesetOf(projectId)', 'What comes next (auto-cycled with weight decay)'],
      ['JBDirectory.terminalsOf(projectId)', 'All active terminals'],
      ['JBDirectory.primaryTerminalOf(projectId, token)', 'Default terminal for a specific token'],
      ['JBMultiTerminal.accountingContextsOf(projectId)', 'Which tokens/currencies are accepted'],
      ['JBSplits.splitsOf(projectId, rulesetId, groupId)', 'Payout and reserved token distribution rules'],
    ]),
    fnRefTable('FUND ACCESS LIMITS', [
      ['JBFundAccessLimits.payoutLimitOf(...)', 'Maximum distributable per cycle per token'],
      ['JBFundAccessLimits.surplusAllowanceOf(...)', 'How much surplus the owner can withdraw'],
    ]),
    infoBox('Empty fundAccessLimitGroups = zero payouts (NOT unlimited). Use uint224.max for unlimited payouts.')
  ]));

  wrap.appendChild(guideSection('build-fund', '3. GET FUNDED', [
    'Once launched, anyone can contribute to the project through its configured terminals.'
  ], [
    codeBlock(
      'JBMultiTerminal.pay',
      'pay(\n' +
      '  projectId,\n' +
      '  token,              // which token to pay with\n' +
      '  amount,             // how much\n' +
      '  beneficiary,        // who receives the minted tokens\n' +
      '  minReturnedTokens,  // slippage protection\n' +
      '  memo,               // message attached to the payment\n' +
      '  metadata            // extra data for hooks\n' +
      ')\n' +
      '// Returns: number of tokens minted for the beneficiary'
    ),
    fnRefTable('CHECKING BALANCES', [
      ['JBTerminalStore.balanceOf(terminal, projectId, token)', 'Terminal balance for a specific token'],
      ['JBTerminalStore.currentSurplusOf(...)', 'Surplus across specified terminals and tokens'],
      ['JBTerminalStore.currentTotalSurplusOf(...)', 'Surplus aggregated across ALL terminals'],
    ]),
    infoBox('Anyone can also inject capital without receiving tokens via addToBalanceOf(). This is useful for grants, donations, or returning funds.')
  ]));

  wrap.appendChild(guideSection('build-tokens-mgmt', '4. MANAGE TOKENS', [
    'Tokens start as internal credits. Deploy an ERC-20 whenever you’re ready.'
  ], [
    fnRefTable('TOKEN OPERATIONS', [
      ['JBController.deployERC20For(projectId, name, symbol, salt)', 'Deploy the project’s ERC-20 token'],
      ['JBTokens.tokenOf(projectId)', 'Get the ERC-20 address (zero if not yet deployed)'],
      ['JBTokens.totalBalanceOf(holder, projectId)', 'Complete holdings (credits + ERC-20)'],
      ['JBTokens.creditBalanceOf(holder, projectId)', 'Internal credits only'],
      ['JBController.claimTokensFor(holder, projectId, count, beneficiary)', 'Convert credits into ERC-20 tokens'],
    ]),
    fnRefTable('MINTING & BURNING', [
      ['JBController.mintTokensOf(projectId, tokenCount, beneficiary, memo, useReservedPercent)', 'Owner mints tokens on-demand (if ruleset allows)'],
      ['JBController.burnTokensOf(holder, projectId, tokenCount, memo)', 'Holder burns their own tokens'],
    ])
  ]));

  wrap.appendChild(guideSection('build-distribute', '5. DISTRIBUTE', [
    'Projects distribute funds through payouts and reserved tokens. By default anyone can trigger distribution, but the ownerMustSendPayouts ruleset flag can restrict it to the project owner.'
  ], [
    codeBlock(
      'JBMultiTerminal.sendPayoutsOf',
      'sendPayoutsOf(\n' +
      '  projectId,\n' +
      '  token,\n' +
      '  amount,              // up to the payout limit\n' +
      '  currency,\n' +
      '  minTokensPaidOut     // slippage protection\n' +
      ')\n' +
      '// Distributes to splits, leftover to project owner\n' +
      '// 2.5% protocol fee on payouts, except to other Juicebox projects and feeless addresses'
    ),
    codeBlock(
      'JBController.sendReservedTokensToSplitsOf',
      'sendReservedTokensToSplitsOf(projectId)\n' +
      '// Anyone can call this at any time\n' +
      '// Mints accumulated reserved tokens and distributes to splits'
    ),
    fnRefTable('TRACKING USAGE', [
      ['JBTerminalStore.usedPayoutLimitOf(...)', 'How much of the payout limit has been used this cycle'],
      ['JBTerminalStore.usedSurplusAllowanceOf(...)', 'How much surplus allowance has been used'],
      ['JBController.pendingReservedTokenBalanceOf(projectId)', 'Undistributed reserved tokens'],
    ]),
    infoBox('sendPayoutsOf() is permissionless by default — anyone can trigger distributions. To restrict it to the project owner, enable the ownerMustSendPayouts flag in the ruleset metadata.')
  ]));

  wrap.appendChild(guideSection('build-cashout', '6. CASH OUT', [
    'Token holders can cash out (redeem) their tokens for a proportional share of the project’s surplus. Surplus = terminal balance minus the remaining (unused) payout limit for the cycle.',
    'The cash out tax rate controls how much value stays in the project vs. goes to the redeemer. A rate of 0% = full proportional redemption. Higher rates incentivize holding but reduce access to capital.'
  ], [
    codeBlock(
      'JBMultiTerminal.cashOutTokensOf',
      'cashOutTokensOf(\n' +
      '  holder,\n' +
      '  projectId,\n' +
      '  cashOutCount,         // how many tokens to burn\n' +
      '  tokenToReclaim,       // which token to receive\n' +
      '  minTokensReclaimed,   // slippage protection\n' +
      '  beneficiary,          // who receives the funds\n' +
      '  metadata\n' +
      ')'
    ),
    diagram('BONDING CURVE', [
      '  reclaim = surplus × (cashOutCount / totalSupply)',
      '         × [(MAX - taxRate) + taxRate × (cashOutCount / totalSupply)]',
      '         ÷ MAX',
      '',
      '  taxRate = 0%    → full proportional redemption',
      '  taxRate = 100%  → value stays in project (early holders protected)',
    ]),
    infoBox('Cash outs with tax rate > 0% pay the 2.5% protocol fee on the whole reclaimed amount. At tax rate 0% the fee still applies, on min(reclaimed, feeFreeSurplusOf) — often zero, but not always.')
  ]));

  wrap.appendChild(guideSection('build-evolve', '7. EVOLVE', [
    'Projects evolve by queuing new rulesets. Changes take effect at the next cycle boundary (or immediately if the current ruleset has no duration).'
  ], [
    codeBlock(
      'JBController.queueRulesetsOf',
      'queueRulesetsOf(\n' +
      '  projectId,\n' +
      '  rulesetConfigurations[],  // new parameters\n' +
      '  memo\n' +
      ')\n' +
      '// If an approval hook is configured, it must approve\n' +
      '// the changes before they can activate.'
    ),
    fnRefTable('INSPECTING QUEUED CHANGES', [
      ['JBController.latestQueuedRulesetOf(projectId)', 'Latest ruleset in the queue and its approval status (may already be the active one)'],
      ['JBController.allRulesetsOf(projectId, startingId, size)', 'Complete ruleset history'],
    ])
  ]));

  // --- Life of a Revnet ---

  var revnetHeader = document.createElement('div');
  revnetHeader.className = 'guide-part-header';
  revnetHeader.textContent = 'LIFE OF A REVNET';
  wrap.appendChild(revnetHeader);

  wrap.appendChild(guideSection('build-revnet-what', '8. WHAT’S A REVNET?', [
    'A revnet is a Juicebox project owned by a special contract (REVOwner) that enforces a fixed set of rules. No one — not even the deployer — can change the rules after launch.',
    'This creates a revenue-backed token with programmatic capital formation and zero payout mismanagement risk. The token is automatically deployed as an ERC-20 at launch.',
    'Revnets replace "rulesets" with "stages" — same underlying mechanism, but the terminology emphasizes the predetermined progression.'
  ], [
    diagram('REVNET vs PROJECT', [
      '  PROJECT',
      '  • owned by EOA/multisig',
      '  • owner can change rulesets',
      '  • manual ERC-20 deploy',
      '  • flexible governance',
      '  • good for: DAOs, collectives',
      '',
      '  REVNET',
      '  • owned by REVOwner contract',
      '  • stages locked at deploy',
      '  • ERC-20 auto-deployed',
      '  • trustless, programmatic',
      '  • good for: protocols, tokens',
    ])
  ]));

  wrap.appendChild(guideSection('build-revnet-deploy', '9. DEPLOY A REVNET', [
    'Deploy with REVDeployer.deployFor():'
  ], [
    codeBlock(
      'REVDeployer.deployFor',
      'deployFor(\n' +
      '  revnetId,                        // project ID (or 0 for auto)\n' +
      '  configuration,                   // REVConfig with stages\n' +
      '  accountingContextsToAccept[],    // tokens the terminal should accept\n' +
      '  suckerDeploymentConfiguration,   // cross-chain setup\n' +
      '  tiered721HookConfiguration,      // optional NFT tiers\n' +
      '  allowedPosts[]                   // optional croptop posts\n' +
      ')'
    ),
    textBlock('After deployment, interactions are identical to regular projects — pay(), cashOutTokensOf(), and all read functions work the same way. The difference is governance: no one can change the rules.')
  ]));

  wrap.appendChild(guideSection('build-revnet-stages', '10. STAGES', [
    'Stages are pre-programmed rulesets. A revnet might start with high token issuance (bootstrapping), then reduce over time (scarcity), and eventually reach a steady state.',
    'Each stage can configure: token weight, weight decay, reserved splits, cash out tax rate, and more. Once deployed, stages progress automatically at their configured boundaries.'
  ], [
    fnRefTable('READING STAGE STATE', [
      ['JBController.currentRulesetOf(projectId)', 'Active stage parameters'],
      ['JBController.upcomingRulesetOf(projectId)', 'Next stage (empty if none is queued)'],
      ['JBController.allRulesetsOf(projectId, startingId, size)', 'Complete stage history'],
    ]),
  ]));

  wrap.appendChild(guideSection('build-revnet-fees', '11. REVNET FEES', [
    'Cash outs from revnets with a cash out tax rate > 0% incur two fees:',
  ], [
    stepList([
      '2.5% protocol fee — taken from the reclaimed value by JBMultiTerminal, sent to the Juicebox protocol’s project',
      '2.5% revnet fee — taken from the token count by REVOwner, sent to the revnet fee project',
    ]),
    textBlock('The protocol fee is on the value reclaimed (ETH/tokens out). The revnet fee is on the token count burned (project tokens). These are different bases.')
  ]));

  // --- Ecosystem Tools ---

  var ecoHeader = document.createElement('div');
  ecoHeader.className = 'guide-part-header';
  ecoHeader.textContent = 'ECOSYSTEM TOOLS';
  wrap.appendChild(ecoHeader);

  wrap.appendChild(guideSection('build-permissions', '12. PERMISSIONS', [
    'Grant fine-grained access to other addresses with JBPermissions. Each permission is a bit in a 256-bit field.'
  ], [
    codeBlock(
      'JBPermissions.setPermissionsFor',
      'setPermissionsFor(\n' +
      '  account,         // the address granting permission\n' +
      '  permissionsData  // { operator, projectId, permissionIds[] }\n' +
      ')\n' +
      '// projectId = 0 is the wildcard: every project `account` controls on this chain'
    ),
    fnRefTable('CHECKING PERMISSIONS', [
      ['JBPermissions.hasPermission(operator, account, projectId, permissionId, includeRoot, includeWildcard)', 'Check a single permission'],
      ['JBPermissions.hasPermissions(operator, account, projectId, permissionIds[], includeRoot, includeWildcard)', 'Check multiple permissions at once'],
      ['JBPermissions.WILDCARD_PROJECT_ID()', 'Returns 0 — the wildcard project ID'],
    ]),
    propertyTable('PERMISSION IDS', [
      ['1 - ROOT', 'Grants all permissions. Use with extreme care.'],
      ['2 - QUEUE_RULESETS', 'Queue new rulesets for the project.'],
      ['3 - LAUNCH_RULESETS', 'Launch the project’s first rulesets.'],
      ['4 - CASH_OUT_TOKENS', 'Cash out (redeem) project tokens on a holder’s behalf.'],
      ['5 - SEND_PAYOUTS', 'Trigger payout distributions.'],
      ['6 - MIGRATE_TERMINAL', 'Migrate funds to a new terminal.'],
      ['7 - SET_PROJECT_URI', 'Update project metadata.'],
      ['8 - DEPLOY_ERC20', 'Deploy the project’s ERC-20 token.'],
      ['9 - SET_TOKEN', 'Set a custom token for the project.'],
      ['10 - MINT_TOKENS', 'Mint tokens on-demand.'],
      ['11 - BURN_TOKENS', 'Burn tokens from another holder.'],
      ['12 - CLAIM_TOKENS', 'Claim credits into ERC-20 tokens for a holder.'],
      ['13 - TRANSFER_CREDITS', 'Transfer a holder’s unclaimed credits.'],
      ['14 - SET_CONTROLLER', 'Change the project controller.'],
      ['15 - SET_TERMINALS', 'Set the project’s terminals.'],
      ['16 - ADD_TERMINALS', 'Add terminals to the project.'],
      ['17 - SET_PRIMARY_TERMINAL', 'Set the primary terminal for a token.'],
      ['18 - USE_ALLOWANCE', 'Withdraw surplus via the surplus allowance.'],
      ['19 - SET_SPLIT_GROUPS', 'Modify payout and reserved token splits.'],
      ['20 - ADD_PRICE_FEED', 'Add a price feed for a currency pair.'],
      ['21 - ADD_ACCOUNTING_CONTEXTS', 'Add accounting contexts (accepted tokens) to a terminal.'],
      ['22 - SET_TOKEN_METADATA', 'Set the project token’s name and symbol.'],
      ['23 - SIGN_FOR_ERC20', 'Sign ERC-20 permit approvals on the project’s behalf.'],
      ['24 - ADJUST_721_TIERS', 'Add or remove tiers on a 721 hook.'],
      ['25 - SET_721_METADATA', 'Update a 721 hook’s metadata (base URI, resolver, contract URI).'],
      ['26 - MINT_721', 'Mint NFTs directly, without a payment.'],
      ['27 - SET_721_DISCOUNT_PERCENT', 'Set the 721 hook’s discount percent.'],
      ['28 - SET_BUYBACK_TWAP', 'Set the buyback hook’s TWAP window.'],
      ['29 - SET_BUYBACK_POOL', 'Set the buyback hook’s Uniswap pool.'],
      ['30 - SET_BUYBACK_HOOK', 'Set which buyback hook the registry routes the project to.'],
      ['31 - SET_ROUTER_TERMINAL', 'Configure the project’s router terminal.'],
      ['32 - MAP_SUCKER_TOKEN', 'Map a token across a sucker pair.'],
      ['33 - DEPLOY_SUCKERS', 'Deploy cross-chain suckers for the project.'],
      ['34 - SET_SUCKER_PEER', 'Set a sucker’s cross-chain peer.'],
      ['35 - SUCKER_SAFETY', 'Emergency token recovery on a sucker.'],
      ['36 - SET_SUCKER_DEPRECATION', 'Deprecate a sucker.'],
      ['37 - OPEN_LOAN', 'Open a REVLoans loan against project tokens.'],
      ['38 - REALLOCATE_LOAN', 'Move collateral between loans. Also borrows the full current capacity.'],
      ['39 - REPAY_LOAN', 'Repay a loan on a holder’s behalf.'],
    ]),
    infoBox('Permissions are per-operator, per-project. Granting QUEUE_RULESETS to address X for project 5 doesn’t give X any access to project 6.')
  ]));

  wrap.appendChild(guideSection('build-nfts', '13. NFT TIERS', [
    'Deploy tiered NFTs as pay hooks using JB721TiersHook. Payers pick tiers in the pay metadata and receive the NFTs their payment covers.'
  ], [
    codeBlock(
      'JB721TiersHookProjectDeployer.launchProjectFor',
      'launchProjectFor(\n' +
      '  owner,\n' +
      '  deployTiersHookConfig,    // NFT name, symbol, tiers[]\n' +
      '  launchProjectConfig,      // standard project config\n' +
      '  controller,\n' +
      '  salt                      // CREATE2 salt for a deterministic hook address (0 for none)\n' +
      ')\n' +
      '// Always use this deployer, even with empty tiers'
    ),
    propertyTable('TIER CONFIGURATION', [
      ['price', 'What one NFT of this tier costs.'],
      ['initialSupply', 'Max NFTs available. Must be at least 1; capped at 999,999,999. 0 is rejected.'],
      ['category', 'Grouping ID. Tiers MUST be sorted by category (ascending).'],
      ['reserveFrequency', 'Mint 1 reserved NFT every N minted.'],
      ['reserveBeneficiary', 'Who receives reserved NFTs.'],
      ['votingUnits', 'Governance weight (via JB721Checkpoints). Applies only when the tier’s flags.useVotingUnits is set — otherwise voting power tracks the tier price.'],
      ['encodedIpfsUri', 'IPFS content hash for metadata.'],
      ['flags.cantBeRemoved', 'If true, tier is permanent (one of the nested flags: allowOwnerMint, useVotingUnits, transfersPausable, cantBeRemoved, …).'],
    ]),
    fnRefTable('READING NFT STATE', [
      ['JB721TiersHookStore.tiersOf(hook, categories[], includeResolvedUri, startId, size)', 'List tiers with optional filters'],
      ['JB721TiersHookStore.tierOf(hook, tierId, includeResolvedUri)', 'Single tier details'],
      ['JB721TiersHook.balanceOf(owner)', 'NFTs held by an address'],
      ['JB721TiersHook.cashOutWeightOf(tokenIds[])', 'Cash out weight of specific NFTs (divide by totalCashOutWeight() for the surplus fraction)'],
    ]),
    infoBox('Tiers are sorted by CATEGORY, not price. The contract reverts with InvalidCategorySortOrder if submitted out of order.')
  ]));

  wrap.appendChild(guideSection('build-hooks', '14. CUSTOM HOOKS', [
    'Build custom logic that executes at key moments in the payment lifecycle. Hooks are the primary extension mechanism.'
  ], [
    propertyTable('HOOK INTERFACES', [
      ['IJBRulesetDataHook', 'Intercepts pay and cash out BEFORE state changes. Can override the weight (pay) or the cash out tax rate / effective counts (cash out), and specify pay and cash out hook specifications.'],
      ['IJBPayHook', 'Called AFTER payment recorded and tokens minted. Use for rewards, notifications, side effects.'],
      ['IJBCashOutHook', 'Called AFTER tokens burned and funds transferred. Use for cleanup, analytics, conditional logic.'],
      ['IJBSplitHook', 'Called when a split routes funds to a hook address. Use for auto-investing, compounding, forwarding.'],
      ['IJBRulesetApprovalHook', 'Gates queued rulesets. Must return APPROVED before a queued ruleset can activate.'],
    ]),
    codeBlock(
      'IJBPayHook interface',
      'function afterPayRecordedWith(\n' +
      '  JBAfterPayRecordedContext calldata context\n' +
      ') external payable;\n' +
      '\n' +
      '// context includes:\n' +
      '//   payer, projectId, rulesetId, amount,\n' +
      '//   forwardedAmount, weight, newlyIssuedTokenCount,\n' +
      '//   beneficiary, hookMetadata, payerMetadata'
    ),
    infoBox('Data hooks run BEFORE state changes and can override values. Pay and cash out hooks run AFTER and are for side effects only.')
  ]));

  wrap.appendChild(guideSection('build-distributor', '15. DISTRIBUTOR', [
    'JBDistributor is an optional, project-deployed add-on (not part of the core protocol deployment). It distributes ERC-20 rewards to stakers in time-based rounds with linear vesting. Two implementations exist: JBTokenDistributor (for IJBActiveVotes token holders, e.g. a Juicebox JBERC20) and JB721Distributor (for NFT holders).',
    'The distributor is funded via split hooks or direct deposits. Each round, a snapshot captures the distributable balance. Stakers claim their pro-rata share, which vests linearly over a configured number of rounds.'
  ], [
    fnRefTable('CORE FUNCTIONS', [
      ['fund(hook, token, amount)', 'Directly deposit reward tokens for a specific hook’s staker pool'],
      ['beginVesting(hook, tokenIds[], tokens[])', 'Snapshot and begin vesting for the specified token IDs'],
      ['collectVestedRewards(hook, tokenIds[], tokens[], beneficiary)', 'Collect unlocked vested tokens (auto-vests current round too)'],
      ['releaseForfeitedRewards(hook, tokenIds[], tokens[], beneficiary)', 'Return unvested rewards from burned tokens to the pool'],
      ['poke()', 'Record the snapshot block for the current round early'],
    ]),
    fnRefTable('READ STATE', [
      ['balanceOf(hook, token)', 'Balance held for a hook’s staker pool'],
      ['collectableFor(hook, tokenId, token)', 'How much is unlocked and ready to collect right now'],
      ['claimedFor(hook, tokenId, token)', 'Total uncollected amount (vesting + vested-but-uncollected)'],
      ['currentRound()', 'The current round number'],
      ['roundSnapshotBlock(round)', 'The block number used for stake weight lookups'],
    ]),
    infoBox('A holder’s stake comes from IVotes.getPastVotes() (token distributors) or tier voting units (721 distributors). The TOTAL-stake denominator uses IJBActiveVotes.getPastTotalActiveVotes — which excludes undelegated balances (e.g. AMM-held tokens), so holders must delegate (even to themselves) to count. Rewards are proportional to active stake at the snapshot block.')
  ]));

  wrap.appendChild(guideSection('build-handles', '16. PROJECT HANDLES', [
    'JBProjectHandles maps ENS names to Juicebox project IDs using bidirectional verification. Anyone can propose a handle, but only verified ones (where the ENS text record matches) are returned by handleOf().',
    'All functions take a chainId parameter — handles are chain-aware. Storage is keyed by the setter address, so multiple addresses can propose different handles for the same project.'
  ], [
    fnRefTable('HANDLE FUNCTIONS', [
      ['setEnsNamePartsFor(chainId, projectId, parts[])', 'Associate ENS name parts with a project. Anyone can call this — no access control.'],
      ['ensNamePartsOf(chainId, projectId, setter)', 'Get the stored name parts as set by a specific setter address.'],
      ['handleOf(chainId, projectId, setter)', 'Returns the verified handle string, or empty if ENS text record doesn’t match.'],
      ['TEXT_KEY', 'The ENS text record key: "juicebox". Expected value: "{chainId}:{projectId}".'],
    ]),
    textBlock('Name parts are in reverse order. handleOf returns the dot-joined labels without a .eth suffix; the suffix is only added when computing the namehash for verification. `_formatHandle` (JBProjectHandles.sol:220-232) walks the array from the LAST element to the first, so the innermost label goes last. For "myproject.eth" → ["myproject"]. For "sub.myproject.eth" → ["myproject", "sub"]. Parts cannot contain dots, ASCII control characters, DEL, "eth", or be empty. Unicode normalization (ENSIP-15) is the caller/client’s responsibility, not the contract’s.')
  ]));

  wrap.appendChild(guideSection('build-payer', '17. PAYER ADDRESS', [
    'A JBProjectPayer address is deployed as a minimal proxy (clone). The constructor takes only a JBDirectory address. After deployment, defaults are set via initialize() or setDefaultValues().',
    'The receive path accepts the native token (ETH) only. When defaultAddToBalance is false, incoming native ETH triggers pay() — minting tokens for the beneficiary. When true, funds are added via addToBalanceOf() without minting. The beneficiary defaults to msg.sender if not configured. ERC-20 payments must call pay() or addToBalanceOf() after approval; direct ERC-20 transfers do not trigger either path.'
  ], [
    codeBlock(
      'JBProjectPayer defaults',
      '// Set via initialize() after clone deployment:\n' +
      'defaultProjectId       // which project to forward to\n' +
      'defaultBeneficiary     // who gets the tokens (0 = msg.sender)\n' +
      'defaultMemo            // attached to each payment\n' +
      'defaultMetadata        // extra data for hooks\n' +
      'defaultAddToBalance    // false = pay(), true = addToBalance()\n' +
      '\n' +
      '// Anyone sends ETH to the payer address:\n' +
      '//   → receive() fires\n' +
      '//   → looks up DIRECTORY.primaryTerminalOf(projectId, token)\n' +
      '//   → calls pay() or addToBalanceOf() with defaults'
    ),
    infoBox('Terminal lookup happens at payment time via JBDirectory, so the payer address automatically follows terminal migrations without reconfiguration.')
  ]));

  wrap.appendChild(guideSection('build-swap-terminal', '18. ROUTER TERMINAL', [
    'JBRouterTerminal is a universal payment terminal: it accepts any token and automatically converts it into whatever token the destination project accepts, then forwards the result to that project’s primary terminal. It’s a pass-through — it never holds a balance.',
    'There is no fixed output token. For each payment, a JBPayRouteResolver evaluates every token the destination project accepts and picks the route that yields the most project tokens for the payer — choosing among direct forwarding, a Uniswap V3 or V4 swap, a recursive cash out of JB tokens, or a combination. Pools and routes are discovered automatically, not configured per project.'
  ], [
    fnRefTable('ROUTER TERMINAL FUNCTIONS', [
      ['pay(...)', 'Same IJBTerminal interface as JBMultiTerminal — resolves the best route, converts the input, then calls pay() on the destination terminal.'],
      ['addToBalanceOf(...)', 'Same as pay() but forwards via addToBalanceOf() on the destination terminal (no token minting).'],
      ['previewPayFor(...)', 'Preview the chosen route and expected output for a payment without executing it.'],
      ['bestPoolLiquidityOf(tokenA, tokenB)', 'Report the deepest-liquidity Uniswap pool the router would use for a pair.'],
    ]),
    textBlock('The router is reached through JBRouterTerminalRegistry, which is what a project adds to JBDirectory alongside JBMultiTerminal; the registry resolves to JBRouterTerminal. Routing is internal (JBPayRouteResolver) — there is no per-project pool configuration.')
  ]));

  wrap.appendChild(guideSection('build-buyback', '19. BUYBACK HOOK', [
    'JBBuybackHook compares the mint price against a Uniswap V4 pool price and routes payments (and cash outs) to whichever gives better value. Slippage tolerance defaults to a TWAP-based sigmoid; a payer can override it with a quote and minimum in the pay metadata.',
  ], [
    codeBlock(
      'JBBuybackHook configuration',
      '// Set up the buyback hook with a Uniswap V4 pool\n' +
      'JBBuybackHook.setPoolFor(\n' +
      '  projectId,\n' +
      '  fee,              // Uniswap pool fee tier\n' +
      '  tickSpacing,      // pool tick spacing\n' +
      '  twapWindow,       // TWAP observation window (seconds)\n' +
      '  terminalToken     // the terminal token to route\n' +
      ')\n' +
      '// The pool key is once-only; the TWAP window stays mutable via setTwapWindowOf\n' +
      '// Requires SET_BUYBACK_POOL permission'
    ),
    diagram('BUYBACK DECISION FLOW', [
      '  payment arrives',
      '     │',
      '     ▼',
      '  query TWAP oracle for market price',
      '     │',
      '     ├─ pool gives more tokens than minting',
      '     │  └─▶ swap on Uniswap V4, mint any unswapped remainder',
      '     │',
      '     └─ minting gives equal or more tokens',
      '        └─▶ normal mint flow (weight × amount)',
    ]),
    infoBox('The hook also handles cash outs: if the pool offers more than the bonding curve reclaim (after fees), it routes the sell through the pool instead. Payers can bypass the TWAP by providing their own quote in payment metadata.')
  ]));

  // --- Build Your Own ---
  var ownHeader = document.createElement('div');
  ownHeader.className = 'guide-part-header';
  ownHeader.textContent = 'BUILD YOUR OWN';
  wrap.appendChild(ownHeader);

  wrap.appendChild(guideSection('build-bendystraw', '20. INDEXED DATA (BENDYSTRAW)', [
    'Bendystraw is the Juicebox indexer: a Ponder service that watches every V6 contract on every supported chain and serves the results over GraphQL. It is how this site lists projects, draws activity feeds and price charts, ranks trending projects, and reads LP positions — none of which are practical to assemble from RPC calls at page-load speed.',
    'Use it for anything a person reads. Use the chain for anything a wallet signs: re-read balances, rulesets, allowances, and quotes onchain right before building a transaction. The index can lag the chain by a few blocks, and a lagging index looks like empty data, not an error.'
  ], [
    fnRefTable('ENDPOINTS', [
      ['https://bendystraw.up.railway.app/graphql', 'Mainnets: Ethereum, Optimism, Base, Arbitrum. No API key needed'],
      ['https://testnet.bendystraw.xyz/graphql', 'Testnets: Sepolia and the L2 Sepolias'],
      ['…/schema', 'A playground with the schema explorer; POST an introspection query to the graphql URL for codegen (same schema on both databases)'],
    ]),
    codeBlock(
      'A first query',
      'POST https://bendystraw.up.railway.app/graphql\n' +
      '{\n' +
      '  projects(where: { chainId: 8453, version: 6 }, orderBy: "balance", orderDirection: "desc", limit: 10) {\n' +
      '    items { projectId chainId name balance suckerGroupId }\n' +
      '    totalCount\n' +
      '  }\n' +
      '}'
    ),
    fnRefTable('WHAT TO ASK IT FOR', [
      ['projects / project(chainId, projectId)', 'Name, metadata URI, balance, token, owner, and the sucker group that links its chains'],
      ['payEvents, cashOutTokensEvents, activityEvents', 'The feed behind any project page; filter by projectId or suckerGroupId'],
      ['participants', 'Token holders and their balances, per project or per sucker group'],
      ['buybackPools, swapEvents, buybackPoolPositions', 'The AMM: pool identity, every trade’s post-trade price, and every LP range'],
      ['loans, borrowLoanEvents', 'Revnet loans and their collateral'],
      ['nftTiers, mintNftEvents', '721 shop tiers and purchases'],
      ['suckerTransactions', 'Cross-chain moves and where each one is in its lifecycle'],
    ]),
    stepList([
      'Every V6 row is versioned: filter with version: 6, and key a project by chainId + projectId, never projectId alone — the same number exists on every chain.',
      'Numeric arguments on singular queries are Float!, not Int! (Ponder’s choice). Declare variables as Float! or the request fails validation with no data.',
      'Lists page with limit and offset and return totalCount; loop until you have them all rather than trusting one page.',
      'suckerGroupId is as-of-event: when chains are linked later, old event rows keep the group id they were written with. Query by every project in the group when you need the full history.',
      'The SDK’s requestBendystraw(endpoint, query, variables) handles the POST, error surfacing, and endpoint normalisation; selectBendystrawEndpoint picks mainnet vs testnet from a chainId.',
    ]),
    infoBox('Building with an agent? The /jb-bendystraw skill in the Juicebox V6 skills library carries the schema, the query patterns above, and the gotchas — hand it over before asking for a feed, chart, or holder table. Source: github.com/peripheralist/bendystraw.')
  ]));

  wrap.appendChild(guideSection('build-clients', '21. BUILD FROM THIS CLIENT', [
    'Juicebox Money is a production V6 client you can study, fork, or use as a reference for your own product. Its Next.js interface combines server-assisted indexing and IPFS services with wallet flows that build and verify Juicebox transactions from the current V6 contracts.',
    'Treat each working flow as an implementation example, not a black box. The project, account, shop, and create surfaces show how product interactions map to indexed reads, fresh onchain checks, transaction builders, ABI round trips, and clear signing previews. Give the relevant source and tests to your coding agent when you want to reuse one of those patterns.'
  ], [
    stepList([
      'Start from the product flow closest to yours — such as Pay, Cash Out, project creation, ruleset editing, or the Shop — and identify its component, supporting reads, and transaction builder.',
      'Give your coding agent that source, its tests, this guide’s deep link, the current V6 contract repository below, and the Juicebox V6 skills library (github.com/mejango/juicebox-skills) — a Claude Code plugin whose skills carry the addresses, ABIs, fee math, and transaction-safety rules so the agent does not reconstruct them from memory.',
      'Keep indexed data for fast discovery and display, but re-read signing-critical state onchain immediately before building and submitting a transaction.',
      'Reuse the pure transaction-builder and ABI round-trip pattern, then add product-specific invariants and browser tests before asking a wallet to sign.'
    ]),
    (function () {
      var box = document.createElement('p'); box.className = 'guide-text';
      box.appendChild(document.createTextNode('Reference: '));
      var lk = function (href, text) { var a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = text; return a; };
      box.appendChild(lk('https://github.com/mejango/juicebox-money', 'Juicebox Money’s repo (source + tests)'));
      box.appendChild(document.createTextNode(' and '));
      box.appendChild(lk('https://github.com/Bananapus/version-6', 'V6 contracts (version-6)'));
      box.appendChild(document.createTextNode('.'));
      return box;
    })(),
    (function () {
      var p = document.createElement('p'); p.className = 'guide-text';
      p.textContent = 'Use the app as a product reference and the repository as the implementation reference. Server routes improve indexing, search, media, and transaction preparation; signing remains explicit, and each wallet-bound action is decoded and checked against the V6 ABI before submission.';
      return p;
    })()
  ]));

  container.appendChild(wrap);
  initSmoothScroll(container);
}

// Wants version — the "Why?" page as the answer to "what do project owners
// actually want?". Opens with a single setup paragraph, then a list of
// "They want…" beats culminating in the closer: earn money on their terms.
export function renderWhyTab() {
  var container = document.getElementById('tab-why');
  if (!container) return;
  container.innerHTML = '';

  var wrap = document.createElement('div');
  wrap.className = 'guide-wrap why-wrap why-wants';

  var hero = document.createElement('div');
  hero.className = 'why-hero';

  var kicker = document.createElement('div');
  kicker.className = 'why-kicker';
  kicker.textContent = 'WHY JUICEBOX?';
  hero.appendChild(kicker);

  var title = document.createElement('div');
  title.className = 'why-title';
  title.textContent = 'What open source businesses, campaigns, and indie projects actually want:';
  hero.appendChild(title);

  wrap.appendChild(hero);

  var wants = [
    'They want to receive payments wherever and however people want to pay them, and issue their unified, programmable, tokenized assets wherever their users want them, in real time, without managerial overhead.',
    'They want to give their community strong guarantees that assets are backed by the full project’s revenues and raises across networks, and can be programmed to do anything else they wish.',
    'They want to use common pay and cash out functions that let any platform facilitate more flow of money to them, including their own websites. No lock-in.',
    'They want the choice to start their rules open-ended and flexible, evolving as their needs change, and locking for strong guarantees whenever they choose.',
    'They want to operate openly and predictably so they remain auditable by anyone and continue to earn their community’s trust under increased scrutiny over time.',
    'They want to be sure they can keep operating their own money forever, without the powers that be getting in the way.',
    'They want to pay a fee sufficient to feed a healthy, growing, supportive payment network that powers their endeavor without being extractive.',
    'They want certainty that the price they agree to pay for their financial services cannot change on them under any circumstances or by anyone’s discretion.',
    'They want to be acknowledged as customers with real needs, and as investors rewarded for playing a part in helping the payments ecosystem they chose grow by virtue of their usage.',
    'They want to leverage AI acceleration to build more freely and openly with increased security, and without siloing themselves in their own corner of the internet.',
    'They want to be able to fully audit the money system they choose with their own eyes and their own AIs.',
    'They want the freedom to earn their money, on their terms.'
  ];

  var list = document.createElement('div');
  list.className = 'why-wants-list';
  for (var i = 0; i < wants.length; i++) {
    var w = document.createElement('p');
    w.className = 'why-want';
    w.textContent = wants[i];
    list.appendChild(w);
  }
  wrap.appendChild(list);

  container.appendChild(wrap);
}

// --- Helper builders ---

// A small link icon next to a section header that copies a deep link to that section (paste to an LLM).
function sectionLinkButton(id) {
  var btn = document.createElement('button');
  btn.className = 'guide-copy-link';
  btn.type = 'button';
  btn.title = 'Copy a link to this section';
  btn.setAttribute('aria-label', 'Copy link to this section');
  btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
  btn.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    var url = location.origin + location.pathname + location.search + '#' + id;
    var ok = function () { btn.classList.add('guide-copy-link--ok'); btn.title = 'Copied'; setTimeout(function () { btn.classList.remove('guide-copy-link--ok'); btn.title = 'Copy a link to this section'; }, 1300); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(ok, ok);
    else { try { var ta = document.createElement('textarea'); ta.value = url; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); } catch (_) {} ok(); }
  });
  return btn;
}

function guideSection(id, title, paragraphs, extras) {
  var section = document.createElement('div');
  section.className = 'guide-section';
  section.id = id;

  var h = document.createElement('h2');
  h.className = 'guide-section-title';
  var titleSpan = document.createElement('span');
  titleSpan.textContent = title;
  h.appendChild(titleSpan);
  // Copy a deep link to this section — paste it to an LLM ("recreate this feature against the V6 contracts")
  // or share it. The link routes back to this tab + scrolls here (see applyHash in app.js).
  h.appendChild(sectionLinkButton(id));
  section.appendChild(h);

  for (var i = 0; i < paragraphs.length; i++) {
    var p = document.createElement('p');
    p.className = 'guide-text';
    p.textContent = paragraphs[i];
    section.appendChild(p);
  }

  if (extras) {
    for (var j = 0; j < extras.length; j++) {
      section.appendChild(extras[j]);
    }
  }

  return section;
}

function diagram(label, lines) {
  var el = document.createElement('div');
  el.className = 'guide-diagram';
  // Diagrams scroll horizontally on narrow screens. Make that viewport
  // keyboard-reachable instead of trapping the content behind touch input.
  el.tabIndex = 0;
  var title = document.createElement('div');
  title.className = 'guide-diagram-title';
  title.textContent = label;
  el.appendChild(title);
  var pre = document.createElement('pre');
  pre.className = 'guide-diagram-pre';
  pre.textContent = lines.join('\n');
  el.appendChild(pre);
  return el;
}

function propertyTable(label, rows) {
  var el = document.createElement('div');
  el.className = 'guide-prop-table';
  if (label) {
    var title = document.createElement('div');
    title.className = 'guide-prop-title';
    title.textContent = label;
    el.appendChild(title);
  }
  for (var i = 0; i < rows.length; i++) {
    var row = document.createElement('div');
    row.className = 'guide-prop-row';
    var name = document.createElement('code');
    name.className = 'guide-prop-name';
    name.textContent = rows[i][0];
    var desc = document.createElement('span');
    desc.className = 'guide-prop-desc';
    desc.textContent = rows[i][1];
    row.appendChild(name);
    row.appendChild(desc);
    el.appendChild(row);
  }
  return el;
}

function fnRefTable(label, rows) {
  var el = document.createElement('div');
  el.className = 'guide-fn-table';
  if (label) {
    var title = document.createElement('div');
    title.className = 'guide-fn-title';
    title.textContent = label;
    el.appendChild(title);
  }
  for (var i = 0; i < rows.length; i++) {
    var row = document.createElement('div');
    row.className = 'guide-fn-row';
    var fn = document.createElement('code');
    fn.className = 'guide-fn-name';
    fn.textContent = rows[i][0];
    var desc = document.createElement('span');
    desc.className = 'guide-fn-desc';
    desc.textContent = rows[i][1];
    row.appendChild(fn);
    row.appendChild(desc);
    el.appendChild(row);
  }
  return el;
}

function codeBlock(label, code) {
  var el = document.createElement('div');
  el.className = 'guide-code';
  // Long examples scroll horizontally at phone widths; expose that scroll
  // region to keyboard and assistive-technology users as well.
  el.tabIndex = 0;
  if (label) {
    var title = document.createElement('div');
    title.className = 'guide-code-title';
    title.textContent = label;
    el.appendChild(title);
  }
  var pre = document.createElement('pre');
  pre.className = 'guide-code-pre';
  pre.textContent = code;
  el.appendChild(pre);
  return el;
}

function infoBox(text) {
  var el = document.createElement('div');
  el.className = 'guide-info';
  el.textContent = text;
  return el;
}

function textBlock(text) {
  var p = document.createElement('p');
  p.className = 'guide-text';
  p.textContent = text;
  return p;
}

function stepList(items) {
  var el = document.createElement('div');
  el.className = 'guide-steps';
  for (var i = 0; i < items.length; i++) {
    var step = document.createElement('div');
    step.className = 'guide-step';
    var num = document.createElement('span');
    num.className = 'guide-step-num';
    num.textContent = (i + 1);
    var text = document.createElement('span');
    text.className = 'guide-step-text';
    text.textContent = items[i];
    step.appendChild(num);
    step.appendChild(text);
    el.appendChild(step);
  }
  return el;
}

function initSmoothScroll(container) {
  container.querySelectorAll('.guide-toc-link').forEach(function(link) {
    link.addEventListener('click', function(e) {
      e.preventDefault();
      var targetId = link.getAttribute('href').slice(1);
      var target = document.getElementById(targetId);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
}
