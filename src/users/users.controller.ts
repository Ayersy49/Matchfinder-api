// src/users/users.controller.ts
import {
  Body,
  Controller,
  Get,
  Put,
  Req,
  UseGuards,
  UnauthorizedException,
  Query, // <-- eklendi
} from '@nestjs/common';
import { Prisma } from '@prisma/client'; // PrismaClient kullanılmıyor; sadece Prisma yeterli
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard } from '@nestjs/passport';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsBoolean,
  Max,
  Min,
} from 'class-validator';

/** ---- Json cast helper ---- */
const J = (v: unknown) => v as unknown as Prisma.InputJsonValue;

/** ---- Domain ---- */
enum DominantFoot {
  L = 'L',
  R = 'R',
  B = 'B',
  N = 'N',
}
const ALLOWED_POSITIONS = [
  'GK', 'LB', 'CB', 'RB', 'LWB', 'RWB', 'DM', 'CM', 'AM', 'LW', 'RW', 'ST',
] as const;
type PositionKey = (typeof ALLOWED_POSITIONS)[number];

type AvDay = { enabled: boolean; start: string; end: string };
type Availability = Record<
  'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun',
  AvDay
>;

const DEFAULT_AVAILABILITY: Availability = {
  mon: { enabled: false, start: '20:00', end: '23:59' },
  tue: { enabled: false, start: '20:00', end: '23:59' },
  wed: { enabled: false, start: '20:00', end: '23:59' },
  thu: { enabled: false, start: '20:00', end: '23:59' },
  fri: { enabled: false, start: '20:00', end: '23:59' },
  sat: { enabled: false, start: '20:00', end: '23:59' },
  sun: { enabled: false, start: '20:00', end: '23:59' },
};

/** ---- DTO'lar ---- */
class UpdateMeDto {
  @IsOptional() @IsEnum(DominantFoot) dominantFoot?: DominantFoot;
  @IsOptional() preferredFormation?: '4-2-3-1' | '4-3-3' | '3-5-2';

  @IsOptional() @IsArray() @ArrayMaxSize(3) @ArrayUnique()
  positions?: PositionKey[];

  @IsOptional() @IsInt() @Min(1) @Max(10)
  level?: number;

  @IsOptional() @IsObject()
  positionLevels?: Record<string, number>;

  @IsOptional() @IsObject()
  availability?: Partial<Availability>;

  // opsiyonel: aynı endpoint’ten de güncellenebilmesi için
  @IsOptional() @IsBoolean()
  discoverable?: boolean;

  @IsOptional() @IsNumber()
  lat?: number;

  @IsOptional() @IsNumber()
  lng?: number;
}

class DiscoverableDto {
  @IsOptional() @IsBoolean()
  value?: boolean; // verilirse set, verilmezse toggle
}

class LocationDto {
  @IsNumber() lat!: number;
  @IsNumber() lng!: number;
}

