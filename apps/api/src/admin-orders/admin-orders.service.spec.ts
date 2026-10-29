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
 * (isso é coberto pelos e2e): aqui interessa só o que acontece antes dela.
 */
function setup(status: OrderStatus | null, result: CancelChargeResult = 'cancelled') {
  const events: string[] = [];
  const db = {
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
      // de o cancelamento terminar.
      expect(events).toEqual(['read', `cancel ${ORDER_ID}`, 'transaction']);
    },
  );

  it('sem Pix pendente segue para a transação como antes', async () => {
    const { service, events } = setup('PENDING_PAYMENT', 'no_charge');

    await service.updateStatus(ORDER_ID, 'PAID');

    expect(events).toEqual(['read', `cancel ${ORDER_ID}`, 'transaction']);
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
