import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Prisma, InviteStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard'; // <<<

import {
  buildInitialSlots,
  upgradeLegacySlots,
  normalizeSlots,
  removeUser,
  Slot,
  Team,
} from './slots';

type InviteDtoCreate = {
  toUserId?: string;
  toPhone?: string;
  message?: string;
};
type InviteDtoRespond = {
  action: 'ACCEPT' | 'DECLINE' | 'CANCEL';
};

function getUserIdFromReq(req: any): string | undefined {
  return req?.user?.id || req?.user?.sub || req?.user?.userId || undefined;
}

type AccessResult = { ok: true } | { ok: false; code: 'not_found' | 'forbidden' };
async function canAccessMatch(
  prisma: PrismaService,
  matchId: string,
  userId: string,
): Promise<AccessResult> {
  const m = await prisma.match.findUnique({
    where: { id: matchId },
    select: { id: true, ownerId: true, slots: true, format: true },
  });
  if (!m) return { ok: false, code: 'not_found' };
  if (m.ownerId === userId) return { ok: true };
  const slots = normalizeSlots(m.slots, m.format);
  const isParticipant = slots.some((s) => s.userId === userId);
  return isParticipant ? { ok: true } : { ok: false, code: 'forbidden' };
}

@Controller('matches')
export class MatchesController {
  constructor(private prisma: PrismaService) {}

  /* -------------------- LİSTE -------------------- */
  @Get()
  async list(@Query() _q: any) {
    const items = await this.prisma.match.findMany({
      orderBy: [{ time: 'asc' as const }, { createdAt: 'desc' as const }],
      select: {
        id: true,
        title: true,
        location: true,
        level: true,
        format: true,
        price: true,
        time: true,
        createdAt: true,
        slots: true,
        ownerId: true,
      },
    });
    return items.map((m) => ({
      ...m,
      slots: normalizeSlots(m.slots, m.format),
    }));
  }

