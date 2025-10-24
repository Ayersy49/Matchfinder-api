// src/series/series.controller.ts
import {
  BadRequestException, Body, Controller, Get, NotFoundException,
  Param, Post, Query, Req, UnauthorizedException, UseGuards, ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Prisma } from '@prisma/client';
import { buildInitialSlots, normalizeSlots, isFree, teamSizeFromFormat } from '../matches/slots';

function parseHHmm(s: string) {
  const m = String(s||'').match(/^(\d{2}):(\d{2})$/);
  if (!m) throw new BadRequestException('invalid timeHHmm');
  const hh = +m[1], mm = +m[2];
  if (hh<0 || hh>23 || mm<0 || mm>59) throw new BadRequestException('invalid timeHHmm');
  return { hh, mm };
}
function dowJS(d: Date) { const x = d.getDay(); return x===0 ? 7 : x; } // Sun:7
function firstOnOrAfter(start: Date, targetDow: number): Date {
  const s = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const cur = dowJS(s);
  const add = (targetDow - cur + 7) % 7;
  s.setDate(s.getDate() + add);
  return s;
}
function addDays(d: Date, n: number) { const x = new Date(d); x.setDate(x.getDate()+n); return x; }
function addMinutes(d: Date, n: number) { return new Date(d.getTime() + n*60000); }

// Takım başına SUB sayısı: 5v5–6v6 → 1, 7v7–9v9 → 2, 10v10–11v11 → 3
function reservesPerTeamByFormat(fmt: string) {
  const n = teamSizeFromFormat(fmt);
  if (n <= 6) return 1;
  if (n <= 9) return 2;
  return 3;
}

@UseGuards(JwtAuthGuard)
@Controller('series')
export class SeriesController {
  constructor(private prisma: PrismaService) {}

  // ---------- ACTIVE: Public + bana görünür (owner/üye/katılımcı) seriler ----------
  @Get('active')
  async active(
    @Req() req: any,
    @Query('level') _level?: string,
    @Query('format') formatFilter?: string,
  ) {
    const userId: string | undefined = req?.user?.id || req?.user?.sub;

    // Üyeliklerim
    const myMemberOf = await this.prisma.seriesMember.findMany({
      where: { userId },
      select: { seriesId: true },
    });
    const memberSeries = new Set(myMemberOf.map(x => x.seriesId));

    // Yaklaşan seri maçları
    const now = new Date();
    const upcoming = await this.prisma.match.findMany({
      where: {
        seriesId: { not: null },
        time: { gt: new Date(now.getTime() - 2 * 3600 * 1000) },
        status: { in: ['OPEN', 'DRAFT'] as any },
      },
      select: {
        id: true,
        time: true,
        seriesId: true,
        ownerId: true,
        listed: true,
        inviteOnly: true,
        slots: true,
        format: true,
      },
      orderBy: { time: 'asc' },
    });

    // Görünebilir seriler + o serinin en yakın maçı
    const visibleMap = new Map<string, { nextMatch?: { id: string; time: Date | string } }>();

    for (const m of upcoming) {
      const sId = m.seriesId!;
      const slots = normalizeSlots(m.slots as any, m.format as any);
      const joined = userId ? slots.some(s => s.userId === userId) : false;
      const owner = !!(userId && m.ownerId === userId);
      const member = memberSeries.has(sId);
      const publicListed = m.listed === true;

      const canSee = publicListed || owner || member || joined;
      if (!canSee) continue;

      const cur = visibleMap.get(sId) || {};
      if (!cur.nextMatch || new Date(m.time) < new Date(cur.nextMatch.time)) {
        cur.nextMatch = { id: m.id, time: m.time };
      }
      visibleMap.set(sId, cur);
    }

    // Sahip olduğum seriler (maç üretilmemişse bile görün)
    const myOwned = await this.prisma.matchSeries.findMany({
      where: { ownerId: userId },
      select: { id: true },
    });
    for (const s of myOwned) visibleMap.set(s.id, visibleMap.get(s.id) || {});

    const seriesIds = Array.from(visibleMap.keys());
    if (seriesIds.length === 0) return [];

    // Seri satırları
    const seriesRows = await this.prisma.matchSeries.findMany({
      where: {
        id: { in: seriesIds },
        ...(formatFilter ? { format: formatFilter } : {}),
      },
      select: {
        id: true,
        title: true,
        location: true,
        format: true,
        inviteOnly: true,
        ownerId: true,
      },
    });

    // <<< RSVP SAYIMLARI: her serinin "en yakın maçı" için toplu çek >>>
    const nextMatchIds = seriesIds
      .map(id => visibleMap.get(id)?.nextMatch?.id)
      .filter(Boolean) as string[];

    const attRows = nextMatchIds.length
      ? await this.prisma.matchAttendance.findMany({
          where: { matchId: { in: nextMatchIds } },
          select: { matchId: true, status: true },
        })
      : [];

    const attMap = new Map<string, { going: number; notGoing: number }>();
    for (const a of attRows) {
      const rec = attMap.get(a.matchId) || { going: 0, notGoing: 0 };
      if (a.status === 'GOING') rec.going++;
      else if (a.status === 'NOT_GOING') rec.notGoing++;
      attMap.set(a.matchId, rec);
    }

    // Son cevap
    return seriesRows.map(s => {
      const isOwner = Boolean(userId && s.ownerId === userId);
      const isMember = memberSeries.has(s.id);
      const canRSVP = isOwner || isMember;

      const nm = visibleMap.get(s.id)?.nextMatch ?? null;
      const attendance = nm ? (attMap.get(nm.id) || { going: 0, notGoing: 0 }) : undefined;

      return {
        id: s.id,
        title: s.title,
        location: s.location,
        format: s.format,
        inviteOnly: s.inviteOnly,
        nextMatch: nm ? { id: nm.id, time: nm.time, attendance } : null,
        canRSVP,
      };
    });
  }

