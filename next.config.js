/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  serverExternalPackages: ['ioredis', 'argon2'],
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=(), usb=(), serial=(), midi=(), sync-xhr=(), autoplay=(), display-capture=(), fullscreen=(), picture-in-picture=(), screen-wake-lock=(), clipboard-read=(), clipboard-write=()' },
          { key: 'Content-Security-Policy', value: "default-src 'none'; script-src 'none'; style-src 'none'; img-src 'none'; connect-src 'self' https://admin.tirbeo.app https://accounts.tirbeo.app https://dashboard.tirbeo.app https://forms.tirbeo.app https://support.tirbeo.app https://tirbeo.app https://www.tirbeo.app; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none';" },
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
