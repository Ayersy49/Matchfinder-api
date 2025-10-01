// src/users/users.controller.ts
import {
  Body,
  Controller,
  Get,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard } from '@nestjs/passport';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

enum DominantFoot {
  L = 'L',
  R = 'R',
  B = 'B', // both
  N = 'N', // none
}

const ALLOWED_POSITIONS = [
  'GK', 'LB', 'CB', 'RB', 'LWB', 'RWB', 'DM', 'CM', 'AM', 'LW', 'RW', 'ST',
] as const;
type PositionKey = (typeof ALLOWED_POSITIONS)[number];

type AvDay = { enabled: boolean; start: string; end: string };
type Availability = Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', AvDay>;

const DEFAULT_AVAILABILITY: Availability = {
  mon: { enabled: false, start: '20:00', end: '23:59' },
  tue: { enabled: false, start: '20:00', end: '23:59' },
  wed: { enabled: false, start: '20:00', end: '23:59' },
  thu: { enabled: false, start: '20:00', end: '23:59' },
  fri: { enabled: false, start: '20:00', end: '23:59' },
  sat: { enabled: false, start: '20:00', end: '23:59' },
  sun: { enabled: false, start: '20:00', end: '23:59' },
};

class UpdateMeDto {
  @IsOptional()
  @IsEnum(DominantFoot)
  dominantFoot?: DominantFoot;

  @IsOptional()
  // formasyon seti sabit: sadece bu üç değer
  preferredFormation?: '4-2-3-1' | '4-3-3' | '3-5-2';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ArrayUnique()
  positions?: PositionKey[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  level?: number;

  @IsOptional()
  @IsObject()
  positionLevels?: Record<string, number>;

  @IsOptional()
  @IsObject()
  availability?: Partial<Availability>;
}

@Controller('users')
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  // Kimlikli kullanıcıyı getir (yoksa phone ile oluştur)
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
          positions: [],
          positionLevels: {},
          availability: DEFAULT_AVAILABILITY,
        },
      });
    }

    // Güvenli dönüş (Json alanlar bozuksa fallback ver)
    const safePositions = Array.isArray(user?.positions) ? (user!.positions as any[]) : [];
    const safeLevels =
      user?.positionLevels && typeof user.positionLevels === 'object'
        ? (user!.positionLevels as Record<string, number>)
        : {};
    const safeAvail =
      user?.availability && typeof user.availability === 'object'
        ? ({ ...DEFAULT_AVAILABILITY, ...(user!.availability as any) } as Availability)
        : DEFAULT_AVAILABILITY;

    return {
      id: user?.id ?? null,
      phone: user?.phone ?? phoneDigits ?? null,
      dominantFoot: user?.dominantFoot ?? 'N',
      positions: safePositions,
      preferredFormation: (user?.preferredFormation as any) ?? '4-2-3-1',
      positionLevels: safeLevels,
      availability: safeAvail,
      level: user?.level ?? 5,
      createdAt: user?.createdAt ?? null,
      updatedAt: user?.updatedAt ?? null,
    };
  }

  // Profili güncelle
  @UseGuards(AuthGuard('jwt'))
  @Put('me')
  async update(@Req() req: any, @Body() dto: UpdateMeDto) {
    const id = req.user?.sub as string | undefined;
    const phoneDigits = String(req.user?.phone ?? '').replace(/\D/g, '');

    // positions
    let positions: PositionKey[] | undefined;
    if (dto.positions) {
      positions = dto.positions
        .filter((p) => (ALLOWED_POSITIONS as readonly string[]).includes(p))
        .slice(0, 3) as PositionKey[];
    }

    // positionLevels (sadece izin verilen pozisyonlar ve 1..10)
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
      const merge: any = { ...DEFAULT_AVAILABILITY };
      for (const k of Object.keys(DEFAULT_AVAILABILITY) as Array<keyof Availability>) {
        const d = (dto.availability as any)[k];
        if (!d) continue;
        const ok = (s: any) => typeof s === 'string' && /^\d{2}:\d{2}$/.test(s);
        merge[k] = {
          enabled: !!d.enabled,
          start: ok(d.start) ? d.start : DEFAULT_AVAILABILITY[k].start,
          end: ok(d.end) ? d.end : DEFAULT_AVAILABILITY[k].end,
        };
      }
      availability = merge as Availability;
    }

    // yazılacak veri
    const data: any = {};
    if (dto.dominantFoot) data.dominantFoot = dto.dominantFoot;
    if (positions) data.positions = positions;
    if (typeof dto.level === 'number') data.level = Math.max(1, Math.min(10, dto.level));
    if (positionLevels) data.positionLevels = positionLevels;
    if (availability) data.availability = availability;
    if (
      dto.preferredFormation &&
      ['4-2-3-1', '4-3-3', '3-5-2'].includes(dto.preferredFormation)
    ) {
      data.preferredFormation = dto.preferredFormation;
    }

    // kullanıcıyı bul/oluştur
    let user = id ? await this.prisma.user.findUnique({ where: { id } }) : null;
    if (!user && phoneDigits) {
      user = await this.prisma.user.upsert({
        where: { phone: phoneDigits },
        update: {},
        create: {
          phone: phoneDigits,
          positions: [],
          positionLevels: {},
          availability: DEFAULT_AVAILABILITY,
        },
      });
    }

    const updated = await this.prisma.user.update({
      where: { id: user!.id },
      data,
    });
    return updated;
  }
}