  /* -------------------- DETAY -------------------- */
  @Get(':id')
  async detail(@Param('id') id: string) {
    const m = await this.prisma.match.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        location: true,
        level: true,
        format: true,
        price: true,
        time: true,
        createdAt: true,
        updatedAt: true,
        ownerId: true,
        slots: true,
      },
    });
    if (!m) throw new NotFoundException('match not found');
    return { ...m, slots: normalizeSlots(m.slots, m.format) };
  }

  /* -------------------- OLUŞTUR -------------------- */
  @Post()
  @UseGuards(JwtAuthGuard)
  async create(@Req() req: any, @Body() body: any) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new HttpException('unauthorized', HttpStatus.UNAUTHORIZED);

    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!me) throw new UnauthorizedException('reauth_required');

    const fmt = (body?.format ?? '7v7') as string;
    const initialSlots: Slot[] = buildInitialSlots(fmt, body?.positions);

    const created = await this.prisma.match.create({
      data: {
        title: body?.title ?? null,
        location: body?.location ?? null,
        level: body?.level ?? null,
        format: fmt,
        price: typeof body?.price === 'number' ? body.price : null,
        time: body?.time ?? null,
        slots: initialSlots as unknown as Prisma.JsonArray,
        ownerId: userId,
      },
      select: {
        id: true,
        title: true,
        location: true,
        level: true,
        format: true,
        price: true,
        time: true,
        createdAt: true,
        ownerId: true,
        slots: true,
      },
    });

    return { ...created, slots: initialSlots };
  }

  /* -------------------- KATIL -------------------- */
  @Post('join')
  @UseGuards(JwtAuthGuard)
  async join(
    @Req() req: any,
    @Body() body: { matchId: string; pos?: string; team?: Team; strict?: boolean },
  ) {
    // >>> geçici debug – sorun devam ederse ENV ile aç-kapa
    if (process.env.DEBUG_AUTH === '1') {
      console.log('[JOIN] AUTH HDR =', req.headers?.authorization);
      console.log('[JOIN] USER     =', req.user);
    }

    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();

    const match = await this.prisma.match.findUnique({ where: { id: body.matchId } });
    if (!match) throw new NotFoundException('match not found');

    const slots: Slot[] = normalizeSlots((match as any).slots, (match as any).format);

    // Zaten katıldıysa
    const mine = slots.find((s) => s.userId === userId);
    if (mine) return { ok: true, pos: mine.pos };

    // Pozisyon geldiyse
    let desired = body.pos?.trim().toUpperCase();
    if (desired) {
      const ok = slots.some(
        (s) => s.pos === desired && !s.userId && (!body.team || s.team === body.team),
      );
      if (!ok) throw new ConflictException('slot already taken');
    }

    // Gelmediyse: tercihlerden oto
    if (!desired) {
      const me = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { positions: true },
      });

      const prefs: string[] = Array.isArray(me?.positions)
        ? (me!.positions as any[]).map(String).slice(0, 3).map((p) => p.toUpperCase())
        : [];

      const open = new Set(
        slots.filter((s) => !s.userId && (!body.team || s.team === body.team)).map((s) => s.pos),
      );

      desired = prefs.find((p) => open.has(p));
      if (!desired) throw new ConflictException('no preferred open slot'); // 409
    }

    // Atomik güncelle
    await this.prisma.$transaction(async (tx) => {
      const fresh = await tx.match.findUnique({ where: { id: match.id } });
      const arr: Slot[] = normalizeSlots((fresh as any)?.slots, (fresh as any)?.format);

      const i = arr.findIndex(
        (s) => s.pos === desired && !s.userId && (!body.team || s.team === body.team),
      );
      if (i === -1) throw new ConflictException('slot already taken');

      // Eski yerinden temizle
      for (const s of arr) if (s.userId === userId) s.userId = null;

      arr[i] = { ...arr[i], userId };

      await tx.match.update({
        where: { id: match.id },
        data: { slots: arr as unknown as Prisma.JsonArray },
        select: { id: true },
      });
    });

    return { ok: true, pos: desired };
  }

  // Maç sahibinin temel alanları düzenlemesi
  @Post(':id/edit')
  @UseGuards(JwtAuthGuard)
  async editMatch(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: {
      title?: string | null;
      location?: string | null;
      level?: string | null;       // "Kolay" | "Orta" | "Zor" (serbest string de olur)
      format?: string | null;      // "5v5" | "7v7" | "8v8" | "11v11"
      price?: number | null;
      time?: string | null;        // ISO veya datetime-local string (parse edeceğiz)
    },
  ) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();

    const current = await this.prisma.match.findUnique({
      where: { id },
      select: { ownerId: true, slots: true, format: true },
    });
    if (!current) throw new NotFoundException('match not found');
    if (current.ownerId !== userId) throw new UnauthorizedException('not_owner');

    // Gönderilen alanları nazikçe normalize et
    const data: any = {};
    const normStr = (v: any) =>
      typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : v ?? null;

    if ('title' in body)    data.title    = normStr(body.title);
    if ('location' in body) data.location = normStr(body.location);
    if ('level' in body)    data.level    = normStr(body.level);
    if ('price' in body)    data.price    = body.price === null ? null : Number(body.price);

    if ('time' in body) {
      if (!body.time) data.time = null;
      else {
        const d = new Date(body.time);
        if (isNaN(d.getTime())) throw new BadRequestException('invalid time');
        data.time = d.toISOString();
      }
    }

    if ('format' in body) {
      const nextFmt = normStr(body.format);
      if (nextFmt && nextFmt !== current.format) {
        // Güvenli yaklaşım: format değişimi, biri katılmışsa kilitli
        const anyJoined = normalizeSlots(current.slots, current.format).some(s => !!s.userId);
        if (anyJoined) {
          throw new ConflictException('format_locked'); // UI’da uyarı göster
        }
        data.format = nextFmt;
        // Not: Var olan slotları koruduk; istersen burada buildInitialSlots ile yeniden kurabilirsin.
      }
    }

    await this.prisma.match.update({ where: { id }, data, select: { id: true }});
    return { ok: true };
  }


  /* -------------------- AYRIL (REST: /matches/:id/leave) -------------------- */
  @Post(':id/leave')
  @UseGuards(JwtAuthGuard)
  async leaveRest(@Req() req: any, @Param('id') matchId: string) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();

    const m = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { id: true, slots: true, format: true },
    });
    if (!m) throw new NotFoundException('match not found');

    const slots = normalizeSlots(m.slots, m.format);
    let changed = false;
    for (const s of slots) {
      if (s.userId === userId) {
        s.userId = null;
        changed = true;
      }
    }
    if (!changed) return { ok: true };

    await this.prisma.match.update({
      where: { id: matchId },
      data: { slots: slots as unknown as Prisma.JsonArray },
    });

    return { ok: true };
  }

  /* -------------------- ESKİ MAÇ TEMİZLEME -------------------- */
  @Post('delete-old')
  @UseGuards(JwtAuthGuard)
  async deleteOld() {
    const now = new Date();
    const threeDaysAgo = new Date(Date.now() - 1000 * 60 * 60 * 24 * 3);

    const r1 = await this.prisma.match.deleteMany({ where: { time: { lt: now } } });
    const r2 = await this.prisma.match.deleteMany({
      where: { AND: [{ time: { equals: null } as any }, { createdAt: { lt: threeDaysAgo } }] },
    });

    return { ok: true, deleted: r1.count + r2.count, parts: { past: r1.count, stale: r2.count } };
  }

  /* -------------------- SLOT UPGRADE -------------------- */
  @Post('upgrade-slots')
  @UseGuards(JwtAuthGuard)
  async upgradeAll() {
    const all = await this.prisma.match.findMany({ select: { id: true, format: true, slots: true } });
    let updated = 0;
    for (const m of all) {
      const upgraded = upgradeLegacySlots(m.slots, m.format);
      if (Array.isArray(m.slots) && (m.slots as any[])[0]?.team) continue;
      await this.prisma.match.update({
        where: { id: m.id },
        data: { slots: upgraded as unknown as Prisma.JsonArray },
      });
      updated++;
    }
    return { ok: true, updated };
  }

  /* ===================== SOHBET API ===================== */
  @UseGuards(JwtAuthGuard)
  @Get(':id/messages')
  async listMessages(
    @Req() req: any,
    @Param('id') matchId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit = '30',
  ) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();

    const access = await canAccessMatch(this.prisma, matchId, userId);
    if (!access.ok) {
      if (access.code === 'not_found') throw new NotFoundException('match not found');
      throw new UnauthorizedException();
    }

    const take = Math.max(1, Math.min(parseInt(String(limit) || '30', 10), 100));

    const messages = await this.prisma.message.findMany({
      where: { matchId },
      orderBy: { createdAt: 'desc' },
      take,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: {
        id: true,
        userId: true,
        text: true,
        deleted: true,
        createdAt: true,
        updatedAt: true,
        editedAt: true,
      },
    });

    return { items: messages.reverse() };
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/messages')
  async createMessage(
    @Req() req: any,
    @Param('id') matchId: string,
    @Body() body: { text?: string },
  ) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();

    const access = await canAccessMatch(this.prisma, matchId, userId);
    if (!access.ok) {
      if (access.code === 'not_found') throw new NotFoundException('match not found');
      throw new UnauthorizedException();
    }

    const text = (body?.text || '').trim();
    if (!text) throw new BadRequestException('text required');

    const msg = await this.prisma.message.create({
      data: { matchId, userId, text },
      select: {
        id: true,
        userId: true,
        text: true,
        deleted: true,
        createdAt: true,
        updatedAt: true,
        editedAt: true,
      },
    });

    return { ok: true, message: msg };
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/messages/:msgId/edit')
  async editMessage(
    @Req() req: any,
    @Param('id') matchId: string,
    @Param('msgId') msgId: string,
    @Body() body: { text?: string },
  ) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();

    const access = await canAccessMatch(this.prisma, matchId, userId);
    if (!access.ok) {
      if (access.code === 'not_found') throw new NotFoundException('match not found');
      throw new UnauthorizedException();
    }

    const msg = await this.prisma.message.findUnique({ where: { id: msgId } });
    if (!msg || msg.matchId !== matchId) throw new NotFoundException('message not found');
    if (msg.userId !== userId) throw new UnauthorizedException('not_owner');

    const text = (body?.text || '').trim();
    if (!text) throw new BadRequestException('text required');

    const updated = await this.prisma.message.update({
      where: { id: msgId },
      data: { text, editedAt: new Date() },
      select: {
        id: true,
        userId: true,
        text: true,
        deleted: true,
        createdAt: true,
        updatedAt: true,
        editedAt: true,
      },
    });

    return { ok: true, message: updated };
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/messages/:msgId/delete')
  async deleteMessage(
    @Req() req: any,
    @Param('id') matchId: string,
    @Param('msgId') msgId: string,
  ) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();

    const access = await canAccessMatch(this.prisma, matchId, userId);
    if (!access.ok) {
      if (access.code === 'not_found') throw new NotFoundException('match not found');
      throw new UnauthorizedException();
    }

    const msg = await this.prisma.message.findUnique({ where: { id: msgId } });
    if (!msg || msg.matchId !== matchId) throw new NotFoundException('message not found');
    if (msg.userId !== userId) throw new UnauthorizedException('not_owner');

    const updated = await this.prisma.message.update({
      where: { id: msgId },
      data: { deleted: true, text: '' },
      select: {
        id: true,
        userId: true,
        text: true,
        deleted: true,
        createdAt: true,
        updatedAt: true,
        editedAt: true,
      },
    });

    return { ok: true, message: updated };
  }

  /* ================== INVITES ================== */
  @UseGuards(JwtAuthGuard)
  @Get(':id/invites')
  async listInvites(@Req() req: any, @Param('id') matchId: string) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();

    const access = await canAccessMatch(this.prisma, matchId, userId);
    if (!access.ok) {
      if (access.code === 'not_found') throw new NotFoundException('match not found');
      throw new UnauthorizedException();
    }

    const rows = await this.prisma.invite.findMany({
      where: { matchId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        matchId: true,
        status: true,
        message: true,
        createdAt: true,
        updatedAt: true,
        from: { select: { id: true, phone: true } },
        to: { select: { id: true, phone: true } },
      },
    });

    return { items: rows };
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/invites')
  async createInvite(
    @Req() req: any,
    @Param('id') matchId: string,
    @Body() body: InviteDtoCreate,
  ) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();

    const access = await canAccessMatch(this.prisma, matchId, userId);
    if (!access.ok) {
      if (access.code === 'not_found') throw new NotFoundException('match not found');
      throw new UnauthorizedException();
    }

    let toUser: { id: string } | null = null;
    if (body.toUserId) {
      toUser = await this.prisma.user.findUnique({ where: { id: body.toUserId }, select: { id: true } });
    } else if ((body.toPhone ?? '').trim()) {
      const digits = String(body.toPhone).replace(/\D/g, '');
      const cand = [
        digits,
        digits.startsWith('0') ? digits.slice(1) : `0${digits}`,
        digits.startsWith('90') ? digits.slice(2) : `90${digits}`,
        digits.startsWith('90') ? `0${digits.slice(2)}` : undefined,
        digits.startsWith('905') ? digits.slice(2) : undefined,
        digits.startsWith('905') ? `0${digits.slice(2)}` : undefined,
      ].filter(Boolean) as string[];
      toUser = await this.prisma.user.findFirst({ where: { phone: { in: cand } }, select: { id: true } });
    }

    if (!toUser) throw new BadRequestException('recipient not found');
    if (toUser.id === userId) throw new BadRequestException('cannot invite yourself');

    const existing = await this.prisma.invite.findFirst({
      where: {
        matchId,
        fromId: userId,
        toId: toUser.id,
        status: { in: [InviteStatus.PENDING, InviteStatus.ACCEPTED] },
      },
      select: { id: true, status: true },
    });
    if (existing) throw new ConflictException(`already ${existing.status.toLowerCase()}`);

    const created = await this.prisma.invite.create({
      data: {
        matchId,
        fromId: userId,
        toId: toUser.id,
        message: body.message?.trim() || null,
      },
      select: {
        id: true,
        status: true,
        message: true,
        createdAt: true,
        from: { select: { id: true, phone: true } },
        to: { select: { id: true, phone: true } },
      },
    });

    return { ok: true, invite: created };
  }

  @UseGuards(JwtAuthGuard)
  @Post('invites/:inviteId/respond')
  async respondInvite(
    @Req() req: any,
    @Param('inviteId') inviteId: string,
    @Body() body: InviteDtoRespond,
  ) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();

    const inv = await this.prisma.invite.findUnique({
      where: { id: inviteId },
      select: { id: true, matchId: true, fromId: true, toId: true, status: true },
    });
    if (!inv) throw new NotFoundException('invite not found');

    if (body.action === 'ACCEPT' || body.action === 'DECLINE') {
      if (inv.toId !== userId) throw new UnauthorizedException();
    } else if (body.action === 'CANCEL') {
      if (inv.fromId !== userId) throw new UnauthorizedException();
    } else {
      throw new BadRequestException('invalid action');
    }

    if (inv.status !== InviteStatus.PENDING) throw new ConflictException('already processed');

    const status: InviteStatus =
      body.action === 'ACCEPT'
        ? InviteStatus.ACCEPTED
        : body.action === 'DECLINE'
        ? InviteStatus.DECLINED
        : InviteStatus.CANCELLED;

    const updated = await this.prisma.invite.update({
      where: { id: inviteId },
      data: { status },
      select: { id: true, status: true, matchId: true },
    });

    return { ok: true, invite: updated };
  }

  /* ================== INBOX / OUTBOX ================== */
  @UseGuards(JwtAuthGuard)
  @Get('invites/inbox')
  async listMyIncomingInvites(@Req() req: any, @Query('status') status?: string) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();

    const where: any = { toId: userId };
    if (status) {
      const s = String(status).toUpperCase();
      if (['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED'].includes(s)) where.status = s;
    }

    const rows = await this.prisma.invite.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        message: true,
        createdAt: true,
        updatedAt: true,
        from: { select: { id: true, phone: true } },
        match: { select: { id: true, title: true, time: true, location: true, format: true, level: true } },
      },
    });

    return { items: rows };
  }

  @UseGuards(JwtAuthGuard)
  @Get('invites/sent')
  async listMySentInvites(@Req() req: any, @Query('status') status?: string) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();

    const where: any = { fromId: userId };
    if (status) {
      const s = String(status).toUpperCase();
      if (['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED'].includes(s)) where.status = s;
    }

    const rows = await this.prisma.invite.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        message: true,
        createdAt: true,
        updatedAt: true,
        to: { select: { id: true, phone: true } },
        match: { select: { id: true, title: true, time: true, location: true, format: true, level: true } },
      },
    });

    return { items: rows };
  }
}
