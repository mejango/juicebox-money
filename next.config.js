/** @type {import('next').NextConfig} */
const { PHASE_DEVELOPMENT_SERVER } = require('next/constants')

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=()',
  },
]

module.exports = phase => ({
  // Emit a self-contained server tree for the production OCI image. Keep
  // tracing rooted here because the monorepo parent also has a lockfile.
  output: 'standalone',
  outputFileTracingRoot: __dirname,
  // Keep development and production artifacts separate. Running `next build`
  // while the dev server is active otherwise leaves their webpack chunks
  // mixed together and causes intermittent MODULE_NOT_FOUND errors.
  distDir:
    process.env.NEXT_DIST_DIR ||
    (phase === PHASE_DEVELOPMENT_SERVER ? '.next-dev' : '.next'),
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // Preserve the SDK's ergonomic barrels while compiling client routes from
    // the narrow v6 modules they actually use.
    optimizePackageImports: ['@bananapus/nana-sdk-core'],
  },
  // `page.browsertest.tsx` files are routes ONLY in the deterministic browser
  // build the Playwright suite compiles. They never reach a production image:
  // without the extra extension Next does not treat the file as a route at
  // all, so nothing is emitted and nothing is reachable.
  pageExtensions:
    process.env.NEXT_PUBLIC_DETERMINISTIC_BROWSER === 'true'
      ? ['tsx', 'ts', 'jsx', 'js', 'browsertest.tsx']
      : ['tsx', 'ts', 'jsx', 'js'],
  webpack: (config, { webpack }) => {
    // Para dynamically imports optional peers we don't use (Farcaster
    // mini-apps, Cosmos + Solana wallets); resolve them to empty modules.
    // Only the EVM connector is configured, so these paths never execute.
    config.resolve.alias['@farcaster/miniapp-sdk'] = false
    config.resolve.alias['@farcaster/miniapp-wagmi-connector'] = false
    config.resolve.alias['@getpara/cosmos-wallet-connectors'] = false
    config.resolve.alias['@getpara/evm-wallet-connectors'] = false
    config.resolve.alias['@getpara/solana-wallet-connectors'] = false
    // Para's Wagmi bridge imports the connector barrel for `injected`. Wagmi 3
    // deliberately makes the barrel's vendor SDKs optional, so resolve that
    // import to core's public connector export instead of requiring unused
    // Coinbase, WalletConnect, Safe, Tempo, and Porto peers.
    config.resolve.alias['wagmi/connectors$'] = '@wagmi/core'
    // Other optional integrations referenced by lazy Para modules are unused.
    config.resolve.alias['@x402/core'] = false
    config.resolve.alias['@x402/evm'] = false
    config.resolve.alias['@x402/svm'] = false
    config.resolve.alias['@react-native-async-storage/async-storage'] = false
    config.resolve.alias['pino-pretty'] = false
    for (const provider of [
      'alchemy',
      'biconomy',
      'cdp',
      'gelato',
      'pimlico',
      'porto',
      'rhinestone',
      'safe',
      'thirdweb',
      'zerodev',
    ]) {
      config.resolve.alias[`@getpara/aa-${provider}`] = false
    }
    // @coinbase/wallet-sdk's HeartbeatWorker ends in `export {}`, which the
    // minifier rejects in a classic worker script. Use our vendored copy
    // (identical, minus the module marker).
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(
        /[\\/]HeartbeatWorker(\.js)?$/,
        require('path').resolve(__dirname, 'src/vendor/HeartbeatWorker.js'),
      ),
    )
    return config
  },
  images: {
    // Project media is content-addressed (IPFS), so optimized variants can be
    // cached aggressively. Bundled artwork uses hashed static imports and is
    // served immutable independently of this TTL.
    minimumCacheTTL: 60 * 60 * 24 * 365,
    remotePatterns: [
      { protocol: 'https', hostname: 'ipfs.io' },
      { protocol: 'https', hostname: 'gateway.pinata.cloud' },
      { protocol: 'https', hostname: 'dweb.link' },
    ],
  },
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }]
  },
})
