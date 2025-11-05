// src/teams/team-requests.controller.ts
import {
  Controller, Get, Post, Param, Body, Query,
  BadRequestException, NotFoundException, Req, UseGuards, ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard } from '@nestjs/passport';

@Controller('team-match-requests')
export class TeamRequestsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async listOpen(
    @Query('status') status = 'OPEN',
    @Query('days') days = '3',            // TTL (gün)
  ) {
    const ttlDays = Math.max(1, Number(days) || 3);
    const now = new Date();
    const since = new Date(now.getTime() - ttlDays * 24 * 60 * 60 * 1000);

    // 1) Bakım: çok eski veya maçı geçmiş (tarihi şimdi’den küçük) OPEN ilanları EXPIRED yap
    await this.prisma.teamMatchRequest.updateMany({
      where: {
        status: 'OPEN',
        OR: [
          { createdAt: { lt: since } },
          { date: { lt: now } },
        ],
      },
      data: { status: 'EXPIRED' },
    });

    // 2) Liste: sadece son X günde açılmış ve gelecekteki ilanlar
    // Not: Prisma tipleri güncellenmediyse offers include'u TS warning verebilir → any
    const include: any = {
      reqTeam: { select: { id: true, name: true } },
      offers: { select: { offerTeamId: true } }, // butonları grilemek için lazım
    };

    return this.prisma.teamMatchRequest.findMany({
      where: {
        status,
        createdAt: { gte: since },
        date: { gte: now },
      },
      orderBy: { date: 'asc' },
      include,
    });
  }

  // (offer endpoint’in senin son hali aynen kalabilir)
  @UseGuards(AuthGuard('jwt'))
  @Post(':id/offers')
  async offer(
    @Param('id') id: string,
    @Body() body: { teamId: string },
    @Req() req: any,
  ) {
    const me = req.user ?? {};
    const meId: string | undefined = me.id ?? me.userId ?? me.sub;
    if (!meId) throw new BadRequestException('Giriş gerekli');

    const member = await this.prisma.teamMember.findFirst({
      where: { teamId: body.teamId, userId: meId, status: 'ACTIVE' },
    });
    if (!member) throw new BadRequestException('Bu takımda yetkin yok');

    const request = await this.prisma.teamMatchRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException('İlan bulunamadı');
    if (request.requestingTeamId === body.teamId) {
      throw new BadRequestException('Kendi ilanına teklif gönderemezsin');
    }

    try {
      const delegate: any = (this.prisma as any)['teamMatchOffer'];
      await delegate.create({ data: { requestId: id, offerTeamId: body.teamId } });
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException('Bu takım zaten teklif gönderdi');
      throw new BadRequestException('Teklif oluşturulamadı.');
    }
    return { ok: true };
  }
}
