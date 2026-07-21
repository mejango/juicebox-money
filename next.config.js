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
  // Keep development and production artifacts separate. Running `next build`
  // while the dev server is active otherwise leaves their webpack chunks
  // mixed together and causes intermittent MODULE_NOT_FOUND errors.
  distDir:
    process.env.NEXT_DIST_DIR ||
    (phase === PHASE_DEVELOPMENT_SERVER ? '.next-dev' : '.next'),
  reactStrictMode: true,
  poweredByHeader: false,
  webpack: (config, { webpack }) => {
    // Para dynamically imports optional peers we don't use (Farcaster
    // mini-apps, Cosmos + Solana wallets); resolve them to empty modules.
    // Only the EVM connector is configured, so these paths never execute.
    config.resolve.alias['@farcaster/miniapp-sdk'] = false
    config.resolve.alias['@farcaster/miniapp-wagmi-connector'] = false
    config.resolve.alias['@getpara/cosmos-wallet-connectors'] = false
    config.resolve.alias['@getpara/solana-wallet-connectors'] = false
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
    minimumCacheTTL: 60 * 60 * 24 * 30,
    remotePatterns: [
      { protocol: 'https', hostname: 'ipfs.io' },
      { protocol: 'https', hostname: '*.infura-ipfs.io' },
    ],
  },
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }]
  },
})
