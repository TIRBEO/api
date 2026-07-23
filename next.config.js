/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  serverExternalPackages: ['ioredis', 'argon2'],
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
