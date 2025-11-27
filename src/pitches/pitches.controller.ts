import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PrismaService } from '../prisma/prisma.service';

function getUserIdFromReq(req: any): string | null {
  return req?.user?.sub || req?.user?.userId || req?.user?.id || null;
}

@Controller('pitches')
export class PitchesController {
  constructor(private prisma: PrismaService) {}

  /* ===================== ŞEHİR LİSTESİ ===================== */
  @Get('cities')
  async listCities() {
    const cities = await this.prisma.pitch.groupBy({
      by: ['city'],
      _count: { id: true },
      where: {
        verificationLevel: { gte: 2 },
        status: 'ACTIVE',
      },
      orderBy: { _count: { id: 'desc' } },
    });
    
    return {
      cities: cities.map(c => ({
        name: c.city,
        count: c._count.id,
      })),
    };
  }

  /* ===================== HALASAHA LİSTESİ ===================== */
  @Get()
  async listPitches(
    @Query('city') city?: string,
    @Query('district') district?: string,
    @Query('lat') latQ?: string,
    @Query('lng') lngQ?: string,
    @Query('radius') radiusQ?: string,
    @Query('minLevel') minLevelQ?: string,
    @Query('limit') limitQ?: string,
    @Query('offset') offsetQ?: string,
    @Query('search') search?: string,
  ) {
    const limit = Math.min(100, Math.max(1, parseInt(limitQ || '50', 10)));
    const offset = Math.max(0, parseInt(offsetQ || '0', 10));
    const minLevel = parseInt(minLevelQ || '2', 10);
    
    const where: any = {
      verificationLevel: { gte: minLevel },
      status: 'ACTIVE',
    };
    
    if (city) {
      where.city = { contains: city };
    }
    if (district) {
      where.district = { contains: district };
    }
    if (search) {
      where.OR = [
        { name: { contains: search } },
        { address: { contains: search } },
      ];
    }
    
    const lat = parseFloat(latQ || '');
    const lng = parseFloat(lngQ || '');
    const radius = parseFloat(radiusQ || '10');
    
    let pitches: any[];
    
    if (!isNaN(lat) && !isNaN(lng)) {
      const latDelta = radius / 111;
      const lngDelta = radius / (111 * Math.cos(lat * Math.PI / 180));
      
      where.lat = { gte: lat - latDelta, lte: lat + latDelta };
      where.lng = { gte: lng - lngDelta, lte: lng + lngDelta };
      
      const candidates = await this.prisma.pitch.findMany({
        where,
        select: {
          id: true,
          name: true,
          city: true,
          district: true,
          address: true,
          lat: true,
          lng: true,
          phone: true,
          sourceType: true,
          verificationLevel: true,
          status: true,
        },
        take: limit * 2,
      });
      
      const haversine = (lat1: number, lng1: number, lat2: number, lng2: number) => {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLng/2) * Math.sin(dLng/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        return R * c;
      };
      
      pitches = candidates
        .map(p => ({
          ...p,
          distanceKm: Math.round(haversine(lat, lng, p.lat, p.lng) * 10) / 10,
        }))
        .filter(p => p.distanceKm <= radius)
        .sort((a, b) => a.distanceKm - b.distanceKm)
        .slice(offset, offset + limit);
    } else {
      pitches = await this.prisma.pitch.findMany({
        where,
        select: {
          id: true,
          name: true,
          city: true,
          district: true,
          address: true,
          lat: true,
          lng: true,
          phone: true,
          sourceType: true,
          verificationLevel: true,
          status: true,
        },
        orderBy: [
          { verificationLevel: 'desc' },
          { name: 'asc' },
        ],
        skip: offset,
        take: limit,
      });
    }
    
    const total = await this.prisma.pitch.count({ where });
    
    return { pitches, total, limit, offset };
  }

  /* ===================== TEK SAHA DETAY ===================== */
  @Get(':id')
  async getPitch(@Param('id') id: string) {
    const pitch = await this.prisma.pitch.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            matches: true,
            visits: true,
            reports: true,
          }
        }
      }
    });
    
    if (!pitch) throw new NotFoundException('pitch not found');
    return pitch;
  }

  /* ===================== YENİ SAHA ÖNER ===================== */
  @UseGuards(AuthGuard('jwt'))
  @Post('suggest')
  async suggestPitch(
    @Req() req: any,
    @Body() body: {
      name: string;
      city: string;
      district?: string;
      address?: string;
      lat: number;
      lng: number;
      phone?: string;
    },
  ) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new ForbiddenException();
    
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { createdAt: true },
    });
    
    if (!user) throw new ForbiddenException();
    
    const accountAgeDays = (Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    if (accountAgeDays < 7) {
      throw new ForbiddenException('account_too_new');
    }
    
    const latDelta = 0.001;
    const lngDelta = 0.001;
    
    const nearby = await this.prisma.pitch.findFirst({
      where: {
        lat: { gte: body.lat - latDelta, lte: body.lat + latDelta },
        lng: { gte: body.lng - lngDelta, lte: body.lng + lngDelta },
      },
    });
    
    if (nearby) {
      throw new BadRequestException('pitch_already_exists_nearby');
    }
    
    const pitch = await this.prisma.pitch.create({
      data: {
        name: body.name,
        city: body.city,
        district: body.district || null,
        address: body.address || null,
        lat: body.lat,
        lng: body.lng,
        phone: body.phone || null,
        sourceType: 'USER_SUGGESTED',
        verificationLevel: 1,
        status: 'ACTIVE',
        createdByUserId: userId,
      },
    });
    
    return { ok: true, pitch };
  }

  /* ===================== SAHA RAPORU ===================== */
  @UseGuards(AuthGuard('jwt'))
  @Post(':id/report')
  async reportPitch(
    @Req() req: any,
    @Param('id') pitchId: string,
    @Body() body: {
      type: 'CLOSED' | 'RENOVATION' | 'WRONG_LOCATION' | 'NOT_PITCH' | 'SAFETY_ISSUE';
      comment?: string;
    },
  ) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new ForbiddenException();
    
    const pitch = await this.prisma.pitch.findUnique({ where: { id: pitchId } });
    if (!pitch) throw new NotFoundException('pitch not found');
    
    const report = await this.prisma.pitchReport.create({
      data: {
        pitchId,
        reporterId: userId,
        type: body.type,
        comment: body.comment || null,
        weight: 1.0,
      },
    });
    
    const reportCount = await this.prisma.pitchReport.count({
      where: { pitchId, type: body.type },
    });
    
    if (reportCount >= 3) {
      if (body.type === 'CLOSED') {
        await this.prisma.pitch.update({
          where: { id: pitchId },
          data: { status: 'CLOSED' },
        });
      } else if (body.type === 'RENOVATION') {
        await this.prisma.pitch.update({
          where: { id: pitchId },
          data: { status: 'RENOVATION' },
        });
      }
    }
    
    return { ok: true, report };
  }
}
