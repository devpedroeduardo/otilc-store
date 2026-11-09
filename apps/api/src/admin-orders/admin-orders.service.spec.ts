import {
  BadGatewayException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { OrderStatus } from '@otilc/shared';
import type { Database } from '../db/client';
import type {
  CancelChargeResult,
  PaymentReconciliationService,
} from '../payments/payment-reconciliation.service';
import { AdminOrdersService, pixCancelMessages } from './admin-orders.service';

const ORDER_ID = '7e6d5c4b-0000-4000-8000-000000000000';

/**
 * Banco e cancelamento simulados que registram a ordem das chamadas. A transação não roda o corpo
 * (isso é coberto pelos e2e): aqui interessa só o que acontece antes dela. `reversed` é a resposta
 * da leitura de cobrança estornada (spec-035).
 */
function setup(
  status: OrderStatus | null,
  result: CancelChargeResult = 'cancelled',
  reversed = false,
) {
  const events: string[] = [];
  const query = {
    from: () => query,
    leftJoin: () => query,
    where: () => query,
    limit: jest.fn(async () => (reversed ? [{ id: 'pagamento-estornado' }] : [])),
  };
  const db = {
    select: jest.fn(() => {
      events.push('reversed?');
      return query;
    }),
    query: {
      orders: {
        findFirst: jest.fn(async () => {
          events.push('read');
          return status ? { status } : undefined;
        }),
      },
    },
    transaction: jest.fn(async () => {
      events.push('transaction');
      return { id: ORDER_ID };
    }),
  };
  const payments = {
    cancelPendingCharge: jest.fn(async (orderId: string) => {
      events.push(`cancel ${orderId}`);
      return result;
    }),
  };
  const service = new AdminOrdersService(
    db as unknown as Database,
    payments as unknown as PaymentReconciliationService,
  );
  return { service, db, payments, events };
}

describe('AdminOrdersService.updateStatus: cancelamento do Pix (spec-019)', () => {
  it.each<OrderStatus>(['PAID', 'CANCELED'])(
    'PENDING_PAYMENT → %s cancela o Pix antes de abrir a transação',
    async (to) => {
      const { service, events } = setup('PENDING_PAYMENT');

      await service.updateStatus(ORDER_ID, to);

      // A leitura inicial é um SELECT avulso; a transação (e a trava do pedido) só abre depois
      // de o cancelamento terminar. Só o pagar confere cobrança estornada antes (spec-035).
      const check = to === 'PAID' ? ['reversed?'] : [];
      expect(events).toEqual(['read', ...check, `cancel ${ORDER_ID}`, 'transaction']);
    },
  );

  it('sem Pix pendente segue para a transação como antes', async () => {
    const { service, events } = setup('PENDING_PAYMENT', 'no_charge');

    await service.updateStatus(ORDER_ID, 'PAID');

    expect(events).toEqual(['read', 'reversed?', `cancel ${ORDER_ID}`, 'transaction']);
  });

  it.each<[CancelChargeResult, new (message: string) => Error, string]>([
    ['approved', ConflictException, pixCancelMessages.approved],
    ['failed', BadGatewayException, pixCancelMessages.failed],
    ['pix_disabled', ServiceUnavailableException, pixCancelMessages.pixDisabled],
  ])('cancelamento %s: erro e nenhuma transação', async (result, type, message) => {
    const { service, db } = setup('PENDING_PAYMENT', result);

    const error = await service.updateStatus(ORDER_ID, 'PAID').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(type);
    expect((error as Error).message).toBe(message);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it.each<[OrderStatus, OrderStatus]>([
    ['PAID', 'CANCELED'],
    ['PAID', 'SHIPPED'],
    ['PENDING_PAYMENT', 'SHIPPED'],
    ['EXPIRED', 'PAID'],
  ])('%s → %s não chama o Mercado Pago', async (from, to) => {
    const { service, payments, db } = setup(from);

    await service.updateStatus(ORDER_ID, to);

    expect(payments.cancelPendingCharge).not.toHaveBeenCalled();
    // A transação continua sendo quem decide (e responde 409 nas transições inválidas).
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it('pedido inexistente é 404 sem chamar o Mercado Pago', async () => {
    const { service, payments } = setup(null);

    await expect(service.updateStatus(ORDER_ID, 'PAID')).rejects.toBeInstanceOf(NotFoundException);
    expect(payments.cancelPendingCharge).not.toHaveBeenCalled();
  });
});

describe('AdminOrdersService.updateStatus: cobrança estornada ou contestada (spec-035)', () => {
  it('PENDING_PAYMENT → PAID: 409, sem chamar o Mercado Pago e sem abrir a transação', async () => {
    const { service, db, payments, events } = setup('PENDING_PAYMENT', 'cancelled', true);

    const error = await service.updateStatus(ORDER_ID, 'PAID').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as Error).message).toBe(pixCancelMessages.reversed);
    expect(events).toEqual(['read', 'reversed?']);
    expect(payments.cancelPendingCharge).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('PENDING_PAYMENT → CANCELED não confere estorno: cancelar continua livre', async () => {
    const { service, db, events } = setup('PENDING_PAYMENT', 'cancelled', true);

    await service.updateStatus(ORDER_ID, 'CANCELED');

    expect(db.select).not.toHaveBeenCalled();
    expect(events).toEqual(['read', `cancel ${ORDER_ID}`, 'transaction']);
  });

  it.each<[OrderStatus, OrderStatus]>([
    ['PAID', 'SHIPPED'],
    ['PAID', 'CANCELED'],
    ['EXPIRED', 'PAID'],
  ])('%s → %s não confere estorno antes da transação', async (from, to) => {
    const { service, db } = setup(from, 'cancelled', true);

    await service.updateStatus(ORDER_ID, to);

    expect(db.select).not.toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});
