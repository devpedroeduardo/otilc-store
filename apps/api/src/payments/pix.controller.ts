import { Controller, Get, Inject, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { PixChargeDto } from '@otilc/shared';
import { PixService } from './pix.service';

const uuid = new ParseUUIDPipe({ version: '4' });

/** Cobrança Pix do pedido (docs/api/pagamentos.md). O id do pedido é a chave de acesso. */
@Controller('orders')
export class PixController {
  constructor(@Inject(PixService) private readonly pix: PixService) {}

  /** `201` ao criar a cobrança, `200` se já havia uma pendente. */
  @Post(':id/pix')
  async create(
    @Param('id', uuid) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PixChargeDto> {
    const { charge, created } = await this.pix.createCharge(id);
    res.status(created ? 201 : 200);
    return charge;
  }

  @Get(':id/pix')
  find(@Param('id', uuid) id: string): Promise<PixChargeDto> {
    return this.pix.getCharge(id);
  }
}
