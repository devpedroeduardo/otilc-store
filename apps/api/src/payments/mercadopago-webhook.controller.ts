import { Body, Controller, Headers, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { mercadoPagoWebhookQuerySchema, type MercadoPagoWebhookQuery } from '@otilc/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { MercadoPagoWebhookService } from './mercadopago-webhook.service';

/**
 * Notificações do Mercado Pago (servidor para servidor: CORS não se aplica). Segue o limite
 * global de requisições. O corpo só é validado depois da assinatura (ver o serviço).
 */
@Controller('webhooks/mercadopago')
export class MercadoPagoWebhookController {
  constructor(
    @Inject(MercadoPagoWebhookService) private readonly webhook: MercadoPagoWebhookService,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Query(new ZodValidationPipe(mercadoPagoWebhookQuerySchema)) query: MercadoPagoWebhookQuery,
    @Headers('x-signature') signature: unknown,
    @Headers('x-request-id') requestId: unknown,
    @Body() body: unknown,
  ): Promise<void> {
    await this.webhook.handle({ query, signature, requestId, body });
  }
}
