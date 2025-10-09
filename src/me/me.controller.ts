// src/me/me.controller.ts
import {
  Body,
  BadRequestException,
  Controller,
  Put,
  Req,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PrismaService } from '../prisma/prisma.service';

function getUserIdFromReq(req: any): string | undefined {
  return req?.user?.id || req?.user?.sub || req?.user?.userId;
}

@UseGuards(AuthGuard('jwt'))
@Controller('me')
export class MeController {
  constructor(private prisma: PrismaService) {}

  // /me/location  (lat/lng kaydet)
  @Put('location')
  async updateLocation(
    @Req() req: any,
    @Body() body: { lat?: number; lng?: number },
  ) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException('unauthorized');

    const lat = Number(body?.lat);
    const lng = Number(body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new BadRequestException('invalid lat/lng');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { lat, lng },
    });

    return { ok: true };
  }

  // /me/discoverable  (keşifte görünürlük)
  @Put('discoverable')
  async updateDiscoverable(
    @Req() req: any,
    @Body() body: { value?: boolean },
  ) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException('unauthorized');

    await this.prisma.user.update({
      where: { id: userId },
      data: { discoverable: !!body?.value },
    });

    return { ok: true };
  }
}
