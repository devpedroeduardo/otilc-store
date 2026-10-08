import { adminLoginSchema, adminRoleSchema, type AdminUserDto } from '@otilc/shared';
import { z } from 'zod';
import type { Database } from '../db/client';
import { adminUsers } from '../db/schema';
import { hashPassword } from './password';

/**
 * Dados do script `admin:create`. Reaproveita as regras do login: e-mail normalizado
 * (trim + minúsculas, como o CHECK do banco exige) e senha de 12 a 200 caracteres.
 */
export const newAdminSchema = z.object({
  email: adminLoginSchema.shape.email,
  name: z.string().trim().min(1, 'Informe o nome.').max(120),
  role: z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), adminRoleSchema),
  password: adminLoginSchema.shape.password,
});
export type NewAdminInput = z.infer<typeof newAdminSchema>;

/** Grava o admin com a senha em hash scrypt. Nunca devolve o hash. */
export async function createAdminUser(db: Database, input: NewAdminInput): Promise<AdminUserDto> {
  const [user] = await db
    .insert(adminUsers)
    .values({
      email: input.email,
      name: input.name,
      role: input.role,
      passwordHash: await hashPassword(input.password),
    })
    .returning({
      id: adminUsers.id,
      email: adminUsers.email,
      name: adminUsers.name,
      role: adminUsers.role,
    });
  return user;
}
