import type { NextConfig } from 'next';
import { assertAdminMockOff } from './src/lib/admin-mock-guard';

// Falha o build de produção da Vercel com o mock do admin ligado (spec-016).
assertAdminMockOff(process.env);

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
