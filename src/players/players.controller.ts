// src/players/players.controller.ts
import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PrismaService } from '../prisma/prisma.service';
import { haversineKm } from '../common/geo';

function getUserIdFromReq(req: any) {
  return req?.user?.id || req?.user?.sub || req?.user?.userId;
}

@UseGuards(AuthGuard('jwt'))
@Controller('players')
export class PlayersController {
  constructor(private prisma: PrismaService) {}

  @Get('discover')
  async discover(
    @Req() req: any,
    @Query('lat') latQ?: string,
    @Query('lng') lngQ?: string,
    @Query('radiusKm') radiusQ?: string,
    @Query('level') levelQ?: string,        // opsiyonel
    @Query('positions') posQ?: string,      // opsiyonel, ör: "CM,RW"
  ) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new UnauthorizedException();

    // radius clamp (1–50 km)
    const radiusKm = Math.max(1, Math.min(Number(radiusQ ?? 10), 50));

    // lat/lng parse
    let lat = Number(latQ);
    let lng = Number(lngQ);

    // lat/lng gönderilmemişse kullanıcının kayıtlı konumu
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      const me = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { lat: true, lng: true },
      });
      if (!me?.lat || !me?.lng) throw new BadRequestException('missing lat/lng');
      lat = me.lat;
      lng = me.lng;
    }

    // ---- filtreler
    const level =
      levelQ !== undefined && levelQ !== '' && Number.isFinite(Number(levelQ))
        ? Number(levelQ)
        : undefined;

    const positions = posQ
      ? posQ
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean)
      : [];

    // Yakın bölge için kaba bounding box
    const dLat = radiusKm / 111; // ~111km/derece
    const dLng = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));

    const where: any = {
      discoverable: true,
      id: { not: userId },
      lat: { gte: lat - dLat, lte: lat + dLat },
      lng: { gte: lng - dLng, lte: lng + dLng },
    };

    if (level !== undefined) where.level = level;

    // positions Json içinde string arama (basit contains)
    if (positions.length) {
      where.OR = positions.map((p) => ({
        positions: { contains: `"${p}"` },
      }));
    }

    const candidates = await this.prisma.user.findMany({
      where,
      select: {
        id: true,
        phone: true,
        level: true,
        positions: true,
        lat: true,
        lng: true,
      },
      take: 200,
    });

    // mesafe hesapla + filtrele + sırala
    const center = { lat, lng };
    const items = candidates
      .map((u) => ({
        ...u,
        distanceKm:
          u.lat != null && u.lng != null
            ? haversineKm(center, { lat: u.lat!, lng: u.lng! })
            : 9999,
      }))
      .filter((u) => u.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 100);

    return { items, center, radiusKm };
  }
}
