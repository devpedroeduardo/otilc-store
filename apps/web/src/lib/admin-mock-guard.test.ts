import { describe, expect, it } from 'vitest';
import { assertAdminMockOff } from './admin-mock-guard';

describe('assertAdminMockOff', () => {
  it('barra o mock ligado no build de produção da Vercel', () => {
    for (const NEXT_PUBLIC_ADMIN_MOCK of ['1', 'true']) {
      expect(() =>
        assertAdminMockOff({ VERCEL_ENV: 'production', NEXT_PUBLIC_ADMIN_MOCK }),
      ).toThrow(/NEXT_PUBLIC_ADMIN_MOCK/);
    }
  });

  it('deixa passar a produção da Vercel com o mock ausente ou desligado', () => {
    for (const NEXT_PUBLIC_ADMIN_MOCK of [undefined, '', '0']) {
      expect(() =>
        assertAdminMockOff({ VERCEL_ENV: 'production', NEXT_PUBLIC_ADMIN_MOCK }),
      ).not.toThrow();
    }
  });

  it('fora da produção da Vercel não interfere, nem com o mock ligado', () => {
    for (const VERCEL_ENV of [undefined, 'preview', 'development']) {
      expect(() => assertAdminMockOff({ VERCEL_ENV, NEXT_PUBLIC_ADMIN_MOCK: '1' })).not.toThrow();
    }
  });
});