  // ---------- Serilerimi listele + sıradaki maçı garanti et ----------
  @Get()
  async listMine(@Req() req: any) {
    const me = req.user?.id || req.user?.sub;
    if (!me) throw new UnauthorizedException();

    const all = await this.prisma.matchSeries.findMany({
      where: {
        OR: [
          { ownerId: me },
          { members: { some: { userId: me, active: true } } },
        ],
      },
      include: { members: { where: { active: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const rows: any[] = [];
    for (const s of all) {
      const next = await this.ensureNextForSeries(s);
      rows.push({
        series: {
          id: s.id, ownerId: s.ownerId, title: s.title, location: s.location,
          format: s.format, price: s.price, dayOfWeek: s.dayOfWeek, timeHHmm: s.timeHHmm,
          tz: s.tz, startDate: s.startDate, endDate: s.endDate,
          inviteOnly: s.inviteOnly, reservesPerTeam: s.reservesPerTeam,
        },
        nextMatch: next ? {
          id: next.id, time: next.time, title: next.title, format: next.format,
          location: next.location, inviteOnly: next.inviteOnly, status: next.status, slots: next.slots,
        } : null,
      });
    }
    return rows;
  }

  // Bir seride geleceğe dönük maç yoksa bir sonrakini oluştur ve geri dön
  private async ensureNextForSeries(s: any) {
    const now = new Date();

    const existing = await this.prisma.match.findFirst({
      where: { seriesId: s.id, time: { gte: now } },
      orderBy: { time: 'asc' },
    });
    if (existing) return existing;

    const when = this.nextOccurrenceOnOrAfter(now, s);
    if (!when) return null;

    const near = await this.prisma.match.findFirst({
      where: { seriesId: s.id, time: { gte: addMinutes(when, -1), lte: addMinutes(when, 1) } },
      select: { id: true },
    });
    if (near) return await this.prisma.match.findUnique({ where: { id: near.id } });

    const baseSlots = buildInitialSlots(s.format, undefined, s.reservesPerTeam);
    const arr = normalizeSlots(baseSlots as any, s.format);
    for (const m of s.members ?? []) {
      const P = String(m.pos || 'SUB').toUpperCase();
      let slot = (arr as any[]).find(x => x.pos === P && isFree(x));
      if (!slot) slot = (arr as any[]).find(x => x.pos === 'SUB' && isFree(x));
      if (slot) (slot as any).userId = m.userId;
    }

    const created = await this.prisma.match.create({
      data: {
        title: s.title,
        location: s.location ?? undefined,
        format: s.format,
        price: s.price ?? undefined,
        time: when,
        slots: arr as unknown as Prisma.JsonArray,
        ownerId: s.ownerId,
        inviteOnly: s.inviteOnly,
        status: 'OPEN',
        closedAt: null,
        seriesId: s.id,
        listed: false, // otomatik oluşturulanlar private
      },
    });
    return created;
  }

  private nextOccurrenceOnOrAfter(from: Date, s: any): Date | null {
    const startFloor = new Date(s.startDate);
    const ref = from < startFloor ? startFloor : from;
    const { hh, mm } = parseHHmm(s.timeHHmm);
    const base = firstOnOrAfter(
      new Date(ref.getFullYear(), ref.getMonth(), ref.getDate()),
      s.dayOfWeek
    );
    let d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hh, mm, 0, 0);
    if (d < ref) d = addDays(d, 7);
    if (s.endDate && d > new Date(s.endDate)) return null;
    return d;
  }

  /* --------- OLUŞTUR --------- */
  @Post()
  async create(@Req() req: any, @Body() b: {
    title: string; location?: string|null; format?: string|null; price?: number|null;
    dayOfWeek: number; timeHHmm: string; tz?: string|null;
    startDate: string; endDate?: string|null;
    inviteOnly?: boolean; reservesPerTeam?: number|null;
  }) {
    const userId = req.user?.id || req.user?.sub;
    if (!userId) throw new UnauthorizedException();
    if (!b?.title) throw new BadRequestException('title required');
    const dow = +b.dayOfWeek;
    if (!(dow>=1 && dow<=7)) throw new BadRequestException('dayOfWeek 1..7');
    parseHHmm(b.timeHHmm);

    const created = await this.prisma.matchSeries.create({
      data: {
        ownerId: userId,
        title: b.title,
        location: b.location ?? null,
        format: (b.format ?? '7v7'),
        price: b.price ?? null,
        dayOfWeek: dow,
        timeHHmm: b.timeHHmm,
        tz: b.tz || 'Europe/Istanbul',
        startDate: new Date(b.startDate),
        endDate: b.endDate ? new Date(b.endDate) : null,
        inviteOnly: !!b.inviteOnly,
        reservesPerTeam: b.reservesPerTeam ?? reservesPerTeamByFormat(String(b.format ?? '7v7')),
      },
      select: { id: true },
    });
    return { ok: true, id: created.id };
  }

  /* --------- ÜYE EKLE / ÇIKAR (ADMİN) --------- */
  @Post(':id/members')
  async addMember(@Req() req: any, @Param('id') seriesId: string, @Body() b: { userId: string; pos: string }) {
    const me = req.user?.id || req.user?.sub;
    if (!me) throw new UnauthorizedException();
    const s = await this.prisma.matchSeries.findUnique({ where: { id: seriesId }, select: { ownerId: true }});
    if (!s) throw new NotFoundException('series_not_found');
    if (s.ownerId !== me) throw new ForbiddenException('only_owner');
    await this.prisma.seriesMember.upsert({
      where: { seriesId_userId: { seriesId, userId: b.userId }},
      create: { seriesId, userId: b.userId, pos: String(b.pos||'SUB').toUpperCase(), active: true },
      update: { pos: String(b.pos||'SUB').toUpperCase(), active: true },
    });
    return { ok: true };
  }

  @Post(':id/members/remove')
  async removeMember(@Req() req: any, @Param('id') seriesId: string, @Body() b: { userId: string }) {
    const me = req.user?.id || req.user?.sub;
    if (!me) throw new UnauthorizedException();
    const s = await this.prisma.matchSeries.findUnique({ where: { id: seriesId }, select: { ownerId: true }});
    if (!s) throw new NotFoundException('series_not_found');
    if (s.ownerId !== me) throw new ForbiddenException('only_owner');
    await this.prisma.seriesMember.delete({ where: { seriesId_userId: { seriesId, userId: b.userId }}});
    return { ok: true };
  }

  /* --------- ÜYELİK İSTEĞİ (Kullanıcı) --------- */
  @Post(':id/request-membership')
  async requestMembership(@Req() req: any, @Param('id') seriesId: string, @Body() b: { message?: string }) {
    const userId = req.user?.id || req.user?.sub;
    if (!userId) throw new UnauthorizedException();

    const s = await this.prisma.matchSeries.findUnique({ where: { id: seriesId }, select:{ id:true }});
    if (!s) throw new NotFoundException('series_not_found');

    try {
      await this.prisma.seriesMembershipRequest.create({
        data: { seriesId, requesterId: userId, status: 'PENDING', message: b?.message ?? null },
      });
    } catch (e:any) {
      if (e?.code !== 'P2002') throw e;
    }
    return { ok: true };
  }

  /* --------- ÜYELİK İSTEĞİ YANIT (Admin) --------- */
  @Post(':id/requests/:reqId/respond')
  async respondMembership(@Req() req: any, @Param('id') seriesId: string, @Param('reqId') reqId: string, @Body() b: { action:'APPROVE'|'DECLINE'; pos?: string }) {
    const me = req.user?.id || req.user?.sub;
    if (!me) throw new UnauthorizedException();
    const s = await this.prisma.matchSeries.findUnique({ where: { id: seriesId }, select: { ownerId: true }});
    if (!s) throw new NotFoundException('series_not_found');
    if (s.ownerId !== me) throw new ForbiddenException('only_owner');

    const reqRow = await this.prisma.seriesMembershipRequest.findUnique({ where: { id: reqId }});
    if (!reqRow || reqRow.seriesId !== seriesId) throw new NotFoundException('request_not_found');

    const next = b.action === 'APPROVE' ? 'APPROVED' : 'DECLINED';

    await this.prisma.$transaction(async (tx) => {
      await tx.seriesMembershipRequest.update({ where: { id: reqId }, data: { status: next, respondedAt: new Date() }});
      if (next === 'APPROVED') {
        await tx.seriesMember.upsert({
          where: { seriesId_userId: { seriesId, userId: reqRow.requesterId }},
          create: { seriesId, userId: reqRow.requesterId, pos: String(b?.pos||'SUB').toUpperCase(), active: true },
          update: { active: true, pos: String(b?.pos||'SUB').toUpperCase() },
        });
      }
    });
    return { ok: true };
  }

  /* --------- İLERİ HAFTALARI ELLE ÜRET (opsiyonel) --------- */
  @Post(':id/generate')
  async generate(
    @Req() req:any,
    @Param('id') seriesId: string,
    @Query('weeks') weeksQ?: string,
    @Query('listed') listedQ?: string,
  ) {
    const me = req.user?.id || req.user?.sub;
    if (!me) throw new UnauthorizedException();

    const s = await this.prisma.matchSeries.findUnique({
      where: { id: seriesId },
      include: { members: { where: { active: true } } },
    });
    if (!s) throw new NotFoundException('series_not_found');
    if (s.ownerId !== me) throw new ForbiddenException('only_owner');

    const weeks = Math.max(1, Math.min(parseInt(String(weeksQ||'6'),10)||6, 52));
    const listed = String(listedQ) === '1';
    const { hh, mm } = parseHHmm(s.timeHHmm);

    const start = firstOnOrAfter(new Date(s.startDate), s.dayOfWeek);

    let created = 0;
    for (let i=0;i<weeks;i++){
      const day = addDays(start, i*7);
      if (s.endDate && day > new Date(s.endDate)) break;

      const when = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm, 0, 0);

      const existing = await this.prisma.match.findFirst({
        where: {
          seriesId, time: { gte: addMinutes(when,-1), lte: addMinutes(when, 1) },
        }, select: { id: true },
      });
      if (existing) continue;

      const baseSlots = buildInitialSlots(s.format, undefined, s.reservesPerTeam);
      const arr = normalizeSlots(baseSlots as any, s.format);

      for (const m of s.members) {
        const P = String(m.pos||'SUB').toUpperCase();
        let slot = (arr as any[]).find(x => x.pos === P && isFree(x));
        if (!slot) slot = (arr as any[]).find(x => x.pos === 'SUB' && isFree(x));
        if (slot) (slot as any).userId = m.userId;
      }

      await this.prisma.match.create({
        data: {
          title: s.title,
          location: s.location ?? undefined,
          format: s.format,
          price: s.price ?? undefined,
          time: when,
          slots: arr as unknown as Prisma.JsonArray,
          ownerId: s.ownerId,
          inviteOnly: s.inviteOnly,
          status: 'OPEN',
          closedAt: null,
          seriesId: s.id,
          listed,
        },
      });
      created++;
    }
    return { ok: true, created };
  }
}
