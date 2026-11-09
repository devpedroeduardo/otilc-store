import { Global, Module } from '@nestjs/common';
import { ENV, emailConfig, type Env } from '../config/env';
import { EMAIL_SENDER, LogEmailSender, ResendEmailSender, type EmailSender } from './email-sender';
import { EmailOutboxService } from './email-outbox.service';

/**
 * E-mail de confirmação (spec-036). Global: a transição de pagamento e o painel de pedidos gravam
 * na outbox sem importar este módulo.
 */
@Global()
@Module({
  providers: [
    {
      provide: EMAIL_SENDER,
      inject: [ENV],
      useFactory: (env: Env): EmailSender => {
        const config = emailConfig(env);
        return config.provider === 'resend'
          ? new ResendEmailSender(config.apiKey, config.from)
          : new LogEmailSender();
      },
    },
    EmailOutboxService,
  ],
  exports: [EmailOutboxService],
})
export class EmailModule {}
