/** @type {import('next').NextConfig} */
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=()',
  },
]

module.exports = {
  // Verification builds set NEXT_DIST_DIR so they never clobber the dev
  // server's .next; unset means the normal default.
  distDir: process.env.NEXT_DIST_DIR || '.next',
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
    remotePatterns: [
      { protocol: 'https', hostname: 'ipfs.io' },
      { protocol: 'https', hostname: '*.infura-ipfs.io' },
    ],
  },
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }]
  },
}