/** ---- Controller ---- */
@Controller('users')
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  /** Kimlikli kullanıcıyı getir (yoksa phone ile oluştur) */
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
          availability: J(DEFAULT_AVAILABILITY),
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
    const safeAvail =
      user.availability && typeof user.availability === 'object'
        ? ({ ...DEFAULT_AVAILABILITY, ...(user.availability as any) } as Availability)
        : DEFAULT_AVAILABILITY;

    return {
      id: user.id,
      phone: user.phone ?? phoneDigits ?? null,
      dominantFoot: (user.dominantFoot as DominantFoot) ?? 'N',
      positions: safePositions,
      preferredFormation: (user.preferredFormation as any) ?? '4-2-3-1',
      positionLevels: safeLevels,
      availability: safeAvail,
      level: user.level ?? 5,
      // keşif için
      lat: user.lat ?? null,
      lng: user.lng ?? null,
      discoverable: !!user.discoverable,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  /** Profili güncelle */
  @UseGuards(AuthGuard('jwt'))
  @Put('me')
  async update(@Req() req: any, @Body() dto: UpdateMeDto) {
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
          availability: J(DEFAULT_AVAILABILITY),
          level: 5,
          dominantFoot: 'N',
          preferredFormation: '4-2-3-1',
          discoverable: false,
        },
      });
    }
    if (!user) throw new UnauthorizedException();

    // positions
    let positions: PositionKey[] | undefined;
    if (dto.positions) {
      positions = dto.positions
        .filter((p) => (ALLOWED_POSITIONS as readonly string[]).includes(p))
        .slice(0, 3) as PositionKey[];
    }

    // positionLevels (1..10, izinli pozisyonlar)
    let positionLevels: Record<string, number> | undefined;
    if (dto.positionLevels && typeof dto.positionLevels === 'object') {
      positionLevels = {};
      for (const [k, v] of Object.entries(dto.positionLevels)) {
        if ((ALLOWED_POSITIONS as readonly string[]).includes(k)) {
          const n = Math.max(1, Math.min(10, Number(v)));
          positionLevels[k] = n;
        }
      }
      if (positions) {
        positionLevels = Object.fromEntries(
          Object.entries(positionLevels).filter(([k]) =>
            positions!.includes(k as PositionKey),
          ),
        );
      }
    }

    // availability normalize
    let availability: Availability | undefined;
    if (dto.availability && typeof dto.availability === 'object') {
      const merged: any = { ...DEFAULT_AVAILABILITY };
      for (const k of Object.keys(DEFAULT_AVAILABILITY) as Array<keyof Availability>) {
        const d = (dto.availability as any)[k];
        if (!d) continue;
        const ok = (s: any) => typeof s === 'string' && /^\d{2}:\d{2}$/.test(s);
        merged[k] = {
          enabled: !!d.enabled,
          start: ok(d.start) ? d.start : DEFAULT_AVAILABILITY[k].start,
          end: ok(d.end) ? d.end : DEFAULT_AVAILABILITY[k].end,
        };
      }
      availability = merged as Availability;
    }

    const data: Prisma.UserUpdateInput = {};
    if (dto.dominantFoot) data.dominantFoot = dto.dominantFoot;
    if (positions) data.positions = J(positions);
    if (typeof dto.level === 'number') data.level = Math.max(1, Math.min(10, dto.level));
    if (positionLevels) data.positionLevels = J(positionLevels);
    if (availability) data.availability = J(availability);
    if (dto.preferredFormation && ['4-2-3-1', '4-3-3', '3-5-2'].includes(dto.preferredFormation)) {
      (data as any).preferredFormation = dto.preferredFormation;
    }
    if (typeof dto.discoverable === 'boolean') data.discoverable = dto.discoverable;
    if (typeof dto.lat === 'number' && typeof dto.lng === 'number') {
      const latOk = dto.lat >= -90 && dto.lat <= 90;
      const lngOk = dto.lng >= -180 && dto.lng <= 180;
      if (latOk && lngOk) {
        (data as any).lat = dto.lat;
        (data as any).lng = dto.lng;
      }
    }

    const updated = await this.prisma.user.update({ where: { id: user.id }, data });
    return updated;
  }

  /** Keşifte görünürlüğü aç/kapat (value verilmezse toggle) */
  @UseGuards(AuthGuard('jwt'))
  @Put('me/discoverable')
  async setDiscoverable(@Req() req: any, @Body() body: DiscoverableDto) {
    const id = req.user?.sub as string | undefined;
    if (!id) throw new UnauthorizedException();

    const me = await this.prisma.user.findUnique({ where: { id } });
    if (!me) throw new UnauthorizedException();

    const next =
      typeof body.value === 'boolean' ? body.value : !Boolean(me.discoverable);

    await this.prisma.user.update({
      where: { id },
      data: { discoverable: next },
    });

    return { ok: true, discoverable: next };
  }

  /** Konumu yaz (lat,lng) */
  @UseGuards(AuthGuard('jwt'))
  @Put('me/location')
  async setLocation(@Req() req: any, @Body() body: LocationDto) {
    const id = req.user?.sub as string | undefined;
    if (!id) throw new UnauthorizedException();

    const latOk = body.lat >= -90 && body.lat <= 90;
    const lngOk = body.lng >= -180 && body.lng <= 180;
    if (!latOk || !lngOk) {
      return { ok: false, message: 'invalid_lat_lng' };
    }

    await this.prisma.user.update({
      where: { id },
      data: { lat: body.lat, lng: body.lng },
    });

    return { ok: true };
  }

  /** Yakındaki oyuncular – /users/discover?lat=..&lng=..&radiusKm=..  */
  @UseGuards(AuthGuard('jwt'))
  @Get('discover')
  async discover(
    @Req() req: any,
    @Query('lat') latQ?: string,
    @Query('lng') lngQ?: string,
    @Query('radiusKm') radiusQ?: string,
  ) {
    const meId = req.user?.sub as string | undefined;
    if (!meId) throw new UnauthorizedException();

    // yarıçap
    const radiusKm = Math.max(1, Math.min(200, Number(radiusQ) || 30));

    // baz konum: query yoksa kullanıcının kendi konumu
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

    // adaylar
    const candidates = await this.prisma.user.findMany({
      where: {
        discoverable: true,
        id: { not: meId },
        lat: { not: null },
        lng: { not: null },
      },
      select: {
        id: true,
        phone: true,
        level: true,
        positions: true,
        lat: true,
        lng: true,
      },
    });

    // Haversine
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
