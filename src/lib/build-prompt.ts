export const PLATFORM_BUILD_PROMPT = `I want to build a product or platform on Juicebox V6.

My product: [describe the users, the value they exchange, and the experience I want].

Help me design and build it. Read https://juicebox.money/learn and https://juicebox.money/build, then inspect the current Juicebox V6 source and contracts. Use the Juicebox V6 skills library (https://github.com/mejango/juicebox-skills) to help explain anything Juicebox. In Claude Code, install it with /plugin marketplace add mejango/juicebox-skills, then /plugin install juicebox-v6@juicebox. Use current V6 repositories; protocol repo names end in -v6.

Start with the smallest working product. Explain ideas in plain words before naming technical terms, and link to the Learn glossary. Choose a flexible Juicebox project, a revnet whose core economic terms are set at launch, or both. Map each needed user action to the V6 contracts that handle it. Add extensions or support for more chains only when the product needs them.

For each transaction, show what it does, what it costs, who receives funds or tokens, and the minimum amount I will receive. Then identify the contract, function, arguments, units, required permissions and token approvals. Refresh the relevant chain data before signing. Use current V6 software-library builders where available, check them against deployed contracts, and verify that encoding and decoding the request preserves every field. Show me the exact request and explain its effect before asking me to sign. Keep the full explanation of protocol fees at https://juicebox.money/learn#learn-fees.

Deliver the user journey, the contracts needed, what can go wrong and who has control, a step-by-step plan, meaningful tests, and one complete working feature. Keep the interface focused on my product. Juicebox provides the shared contracts beneath it.`
