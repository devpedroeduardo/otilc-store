import { Body, Controller, Headers, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { mercadoPagoWebhookQuerySchema, type MercadoPagoWebhookQuery } from '@otilc/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { MercadoPagoWebhookService } from './mercadopago-webhook.service';

/**
 * Notificações do Mercado Pago (servidor para servidor: CORS não se aplica). Limite próprio de
 * 600/min por IP, acima do global (120), para aguentar rajadas do Mercado Pago; requisição forjada
 * continua barrada pela assinatura. O corpo só é validado depois da assinatura (ver o serviço).
 */
@Controller('webhooks/mercadopago')
export class MercadoPagoWebhookController {
  constructor(
    @Inject(MercadoPagoWebhookService) private readonly webhook: MercadoPagoWebhookService,
  ) {}

  @Post()
  @HttpCode(200)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  async receive(
    @Query(new ZodValidationPipe(mercadoPagoWebhookQuerySchema)) query: MercadoPagoWebhookQuery,
    @Headers('x-signature') signature: unknown,
    @Headers('x-request-id') requestId: unknown,
    @Body() body: unknown,
  ): Promise<void> {
    await this.webhook.handle({ query, signature, requestId, body });
  }
}
