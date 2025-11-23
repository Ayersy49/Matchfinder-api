// src/matches/matches.controller.ts
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
  ForbiddenException,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Logger } from '@nestjs/common';


import {
  buildInitialSlots,
  normalizeSlots,
  teamSizeFromFormat,
  Slot,
  Team,
  isFree,
  reserveSlot,
  releaseReserved,
} from './slots';

/* ---------- Local TS helper types to satisfy strict mode ---------- */
type MatchListItem = {
  id: string;
  title: string | null;
  location: string | null;
  level: string | null;
  format: string | null;
  price: number | null;
  time: Date | string | null;
  createdAt: Date | string;
  slots: any;
  ownerId: string | null;
  inviteOnly: boolean;
  status: any;
  closedAt: Date | string | null;
  listed: boolean;
  seriesId: string | null;
  createdFrom: string | null;
  highlightUntil: Date | string | null;
  teamAId: string | null;
  teamBId: string | null;
};

type ReqStatus = 'PENDING' | 'APPROVED' | 'DECLINED';

type SimpleUser = {
  id: string;
  phone: string | null;
  level: number | null;
  positions: any;
};

type CandidateUser = {
  id: string;
  phone: string | null;
  level: number | null;
  positions: any;
  availability: any;
  lat: number | null;
  lng: number | null;
};

type ScoredCandidate = {
  id: string;
  phone: string | null;
  level: number | null;
  positions: string[];
  distanceKm: number;
  isFriend: boolean;
  score: number;
  tags: string[];
};

/* ---------- SUB sayısı: 5v5–6v6 → 1, 7v7–9v9 → 2, 10v10–11v11 → 3 ---------- */
function reservesPerTeamByFormat(fmt: string) {
  const n = teamSizeFromFormat(fmt);
  if (n <= 6) return 1;
  if (n <= 9) return 2;
  return 3;
}

/* -------------------- Yardımcılar -------------------- */
function getUserIdFromReq(req: any): string | undefined {
  return req?.user?.id || req?.user?.sub || req?.user?.userId || undefined;
}

function ratingWindowPassed(m: { time?: Date | string | null }): boolean {
  if (!m?.time) return false;
  const t = new Date(m.time as any).getTime();
  return Number.isFinite(t) && Date.now() >= t + 24 * 3600 * 1000;
}


// sadece takım maçı kontrolü
async function ensureTeamMatch(prisma: PrismaService, matchId: string) {
  const m = await prisma.match.findUnique({
    where: { id: matchId },
    select: { createdFrom: true },
  });
  if (!m) throw new NotFoundException('match not found');
  if (m.createdFrom !== 'TEAM_MATCH') {
    throw new ForbiddenException('team_match_only');
  }
}


function effectiveStatus(m: { status?: string | null; time?: any }): 'DRAFT' | 'OPEN' | 'CLOSED' {
  if (m.status === 'CLOSED') return 'CLOSED';
  if (ratingWindowPassed(m)) return 'CLOSED';
  return (m.status as any) || 'OPEN';
}

/* ---- Zaman önerisi yardımcıları ---- */
const PROPOSAL_LIMIT = 3;

// Bu kullanıcı A mı B mi admin? (OWNER/ADMIN & ACTIVE)
async function adminSideForMatch(
  prisma: PrismaService,
  matchId: string,
  userId: string,
): Promise<'A' | 'B' | null> {
  const m = await prisma.match.findUnique({
    where: { id: matchId },
    select: { teamAId: true, teamBId: true },
  });
  if (!m) return null;

  const isAdminOf = async (teamId?: string | null) => {
    if (!teamId) return false;
    const tm = await (prisma as any).teamMember.findFirst({
      where: {
        teamId,
        userId,
        status: 'ACTIVE',
        role: { in: ['OWNER', 'ADMIN'] },
      },
      select: { teamId: true },
    });
    return !!tm;
  };

  if (await isAdminOf(m.teamAId)) return 'A';
  if (await isAdminOf(m.teamBId)) return 'B';
  return null;
}

// Admin onayı kayıt tipi: time_proposal_admin_approve:<pid>:<A|B>
function adminApproveType(pid: string, side: 'A' | 'B') {
  return `time_proposal_admin_approve:${pid}:${side}`;
}


/* ---- ICS yardımcıları ---- */
function icsEscape(s: string) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\n/g, '\\n');
}
function dtStamp(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}
function addMinutes(d: Date, min: number) {
  return new Date(d.getTime() + min * 60 * 1000);
}

/* ===================================================== */

@Controller('matches')

export class MatchesController {
  constructor(private prisma: PrismaService) {}
  private readonly logger = new Logger(MatchesController.name);
  private readonly DEBUG_MATCHES = process.env.DEBUG_MATCHES === '1';



  /* -------------------- LİSTE -------------------- */
  @Get()
  @UseGuards(JwtAuthGuard)
  async list(@Req() req: any, @Query() _q: any) {
    const meId: string | null = getUserIdFromReq(req) ?? null;

    // sadece yayınlanmışlar
    const where: any = { listed: true };
    if (req.user?.role === 'ADMIN' && String(_q?.includeHidden) === '1') {
      delete where.listed;
    }

    let items: MatchListItem[] = await this.prisma.match.findMany({
      where,
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
        inviteOnly: true,
        status: true,
        closedAt: true,
        listed: true,
        seriesId: true,
        createdFrom: true,
        highlightUntil: true,
        teamAId: true,
        teamBId: true,
      },
    });

    // her seriden yalnızca en yakın gelecektekini göster
    const now = new Date();
    const hidePast = String(_q?.hidePast || '') === '1';
    const seenSeries = new Set<string>();

    items = items.filter((m: MatchListItem) => {
      const isPast = m.time ? new Date(m.time as any) < now : false;
      if (hidePast && isPast) return false;

      if (m.seriesId) {
        if (isPast) return false;
        if (seenSeries.has(m.seriesId)) return false;
        seenSeries.add(m.seriesId);
      }
      return true;
    });

    // user yoksa normalize edip dön
    if (!meId) {
      return items.map((m) => {
        const base = {
          ...m,
          statusEffective: effectiveStatus(m),
          slots: normalizeSlots(m.slots, m.format ?? undefined),
        };
        if (m.createdFrom === 'TEAM_MATCH' && !m.highlightUntil) {
          const until = new Date(new Date(m.createdAt).getTime() + 36 * 3600 * 1000);
          return { ...base, highlightUntil: until.toISOString() };
        }
        return base;
      });
    }

    const matchIds = items.map((m) => m.id);

