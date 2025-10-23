import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller('users')
export class UsersPositionsController {
  constructor(private prisma: PrismaService) {}

  // GET /users/:id/positions -> [{ pos:'LW', avg:6.8, samples:12 }, ...]
  @Get(':id/positions')
  async positions(@Param('id') id: string) {
    const u = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!u) throw new NotFoundException('user_not_found');

    const grouped = await this.prisma.positionRating.groupBy({
      by: ['pos'],
      where: { rateeId: id },
      _avg: { score: true },
      _count: { _all: true },
    });

    return grouped.map((x) => ({
      pos: x.pos,
      avg: Number(x._avg?.score ?? 0),
      samples: Number(x._count?._all ?? 0),
    }));
  }
}
