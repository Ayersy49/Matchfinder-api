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
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

import {
  buildInitialSlots,
  upgradeLegacySlots,
  normalizeSlots,
  addReserves,
  teamSizeFromFormat,
  Slot,
  Team,
} from './slots';

// Takım başına kaç yedek istiyorsun?
// Takım başına SUB sayısı: 5v5–6v6 → 1, 7v7–9v9 → 2, 10v10–11v11 → 3
function reservesPerTeamByFormat(fmt: string) {
  const n = teamSizeFromFormat(fmt); // örn: "7v7" → 7
  if (n <= 6) return 1;
  if (n <= 9) return 2;
  return 3;
}


/* -------------------- Yardımcılar -------------------- */
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
  if (slots.some((s) => s.userId === userId)) return { ok: true };

  // ACCEPTED daveti var mı? (delegate'e any ile eriş)
  const hasAccepted = await ((prisma as any).matchInvite).findFirst({
    where: { matchId, toUserId: userId, status: 'ACCEPTED' },
    select: { id: true },
  });
  if (hasAccepted) return { ok: true };

  return { ok: false, code: 'forbidden' };
}

// ---- Öneri endpoint’i için küçük yardımcılar ----
type AvRange = { dow: number; start: string; end: string }; // 1=Mon ... 7=Sun
function toDow(d: Date): number {
  // JS: 0=Sun..6=Sat -> biz: 1=Mon..7=Sun
  const js = d.getDay();
  return js === 0 ? 7 : js;
}
function hhmm(d: Date): string {
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}
function timeInRange(t: string, start: string, end: string) {
  return t >= start && t <= end;
}
function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number) {
  const toRad = (x: number) => (x * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const sa =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(sa), Math.sqrt(1 - sa));
  return R * c;
}
// DB’de availability iki formdan gelebilir: dizi ([{dow,start,end}]) veya eski map formu
function normalizeAvailabilityAny(av: any): AvRange[] {
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
  const out: AvRange[] = [];
  for (const k of Object.keys(map)) {
    const v = (av as any)[k];
    if (!v?.enabled) continue;
    const s = String(v.start || '');
    const e = String(v.end || '');
    if (/^\d{2}:\d{2}$/.test(s) && /^\d{2}:\d{2}$/.test(e) && s < e) {
      out.push({ dow: map[k], start: s, end: e });
    }
  }
  return out;
}

