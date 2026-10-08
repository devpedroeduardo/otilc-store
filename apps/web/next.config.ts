import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // O pacote compartilhado é TypeScript compilado no monorepo.
  transpilePackages: ['@otilc/shared'],
  output: 'standalone',
  async rewrites() {
    return [
      {
        source: '/api/admin/:path*',
        destination: `${process.env.API_URL ?? 'http://localhost:3333'}/api/admin/:path*`,
      },
    ];
  },
};

export default nextConfig;
