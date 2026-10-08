import { ForbiddenException, Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ENV, type Env } from '../config/env';

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * CSRF (ADR 0002): mutações em /api/admin só com `Origin` igual a `WEB_ORIGIN`.
 * Origin ausente também é recusado. Roda como middleware, antes do limite de tentativas
 * e de qualquer guard, inclusive no login.
 */
@Injectable()
export class AdminOriginMiddleware implements NestMiddleware {
  private readonly allowed: string;

  constructor(@Inject(ENV) env: Env) {
    this.allowed = new URL(env.WEB_ORIGIN).origin;
  }

  use(req: Request, _res: Response, next: NextFunction): void {
    if (MUTATING.has(req.method) && req.headers.origin !== this.allowed) {
      throw new ForbiddenException('Origem não permitida.');
    }
    next();
  }
}
