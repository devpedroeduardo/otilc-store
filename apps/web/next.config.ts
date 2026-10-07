import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // O pacote compartilhado é TypeScript compilado no monorepo.
  transpilePackages: ['@otilc/shared'],
  output: 'standalone',
};

export default nextConfig;
