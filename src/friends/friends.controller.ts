import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Prisma } from '@prisma/client'; // sadece Prisma namespace lazım
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

// Prisma enum'u TS tarafında görünmüyorsa da derlensin diye union type:
type FriendRequestStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED';

function uid(req: any): string | undefined {
  return req?.user?.id ?? req?.user?.sub ?? req?.user?.userId ?? undefined;
}

@UseGuards(JwtAuthGuard)
@Controller('friends')
export class FriendsController {
  constructor(private readonly prisma: PrismaService) {}

  // ----- Gelen istekler
  @Get('requests/incoming')
  async incoming(@Req() req: any, @Query('status') status?: string) {
    const me = uid(req);
    if (!me) throw new UnauthorizedException();

    // Tip uyuşmazlıklarını beklemeden ilerlemek için any
    const where: any = { toId: me };
    if (status) {
      const s = String(status).toUpperCase();
      if (['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED'].includes(s)) where.status = s;
    }

    const items = await (this.prisma as any).friendRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        message: true,
        createdAt: true,
        updatedAt: true,
        from: { select: { id: true, phone: true } },
      },
    });

    return { items };
  }

  // ----- Gönderdiğim istekler
  @Get('requests/sent')
  async sent(@Req() req: any, @Query('status') status?: string) {
    const me = uid(req);
    if (!me) throw new UnauthorizedException();

    const where: any = { fromId: me };
    if (status) {
      const s = String(status).toUpperCase();
      if (['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED'].includes(s)) where.status = s;
    }

    const items = await (this.prisma as any).friendRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        message: true,
        createdAt: true,
        updatedAt: true,
        to: { select: { id: true, phone: true } },
      },
    });

    return { items };
  }

  // ----- İstek oluştur
  @Post('requests')
  async create(
    @Req() req: any,
    @Body() body: { toUserId?: string; toPhone?: string; message?: string },
  ) {
    const me = uid(req);
    if (!me) throw new UnauthorizedException();

    let to: { id: string } | null = null;

    if (body.toUserId) {
      to = await this.prisma.user.findUnique({
        where: { id: body.toUserId },
        select: { id: true },
      });
    } else if (body.toPhone) {
      const digits = String(body.toPhone).replace(/\D/g, '');
      const cand = [
        digits,
        digits.startsWith('0') ? digits.slice(1) : `0${digits}`,
        digits.startsWith('90') ? digits.slice(2) : `90${digits}`,
      ];
      to = await this.prisma.user.findFirst({
        where: { phone: { in: cand } },
        select: { id: true },
      });
    }

    if (!to) throw new BadRequestException('recipient_not_found');
    if (to.id === me) throw new BadRequestException('cannot_invite_yourself');

    const existing = await (this.prisma as any).friendRequest.findFirst({
      where: {
        fromId: me,
        toId: to.id,
        status: { in: ['PENDING', 'ACCEPTED'] },
      },
      select: { id: true, status: true },
    });
    if (existing) throw new ConflictException(`already ${String(existing.status).toLowerCase()}`);

    const created = await (this.prisma as any).friendRequest.create({
      data: { fromId: me, toId: to.id, message: body.message?.trim() || null },
    });

    return { ok: true, request: created };
  }

  // ----- İsteğe cevap
  @Post('requests/:id/respond')
  async respond(
    @Req() req: any,
    @Param('id') requestId: string,
    @Body() body: { action: 'ACCEPT' | 'DECLINE' | 'CANCEL' },
  ) {
    const me = uid(req);
    if (!me) throw new UnauthorizedException();

    const r = await (this.prisma as any).friendRequest.findUnique({ where: { id: requestId } });
    if (!r) throw new NotFoundException('request_not_found');

    // yetki
    if (body.action === 'CANCEL') {
      if (r.fromId !== me) throw new UnauthorizedException();
    } else {
      if (r.toId !== me) throw new UnauthorizedException();
    }

    if (r.status !== 'PENDING') throw new ConflictException('already_processed');

    let status: FriendRequestStatus;
    if (body.action === 'ACCEPT') status = 'ACCEPTED';
    else if (body.action === 'DECLINE') status = 'DECLINED';
    else status = 'CANCELLED';

    const updated = await (this.prisma as any).friendRequest.update({
      where: { id: r.id },
      data: { status },
    });

    // kabul edilirse arkadaşlığı yaz
    if (status === 'ACCEPTED') {
      const a = r.fromId < r.toId ? r.fromId : r.toId;
      const b = r.fromId < r.toId ? r.toId : r.fromId;

      await (this.prisma as any).friendship.upsert({
        where: { userId_friendId: { userId: a, friendId: b } },
        update: {},
        create: { userId: a, friendId: b },
      });
    }

    return { ok: true, request: updated };
  }

  // ----- Arkadaş listem
  @Get()
  async list(@Req() req: any) {
    const me = uid(req);
    if (!me) throw new UnauthorizedException();

    const rows = await (this.prisma as any).friendship.findMany({
      where: { OR: [{ userId: me }, { friendId: me }] },
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, phone: true } },
        friend: { select: { id: true, phone: true } },
      },
    });

    const items = rows.map((row: any) => {
      const other = row.userId === me ? row.friend : row.user;
      return { id: other.id, phone: other.phone, since: row.createdAt as Date };
    });

    return { items };
  }

  // ----- Arkadaşlıktan çıkar
  @Post(':otherId/remove')
  async remove(@Req() req: any, @Param('otherId') otherId: string) {
    const me = uid(req);
    if (!me) throw new UnauthorizedException();

    const a = me < otherId ? me : otherId;
    const b = me < otherId ? otherId : me;

    await (this.prisma as any).friendship.deleteMany({
      where: { userId: a, friendId: b },
    });

    return { ok: true };
  }
}
