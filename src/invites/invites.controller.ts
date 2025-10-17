// src/invites/invites.controller.ts
import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  Query,
  UseGuards,
  Req,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';

type InviteBodyByUsers =
  | { toUserId: string; message?: string }
  | { toUserIds: string[]; message?: string };

type InviteBodyByPhone = { toPhone: string; message?: string };

type ListStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED';

@Controller()
export class InvitesController {
  constructor(private prisma: PrismaService) {}

  private digits(s: string) {
    return String(s || '').replace(/\D/g, '');
  }

  private async ensureMatch(matchId: string) {
    const m = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { id: true },
    });
    if (!m) throw new NotFoundException('match_not_found');
    return m;
  }

  private async createInvite(
    matchId: string,
    fromUserId: string,
    opts: { toUserId?: string; toPhone?: string; message?: string },
  ) {
    if (!opts.toUserId && !opts.toPhone) {
      throw new BadRequestException('target_required');
    }

    // Aynı maça aynı hedefe PENDING varken yeniden oluşturma
    const existing = await this.prisma.matchInvite.findFirst({
      where: {
        matchId,
        toUserId: opts.toUserId ?? undefined,
        toPhone: opts.toPhone ?? undefined,
        status: 'PENDING' as any,
      },
      select: { id: true },
    });
    if (existing) return { created: false, id: existing.id };

    const inv = await this.prisma.matchInvite.create({
      data: {
        matchId,
        fromUserId,
        toUserId: opts.toUserId ?? null,
        toPhone: opts.toPhone ?? null,
        message: opts.message ?? null,
        status: 'PENDING' as any,
      },
      select: { id: true },
    });
    return { created: true, id: inv.id };
  }

  /* ----------------------------------------------------------------
   * YENİ “CREATE” ENDPOINT’LER
   * ---------------------------------------------------------------- */

  // POST /matches/:id/invite  (tek ya da çoklu userId)
  @UseGuards(JwtAuthGuard)
  @Post('matches/:id/invite')
  async inviteUsers(
    @Req() req: any,
    @Param('id') matchId: string,
    @Body() body: InviteBodyByUsers,
  ) {
    const meId = req?.user?.sub || req?.user?.id;
    if (!meId) throw new BadRequestException('unauthorized');

    await this.ensureMatch(matchId);

    const ids = Array.isArray((body as any).toUserIds)
      ? ((body as any).toUserIds as string[])
      : (body as any).toUserId
      ? [String((body as any).toUserId)]
      : [];

    if (ids.length === 0) throw new BadRequestException('toUserId(s)_required');

    let created = 0,
      skipped = 0;
    for (const toUserId of ids) {
      if (toUserId === meId) {
        skipped++;
        continue;
      }
      const r = await this.createInvite(matchId, meId, {
        toUserId,
        message: (body as any).message,
      });
      r.created ? created++ : skipped++;
    }

    return { ok: true, created, skipped };
  }

  // POST /matches/:id/invite-phone
  @UseGuards(JwtAuthGuard)
  @Post('matches/:id/invite-phone')
  async invitePhone(
    @Req() req: any,
    @Param('id') matchId: string,
    @Body() body: InviteBodyByPhone,
  ) {
    const meId = req?.user?.sub || req?.user?.id;
    if (!meId) throw new BadRequestException('unauthorized');

    await this.ensureMatch(matchId);

    const toPhone = this.digits(body?.toPhone || '');
    if (!toPhone) throw new BadRequestException('toPhone_required');

    const r = await this.createInvite(matchId, meId, {
      toPhone,
      message: body?.message,
    });
    return { ok: true, created: r.created ? 1 : 0, skipped: r.created ? 0 : 1 };
  }

  /* ----------------------------------------------------------------
   * LİSTELEME ENDPOINT’LERİ (inbox / sent)
   * FE’de mevcut yolları BOZMAMAK için hem yeni hem eski alias’lar var
   * ---------------------------------------------------------------- */

  // GET /matches/invites/inbox?status=PENDING
  @UseGuards(JwtAuthGuard)
  @Get('matches/invites/inbox')
  async inboxNew(@Req() req: any, @Query('status') status?: ListStatus) {
    const meId = req?.user?.sub || req?.user?.id;
    const where: any = { toUserId: meId };
    if (status) where.status = status as any;

    const items = await this.prisma.matchInvite.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { match: true, fromUser: true },
    });

    return {
      items: items.map((x) => ({
        id: x.id,
        matchId: x.matchId,
        fromUserId: x.fromUserId,
        message: x.message,
        status: x.status,
        createdAt: x.createdAt,
        match: x.match ? { id: x.match.id, title: x.match.title, time: x.match.time } : null,
        fromUser: x.fromUser ? { id: x.fromUser.id, phone: x.fromUser.phone } : null,
      })),
    };
  }

  // GET /matches/invites/sent?status=PENDING
  @UseGuards(JwtAuthGuard)
  @Get('matches/invites/sent')
  async sentNew(@Req() req: any, @Query('status') status?: ListStatus) {
    const meId = req?.user?.sub || req?.user?.id;
    const where: any = { fromUserId: meId };
    if (status) where.status = status as any;

    const items = await this.prisma.matchInvite.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { match: true, toUser: true },
    });

    return {
      items: items.map((x) => ({
        id: x.id,
        matchId: x.matchId,
        toUserId: x.toUserId,
        toPhone: x.toPhone,
        message: x.message,
        status: x.status,
        createdAt: x.createdAt,
        match: x.match ? { id: x.match.id, title: x.match.title, time: x.match.time } : null,
        toUser: x.toUser ? { id: x.toUser.id, phone: x.toUser.phone } : null,
      })),
    };
  }

  /* ----------------------------------------------------------------
   * ESKİ ALIAS’LAR — FE geriye dönük uyumluluk
   * ---------------------------------------------------------------- */

  // POST /invites  veya /invites/create
  @UseGuards(JwtAuthGuard)
  @Post('invites')
  async legacyCreate(@Req() req: any, @Body() body: any) {
    const matchId = body?.matchId;
    if (!matchId) throw new BadRequestException('matchId_required');

    if (body?.toPhone) {
      return this.invitePhone(req, matchId, {
        toPhone: body.toPhone,
        message: body?.message,
      });
    }
    const payload: InviteBodyByUsers = body?.toUserIds
      ? { toUserIds: body.toUserIds, message: body?.message }
      : { toUserId: body?.toUserId, message: body?.message };
    return this.inviteUsers(req, matchId, payload);
  }

  @UseGuards(JwtAuthGuard)
  @Post('invites/create')
  async legacyCreate2(@Req() req: any, @Body() body: any) {
    return this.legacyCreate(req, body);
  }

  // ESKİ: POST /matches/:id/invites  (Discover sayfası bunu vuruyor)
  @UseGuards(JwtAuthGuard)
  @Post('matches/:id/invites')
  async legacyMatchInvites(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    // body: { toUserId } veya { toUserIds } veya { toPhone }
    if (body?.toPhone) {
      return this.invitePhone(req, id, { toPhone: body.toPhone, message: body?.message });
    }
    const payload: InviteBodyByUsers = body?.toUserIds
      ? { toUserIds: body.toUserIds, message: body?.message }
      : { toUserId: body?.toUserId, message: body?.message };
    return this.inviteUsers(req, id, payload);
  }

  // ESKİ: GET /invites/inbox ve /invites/sent
  @UseGuards(JwtAuthGuard)
  @Get('invites/inbox')
  inboxOld(@Req() req: any, @Query('status') status?: ListStatus) {
    return this.inboxNew(req, status);
  }
  @UseGuards(JwtAuthGuard)
  @Get('invites/sent')
  sentOld(@Req() req: any, @Query('status') status?: ListStatus) {
    return this.sentNew(req, status);
  }
  /* ------------------------- RESPOND / CANCEL ------------------------- */

  // Genel respond (yeni yol)
  @UseGuards(JwtAuthGuard)
  @Post('invites/:id/respond')
  async respondInvite(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { action?: string; status?: string },
  ) {
    const meId = req?.user?.sub || req?.user?.id;
    if (!meId) throw new BadRequestException('unauthorized');

    const inv = await this.prisma.matchInvite.findUnique({
      where: { id },
      select: { id: true, matchId: true, fromUserId: true, toUserId: true, status: true },
    });
    if (!inv) throw new NotFoundException('invite_not_found');

    if (inv.toUserId !== meId) throw new BadRequestException('not_receiver');
    if (inv.status !== ('PENDING' as any)) throw new BadRequestException('not_pending');

    const raw = String(body?.action || body?.status || '').toUpperCase();
    const map: Record<string, 'ACCEPTED' | 'DECLINED'> = {
      ACCEPT: 'ACCEPTED',
      ACCEPTED: 'ACCEPTED',
      YES: 'ACCEPTED',
      OK: 'ACCEPTED',
      DECLINE: 'DECLINED',
      DECLINED: 'DECLINED',
      REJECT: 'DECLINED',
      NO: 'DECLINED',
    };
    const next = map[raw];
    if (!next) throw new BadRequestException('invalid_action');

    await this.prisma.matchInvite.update({
      where: { id },
      data: { status: next as any, respondedAt: new Date() },
    });

    // (Opsiyonel) Kabulde otomatik slota ekleme vb. burada yapılabilir.

    return { ok: true, status: next };
  }

  // Eski alias: POST /matches/invites/:id/respond
  @UseGuards(JwtAuthGuard)
  @Post('matches/invites/:id/respond')
  respondInviteLegacy(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    return this.respondInvite(req, id, body);
  }

  // Daveti iptal (gönderen)
  @UseGuards(JwtAuthGuard)
  @Post('invites/:id/cancel')
  async cancelInvite(@Req() req: any, @Param('id') id: string) {
    const meId = req?.user?.sub || req?.user?.id;
    if (!meId) throw new BadRequestException('unauthorized');

    const inv = await this.prisma.matchInvite.findUnique({
      where: { id },
      select: { id: true, fromUserId: true, status: true },
    });
    if (!inv) throw new NotFoundException('invite_not_found');
    if (inv.fromUserId !== meId) throw new BadRequestException('not_sender');
    if (inv.status !== ('PENDING' as any)) throw new BadRequestException('not_pending');

    await this.prisma.matchInvite.update({
      where: { id },
      data: { status: 'CANCELLED' as any, respondedAt: new Date() },
    });

    return { ok: true, status: 'CANCELLED' };
  }
  // Eski alias: /matches/invites/:id/cancel
  @UseGuards(JwtAuthGuard)
  @Post('matches/invites/:id/cancel')
  cancelInviteLegacy(@Req() req: any, @Param('id') id: string) {
    return this.cancelInvite(req, id);
  }
}
