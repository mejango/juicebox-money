# First payment examples

These files are served directly and displayed verbatim in `/build/first-payment`.
Edit them here so the tutorial and downloads stay in sync.

The read example uses Base Sepolia project 1 by default. The simulation example
uses the same project, native test ETH, a public payer address, and a 1% minimum
output tolerance. Neither script signs or broadcasts. Do not add private-key
handling or a write command to these examples.

## Check the example

Use Node.js 22 or newer and the pinned package versions:

```sh
npm install --save-exact @bananapus/nana-sdk-core@2.3.2 viem@2.55.19
node read-project.mjs
JB_PAYER=0xYourPublicWalletAddress node preview-payment.mjs
```

Set `BASE_SEPOLIA_RPC_URL` to override the public read gateway. `JB_PROJECT_ID`
can select another project on that network. A failed read is not evidence of an
empty project; keep it as a failed observation.

Before changing dependency versions or the sample identity, run both scripts and
check the chain, controller, ruleset, terminal, minimum output, and decoded call.
Update the tutorial's verification note with the package versions and observed
block. Never turn a simulation into a claim of signed execution. The guided app
payment must refresh and review its own request.

The app's guide browser tests cover the tutorial at narrow and desktop widths,
including keyboard navigation and reading without JavaScript. Center's inspection
route follows the same published Juicescan deployment as its directory; deploy
the new Center route before publishing links that depend on it.
