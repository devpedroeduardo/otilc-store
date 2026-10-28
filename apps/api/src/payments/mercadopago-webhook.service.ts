import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { mercadoPagoWebhookBodySchema, type MercadoPagoWebhookQuery } from '@otilc/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ENV, pixConfig, type Env } from '../config/env';
import { DB, type Database } from '../db/client';
import { paymentNotifications } from '../db/schema';
import { PaymentTransitionService, type SyncOutcome } from './payment-transition.service';
import { pixError } from './pix-errors';
import { verifyWebhookSignature } from './webhook-signature';

export interface WebhookInput {
  query: MercadoPagoWebhookQuery;
  signature: unknown;
  requestId: unknown;
  body: unknown;
}

const bodyPipe = new ZodValidationPipe(mercadoPagoWebhookBodySchema);

/** Ordem do processamento em docs/api/pagamentos.md. Nunca registra headers, corpo ou segredo. */
@Injectable()
export class MercadoPagoWebhookService {
  private readonly logger = new Logger(MercadoPagoWebhookService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    @Inject(PaymentTransitionService) private readonly transition: PaymentTransitionService,
  ) {}

  async handle(input: WebhookInput): Promise<SyncOutcome | 'ignored'> {
    const config = pixConfig(this.env);
    if (!config) throw pixError('PIX_UNAVAILABLE');

    const dataId = input.query['data.id'];
    const { signature, requestId } = input;
    const valid = verifyWebhookSignature({
      signature,
      requestId,
      dataId,
      secret: config.webhookSecret,
    });
    if (!valid || typeof requestId !== 'string') {
      throw new UnauthorizedException('Assinatura inválida.');
    }

    const body = bodyPipe.transform(input.body);
    if (body.data.id !== dataId) {
      throw new BadRequestException('O id do corpo não confere com o da notificação.');
    }
    if (body.type !== 'payment') return 'ignored';

    const seen = await this.db.query.paymentNotifications.findFirst({
      where: eq(paymentNotifications.requestId, requestId),
      columns: { id: true },
    });
    if (seen) return 'duplicate';

    try {
      return await this.transition.sync(dataId, requestId);
    } catch (err) {
      this.logger.error(`Notificação do pagamento ${dataId} falhou: ${(err as Error).message}`);
      throw new InternalServerErrorException('Não foi possível processar a notificação.');
    }
  }
}