/* ===================================================== */

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
    if (!userId) throw new UnauthorizedException();

    const fmt = (body?.format ?? '7v7') as string;
    const baseSlots: Slot[] = buildInitialSlots(fmt, body?.positions);
    // SUB zaten varsa tekrar ekleme
    const initialSlots = baseSlots.some(s => s.pos === 'SUB')
      ? baseSlots
      : addReserves(baseSlots, reservesPerTeamByFormat(fmt));


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
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();

    const match = await this.prisma.match.findUnique({ where: { id: body.matchId } });
    if (!match) throw new NotFoundException('match not found');

    const slots: Slot[] = normalizeSlots((match as any).slots, (match as any).format);

    // Tüm slotlar doluysa net mesaj
    if (slots.every((s) => !!s.userId)) {
      throw new ConflictException('match_full');
    }

    // Zaten katıldıysa
    const mine = slots.find((s) => s.userId === userId);
    if (mine) return { ok: true, pos: mine.pos };

    // Double-check (yarış şartları için)
    const nowSlots: Slot[] = normalizeSlots(match.slots as any, match.format as any);
    const anyOpen = nowSlots.some((s) => !s.userId);
    if (!anyOpen) throw new ConflictException('match_full');

    // Pozisyon geldiyse
    let desired = body.pos?.trim().toUpperCase();
    if (desired) {
      const ok = slots.some(
        (s) => s.pos === desired && !s.userId && (!body.team || s.team === body.team),
      );
      if (!ok) throw new ConflictException('slot already taken');
    }

    // Gelmediyse: tercihlerden oto (+SUB fallback)
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
      if (!desired) {
        // takım tercihi varsa önce o takımın SUB’ı
        const subOnPreferredTeam = slots.find(
          (s) => !s.userId && s.pos === 'SUB' && (!body.team || s.team === body.team),
        );
        if (subOnPreferredTeam) {
          desired = 'SUB';
        } else {
          // herhangi SUB?
          const anySub = slots.find((s) => !s.userId && s.pos === 'SUB');
          if (anySub) desired = 'SUB';
        }
      }

      if (!desired) throw new ConflictException('no preferred open slot');
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
      level?: string | null;
      format?: string | null;
      price?: number | null;
      time?: string | null;
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

    if ('format' in body) {
      const nextFmt = normStr(body.format);
      if (nextFmt && nextFmt !== current.format) {
        const anyJoined = normalizeSlots(current.slots, current.format).some((s) => !!s.userId);
        if (anyJoined) throw new ConflictException('format_locked');

        // format değişiyorsa slotları da yeni kurala göre yeniden üret
        const baseSlots = buildInitialSlots(nextFmt, undefined);
        const withSubs = baseSlots.some(s => s.pos === 'SUB')
          ? baseSlots
          : addReserves(baseSlots, reservesPerTeamByFormat(nextFmt));
        data.format = nextFmt;
        data.slots  = withSubs as unknown as Prisma.JsonArray;
      }
    }
    await this.prisma.match.update({ where: { id }, data, select: { id: true } });
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
    const all = await this.prisma.match.findMany({
      select: { id: true, format: true, slots: true },
    });

    let updated = 0;

    for (const m of all) {
      const current = normalizeSlots(m.slots, m.format);
      const per = reservesPerTeamByFormat(m.format);

      let target = [...current];

      const adjustTeam = (team: Team) => {
        const starters = target.filter((s) => s.team === team && s.pos !== 'SUB');
        const bench    = target.filter((s) => s.team === team && s.pos === 'SUB');

        const assigned = bench.filter((s) => !!s.userId);
        const empty    = bench.filter((s) => !s.userId);

        // fazlaları (boş olanlardan başlayarak) buda
        while (assigned.length + empty.length > per && empty.length > 0) {
          empty.pop();
        }
        // eksikse boş SUB ekle
        while (assigned.length + empty.length < per) {
          empty.push({ team, pos: 'SUB', userId: null } as any);
        }

        return [...starters, ...assigned, ...empty];
      };

      const nextA = adjustTeam('A');
      const nextB = adjustTeam('B');

      target = [...nextA.filter(s => s.team === 'A'), ...nextB.filter(s => s.team === 'B')];

      const changed = JSON.stringify(target) !== JSON.stringify(current);
      if (!changed) continue;

      await this.prisma.match.update({
        where: { id: m.id },
        data: { slots: target as unknown as Prisma.JsonArray },
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
      data: ({ text, editedAt: new Date() } as any),
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
      data: ({ deleted: true, text: '' } as any),
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

    // Maçı ve boş pozisyonları çek
    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { id: true, ownerId: true, time: true, format: true, slots: true },
    });
    if (!match) throw new NotFoundException('match not found');

    // erişim: sahibi/katılımcı/accepted davet
    const access = await canAccessMatch(this.prisma, matchId, userId);
    if (!access.ok) throw new UnauthorizedException();

    const slots = normalizeSlots(match.slots, match.format);
    // slots'tan sonra (boş pozisyonları vs. çıkardıktan hemen sonra)
    const participants: Set<string> = new Set(
      slots
        .filter((s): s is Slot & { userId: string } => typeof s.userId === 'string' && s.userId.length > 0)
        .map((s) => s.userId)
    );

    const openCore = slots.filter((s) => !s.userId && s.pos !== 'SUB').map((s) => s.pos);
    const hasSubHoleA = slots.some((s) => s.team === 'A' && s.pos === 'SUB' && !s.userId);
    const hasSubHoleB = slots.some((s) => s.team === 'B' && s.pos === 'SUB' && !s.userId);

    // Önceden davet edilen (pending/accepted) kullanıcıları ele
    const recentInvs = await ((this.prisma as any).matchInvite).findMany({
      where: { matchId, status: { in: ['PENDING', 'ACCEPTED'] }, toUserId: { not: null } },
      select: { toUserId: true },
    });
    // recentInvs sonrası
    const invited: Set<string> = new Set(
      (recentInvs as Array<{ toUserId: string | null }>)
        .map((x) => x.toUserId)
        .filter((x): x is string => !!x)
    );

    // arayanın konumu
    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { lat: true, lng: true },
    });
    const baseLat = Number(me?.lat);
    const baseLng = Number(me?.lng);
    const hasBase = Number.isFinite(baseLat) && Number.isFinite(baseLng);

    const radiusKm = Math.max(1, Math.min(Number(radiusQ) || 30, 200));
    const limit = Math.max(1, Math.min(Number(limitQ) || 20, 100));

    // Arkadaşlar (puan bonusu)
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
    const notInIds: string[] = [
      userId!,                              // burada zaten üstte auth check var
      ...Array.from(participants),
      ...Array.from(invited),
    ];
    // adaylar
    const candidates = await this.prisma.user.findMany({
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

    // maç zamanı -> dow & HH:MM
    const matchTime = match.time ? new Date(match.time) : null;
    const matchDow = matchTime ? toDow(matchTime) : null;
    const matchT = matchTime ? hhmm(matchTime) : null;

    const scored = candidates
      .map((u) => {
        const posArr = Array.isArray(u.positions) ? (u.positions as any[]).map(String) : [];
        const avRanges = normalizeAvailabilityAny(u.availability);

        // Pozisyon skoru
        let posScore = 0;
        const tags: string[] = [];
        if (openCore.length && posArr.length) {
          const hit = posArr.find((p) => openCore.includes(p));
          if (hit) {
            posScore = 3;
            tags.push(`poz:${hit}`);
          }
        } else if ((hasSubHoleA || hasSubHoleB) && posArr.length) {
          posScore = 1; // çekirdek dolu ama yedek boş olabilir
          tags.push('yedek-uyum');
        }

        // Availability skoru
        let availScore = 0;
        if (matchDow && matchT && avRanges.length) {
          const ok = avRanges.some((r) => r.dow === matchDow && timeInRange(matchT, r.start, r.end));
          if (ok) {
            availScore = 2;
            tags.push('müsait');
          }
        }

        // Mesafe skoru
        let distanceKm = Number.NaN;
        let distScore = 0;
        if (hasBase && u.lat != null && u.lng != null) {
          distanceKm = haversineKm(baseLat, baseLng, Number(u.lat), Number(u.lng));
          if (distanceKm <= radiusKm) {
            distScore = distanceKm <= 5 ? 2 : distanceKm <= 15 ? 1 : 0;
            if (distScore > 0) tags.push(`~${distanceKm.toFixed(1)}km`);
          }
        }

        // Arkadaş bonusu
        const isFriend = friendIds.has(u.id);
        const friendScore = isFriend ? 2 : 0;
        if (isFriend) tags.push('arkadaş');

        // (İLERİ: sportsmanship alanlarını schema’ya ekleyince burada −/＋ puanlayacağız)

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
      .filter((x) => {
        if (hasBase) return Number.isFinite(x.distanceKm) && x.distanceKm <= radiusKm;
        return true;
      })
      .sort((a, b) => {
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
