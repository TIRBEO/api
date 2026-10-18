/** @type {import('next').NextConfig} */
const path = require('path');

const nextConfig = {
  turbopack: {
    // Pin the monorepo workspace root. Without this, Turbopack can infer
    // apps/api as the root and refuse to compile the hoisted node_modules
    // ("Could not find the Next.js package (next/package.json)").
    root: path.join(__dirname, '..', '..'),
  },
  // Dev-only: allow HMR/dev resources when browsing from the LAN device.
  allowedDevOrigins: ['192.168.1.123', 'localhost'],
  // No `typescript.ignoreBuildErrors` — it was `true` here, which let red
  // builds ship; `next build` typechecking is the gate.
  serverExternalPackages: ['ioredis', 'argon2', '@prisma/client', '@prisma/adapter-pg', 'pg'],
  // The /u/* and /share-file/* rewrites that used to sit here aimed at
  // /api/cdn/**, which no longer exists: files are stored in R2 (or the
  // database) and handed back as their own URL, so nothing on this origin
  // serves them and both rules were a two-hop way to reach a 404.
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
