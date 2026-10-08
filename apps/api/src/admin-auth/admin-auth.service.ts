import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { and, eq, gt, lte } from 'drizzle-orm';
import type { AdminLoginInput, AdminUserDto } from '@otilc/shared';
import { DB, type Database } from '../db/client';
import { adminSessions, adminUsers } from '../db/schema';
import { hashPassword, verifyPassword } from './password';
import { generateSessionToken, hashSessionToken, SESSION_TTL_MS } from './session-token';

export interface AdminSession {
  id: string;
  user: AdminUserDto;
}

/** Mesma resposta para e-mail inexistente, senha errada e usuário inativo. */
const INVALID_CREDENTIALS = 'E-mail ou senha inválidos.';

@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);
  /**
   * Hash de uma senha aleatória, usado quando o e-mail não existe: o scrypt roda do mesmo jeito,
   * então o tempo de resposta não revela quais e-mails são de admin.
   */
  private readonly dummyHash = hashPassword(generateSessionToken());

  constructor(@Inject(DB) private readonly db: Database) {}

  /** Confere a senha e cria a sessão. Devolve o token puro, que só vai para o cookie. */
  async login(
    input: AdminLoginInput,
    now = new Date(),
  ): Promise<{ token: string; user: AdminUserDto; expiresAt: Date }> {
    const user = await this.db.query.adminUsers.findFirst({
      where: eq(adminUsers.email, input.email),
    });
    const passwordOk = await verifyPassword(
      input.password,
      user?.passwordHash ?? (await this.dummyHash),
    );
    if (!user || !passwordOk || !user.active) throw new UnauthorizedException(INVALID_CREDENTIALS);

    const token = generateSessionToken();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    await this.db
      .insert(adminSessions)
      .values({ tokenHash: hashSessionToken(token), userId: user.id, expiresAt });

    return { token, user: toAdminUserDto(user), expiresAt };
  }

  /** Sessão válida: hash encontrado, `expires_at` no futuro e usuário ativo. */
  async findSession(token: string, now = new Date()): Promise<AdminSession | null> {
    const [row] = await this.db
      .select({
        sessionId: adminSessions.id,
        id: adminUsers.id,
        email: adminUsers.email,
        name: adminUsers.name,
        role: adminUsers.role,
      })
      .from(adminSessions)
      .innerJoin(adminUsers, eq(adminUsers.id, adminSessions.userId))
      .where(
        and(
          eq(adminSessions.tokenHash, hashSessionToken(token)),
          gt(adminSessions.expiresAt, now),
          eq(adminUsers.active, true),
        ),
      )
      .limit(1);
    if (!row) return null;
    const { sessionId, ...user } = row;
    return { id: sessionId, user };
  }

  async logout(sessionId: string): Promise<void> {
    await this.db.delete(adminSessions).where(eq(adminSessions.id, sessionId));
  }

  /** Apaga as sessões vencidas. Chamado periodicamente pelo AdminSessionCleanupService. */
  async deleteExpiredSessions(now = new Date()): Promise<number> {
    const deleted = await this.db
      .delete(adminSessions)
      .where(lte(adminSessions.expiresAt, now))
      .returning({ id: adminSessions.id });
    if (deleted.length > 0)
      this.logger.log(`${deleted.length} sessão(ões) de admin expirada(s) apagada(s).`);
    return deleted.length;
  }
}

function toAdminUserDto(user: typeof adminUsers.$inferSelect): AdminUserDto {
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}