    // erişim istekleri (benim için)
    const reqs: Array<{ matchId: string; status: ReqStatus }> =
      await this.prisma.matchAccessRequest.findMany({
        where: {
          requesterId: meId,
          matchId: { in: matchIds },
          status: { in: ['PENDING', 'APPROVED'] as any },
        },
        select: { matchId: true, status: true },
      });
    const approvedSet = new Set(
      reqs
        .filter((r: { matchId: string; status: ReqStatus }) => r.status === 'APPROVED')
        .map((r: { matchId: string; status: ReqStatus }) => r.matchId),
    );
    const pendingSet = new Set(
      reqs
        .filter((r: { matchId: string; status: ReqStatus }) => r.status === 'PENDING')
        .map((r: { matchId: string; status: ReqStatus }) => r.matchId),
    );

    /* 1) normalize + access owner/joined/canView */
    const normalized = items.map((m: MatchListItem) => {
      let slots = normalizeSlots(m.slots, m.format ?? undefined);
      if (!Array.isArray(slots) || slots.length === 0) {
        const fmt = m.format || '7v7';
        const per = reservesPerTeamByFormat(fmt);
        slots = buildInitialSlots(fmt, undefined, per);
      }

      const owner = m.ownerId === meId;
      const joined = slots.some((s) => s.userId === meId);
      const canView = !m.inviteOnly || owner || joined || approvedSet.has(m.id);

      return {
        ...m,
        statusEffective: effectiveStatus(m),
        slots,
        access: {
          owner,
          joined,
          canView,
          requestPending: pendingSet.has(m.id),
        },
      };
    });

    /* 2) Üyelikleri çek (seri için) */
    const seriesIds = Array.from(
      new Set(normalized.map((m) => m.seriesId).filter(Boolean) as string[]),
    );
    let memberSet = new Set<string>();
    if (meId && seriesIds.length) {
      const memberships = await (this.prisma as any).seriesMember.findMany({
        where: { seriesId: { in: seriesIds }, userId: meId, active: true },
        select: { seriesId: true },
      });
      memberSet = new Set(memberships.map((x: any) => x.seriesId));
    }

