import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Put,
  Post,
  Req,
  UseGuards,
  UnauthorizedException,
  Param,
  Query,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/* ----------------- Helpers / Types ----------------- */

const J = (v: unknown) => v as unknown as Prisma.InputJsonValue;

type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
type Interval = { start: string; end: string };
type Avail = Record<DayKey, Interval[]>;

const DAY_KEYS: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DOW_TO_KEY: Record<number, DayKey> = {
  1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri', 6: 'sat', 7: 'sun',
};

const EMPTY_AVAIL: Avail = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };

const ALLOWED_POSITIONS = [
  'GK', 'LB', 'CB', 'RB', 'LWB', 'RWB', 'DM', 'CM', 'AM', 'LW', 'RW', 'ST',
] as const;

function getUserId(req: any): string | undefined {
  return req?.user?.id || req?.user?.sub || req?.user?.userId || undefined;
}

const isTime = (s: any) =>
  typeof s === 'string' &&
  /^\d{2}:\d{2}$/.test(s) &&
  +s.slice(0, 2) >= 0 && +s.slice(0, 2) <= 23 &&
  +s.slice(3, 5) >= 0 && +s.slice(3, 5) <= 59;

function mergeIntervals(list: Interval[]): Interval[] {
  const arr = list
    .filter((x) => isTime(x.start) && isTime(x.end) && x.start < x.end)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  const out: Interval[] = [];
  for (const cur of arr) {
    const last = out[out.length - 1];
    if (last && cur.start <= last.end) {
      last.end = cur.end > last.end ? cur.end : last.end;
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

/** Her türlü payload'ı (yeni veya legacy) Avail formatına normalize eder. */
function normalizeAvail(input: any): Avail {
  let src = input;
  if (src && typeof src === 'object' && 'availability' in src) {
    src = (src as any).availability;
  }

  // 1) Yeni format: { mon:[{start,end}], ... }
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    const out: Avail = { ...EMPTY_AVAIL };
    for (const k of DAY_KEYS) {
      const raw = Array.isArray((src as any)[k]) ? (src as any)[k] : [];
      out[k] = mergeIntervals(
        raw.map((r: any) => ({ start: String(r?.start || ''), end: String(r?.end || '') })),
      );
    }
    return out;
  }

  // 2) Legacy: { items:[{ dow:1..7, start, end }]} veya doğrudan dizi
  const arr = Array.isArray((src as any)?.items) ? (src as any).items : src;
  if (!Array.isArray(arr)) throw new BadRequestException('invalid_payload');

  const buckets: Avail = { ...EMPTY_AVAIL };
  for (const it of arr) {
    const dow = Number((it as any)?.dow);
    const start = String((it as any)?.start || '');
    const end = String((it as any)?.end || '');
    if (!(dow >= 1 && dow <= 7 && isTime(start) && isTime(end) && start < end)) continue;
    buckets[DOW_TO_KEY[dow]].push({ start, end });
  }
  for (const k of DAY_KEYS) buckets[k] = mergeIntervals(buckets[k]);
  return buckets;
}

/** DB'deki karışık yapıları (legacy/new) güvenle yeni formata döndürür. */
function coerceFromDb(raw: any): Avail {
  try {
    if (!raw) return { ...EMPTY_AVAIL };
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      return normalizeAvail({ availability: raw });
    }
    if (Array.isArray(raw)) {
      return normalizeAvail({ items: raw });
    }
    return { ...EMPTY_AVAIL };
  } catch {
    return { ...EMPTY_AVAIL };
  }
}

/** davranış skoru rengi */
function colorOf(total: number) {
  if (total >= 90) return 'blue';
  if (total >= 60) return 'green';
  if (total >= 40) return 'yellow';
  return 'red';
}

/* ----------------- Controller ----------------- */

@Controller('users')
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  /** Kimlikli kullanıcı (yoksa phone’dan upsert) */
  @UseGuards(AuthGuard('jwt'))
  @Get('me')
  async me(@Req() req: any) {
    const id = req.user?.sub as string | undefined;
    const phoneDigits = String(req.user?.phone ?? '').replace(/\D/g, '');

    let user = id ? await this.prisma.user.findUnique({ where: { id } }) : null;

    if (!user && phoneDigits) {
      user = await this.prisma.user.upsert({
        where: { phone: phoneDigits },
        update: {},
        create: {
          phone: phoneDigits,
          positions: J([]),
          positionLevels: J({}),
          availability: J(EMPTY_AVAIL),
          level: 5,
          dominantFoot: 'N',
          preferredFormation: '4-2-3-1',
          discoverable: false,
        },
      });
    }
    if (!user) throw new UnauthorizedException();

    const safePositions = Array.isArray(user.positions) ? (user.positions as any[]) : [];
    const safeLevels =
      user.positionLevels && typeof user.positionLevels === 'object'
        ? (user.positionLevels as Record<string, number>)
        : {};
    const safeAvail = coerceFromDb(user.availability);
    // --- dış değerlendirme almış mevkiler (kilitlenecekler) ---
    const prGrouped = await this.prisma.positionRating.groupBy({
      by: ['pos'],
      where: { rateeId: user.id },
      _count: { _all: true },
    });
    const posLocked: string[] = prGrouped
      .filter(x => Number((x as any)?._count?._all || 0) > 0)
      .map(x => String(x.pos).toUpperCase());

    // --- pozisyon seviyelerini UPPERCASE key'lere normalize et ---
    const upperLevels: Record<string, number> = {};
    for (const [k, v] of Object.entries(safeLevels)) {
      upperLevels[String(k).toUpperCase()] = Number(v as any);
    }

    // --- ilk 3 tercih (profildeki positions dizisinin ilk 3'ü) ---
    const top3: string[] = Array.isArray(user.positions)
      ? (user.positions as any[]).map(String).slice(0, 3).map(p => p.toUpperCase())
      : [];

    // --- ilk 3 mevki + kullanıcı kendi verdiği seviye (yoksa genel seviye) ---
    const top3WithLevels = top3.map(p => ({
      pos: p,
      level: Number(upperLevels[p] ?? user.level ?? 5),
    }));


    return {
      id: user.id,
      phone: user.phone ?? phoneDigits ?? null,
      dominantFoot: (user.dominantFoot as any) ?? 'N',
      positions: safePositions,
      preferredFormation: (user.preferredFormation as any) ?? '4-2-3-1',
      positionLevels: upperLevels,
      availability: safeAvail,
      level: user.level ?? 5,
      lat: user.lat ?? null,
      lng: user.lng ?? null,
      discoverable: !!user.discoverable,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      posLocked,
      topPositions: top3,
      top3WithLevels,
    };
  }

  /** Profili güncelle (availability yeni/legacy format) */
  @UseGuards(AuthGuard('jwt'))
  @Put('me')
  async update(@Req() req: any, @Body() dto: any) {
    const id = getUserId(req);
    if (!id) throw new UnauthorizedException();

    const data: Prisma.UserUpdateInput = {};

    if (dto?.dominantFoot && ['L', 'R', 'B', 'N'].includes(dto.dominantFoot)) {
      (data as any).dominantFoot = dto.dominantFoot;
    }
    if (typeof dto?.level === 'number') {
      data.level = Math.max(1, Math.min(10, dto.level));
    }

    if (Array.isArray(dto?.positions)) {
      const allowed = new Set(ALLOWED_POSITIONS as readonly string[]);
      const list = dto.positions.filter((p: any) => allowed.has(String(p))).slice(0, 3);
      data.positions = J(list);
    }

    if (dto?.positionLevels && typeof dto.positionLevels === 'object') {
      // 1) kullanıcının dışarıdan oylama almış (kilitli) mevkilerini çek
      const grouped = await this.prisma.positionRating.groupBy({
        by: ['pos'],
        where: { rateeId: id },
        _count: { _all: true },
      });
      const locked = new Set(
        grouped
          .filter(g => Number((g as any)?._count?._all || 0) > 0)
          .map(g => String(g.pos).toUpperCase())
      );

      const allowed = new Set(ALLOWED_POSITIONS as readonly string[]);
      const pl: Record<string, number> = {};

      // 2) gelen seviyeleri normalleştir, kilitli olanları YAZMA
      for (const [k, v] of Object.entries(dto.positionLevels)) {
        const P = String(k).toUpperCase();
        if (!allowed.has(P)) continue;
        if (locked.has(P)) continue; // kilitliyse atla
        const n = Math.max(1, Math.min(10, Number(v)));
        pl[P] = n;
      }

      if (Object.keys(pl).length > 0) {
        data.positionLevels = J(pl);
      }
    }

    if (dto?.availability || (dto?.items && Array.isArray(dto.items))) {
      const normalized = normalizeAvail(dto);
      data.availability = J(normalized);
    }

    if (dto?.preferredFormation && ['4-2-3-1', '4-3-3', '3-5-2'].includes(dto.preferredFormation)) {
      (data as any).preferredFormation = dto.preferredFormation;
    }

    if (typeof dto?.discoverable === 'boolean') {
      (data as any).discoverable = dto.discoverable;
    }

    if (typeof dto?.lat === 'number' && typeof dto?.lng === 'number') {
      const latOk = dto.lat >= -90 && dto.lat <= 90;
      const lngOk = dto.lng >= -180 && dto.lng <= 180;
      if (latOk && lngOk) {
        (data as any).lat = dto.lat;
        (data as any).lng = dto.lng;
      }
    }

    const updated = await this.prisma.user.update({ where: { id }, data });
    return {
      id: updated.id,
      positions: Array.isArray(updated.positions) ? (updated.positions as any[]) : [],
      positionLevels:
        updated.positionLevels && typeof updated.positionLevels === 'object'
          ? (updated.positionLevels as Record<string, number>)
          : {},
      availability: coerceFromDb(updated.availability),
      level: updated.level,
      dominantFoot: updated.dominantFoot,
      preferredFormation: updated.preferredFormation,
      lat: updated.lat ?? null,
      lng: updated.lng ?? null,
      discoverable: !!updated.discoverable,
      updatedAt: updated.updatedAt,
    };
  }

  /** Keşifte görünürlüğü aç/kapat (value verilmezse toggle) */
  @UseGuards(AuthGuard('jwt'))
  @Put('me/discoverable')
  async setDiscoverable(@Req() req: any, @Body() body: any) {
    const id = getUserId(req);
    if (!id) throw new UnauthorizedException();

    const me = await this.prisma.user.findUnique({ where: { id } });
    if (!me) throw new UnauthorizedException();

    const next = typeof body?.value === 'boolean' ? body.value : !Boolean(me.discoverable);
    await this.prisma.user.update({ where: { id }, data: { discoverable: next } });

    return { ok: true, discoverable: next };
  }

  /** Konumu yaz (lat,lng) */
  @UseGuards(AuthGuard('jwt'))
  @Put('me/location')
  async setLocation(@Req() req: any, @Body() body: any) {
    const id = getUserId(req);
    if (!id) throw new UnauthorizedException();

    const lat = Number(body?.lat);
    const lng = Number(body?.lng);
    const latOk = Number.isFinite(lat) && lat >= -90 && lat <= 90;
    const lngOk = Number.isFinite(lng) && lng >= -180 && lng <= 180;
    if (!latOk || !lngOk) throw new BadRequestException('invalid_lat_lng');

    await this.prisma.user.update({ where: { id }, data: { lat, lng } });
    return { ok: true };
  }

  /** Başkasının herkese açık profili (arkadaşa availability göster) */
  @UseGuards(AuthGuard('jwt'))
  @Get(':id/public-profile')
  async publicProfile(@Req() req: any, @Param('id') id: string) {
    const meId = getUserId(req);
    if (!meId) throw new UnauthorizedException();

    const isFriend = !!(await this.prisma.friendship.findFirst({
      where: { OR: [{ userId: meId, friendId: id }, { userId: id, friendId: meId }] },
    }));

    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, level: true, positions: true, positionLevels: true, preferredFormation: true },
    });
    if (!user) throw new BadRequestException('user_not_found');

    const availability = isFriend
      ? coerceFromDb((await this.prisma.user.findUnique({ where: { id }, select: { availability: true } }))?.availability)
      : null;

    return {
      user: {
        ...user,
        positions: Array.isArray(user.positions) ? (user.positions as any[]) : [],
        positionLevels:
          user.positionLevels && typeof user.positionLevels === 'object'
            ? (user.positionLevels as Record<string, number>)
            : {},
      },
      availability,
      isFriend,
    };
  }

  /* ---------- Müsaitlik Endpoints (Yeni Format) ---------- */

  @UseGuards(AuthGuard('jwt'))
  @Get('me/availability')
  async getMyAvailability(@Req() req: any) {
    const userId = getUserId(req);
    if (!userId) throw new BadRequestException('no_user');

    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { availability: true },
    });

    const availability = coerceFromDb(me?.availability);
    return { availability };
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('me/availability')
  async setMyAvailability(@Req() req: any, @Body() body: any) {
    const userId = getUserId(req);
    if (!userId) throw new BadRequestException('no_user');

    const availability = normalizeAvail(body);
    await this.prisma.user.update({
      where: { id: userId },
      data: { availability: J(availability) },
      select: { id: true },
    });

    return { ok: true, availability };
  }

  /** Davranış özeti (ağırlıklı) – eski kolon adlarıyla */
  @Get(':id/behavior')
  async behavior(@Param('id') id: string) {
    const rows = await this.prisma.rating.findMany({
      where: { ratedId: id }, // DİKKAT: Prisma alanı ratedId
      select: { traits: true, weight: true },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });

    if (!rows.length) {
      return { avg: null, si: 70, total: 70, color: 'green', samples: 0 };
    }

    let wsum = 0, P=0, R=0, S=0, W=0, A=0;
    for (const r of rows) {
      const w = r.weight || 1;
      const t = (r.traits || {}) as any;
      const p  = Number(t.punctuality)   || 0;
      const rs = Number(t.respect)       || 0;
      const sp = Number(t.sportsmanship) || 0;
      const sw = Number(t.swearing)      || 0;
      const ag = Number(t.aggression)    || 0;
      wsum += w;
      P += w * p; R += w * rs; S += w * sp; W += w * sw; A += w * ag;
    }
    const avg = {
      punctuality:   P/wsum,
      respect:       R/wsum,
      sportsmanship: S/wsum,
      swearing:      W/wsum,
      aggression:    A/wsum,
    };

    const n = (x:number)=> (x-1)/4;
    const total = Math.round(100 * (
      0.15*n(avg.punctuality) + 0.25*n(avg.respect) + 0.25*n(avg.sportsmanship) +
      0.20*n(avg.swearing)    + 0.15*n(avg.aggression)
    ));
    const color = total >= 90 ? 'blue' : total >= 60 ? 'green' : total >= 40 ? 'yellow' : 'red';

    return { avg, si: total, total, color, samples: rows.length };
  }

  // GET /users/:id/positions
  @Get(':id/positions')
  async positions(@Param('id') id: string) {
    const rows = await this.prisma.positionRating.findMany({
      where: { rateeId: id },
      select: { pos: true, score: true, weight: true },
      take: 5000,
      orderBy: { createdAt: 'desc' },
    });

    const byPos: Record<string, { avg: number; samples: number }> = {};
    for (const r of rows) {
      const p = r.pos;
      const w = r.weight ?? 1;
      if (!byPos[p]) byPos[p] = { avg: 0, samples: 0 };
      byPos[p].avg += w * r.score;
      byPos[p].samples += 1;
      (byPos as any)[p].wsum = ((byPos as any)[p].wsum ?? 0) + w;
    }
    for (const p of Object.keys(byPos)) {
      const wsum = (byPos as any)[p].wsum || 1;
      byPos[p].avg = +(byPos[p].avg / wsum).toFixed(1);
      delete (byPos as any)[p].wsum;
    }
    return { byPos };
  }

  /** Yakındaki oyuncular */
  @UseGuards(AuthGuard('jwt'))
  @Get('discover')
  async discover(
    @Req() req: any,
    @Query('lat') latQ?: string,
    @Query('lng') lngQ?: string,
    @Query('radiusKm') radiusQ?: string,
  ) {
    const meId = getUserId(req);
    if (!meId) throw new UnauthorizedException();

    const radiusKm = Math.max(1, Math.min(200, Number(radiusQ) || 30));

    let baseLat = Number(latQ);
    let baseLng = Number(lngQ);
    if (!Number.isFinite(baseLat) || !Number.isFinite(baseLng)) {
      const me = await this.prisma.user.findUnique({
        where: { id: meId },
        select: { lat: true, lng: true },
      });
      if (!me?.lat || !me?.lng) return { items: [] as any[] };
      baseLat = me.lat!;
      baseLng = me.lng!;
    }

    const candidates = await this.prisma.user.findMany({
      where: {
        discoverable: true,
        id: { not: meId },
        lat: { not: null },
        lng: { not: null },
      },
      select: { id: true, phone: true, level: true, positions: true, lat: true, lng: true },
    });

    const toRad = (x: number) => (x * Math.PI) / 180;
    const haversineKm = (aLat: number, aLng: number, bLat: number, bLng: number) => {
      const R = 6371;
      const dLat = toRad(bLat - aLat);
      const dLng = toRad(bLng - aLng);
      const sa =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
      const c = 2 * Math.atan2(Math.sqrt(sa), Math.sqrt(1 - sa));
      return R * c;
    };

    const items = candidates
      .map((u) => {
        const dist = haversineKm(baseLat, baseLng, Number(u.lat), Number(u.lng));
        let pos: string[] | null = null;
        if (Array.isArray(u.positions)) pos = (u.positions as any[]).map(String);
        return {
          id: u.id,
          phone: u.phone ?? null,
          level: u.level ?? null,
          positions: pos,
          lat: Number(u.lat),
          lng: Number(u.lng),
          distanceKm: dist,
        };
      })
      .filter((x) => x.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 100);

    return { items };
  }
}
