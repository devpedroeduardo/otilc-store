import { HttpException } from '@nestjs/common';
import { pixErrorMessages, pixErrorStatus, type PixErrorCode } from '@otilc/shared';

const errorNames: Record<PixErrorCode, string> = {
  PIX_UNAVAILABLE: 'Service Unavailable',
  ORDER_NOT_PAYABLE: 'Conflict',
};

/** Erro do Pix no formato de `pixErrorResponseSchema` (docs/api/pagamentos.md). */
export function pixError(code: PixErrorCode): HttpException {
  const statusCode = pixErrorStatus[code];
  return new HttpException(
    { statusCode, code, message: pixErrorMessages[code], error: errorNames[code] },
    statusCode,
  );
}
