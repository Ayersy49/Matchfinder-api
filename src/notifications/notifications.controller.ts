import { Controller, Get, Post, Query, Param, Req, UseGuards, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async list(@Req() req: any, @Query('unread') unread?: string) {
    const userId = req.user?.id || req.user?.sub;
    const where: any = { userId };
    if (String(unread) === '1') where.readAt = null;
    const items = await this.prisma.notification.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 50,
    });
    return { items, count: items.length };
  }

  @Post(':id/read')
  async read(@Req() req: any, @Param('id') id: string) {
    const userId = req.user?.id || req.user?.sub;
    const n = await this.prisma.notification.findUnique({ where: { id } });
    if (!n || n.userId !== userId) throw new NotFoundException('not_found');
    await this.prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
    return { ok: true };
  }

  // (Opsiyonel) son 24 saatte biten maçlar için rating hatırlatma tohumla
  @Post('seed-rating-reminders')
  async seedRatingReminders() {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const matches = await this.prisma.match.findMany({
      where: { time: { lt: new Date(), gt: since } },
      select: { id: true, slots: true },
    });
    let created = 0;
    for (const m of matches) {
      const uids = Array.from(new Set(((m.slots as any[]) ?? []).map(s => s?.userId).filter(Boolean)));
      for (const uid of uids) {
        try {
          await this.prisma.notification.create({
            data: { userId: String(uid), type: 'rating_reminder', matchId: m.id, data: { matchId: m.id } },
          });
          created++;
        } catch (e: any) { if (e?.code !== 'P2002') throw e; } // unique ihlali sessiz
      }
    }
    return { ok: true, created };
  }
}
