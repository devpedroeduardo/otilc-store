import { ConflictException } from '@nestjs/common';
import { adminAlertErrorMessages, type AdminAlertErrorCode } from '@otilc/shared';

/** `409` das rotas de alerta no formato de `adminAlertErrorResponseSchema` (docs/api/admin.md). */
export function alertConflict(code: AdminAlertErrorCode): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code,
    message: adminAlertErrorMessages[code],
    error: 'Conflict',
  });
}
