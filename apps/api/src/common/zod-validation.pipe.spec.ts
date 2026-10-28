import { BadRequestException } from '@nestjs/common';
import { adminProductInputSchema, catalogQuerySchema, checkoutSchema } from '@otilc/shared';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe';

/** Captura a exceção lançada pelo pipe para conferir status e corpo exatos da resposta 400. */
function rejection(pipe: ZodValidationPipe<unknown>, value: unknown): BadRequestException {
  try {
    pipe.transform(value);
  } catch (err) {
    if (err instanceof BadRequestException) return err;
    throw err;
  }
  throw new Error('o pipe aceitou uma entrada inválida');
}

describe('ZodValidationPipe', () => {
  it('devolve 400 com mensagem fixa e a lista de campos com erro', () => {
    const err = rejection(new ZodValidationPipe(checkoutSchema), {
      items: [{ variantId: '', quantity: 1.5 }],
      customer: { name: 'A', email: 'x', phone: '123' },
    });
    expect(err.getStatus()).toBe(400);
    expect(err.getResponse()).toEqual({
      message: 'Dados inválidos.',
      errors: [
        { field: 'items.0.variantId', message: 'String must contain at least 1 character(s)' },
        { field: 'items.0.quantity', message: 'Expected integer, received float' },
        { field: 'customer.name', message: 'String must contain at least 2 character(s)' },
        { field: 'customer.email', message: 'E-mail inválido.' },
        { field: 'customer.phone', message: 'Telefone inválido.' },
      ],
    });
  });

  it('mantém as mensagens padrão documentadas em docs/api', () => {
    const err = rejection(new ZodValidationPipe(adminProductInputSchema), {
      slug: 'camiseta',
      name: 'Camiseta',
      priceCents: 0,
      condition: null,
      status: 'X',
      categorySlug: 'camisetas',
    });
    expect(err.getResponse()).toEqual({
      message: 'Dados inválidos.',
      errors: [
        { field: 'priceCents', message: 'Number must be greater than 0' },
        {
          field: 'status',
          message:
            "Invalid enum value. Expected 'ACTIVE' | 'RESERVED' | 'SOLD_OUT' | 'DRAFT', received 'X'",
        },
        { field: 'featured', message: 'Required' },
      ],
    });
  });

  it('valida query string com coerção e schema criado na própria API', () => {
    expect(
      rejection(new ZodValidationPipe(catalogQuerySchema), { pagina: 'abc' }).getResponse(),
    ).toEqual({
      message: 'Dados inválidos.',
      errors: [{ field: 'pagina', message: 'Expected number, received nan' }],
    });
    const slug = z.string().regex(/^[a-z0-9-]{1,120}$/, 'Endereço de produto inválido.');
    expect(rejection(new ZodValidationPipe(slug), 'ABC').getResponse()).toEqual({
      message: 'Dados inválidos.',
      errors: [{ field: '', message: 'Endereço de produto inválido.' }],
    });
  });

  it('devolve os dados validados sem campos desconhecidos (o preço não vem do navegador)', () => {
    const pipe = new ZodValidationPipe(checkoutSchema);
    const customer = { name: 'Ana Souza', email: 'ana@example.com', phone: '+5585999990000' };
    expect(
      pipe.transform({
        items: [{ variantId: 'v1', quantity: 1, priceCents: 1 }],
        customer,
        totalCents: 1,
      }),
    ).toEqual({ items: [{ variantId: 'v1', quantity: 1 }], customer });
  });
});