    /* 3) tek return */
    return normalized.map((m: any) => {
      const extra: Partial<typeof m> = {};
      if (m.createdFrom === 'TEAM_MATCH' && !m.highlightUntil) {
        const untilIso = new Date(
          new Date(m.createdAt as any).getTime() + 36 * 3600 * 1000,
        ).toISOString();
        (extra as any).highlightUntil = untilIso;
      }

      return {
        ...m,
        ...extra,
        access: {
          ...m.access,
          isSeriesMember: Boolean(m.seriesId && memberSet.has(m.seriesId as string)),
        },
      };
    });
  }

  /* -------------------- DETAY -------------------- */
  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async findOne(@Param('id') id: string, @Req() req: any) {
    const meId: string | null = getUserIdFromReq(req) ?? null;

    const m = await this.prisma.match.findUnique({
      where: { id },
      select: {
        id: true,
        ownerId: true,
        title: true,
        location: true,
        level: true,
        format: true,
        price: true,
        time: true,
        slots: true,
        inviteOnly: true,
        createdAt: true,
        updatedAt: true,
        status: true,
        closedAt: true,
        createdFrom: true,
        highlightUntil: true,
        teamAId: true,
        teamBId: true,
      },
    });
    if (!m) throw new NotFoundException('not_found');


    // kilitli ise erişim kontrolü
    if (m.inviteOnly) {
      const acc = meId
        ? await canAccessMatch(this.prisma, id, meId)
        : ({ ok: false, code: 'forbidden' } as const);
      if (!acc.ok) throw new ForbiddenException('locked');
    }

    // normalize + fallback
    let slots = normalizeSlots(m.slots, m.format ?? undefined);
    if (!Array.isArray(slots) || slots.length === 0) {
      const fmt = m.format || '7v7';
      const per = reservesPerTeamByFormat(fmt);
      slots = buildInitialSlots(fmt, undefined, per);
    }



    const base = {
      ...m,
      statusEffective: effectiveStatus(m),
      slots,
    };

    const owner = meId ? m.ownerId === meId : false;
    const joined = meId ? base.slots.some((s: any) => s?.userId === meId) : false;
    const canEdit = meId ? await canEditMatchSchedule(this.prisma, id, meId) : false;
    const access = { owner, joined, canView: true, requestPending: false, canEdit };

    if (m.createdFrom === 'TEAM_MATCH' && !m.highlightUntil) {
      const untilIso = new Date(
        new Date(m.createdAt as any).getTime() + 36 * 3600 * 1000,
      ).toISOString();
      return { ...base, access, highlightUntil: untilIso };
    }
    return { ...base, access };
  }

  /* -------------------- SAAT ÖNER -------------------- */
  @UseGuards(JwtAuthGuard)
  @Post(':id/propose-time')
  async proposeTime(
    @Req() req: any,
    @Param('id') matchId: string,
    @Body() body: { time?: string },
  ) {
    const userId = req.user?.id || req.user?.sub;
    if (!userId) throw new UnauthorizedException();

    const m = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { createdFrom: true },
    });
    if (!m) throw new NotFoundException('match_not_found');
    if (m.createdFrom !== 'TEAM_MATCH') throw new ForbiddenException('only_for_team_match');

    const side = await adminSideForMatch(this.prisma as any, matchId, userId);
    if (!side) throw new ForbiddenException('not_allowed');

    const iso = String(body?.time || '').trim();
    const d = new Date(iso);
    if (!iso || isNaN(d.getTime())) throw new BadRequestException('invalid_time');
    const normIso = d.toISOString();

    const existing = await (this.prisma as any).notification.findMany({
      where: { type: 'time_proposal', matchId },
      select: { data: true },
    });
    if (existing.some((p: any) => String(p?.data?.time || '') === normIso)) {
      throw new ConflictException('duplicate_time');
    }

    const existed = await (this.prisma as any).notification.findFirst({
      where: { userId, type: 'time_proposal', matchId },
      select: { id: true },
    });
    if (existed) {
      await (this.prisma as any).notification.update({
        where: { id: existed.id },
        data: { data: { matchId, time: normIso, by: userId } },
      });
    } else {
      await (this.prisma as any).notification.create({
        data: { userId, type: 'time_proposal', matchId, data: { matchId, time: normIso, by: userId } },
      });
    }
    return { ok: true };
  }


  /* -------------------- MAÇ DURUMU -------------------- */
  @Post(':id/status')
  @UseGuards(JwtAuthGuard)
  async setStatus(
    @Req() req: any,
    @Param('id') matchId: string,
    @Body() body: { status: 'OPEN' | 'CLOSED' | 'DRAFT' },
  ) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();
    const m = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { ownerId: true },
    });
    if (!m) throw new NotFoundException('match_not_found');
    if (m.ownerId !== userId) throw new ForbiddenException('only_owner');

    const next = String(body?.status || '').toUpperCase();
    if (!['OPEN', 'CLOSED', 'DRAFT'].includes(next))
      throw new BadRequestException('invalid_status');

    await this.prisma.match.update({
      where: { id: matchId },
      data: { status: next as any, closedAt: next === 'CLOSED' ? new Date() : null },
    });
    return { ok: true };
  }

  /* -------------------- ERİŞİM İSTEĞİ OLUŞTUR -------------------- */
  @Post(':id/request-access')
  @UseGuards(JwtAuthGuard)
  async requestAccess(
    @Req() req: any,
    @Param('id') matchId: string,
    @Body() body: { message?: string },
  ) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();

    const m = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { ownerId: true, inviteOnly: true, slots: true, format: true },
    });
    if (!m) throw new NotFoundException('match_not_found');
    if (!m.inviteOnly) return { ok: true };
    if (m.ownerId === userId) return { ok: true };

    const slots = normalizeSlots(m.slots, m.format ?? undefined);
    if (slots.some((s) => s.userId === userId)) return { ok: true };

    const p: any = this.prisma;
    const existed = await p.matchAccessRequest.findFirst({
      where: { matchId, requesterId: userId, status: 'PENDING' },
      select: { id: true },
    });
    if (existed) return { ok: true };

    try {
      await p.matchAccessRequest.create({
        data: {
          matchId,
          requesterId: userId,
          status: 'PENDING',
          message: body?.message ?? null,
          respondedAt: null,
        },
      });
      return { ok: true };
    } catch (err: any) {
      if (err?.code === 'P2002') return { ok: true };
      this.logger.error('request-access error', err?.stack || String(err), { matchId, userId });
      throw new BadRequestException('request_access_failed');
    }
  }

  /* ---- SAHİP: bekleyen istekleri listele ---- */
  @Get(':id/requests')
  @UseGuards(JwtAuthGuard)
  async listRequests(@Req() req: any, @Param('id') matchId: string) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();

    const m = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { ownerId: true },
    });
    if (!m) throw new NotFoundException('match_not_found');
    if (m.ownerId !== userId) throw new ForbiddenException('only_owner');

    const p: any = this.prisma;
    let items: { id: string; requesterId: string; message: string | null; createdAt: Date }[] =
      [];
    try {
      items = await p.matchAccessRequest.findMany({
        where: { matchId, status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, requesterId: true, message: true, createdAt: true },
      });
    } catch (e: any) {
      const msg = String(e?.message || '');
      if (e?.code === 'P2021' || e?.code === 'P2022' || /matchaccessrequest/i.test(msg)) {
        return { ok: true, items: [] };
      }
      throw e;
    }

    if (items.length === 0) return { ok: true, items: [] };

    const requesterIds = items.map((i) => i.requesterId);
    const users: SimpleUser[] = await this.prisma.user.findMany({
      where: { id: { in: requesterIds } },
      select: { id: true, phone: true, level: true, positions: true },
    });
    const uMap = new Map<string, SimpleUser>(users.map((u) => [u.id, u]));

    return {
      ok: true,
      items: items.map((it) => ({
        id: it.id,
        userId: it.requesterId,
        phone: uMap.get(it.requesterId)?.phone ?? null,
        level: uMap.get(it.requesterId)?.level ?? null,
        positions: Array.isArray(uMap.get(it.requesterId)?.positions)
          ? (uMap.get(it.requesterId)!.positions as any[])
          : [],
        message: it.message ?? null,
        createdAt: it.createdAt,
      })),
    };
  }

  /* ---- SAHİP: istek onay / red ---- */
  @Post(':id/requests/:reqId/respond')
  @UseGuards(JwtAuthGuard)
  async respondRequest(
    @Req() req: any,
    @Param('id') matchId: string,
    @Param('reqId') reqId: string,
    @Body() body: { action: 'APPROVE' | 'DECLINE' },
  ) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();

    const m = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { ownerId: true },
    });
    if (!m) throw new NotFoundException('match_not_found');
    if (m.ownerId !== userId) throw new ForbiddenException('only_owner');

    const p: any = this.prisma;
    const r = await p.matchAccessRequest.findUnique({ where: { id: reqId } });
    if (!r || r.matchId !== matchId) throw new NotFoundException('request_not_found');

    const nextStatus = body.action === 'APPROVE' ? 'APPROVED' : 'DECLINED';

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await (tx as any).matchAccessRequest.deleteMany({
        where: {
          matchId,
          requesterId: r.requesterId,
          status: nextStatus,
          NOT: { id: r.id },
        },
      });

      await (tx as any).matchAccessRequest.update({
        where: { id: r.id },
        data: { status: nextStatus, respondedAt: new Date() },
      });
    });

    if (nextStatus === 'APPROVED') {
      try {
        await this.prisma.notification.create({
          data: { userId: r.requesterId, type: 'access_approved', matchId, data: { matchId } },
        });
      } catch (e: any) {
        if (e?.code !== 'P2002') console.error(e);
      }
    }
    return { ok: true };
  }

  /* -------------------- OLUŞTUR -------------------- */
  @Post()
  @UseGuards(JwtAuthGuard)
  async create(@Req() req: any, @Body() body: any) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();

    const fmt = (body?.format ?? '7v7') as string;
    const baseSlots: Slot[] = buildInitialSlots(
      fmt,
      body?.positions,
      reservesPerTeamByFormat(fmt),
    );
    const initialSlots = baseSlots;
    const listedFinal = body?.seriesId ? (body?.listed ?? false) : (body?.listed ?? true);

    const created = await this.prisma.match.create({
      data: {
        title: body?.title ?? null,
        location: body?.location ?? null,
        level: body?.level ?? null,
        format: fmt,
        price: typeof body?.price === 'number' ? body.price : null,
        time: body?.time ?? null,
        slots: initialSlots as any,
        ownerId: userId,
        inviteOnly: !!body?.inviteOnly,
        status: (body?.status as any) || 'OPEN',
        closedAt: null,
        seriesId: body?.seriesId ?? null,
        listed: listedFinal,
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
        inviteOnly: true,
        status: true,
        closedAt: true,
        listed: true,
        seriesId: true,
      },
    });

    return { ...created, slots: initialSlots, statusEffective: effectiveStatus(created) };
  }

  /* -------------------- YAYINLA -------------------- */
  @UseGuards(JwtAuthGuard)
  @Post(':id/publish')
  async publish(
    @Req() req: any,
    @Param('id') id: string,
    @Body('listed') listed: boolean | string,
  ) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();

    const m = await this.prisma.match.findUnique({ where: { id }, select: { ownerId: true } });
    if (!m) throw new NotFoundException('match_not_found');
    if (m.ownerId !== userId && req.user?.role !== 'ADMIN')
      throw new ForbiddenException('only_owner');

    const isListed = listed === true || listed === 'true' || listed === '1';
    await this.prisma.match.update({ where: { id }, data: { listed: isListed } });
    return { ok: true, listed: isListed };
  }

  /* -------------------- KATIL -------------------- */
  @Post('join')
  @UseGuards(JwtAuthGuard)
  async join(
    @Req() req: any,
    @Body() body: { matchId: string; pos?: string; team?: Team; strict?: boolean },
  ) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();

    const match = await this.prisma.match.findUnique({
      where: { id: body.matchId },
      select: { id: true, inviteOnly: true, status: true, time: true, slots: true, format: true },
    });
    if (!match) throw new NotFoundException('match not found');

    const eff = effectiveStatus(match);
    if (eff === 'CLOSED') throw new ConflictException('closed');
    if (match.status === 'DRAFT') throw new ForbiddenException('draft');

    let slots: Slot[] = normalizeSlots(match.slots as any, (match.format ?? undefined) as any);
    if (!Array.isArray(slots) || slots.length === 0) {
      const fmt = match.format || '7v7';
      slots = buildInitialSlots(fmt, undefined, reservesPerTeamByFormat(fmt));
    }

    if (match.inviteOnly) {
      const access = await canAccessMatch(this.prisma, match.id, userId);
      if (!access.ok) throw new ForbiddenException('invite_only');
    }

    if (slots.every((s) => !isFree(s))) throw new ConflictException('match_full');

    const mine = slots.find((s) => s.userId === userId);
    if (mine) return { ok: true, pos: mine.pos };

    const anyOpen = slots.some((s) => isFree(s));
    if (!anyOpen) throw new ConflictException('match_full');

    let desired = body.pos?.trim().toUpperCase();

    if (desired) {
      const ok = slots.some(
        (s) => s.pos === desired && isFree(s) && (!body.team || s.team === body.team),
      );
      if (!ok) throw new ConflictException('slot already taken');
    }

    if (!desired) {
      const me = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { positions: true },
      });

      const prefs: string[] = Array.isArray(me?.positions)
        ? (me!.positions as any[]).map(String).slice(0, 3).map((p) => p.toUpperCase())
        : [];

      const open = new Set(
        slots.filter((s) => isFree(s) && (!body.team || s.team === body.team)).map((s) => s.pos),
      );

      desired = prefs.find((p) => open.has(p));
      if (!desired) {
        const subOnPreferredTeam = slots.find(
          (s) => isFree(s) && s.pos === 'SUB' && (!body.team || s.team === body.team),
        );
        if (subOnPreferredTeam) desired = 'SUB';
        else {
          const anySub = slots.find((s) => isFree(s) && s.pos === 'SUB');
          if (anySub) desired = 'SUB';
        }
      }

      if (!desired) throw new ConflictException('no preferred open slot');
    }

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const fresh = await tx.match.findUnique({ where: { id: match.id } });

      let arr: Slot[] = normalizeSlots(
        (fresh as any)?.slots,
        ((fresh as any)?.format ?? undefined) as any,
      );
      if (!Array.isArray(arr) || arr.length === 0) {
        const fmt = (fresh as any)?.format || '7v7';
        arr = buildInitialSlots(fmt, undefined, reservesPerTeamByFormat(fmt));
      }

      const i = arr.findIndex(
        (s) => s.pos === desired && isFree(s) && (!body.team || s.team === body.team),
      );
      if (i === -1) throw new ConflictException('slot already taken');

      for (const s of arr) if (s.userId === userId) s.userId = null;
      arr[i] = { ...arr[i], userId };

      await tx.match.update({
        where: { id: match.id },
        data: { slots: arr as any },
        select: { id: true },
      });
    });

    return { ok: true, pos: desired };
  }

  /* -------------------- Maç düzenle -------------------- */
  @Post(':id/edit')
  @UseGuards(JwtAuthGuard)
  async editMatch(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: {
      title?: string | null;
      location?: string | null;
      level?: string | null;
      format?: string | null;
      price?: number | null;
      time?: string | null;
      status?: 'OPEN' | 'CLOSED' | 'DRAFT';
    },
  ) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();

    const current = await this.prisma.match.findUnique({
      where: { id },
      select: { ownerId: true, slots: true, format: true, status: true },
    });
    if (!current) throw new NotFoundException('match not found');
    const can = await canEditMatchSchedule(this.prisma, id, userId);
    if (!can) throw new ForbiddenException('not_allowed');

    const data: any = {};
    const normStr = (v: any) =>
      typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : v ?? null;

    if ('title' in body) data.title = normStr(body.title);
    if ('location' in body) data.location = normStr(body.location);
    if ('level' in body) data.level = normStr(body.level);
    if ('price' in body) data.price = body.price === null ? null : Number(body.price);

    if ('time' in body) {
      if (!body.time) data.time = null;
      else {
        const d = new Date(body.time);
        if (isNaN(d.getTime())) throw new BadRequestException('invalid time');
        data.time = d.toISOString();
      }
    }

    if ('status' in body && body.status) {
      const next = String(body.status).toUpperCase();
      if (!['OPEN', 'CLOSED', 'DRAFT'].includes(next))
        throw new BadRequestException('invalid_status');
      data.status = next;
      data.closedAt = next === 'CLOSED' ? new Date() : null;
    }

    if ('format' in body) {
      const nextFmt = normStr(body.format);
      if (nextFmt && nextFmt !== current.format) {
        const anyJoined = normalizeSlots(current.slots, current.format ?? undefined).some(
          (s) => !isFree(s),
        );
        if (anyJoined) throw new ConflictException('format_locked');

        const baseSlots = buildInitialSlots(
          nextFmt,
          undefined,
          reservesPerTeamByFormat(nextFmt),
        );
        data.format = nextFmt;
        data.slots = baseSlots as any;
      }
    }

    await this.prisma.match.update({ where: { id }, data, select: { id: true } });
    return { ok: true };
  }

  /* -------------------- KİLİT AÇ/KAPA (inviteOnly) -------------------- */
  @Post(':id/lock')
  @UseGuards(JwtAuthGuard)
  async lockMatch(
    @Req() req: any,
    @Param('id') matchId: string,
    @Body() body: { inviteOnly: boolean },
  ) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();

    const m = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { ownerId: true },
    });
    if (!m) throw new NotFoundException('match not found');
    if (m.ownerId !== userId) throw new ForbiddenException('only_owner');

    await this.prisma.match.update({
      where: { id: matchId },
      data: { inviteOnly: !!body.inviteOnly },
    });
    return { ok: true, inviteOnly: !!body.inviteOnly };
  }

  /* -------------------- SLOT REZERV (Admin/ +1) -------------------- */
  @Post(':id/reserve')
  @UseGuards(JwtAuthGuard)
  async reserve(
    @Req() req: any,
    @Param('id') matchId: string,
    @Body() body: { team: Team; pos: string; type: 'ADMIN' | 'GUEST' },
  ) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();

    const m = await this.prisma.match.findUnique({ where: { id: matchId } });
    if (!m) throw new NotFoundException('match not found');

    const eff = effectiveStatus(m as any);
    if (eff === 'CLOSED') throw new ForbiddenException('match_closed');
    if ((m as any).status === 'DRAFT') throw new ForbiddenException('draft');

    const isOwner = (m as any).ownerId === userId;
    if (body.type === 'ADMIN' && !isOwner) throw new ForbiddenException('only_owner');

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const fresh = await tx.match.findUnique({ where: { id: matchId } });
      const arr: Slot[] = normalizeSlots(
        (fresh as any)?.slots,
        ((fresh as any)?.format ?? undefined) as any,
      );
      if (!reserveSlot(arr, body.team, body.pos, body.type, userId)) {
        throw new ConflictException('no_free_slot');
      }
      await tx.match.update({
        where: { id: matchId },
        data: { slots: arr as any },
      });
    });

    return { ok: true };
  }

  @Post(':id/reserve/remove')
  @UseGuards(JwtAuthGuard)
  async unreserve(
    @Req() req: any,
    @Param('id') matchId: string,
    @Body() body: { team: Team; pos: string },
  ) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();

    const m = await this.prisma.match.findUnique({ where: { id: matchId } });
    if (!m) throw new NotFoundException('match not found');

    const eff = effectiveStatus(m as any);
    if (eff === 'CLOSED') throw new ForbiddenException('match_closed');
    if ((m as any).status === 'DRAFT') throw new ForbiddenException('draft');

    const isOwner = (m as any).ownerId === userId;

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const fresh = await tx.match.findUnique({ where: { id: matchId } });
      const arr: Slot[] = normalizeSlots(
        (fresh as any)?.slots,
        ((fresh as any)?.format ?? undefined) as any,
      );

      const target = arr.find(
        (s) => s.team === body.team && s.pos === body.pos && (s as any).placeholder,
      );
      if (!target) throw new NotFoundException('placeholder_not_found');

      if ((target as any).placeholder === 'GUEST' && !isOwner && (target as any).guestOfUserId !== userId)
        throw new ForbiddenException('not_owner_of_plusone');

      if (!releaseReserved(arr, body.team, body.pos))
        throw new ConflictException('cannot_release');

      await tx.match.update({
        where: { id: matchId },
        data: { slots: arr as any },
      });
    });

    return { ok: true };
  }

  /* -------------------- AYRIL -------------------- */
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

    const slots = normalizeSlots(m.slots, m.format ?? undefined);
    let changed = false;
    for (const s of slots) {
      if (s.userId === userId) {
        (s as any).userId = null;
        changed = true;
      }
    }
    if (!changed) return { ok: true };

    await this.prisma.match.update({
      where: { id: matchId },
      data: { slots: slots as any },
    });

    return { ok: true };
  }

  /* -------------------- RSVP -------------------- */
  @Post(':id/rsvp')
  @UseGuards(JwtAuthGuard)
  async rsvp(
    @Req() req: any,
    @Param('id') id: string,
    @Body() b: { status: 'GOING' | 'NOT_GOING' },
  ) {
    const meId = req.user?.id || req.user?.sub;
    if (!meId) throw new UnauthorizedException();

    const m = await this.prisma.match.findUnique({
      where: { id },
      select: { id: true, seriesId: true, ownerId: true, slots: true, format: true },
    });
    if (!m) throw new NotFoundException('match_not_found');

    if (m.seriesId) {
      const isOwner = m.ownerId === meId;

      const isMember = !!(await this.prisma.seriesMember.findFirst({
        where: { seriesId: m.seriesId, userId: meId, active: true },
        select: { userId: true },
      }));

      if (!isOwner && !isMember) throw new ForbiddenException('not_series_member');
    }

    await this.prisma.matchAttendance.upsert({
      where: { matchId_userId: { matchId: id, userId: meId } },
      create: { matchId: id, userId: meId, status: b.status },
      update: { status: b.status },
    });

    return { ok: true };
  }

  /* -------------------- Bu haftayı iptal et (admin) -------------------- */
  @Post(':id/cancel-week')
  @UseGuards(JwtAuthGuard)
  async cancelWeek(@Req() req: any, @Param('id') matchId: string) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();
    const m = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { id: true, ownerId: true, status: true, seriesId: true },
    });
    if (!m) throw new NotFoundException('match_not_found');
    if (m.ownerId !== userId) throw new ForbiddenException('only_owner');

    await this.prisma.match.update({
      where: { id: matchId },
      data: { status: 'CLOSED', closedAt: new Date() },
    });

    if (m.seriesId) {
      const members = await (this.prisma as any).seriesMember.findMany({
        where: { seriesId: m.seriesId, active: true },
        select: { userId: true },
      });
      for (const u of members) {
        try {
          await (this.prisma as any).notification.create({
            data: {
              userId: u.userId,
              type: 'series_week_canceled',
              matchId,
              data: { matchId },
            },
          });
        } catch (_) {}
      }
    }
    return { ok: true };
  }

  /* ===================== ICS: Takvime Ekle ===================== */
  @Get(':id/ics')
  @UseGuards(JwtAuthGuard)
  async ics(@Param('id') id: string, @Res() res: Response) {
    const m = await this.prisma.match.findUnique({
      where: { id },
      select: { id: true, title: true, location: true, time: true },
    });
    if (!m) throw new NotFoundException('not_found');

    const start = m.time ? new Date(m.time) : new Date();
    const end = addMinutes(start, 90);
    const uid = `match-${m.id}@matchfinder`;
    const now = new Date();

    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//MatchFinder//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${icsEscape(uid)}`,
      `DTSTAMP:${dtStamp(now)}`,
      `DTSTART:${dtStamp(start)}`,
      `DTEND:${dtStamp(end)}`,
      `SUMMARY:${icsEscape(m.title || 'Maç')}`,
      m.location ? `LOCATION:${icsEscape(m.location)}` : '',
      'END:VEVENT',
      'END:VCALENDAR',
    ]
      .filter(Boolean)
      .join('\r\n');

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="match-${m.id}.ics"`);
    return res.send(ics);
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
    const all = await this.prisma.match.findMany({
      select: { id: true, format: true, slots: true },
    });

    let updated = 0;

    for (const m of all) {
      const current = normalizeSlots(m.slots, m.format ?? undefined);
      const per = reservesPerTeamByFormat(m.format || '7v7');

      let target = [...current];

      const adjustTeam = (team: Team) => {
        const starters = target.filter((s) => s.team === team && s.pos !== 'SUB');
        const bench = target.filter((s) => s.team === team && s.pos === 'SUB');

        const assigned = bench.filter((s) => !isFree(s));
        const empty = bench.filter((s) => isFree(s));

        while (assigned.length + empty.length > per && empty.length > 0) empty.pop();
        while (assigned.length + empty.length < per)
          empty.push({ team, pos: 'SUB', userId: null } as any);

        return [...starters, ...assigned, ...empty];
      };

      const nextA = adjustTeam('A');
      const nextB = adjustTeam('B');

      target = [
        ...nextA.filter((s) => s.team === 'A'),
        ...nextB.filter((s) => s.team === 'B'),
      ];

      const changed = JSON.stringify(target) !== JSON.stringify(current);
      if (!changed) continue;

      await this.prisma.match.update({
        where: { id: m.id },
        data: { slots: target as any },
      });
      updated++;
    }

    return { ok: true, updated };
  }

  /* ===================== ZAMAN ÖNERİLERİ ===================== */
  // Önerileri listele (oy ve admin onaylarıyla)
  @UseGuards(JwtAuthGuard)
  @Get(':id/time-proposals')
  async listTimeProposals(@Req() req: any, @Param('id') matchId: string) {
    const userId = req.user?.id || req.user?.sub;
    if (!userId) throw new UnauthorizedException();

    const m = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { createdFrom: true },
    });
    if (!m) throw new NotFoundException('match_not_found');
    if (m.createdFrom !== 'TEAM_MATCH') return { ok: true, items: [] };

    const props = await (this.prisma as any).notification.findMany({
      where: { type: 'time_proposal', matchId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, userId: true, data: true, createdAt: true },
    });
    if (!props.length) return { ok: true, items: [] };

    const votes = await (this.prisma as any).notification.findMany({
      where: { type: { startsWith: 'time_proposal_vote' }, matchId },
      select: { userId: true, data: true },
    });
    const approvals = await (this.prisma as any).notification.findMany({
      where: { type: { contains: 'time_proposal_admin_approve:' }, matchId },
      select: { type: true },
    });

    const byProp: Record<string, { up: number; down: number; mine: 'UP'|'DOWN'|null; a: boolean; b: boolean }> = {};
    for (const p of props) byProp[p.id] = { up: 0, down: 0, mine: null, a: false, b: false };

    for (const v of votes) {
      const pid = (v as any).data?.proposalId;
      const val = String((v as any).data?.value || '').toUpperCase();
      if (!byProp[pid]) continue;
      if (val === 'UP') byProp[pid].up++;
      else if (val === 'DOWN') byProp[pid].down++;
      if (v.userId === userId) byProp[pid].mine = (val === 'UP' ? 'UP' : val === 'DOWN' ? 'DOWN' : null);
    }
  
    for (const a of approvals) {
      const parts = String(a.type).split(':'); // time_proposal_admin_approve:<pid>:<A|B>
      if (parts.length === 3) {
        const pid = parts[1];
        const side = parts[2];
        if (byProp[pid]) {
          if (side === 'A') byProp[pid].a = true;
          if (side === 'B') byProp[pid].b = true;
        }
      }
    } 

    return {
      ok: true,
      items: props.map((p: any) => ({
        id: p.id,
        by: p.data?.by || p.userId,
        time: p.data?.time || null,
        createdAt: p.createdAt,
        votesUp: byProp[p.id].up,
        votesDown: byProp[p.id].down,
        myVote: byProp[p.id].mine,
        // FE beklediği isimler:
        ackA: byProp[p.id].a,
        ackB: byProp[p.id].b,
        appliedAt: null, // şimdilik notification'larda tutmuyoruz
      })),
    };
  }



  // Öneriye oy ver — admin ise UP verdiğinde taraf onayı olarak say, iki taraf onaylıysa otomatik uygula
  @UseGuards(JwtAuthGuard)
  @Post(':id/time-proposals/:pid/vote')
  async voteTimeProposal(
    @Req() req: any,
    @Param('id') matchId: string,
    @Param('pid') pid: string,
    @Body() body: { value: 'UP'|'DOWN' },
  ) {
    const userId = req.user?.id || req.user?.sub;
    if (!userId) throw new UnauthorizedException();

    const m = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { createdFrom: true },
    });
    if (!m) throw new NotFoundException('match_not_found');
    if (m.createdFrom !== 'TEAM_MATCH') throw new ForbiddenException('only_for_team_match');

    const prop = await (this.prisma as any).notification.findUnique({
      where: { id: pid },
      select: { id: true, matchId: true, type: true, data: true },
    });
    if (!prop || prop.matchId !== matchId || prop.type !== 'time_proposal') {
      throw new NotFoundException('proposal_not_found');
    }

    const val = String(body?.value || '').toUpperCase();
    if (val !== 'UP' && val !== 'DOWN') throw new BadRequestException('invalid_vote');

    const voteType = `time_proposal_vote:${pid}`;
    const existed = await (this.prisma as any).notification.findFirst({
      where: { userId, type: voteType, matchId },
      select: { id: true },
    });
    if (existed) {
      await (this.prisma as any).notification.update({
        where: { id: existed.id },
        data: { data: { proposalId: pid, value: val } },
      });
    } else {
      await (this.prisma as any).notification.create({
        data: { userId, type: voteType, matchId, data: { proposalId: pid, value: val } },
      });
    }

    const side = await adminSideForMatch(this.prisma as any, matchId, userId);
    if (side) {
      const approveType = `time_proposal_admin_approve:${pid}:${side}`;
      if (val === 'UP') {
        const ap = await (this.prisma as any).notification.findFirst({
          where: { userId, type: approveType, matchId }, select: { id: true }
        });
        if (!ap) {
          await (this.prisma as any).notification.create({
            data: { userId, type: approveType, matchId, data: { proposalId: pid, side } },
          });
        }
      } else {
        await (this.prisma as any).notification.deleteMany({
          where: { userId, type: approveType, matchId },
        });
      }
    }

    const approvals = await (this.prisma as any).notification.findMany({
      where: { type: { contains: `time_proposal_admin_approve:${pid}:` }, matchId },
      select: { type: true },
    });
    const okA = approvals.some((a: any) => String(a.type).endsWith(':A'));
    const okB = approvals.some((a: any) => String(a.type).endsWith(':B'));

    if (okA && okB) {
      const iso = String((prop as any).data?.time || '');
      const d = new Date(iso);
      if (iso && !isNaN(d.getTime())) {
        const isoTime = d.toISOString();
        await this.prisma.match.update({
          where: { id: matchId },
          data: { time: isoTime },
        });
        return { ok: true, applied: true, time: isoTime };
      }
    }
    return { ok: true, applied: false };
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/time-proposals/:pid/ack')
  async ackTimeProposal(
    @Req() req: any,
    @Param('id') matchId: string,
    @Param('pid') pid: string,
  ) {
    await ensureTeamMatch(this.prisma, matchId);

    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();

    // Bu kullanıcı A mı B mi kaptan?
    const side = await adminSideForMatch(this.prisma as any, matchId, userId);
    if (!side) throw new ForbiddenException('not_allowed');

    // Öneriyi doğrula
    const prop = await (this.prisma as any).notification.findUnique({
      where: { id: pid },
      select: { matchId: true, type: true, data: true },
    });
    if (!prop || prop.matchId !== matchId || prop.type !== 'time_proposal') {
      throw new NotFoundException('proposal_not_found');
    }

    // Bu kaptanın onay kaydını oluştur (yoksa)
    const approveType = `time_proposal_admin_approve:${pid}:${side}`;
    const existed = await (this.prisma as any).notification.findFirst({
      where: { userId, type: approveType, matchId },
      select: { id: true },
    });
    if (!existed) {
      await (this.prisma as any).notification.create({
        data: {
          userId,
          type: approveType,
          matchId,
          data: { proposalId: pid, side },
        },
      });
    }

    // İki taraf da onayladı mı?
    const approvals = await (this.prisma as any).notification.findMany({
      where: { type: { contains: `time_proposal_admin_approve:${pid}:` }, matchId },
      select: { type: true },
    });
    const okA = approvals.some((a: any) => String(a.type).endsWith(':A'));
    const okB = approvals.some((a: any) => String(a.type).endsWith(':B'));

    if (okA && okB) {
      const iso = String((prop as any).data?.time || '');
      const d = new Date(iso);
      if (iso && !isNaN(d.getTime())) {
        const isoTime = d.toISOString();
        await this.prisma.match.update({
          where: { id: matchId },
          data: { time: isoTime },
        });
        return { ok: true, applied: true, time: isoTime };
      } 
    }
    return { ok: true, applied: false };
  }


  // Öneriyi uygula (maç saatini öneriye çek) — owner veya takım admini
  @UseGuards(JwtAuthGuard)
  @Post(':id/time-proposals/:pid/apply')
  async applyTimeProposal(
    @Req() req: any,
    @Param('id') matchId: string,
    @Param('pid') pid: string,
  ) {
    await ensureTeamMatch(this.prisma, matchId);
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();

    const can = await canEditMatchSchedule(this.prisma, matchId, userId);
    if (!can) throw new ForbiddenException('not_allowed');

    const prop = await (this.prisma as any).notification.findUnique({
      where: { id: pid },
      select: { matchId: true, data: true },
    });
    if (!prop || prop.matchId !== matchId) throw new NotFoundException('proposal_not_found');

    const iso = String((prop as any).data?.time || '');
    const d = new Date(iso);
    if (!iso || isNaN(d.getTime())) throw new BadRequestException('invalid_time');

    const isoTime = d.toISOString();
    await this.prisma.match.update({ where: { id: matchId }, data: { time: isoTime } });
    return { ok: true, applied: true, time: isoTime };
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
      data: { text, editedAt: new Date() } as any,
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
      data: { deleted: true, text: '' } as any,
    });

    return { ok: true, message: updated };
  }

  /* ===================== ÖNERİLEN DAVETLER ===================== */
  @UseGuards(JwtAuthGuard)
  @Get(':id/recommend-invites')
  async recommendInvites(
    @Req() req: any,
    @Param('id') matchId: string,
    @Query('radiusKm') radiusQ?: string,
    @Query('limit') limitQ?: string,
  ) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();

    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { id: true, ownerId: true, time: true, format: true, slots: true },
    });
    if (!match) throw new NotFoundException('match not found');

    const access = await canAccessMatch(this.prisma, matchId, userId);
    if (!access.ok) throw new UnauthorizedException();

    const slots = normalizeSlots(match.slots, match.format ?? undefined);
    const participants: Set<string> = new Set(
      slots
        .filter(
          (s): s is Slot & { userId: string } =>
            typeof (s as any).userId === 'string' && (s as any).userId.length > 0,
        )
        .map((s) => (s as any).userId),
    );

    const openCore = slots.filter((s) => isFree(s) && s.pos !== 'SUB').map((s) => s.pos);
    const hasSubHoleA = slots.some((s) => s.team === 'A' && s.pos === 'SUB' && isFree(s));
    const hasSubHoleB = slots.some((s) => s.team === 'B' && s.pos === 'SUB' && isFree(s));

    const recentInvs = await this.prisma.matchInvite.findMany({
      where: { matchId, status: { in: ['PENDING', 'ACCEPTED'] }, toUserId: { not: null } },
      select: { toUserId: true },
    });
    const invited: Set<string> = new Set(
      (recentInvs as Array<{ toUserId: string | null }>)
        .map((x) => x.toUserId)
        .filter((x): x is string => !!x),
    );

    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { lat: true, lng: true },
    });
    const baseLat = Number(me?.lat);
    const baseLng = Number(me?.lng);
    const hasBase = Number.isFinite(baseLat) && Number.isFinite(baseLng);

    const radiusKm = Math.max(1, Math.min(Number(radiusQ) || 30, 200));
    const limit = Math.max(1, Math.min(Number(limitQ) || 20, 100));

    const friends = await this.prisma.friendship.findMany({
      where: {
        OR: [
          { userId, friendId: { not: userId } },
          { friendId: userId, userId: { not: userId } },
        ],
      },
      select: { userId: true, friendId: true },
    });
    const friendIds = new Set<string>();
    for (const f of friends) {
      if (f.userId === userId) friendIds.add(f.friendId);
      if (f.friendId === userId) friendIds.add(f.userId);
    }

    const notInIds: string[] = [userId, ...Array.from(participants), ...Array.from(invited)];

    const candidates: CandidateUser[] = await this.prisma.user.findMany({
      where: {
        discoverable: true,
        id: { notIn: notInIds },
        lat: { not: null },
        lng: { not: null },
      },
      select: {
        id: true,
        phone: true,
        level: true,
        positions: true,
        availability: true,
        lat: true,
        lng: true,
      },
    });

    const toDow = (d: Date): number => {
      const js = d.getDay(); // 0..6 (Sun..Sat)
      return js === 0 ? 7 : js;
    };
    const hhmm = (d: Date): string => {
      const h = d.getHours().toString().padStart(2, '0');
      const m = d.getMinutes().toString().padStart(2, '0');
      return `${h}:${m}`;
    };
    const timeInRange = (t: string, start: string, end: string) => t >= start && t <= end;

    function normalizeAvailabilityAny(av: any) {
      if (!av) return [];
      if (Array.isArray(av)) {
        return av
          .map((x) => ({
            dow: Number(x?.dow),
            start: String(x?.start || ''),
            end: String(x?.end || ''),
          }))
          .filter(
            (x) =>
              x.dow >= 1 &&
              x.dow <= 7 &&
              /^\d{2}:\d{2}$/.test(x.start) &&
              /^\d{2}:\d{2}$/.test(x.end) &&
              x.start < x.end,
          );
      }
      const map: Record<string, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };
      const out: any[] = [];
      for (const k of Object.keys(map)) {
        const v = (av as any)[k];
        if (!v?.enabled) continue;
        const s = String(v.start || '');
        const e = String(v.end || '');
        if (/^\d{2}:\d{2}$/.test(s) && /^\d{2}:\d{2}$/.test(e) && s < e)
          out.push({ dow: map[k], start: s, end: e });
      }
      return out;
    }

    const matchTime = match.time ? new Date(match.time) : null;
    const matchDow = matchTime ? toDow(matchTime) : null;
    const matchT = matchTime ? hhmm(matchTime) : null;

    const scored: ScoredCandidate[] = (candidates as CandidateUser[])
      .map((u: CandidateUser) => {
        const posArr = Array.isArray(u.positions) ? (u.positions as any[]).map(String) : [];
        const avRanges = normalizeAvailabilityAny(u.availability);

        let posScore = 0;
        const tags: string[] = [];
        if (openCore.length && posArr.length) {
          const hit = posArr.find((p) => openCore.includes(p));
          if (hit) {
            posScore = 3;
            tags.push(`poz:${hit}`);
          }
        } else if ((hasSubHoleA || hasSubHoleB) && posArr.length) {
          posScore = 1;
          tags.push('yedek-uyum');
        }

        let availScore = 0;
        if (matchDow && matchT && avRanges.length) {
          const ok = avRanges.some((r) => r.dow === matchDow && timeInRange(matchT, r.start, r.end));
          if (ok) {
            availScore = 2;
            tags.push('müsait');
          }
        }

        const toRad = (x: number) => (x * Math.PI) / 180;
        const R = 6371;
        const haversineKm = (aLat: number, aLng: number, bLat: number, bLng: number) => {
          const dLat = toRad(bLat - aLat);
          const dLng = toRad(bLng - aLng);
          const sa =
            Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
          const c = 2 * Math.atan2(Math.sqrt(sa), Math.sqrt(1 - sa));
          return R * c;
        };

        let distanceKm = Number.NaN;
        let distScore = 0;
        if (hasBase && u.lat != null && u.lng != null) {
          distanceKm = haversineKm(baseLat, baseLng, Number(u.lat), Number(u.lng));
          if (distanceKm <= radiusKm) {
            distScore = distanceKm <= 5 ? 2 : distanceKm <= 15 ? 1 : 0;
            if (distScore > 0) tags.push(`~${distanceKm.toFixed(1)}km`);
          }
        }

        const isFriend = friendIds.has(u.id);
        const friendScore = isFriend ? 2 : 0;
        if (isFriend) tags.push('arkadaş');

        const score = posScore + availScore + distScore + friendScore;

        return {
          id: u.id,
          phone: u.phone,
          level: u.level,
          positions: posArr,
          distanceKm,
          isFriend,
          score,
          tags,
        };
      })
      .filter((x: ScoredCandidate) => {
        if (hasBase) return Number.isFinite(x.distanceKm) && x.distanceKm <= radiusKm;
        return true;
      })
      .sort((a: ScoredCandidate, b: ScoredCandidate) => {
        if (b.score !== a.score) return b.score - a.score;
        if (Number.isFinite(a.distanceKm) && Number.isFinite(b.distanceKm)) {
          if (a.distanceKm !== b.distanceKm) return a.distanceKm - b.distanceKm;
        }
        return (b.level ?? 0) - (a.level ?? 0);
      })
      .slice(0, limit);

    return {
      ok: true,
      openPositions: Array.from(new Set(openCore)),
      canSubA: hasSubHoleA,
      canSubB: hasSubHoleB,
      items: scored,
    };
  }
}

/* -------------------- erişim kontrolü (helper) -------------------- */
async function canAccessMatch(
  prisma: PrismaService,
  matchId: string,
  userId: string,
): Promise<{ ok: true } | { ok: false; code: 'not_found' | 'forbidden' }> {
  const m = await prisma.match.findUnique({
    where: { id: matchId },
    select: { id: true, ownerId: true, slots: true, format: true },
  });

  if (!m) return { ok: false, code: 'not_found' };
  if (m.ownerId === userId) return { ok: true };

  const slots = normalizeSlots(m.slots, m.format ?? undefined);
  if (slots.some((s) => (s as any).userId === userId)) return { ok: true };

  const hasAccepted = await prisma.matchInvite.findFirst({
    where: { matchId, toUserId: userId, status: 'ACCEPTED' },
    select: { id: true },
  });
  if (hasAccepted) return { ok: true };

  const approved = await (prisma as any).matchAccessRequest.findFirst({
    where: { matchId, requesterId: userId, status: 'APPROVED' },
    select: { id: true },
  });
  if (approved) return { ok: true };

  return { ok: false, code: 'forbidden' };
}

/* ---- CAN EDIT SCHEDULE (owner veya takım admini) ---- */
async function canEditMatchSchedule(
  prisma: any,
  matchId: string,
  userId: string,
): Promise<boolean> {
  const m = await prisma.match.findUnique({
    where: { id: matchId },
    select: { ownerId: true, createdFrom: true, teamAId: true, teamBId: true },
  });
  if (!m) return false;
  if (m.ownerId === userId) return true;
  if (m.createdFrom !== 'TEAM_MATCH') return false;

  const checkAdmin = async (teamId?: string | null) => {
    if (!teamId) return null;
    return prisma.teamMember.findFirst({
      where: {
        teamId,
        userId,
        status: 'ACTIVE',
        role: { in: ['OWNER', 'ADMIN'] },
      },
      select: { teamId: true }, // ← ✅ DOĞRU!
    });
  };

  const [a, b] = await Promise.all([checkAdmin(m.teamAId), checkAdmin(m.teamBId)]);
  return !!(a || b);
}
