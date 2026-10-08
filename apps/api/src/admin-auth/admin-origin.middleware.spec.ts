import { ForbiddenException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { Env } from '../config/env';
import { AdminOriginMiddleware } from './admin-origin.middleware';

const middleware = new AdminOriginMiddleware({ WEB_ORIGIN: 'http://localhost:3000' } as Env);

function run(method: string, origin?: string): NextFunction {
  const next = jest.fn();
  const req = { method, headers: origin === undefined ? {} : { origin } } as Request;
  middleware.use(req, {} as Response, next);
  return next;
}

describe('AdminOriginMiddleware (CSRF)', () => {
  it.each(['POST', 'PATCH', 'PUT', 'DELETE'])('%s com a origem da loja passa', (method) => {
    expect(run(method, 'http://localhost:3000')).toHaveBeenCalled();
  });

  it.each([
    ['POST', 'https://evil.example'],
    ['DELETE', 'http://localhost:3000.evil.example'],
    ['PUT', 'null'],
    ['PATCH', undefined],
  ])('%s com Origin %p é recusado', (method, origin) => {
    expect(() => run(method, origin)).toThrow(ForbiddenException);
  });

  it('GET não depende de Origin', () => {
    expect(run('GET')).toHaveBeenCalled();
  });
});
