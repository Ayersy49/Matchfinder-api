import { Controller, Get, Post, Param, Query, Req, UseGuards, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

function uid(req:any){ return req?.user?.id || req?.user?.sub || req?.user?.userId; }

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async list(@Req() req:any, @Query('unread') unread?: string) {
    const userId = uid(req); if(!userId) throw new UnauthorizedException();
    const where:any = { userId };
    if (unread) where.readAt = null;

    const items = await this.prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { ok:true, items };
  }
  

  @Post(':id/read')
  async read(@Req() req:any, @Param('id') id:string){
    const userId = uid(req); if(!userId) throw new UnauthorizedException();
    const n = await this.prisma.notification.findUnique({ where: { id } });
    if (!n || n.userId !== userId) throw new NotFoundException('not_found');
    await this.prisma.notification.update({ where:{ id }, data:{ readAt: new Date() } });
    return { ok:true };
  }
}
