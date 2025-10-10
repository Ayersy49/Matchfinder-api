import {
  Controller, Post, Body,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

@Controller('auth')
export class DevAuthController {
  constructor(private prisma: PrismaService, private jwt: JwtService) {}

  @Post('dev-login')
  async devLogin(@Body() body: { phone?: string; userId?: string }) {
    let userId = (body?.userId || '').trim();

    // userId yoksa telefonla bul/oluştur
    if (!userId) {
      const raw = (body?.phone || '905551112233').replace(/\D/g, '');
      const phone = raw.startsWith('90') ? raw : `90${raw}`;

      let u = await this.prisma.user.findFirst({ where: { phone } });
      if (!u) {
        const data: Prisma.UserCreateInput = {
          phone,
          positions: [] as Prisma.InputJsonValue, // <- kritik: InputJsonValue
        };
        u = await this.prisma.user.create({ data });
      }
      userId = u.id;
    }

    // token’ı aynı secret ile üret
    const token = await this.jwt.signAsync({ id: userId });
    return { ok: true, token, userId };
  }
}
