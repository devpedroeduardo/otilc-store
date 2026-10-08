import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { adminLoginSchema, type AdminLoginInput, type AdminUserDto } from '@otilc/shared';
import type { CookieOptions, Response } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ENV, type Env } from '../config/env';
import { AdminAuthGuard } from './admin-auth.guard';
import { AdminAuthService, type AdminSession } from './admin-auth.service';
import { CurrentSession } from './roles.decorator';
import { SESSION_COOKIE, SESSION_COOKIE_PATH, SESSION_TTL_MS } from './session-token';

@Controller('admin')
export class AdminAuthController {
  constructor(
    @Inject(AdminAuthService) private readonly auth: AdminAuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Login. Limite bem mais baixo que o resto da API: 5 tentativas por minuto por IP. */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('session')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(adminLoginSchema)) input: AdminLoginInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminUserDto> {
    const { token, user } = await this.auth.login(input);
    res.cookie(SESSION_COOKIE, token, { ...this.cookieOptions(), maxAge: SESSION_TTL_MS });
    return user;
  }

  @UseGuards(AdminAuthGuard)
  @Delete('session')
  @HttpCode(204)
  async logout(
    @CurrentSession() session: AdminSession,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(session.id);
    res.cookie(SESSION_COOKIE, '', { ...this.cookieOptions(), maxAge: 0 });
  }

  @UseGuards(AdminAuthGuard)
  @Get('me')
  me(@CurrentSession() session: AdminSession): AdminUserDto {
    return session.user;
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      sameSite: 'strict',
      secure: this.env.NODE_ENV === 'production',
      path: SESSION_COOKIE_PATH,
    };
  }
}
