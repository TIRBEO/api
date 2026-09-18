/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  // @tirbeo/* packages ship TypeScript source (no prebuilt dist) — Next must
  // compile them, same as the other file:- workspace packages.
  transpilePackages: ['@tirbeo/pusher', '@tirbeo/types'],
  serverExternalPackages: ['ioredis', 'argon2', '@prisma/client', '@prisma/adapter-pg', 'pg'],
  async rewrites() {
    return {
      beforeFiles: [
        // Clean public URL for redeemed one-time share content — same
        // handler, same access window; the browser only sees this path.
        { source: '/share-file/:token', destination: '/api/cdn/share/:token/content' },
      ],
      afterFiles: [
        // Public file URLs: cdn.tirbeo.app/u/<userId>/<folders>/<file>
        // (also covers the API origin itself in dev)
        { source: '/u/:path*', destination: '/api/cdn/u/:path*' },
      ],
    };
  },
  async headers() {
    return [
      {
        source: '/logo.png',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=604800, stale-while-revalidate=2592000' },
        ],
      },
      {
        source: '/(.*)',
        headers: [
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=(), usb=(), serial=(), midi=(), sync-xhr=(), autoplay=(), display-capture=(), fullscreen=(), picture-in-picture=(), screen-wake-lock=(), clipboard-read=(), clipboard-write=()' },
        ],
      },
    ];
  },
  turbopack: {},
  webpack: (config, { isServer }) => {
    config.output = config.output || {};
    config.output.hashFunction = 'xxhash64';
    if (isServer) {
      config.externals = [...(config.externals || []), 'ioredis', 'argon2'];
    }
    return config;
  },
};

module.exports = nextConfig;
