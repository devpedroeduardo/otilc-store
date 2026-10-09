import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import type { AdminRole } from '@otilc/shared';
import { AdminAuthService } from '../src/admin-auth/admin-auth.service';
import { createAdminUser } from '../src/admin-auth/new-admin';
import { hashSessionToken, SESSION_COOKIE } from '../src/admin-auth/session-token';
import { adminSessions, adminUsers } from '../src/db/schema';
import { resetData, setupTestApp, teardownTestApp, type TestContext } from './setup';

const WEB_ORIGIN = 'http://localhost:3000';
const PASSWORD = randomBytes(24).toString('base64url');
const WRONG_PASSWORD = randomBytes(24).toString('base64url');
const OWNER = { email: 'dono@example.test', name: 'Dono', role: 'OWNER' as AdminRole };

describe('Login de administrador (integração com Postgres)', () => {
  let ctx: TestContext;
  // O limite de login é por IP e o armazenamento do throttler vive enquanto o app vive:
  // cada requisição de login usa um IP próprio, salvo no teste do 429.
  let ipCounter = 0;
  const nextIp = () => `10.20.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

  beforeAll(async () => {
    ctx = await setupTestApp();
  });
  beforeEach(() => resetData(ctx.db));
  afterAll(() => teardownTestApp(ctx));

  const http = () => request(ctx.app.getHttpServer());

  function login(body: object, ip = nextIp()) {
    return http()
      .post('/api/admin/session')
      .set('Origin', WEB_ORIGIN)
      .set('X-Forwarded-For', ip)
      .send(body);
  }

  async function createOwner() {
    return createAdminUser(ctx.db, { ...OWNER, password: PASSWORD });
  }

  /** Faz login e devolve o header `Cookie` para as próximas requisições. */
  async function loginCookie(): Promise<string> {
    const res = await login({ email: OWNER.email, password: PASSWORD }).expect(200);
    return sessionCookieFrom(res.headers['set-cookie']).split(';')[0];
  }

  /** `Path=/` e nada mais (não aceita `Path=/api/admin`). */
  const COOKIE_PATH_ROOT = /;\s*Path=\/(;|$)/;

  function sessionCookieFrom(header: unknown): string {
    const cookies = Array.isArray(header) ? header : [header];
    const found = cookies.find(
      (c): c is string => typeof c === 'string' && c.startsWith(`${SESSION_COOKIE}=`),
    );
    if (!found) throw new Error('Set-Cookie da sessão ausente');
    return found;
  }

  describe('POST /api/admin/session', () => {
    it('cria a sessão, devolve o AdminUserDto e o cookie com os atributos da ADR', async () => {
      const user = await createOwner();

      const res = await login({ email: '  Dono@Example.test ', password: PASSWORD }).expect(200);

      expect(res.body).toEqual({ id: user.id, ...OWNER });
      const setCookie = sessionCookieFrom(res.headers['set-cookie']);
      const token = /^otilc_admin=([^;]+);/.exec(setCookie)?.[1] ?? '';
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
      // Path=/ exato (spec-007): as páginas /admin/** da loja também precisam receber o cookie.
      expect(setCookie).toMatch(COOKIE_PATH_ROOT);
      expect(setCookie).toContain('Max-Age=28800');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Strict');
      // Secure só em produção; os testes rodam com NODE_ENV=test.
      expect(setCookie).not.toContain('Secure');

      // O banco guarda só o SHA-256 do token, com validade de 8 horas.
      const [session] = await ctx.db.select().from(adminSessions);
      expect(session.tokenHash).toBe(hashSessionToken(token));
      expect(session.tokenHash).not.toContain(token);
      const ttl = session.expiresAt.getTime() - Date.now();
      expect(ttl).toBeGreaterThan(8 * 3600_000 - 60_000);
      expect(ttl).toBeLessThanOrEqual(8 * 3600_000);
    });

    it('senha errada, e-mail inexistente e usuário inativo recebem o mesmo 401', async () => {
      await createOwner();
      await createAdminUser(ctx.db, {
        email: 'inativo@example.test',
        name: 'Inativo',
        role: 'STAFF',
        password: PASSWORD,
      });
      await ctx.db
        .update(adminUsers)
        .set({ active: false })
        .where(eq(adminUsers.email, 'inativo@example.test'));

      const attempts = await Promise.all([
        login({ email: OWNER.email, password: WRONG_PASSWORD }),
        login({ email: 'ninguem@example.test', password: PASSWORD }),
        login({ email: 'inativo@example.test', password: PASSWORD }),
      ]);

      for (const res of attempts) {
        expect(res.status).toBe(401);
        expect(res.body).toEqual({
          statusCode: 401,
          message: 'E-mail ou senha inválidos.',
          error: 'Unauthorized',
        });
        expect(res.headers['set-cookie']).toBeUndefined();
      }
      const [{ total }] = await ctx.db
        .select({ total: sql<number>`count(*)::int` })
        .from(adminSessions);
      expect(total).toBe(0);
    });

    it('corpo inválido é 400 com a lista de campos', async () => {
      const res = await login({ email: 'nao-e-email', password: 'curta' }).expect(400);
      expect(res.body.message).toBe('Dados inválidos.');
      expect(res.body.errors.map((e: { field: string }) => e.field).sort()).toEqual([
        'email',
        'password',
      ]);
    });

    it('limita a 5 tentativas por minuto por IP (429)', async () => {
      await createOwner();
      const ip = '10.99.0.1';
      const wrong = { email: OWNER.email, password: WRONG_PASSWORD };

      for (let i = 0; i < 5; i++) await login(wrong, ip).expect(401);
      // Nem a senha certa passa depois do limite.
      await login({ email: OWNER.email, password: PASSWORD }, ip).expect(429);
      // Outro IP não é afetado.
      await login({ email: OWNER.email, password: PASSWORD }).expect(200);
    });
  });

  describe('CSRF por Origin', () => {
    it.each([
      ['de outro site', 'https://evil.example'],
      ['ausente', undefined],
    ])('mutação com Origin %s recebe 403 antes de tudo, inclusive no login', async (_, origin) => {
      await createOwner();
      const cookie = await loginCookie();

      const loginReq = http()
        .post('/api/admin/session')
        .set('X-Forwarded-For', nextIp())
        .send({ email: OWNER.email, password: PASSWORD });
      const logoutReq = http().delete('/api/admin/session').set('Cookie', cookie);
      // Rotas ainda inexistentes da árvore /api/admin também são cobertas (spec-005).
      const otherReq = http().patch('/api/admin/products/qualquer').set('Cookie', cookie);
      for (const req of [loginReq, logoutReq, otherReq]) {
        if (origin) req.set('Origin', origin);
        const res = await req;
        expect(res.status).toBe(403);
        expect(res.headers['set-cookie']).toBeUndefined();
      }

      // Nada mudou: a sessão continua lá e é a única.
      const sessions = await ctx.db.select().from(adminSessions);
      expect(sessions).toHaveLength(1);
      await http().get('/api/admin/me').set('Cookie', cookie).expect(200);
    });

    it('o 403 de Origin não consome o limite de login', async () => {
      await createOwner();
      const ip = '10.99.0.2';
      for (let i = 0; i < 6; i++) {
        await http()
          .post('/api/admin/session')
          .set('Origin', 'https://evil.example')
          .set('X-Forwarded-For', ip)
          .send({ email: OWNER.email, password: PASSWORD })
          .expect(403);
      }
      await login({ email: OWNER.email, password: PASSWORD }, ip).expect(200);
    });

    it('GET não exige Origin', async () => {
      await createOwner();
      const cookie = await loginCookie();
      await http().get('/api/admin/me').set('Cookie', cookie).expect(200);
    });
  });

  describe('GET /api/admin/me', () => {
    it('devolve o AdminUserDto da sessão, sem hashes', async () => {
      const user = await createOwner();
      const cookie = await loginCookie();

      const res = await http().get('/api/admin/me').set('Cookie', cookie).expect(200);
      expect(res.body).toEqual({ id: user.id, ...OWNER });
    });

    it.each([
      ['sem cookie', undefined],
      ['com cookie malformado', `${SESSION_COOKIE}=x'; OR 1=1`],
      ['com token desconhecido', `${SESSION_COOKIE}=${'A'.repeat(43)}`],
    ])('401 %s', async (_, cookie) => {
      const req = http().get('/api/admin/me');
      if (cookie) req.set('Cookie', cookie);
      const res = await req.expect(401);
      expect(JSON.stringify(res.body)).not.toMatch(/hash|token_hash|password/i);
    });

    it('401 com sessão expirada', async () => {
      await createOwner();
      const cookie = await loginCookie();
      await ctx.db.update(adminSessions).set({ expiresAt: new Date(Date.now() - 1000) });
      await http().get('/api/admin/me').set('Cookie', cookie).expect(401);
    });

    it('401 com sessão revogada (apagada) ou usuário desativado', async () => {
      await createOwner();
      const cookie = await loginCookie();
      await ctx.db.update(adminUsers).set({ active: false });
      await http().get('/api/admin/me').set('Cookie', cookie).expect(401);

      await ctx.db.update(adminUsers).set({ active: true });
      await http().get('/api/admin/me').set('Cookie', cookie).expect(200);
      await ctx.db.delete(adminSessions);
      await http().get('/api/admin/me').set('Cookie', cookie).expect(401);
    });
  });

  describe('DELETE /api/admin/session', () => {
    it('apaga a sessão no banco, limpa o cookie e revoga na hora', async () => {
      await createOwner();
      const cookie = await loginCookie();
      const other = await loginCookie();

      const res = await http()
        .delete('/api/admin/session')
        .set('Origin', WEB_ORIGIN)
        .set('Cookie', cookie)
        .expect(204);

      const cleared = sessionCookieFrom(res.headers['set-cookie']);
      expect(cleared).toMatch(/^otilc_admin=;/);
      expect(cleared).toContain('Max-Age=0');
      // Mesmo Path=/ do login: um cookie limpo com outro path não apagaria o original.
      expect(cleared).toMatch(COOKIE_PATH_ROOT);
      expect(cleared).toContain('HttpOnly');
      expect(cleared).toContain('SameSite=Strict');

      await http().get('/api/admin/me').set('Cookie', cookie).expect(401);
      // Só a sessão do logout foi apagada.
      expect(await ctx.db.select().from(adminSessions)).toHaveLength(1);
      await http().get('/api/admin/me').set('Cookie', other).expect(200);
    });

    it('401 sem sessão', async () => {
      await http().delete('/api/admin/session').set('Origin', WEB_ORIGIN).expect(401);
    });
  });

  describe('limpeza de sessões expiradas', () => {
    it('apaga só as sessões vencidas', async () => {
      await createOwner();
      await loginCookie();
      await loginCookie();
      const [first] = await ctx.db.select().from(adminSessions).limit(1);
      await ctx.db
        .update(adminSessions)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(adminSessions.id, first.id));

      const deleted = await ctx.app.get(AdminAuthService).deleteExpiredSessions();

      expect(deleted).toBe(1);
      const left = await ctx.db.select().from(adminSessions);
      expect(left.map((s) => s.id)).not.toContain(first.id);
      expect(left).toHaveLength(1);
    });
  });

  describe('script admin:create', () => {
    it('grava e-mail normalizado e senha em hash scrypt, nunca em texto puro', async () => {
      await createAdminUser(ctx.db, { ...OWNER, password: PASSWORD });
      const [row] = await ctx.db.select().from(adminUsers);
      expect(row.passwordHash).toMatch(/^scrypt\$/);
      expect(row.passwordHash).not.toContain(PASSWORD);
    });

    it('o banco recusa e-mail duplicado', async () => {
      await createOwner();
      await expect(createOwner()).rejects.toThrow();
    });
  });
});
