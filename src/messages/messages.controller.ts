// src/messages/messages.controller.ts
import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard } from '@nestjs/passport';

type CreateDto = { matchId: string; text: string };

@Controller('messages')
@UseGuards(AuthGuard('jwt'))
export class MessagesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Query('matchId') matchId: string,
    @Query('after') after?: string,
  ) {
    if (!matchId) return [];
    const where: any = { matchId };
    if (after) where.createdAt = { gt: new Date(after) };
    const items = await this.prisma.message.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      take: 100,
      include: { user: true },
    });
    return items.map((m) => ({
      id: m.id,
      matchId: m.matchId,
      text: m.text,
      createdAt: m.createdAt,
      user: {
        id: m.userId,
        phone: m.user.phone,
        // basit takma ad: son 2-3 haneyi göster
        nickname: 'U' + (m.user.phone?.slice(-3) ?? '***'),
      },
    }));
  }

  @Post()
  async create(@Req() req: any, @Body() dto: CreateDto) {
    // userId yoksa phone ile kullanıcıyı bul/oluştur (profildeki gibi)
    let userId = req.user?.sub as string | undefined;
    const phoneDigits = String(req.user?.phone ?? '').replace(/\D/g, '');

    if (!userId && phoneDigits) {
      const u = await this.prisma.user.upsert({
        where: { phone: phoneDigits },
        update: {},
        create: { phone: phoneDigits, positions: [], positionLevels: {}, availability: {} },
      });
      userId = u.id;
    }

    const text = String(dto?.text ?? '').trim().slice(0, 500);
    const matchId = String(dto?.matchId ?? '').trim().slice(0, 100);

    if (!userId || !text || !matchId) {
      return { ok: false };
    }

    const m = await this.prisma.message.create({
      data: { userId, matchId, text },
      include: { user: true },
    });

    return {
      id: m.id,
      matchId: m.matchId,
      text: m.text,
      createdAt: m.createdAt,
      user: {
        id: m.userId,
        phone: m.user.phone,
        nickname: 'U' + (m.user.phone?.slice(-3) ?? '***'),
      },
    };
  }
} // <--- sınıfın kapanışı BURA!
