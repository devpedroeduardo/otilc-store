import { Module } from '@nestjs/common';
import { ENV, pixConfig, type Env } from '../config/env';
import { MercadoPagoClient, PIX_PROVIDER, type PixProvider } from './mercadopago.client';
import { MercadoPagoWebhookController } from './mercadopago-webhook.controller';
import { MercadoPagoWebhookService } from './mercadopago-webhook.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { PaymentTransitionService } from './payment-transition.service';
import { PixController } from './pix.controller';
import { PixService } from './pix.service';

@Module({
  controllers: [PixController, MercadoPagoWebhookController],
  providers: [
    {
      // Sem as variáveis do Mercado Pago, o Pix fica desligado (null): POST /pix responde 503.
      provide: PIX_PROVIDER,
      inject: [ENV],
      useFactory: (env: Env): PixProvider | null => {
        const config = pixConfig(env);
        return config ? new MercadoPagoClient(config.accessToken) : null;
      },
    },
    PaymentTransitionService,
    PixService,
    MercadoPagoWebhookService,
    PaymentReconciliationService,
  ],
  // O job de expiração e o painel de pedidos cancelam no Mercado Pago o Pix pendente do pedido.
  exports: [PaymentReconciliationService],
})
export class PaymentsModule {}
