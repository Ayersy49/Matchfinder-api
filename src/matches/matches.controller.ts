// src/matches/matches.controller.ts
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard } from '@nestjs/passport';

type Slot = { pos: string; userId?: string | null };

type CreateDto = {
  title: string;
  location?: string;
  level?: 'Kolay' | 'Orta' | 'Zor';
  format?: '5v5' | '7v7' | '8v8' | '11v11';
  price?: number;
  time?: string; // ISO
  slots?: Slot[];
};

type JoinDto = { matchId: string; pos: string };
type LeaveDto = { matchId: string };

function safeSlots(raw: any): Slot[] {
  if (!raw) return [];
  try {
    const v = Array.isArray(raw) ? raw : JSON.parse(String(raw));
    return (v as any[]).map((s) => ({
      pos: String(s?.pos ?? '').toUpperCase().slice(0, 8),
      userId: s?.userId ?? null,
    }));
  } catch {
    return [];
  }
}

// Kullanıcı oluşmadıysa telefonla upsert et (UsersController.me ile uyumlu)
const DEFAULT_AVAILABILITY = {
  mon: { enabled: false, start: '20:00', end: '23:59' },
  tue: { enabled: false, start: '20:00', end: '23:59' },
  wed: { enabled: false, start: '20:00', end: '23:59' },
  thu: { enabled: false, start: '20:00', end: '23:59' },
  fri: { enabled: false, start: '20:00', end: '23:59' },
  sat: { enabled: false, start: '20:00', end: '23:59' },
  sun: { enabled: false, start: '20:00', end: '23:59' },
};

async function ensureUserId(prisma: PrismaService, req: any): Promise<string | undefined> {
  let userId = req.user?.sub as string | undefined;
  if (userId) return userId;

  const phoneDigits = String(req.user?.phone ?? '').replace(/\D/g, '');
  if (!phoneDigits) return undefined;

  const u = await prisma.user.upsert({
    where: { phone: phoneDigits },
    update: {},
    create: {
      phone: phoneDigits,
      positions: [],
      positionLevels: {},
      availability: DEFAULT_AVAILABILITY,
    },
  });
  return u.id;
}

@Controller('matches')
@UseGuards(AuthGuard('jwt'))
export class MatchesController {
  constructor(private readonly prisma: PrismaService) {}

  // Liste
  @Get()
  async list() {
    return this.prisma.match.findMany({
      orderBy: { time: 'desc' },
      take: 50,
      include: { owner: true },
    });
  }

  // Detay
  @Get(':id')
  async detail(@Param('id') id: string) {
    return this.prisma.match.findUnique({
      where: { id },
      include: { owner: true },
    });
  }

  // Oluştur
  @Post()
  async create(@Req() req: any, @Body() dto: CreateDto) {
    const ownerId = await ensureUserId(this.prisma, req);

    const payload = {
      title: (dto.title ?? '').trim().slice(0, 100) || 'Maç',
      location: (dto.location ?? '').trim().slice(0, 100) || null,
      level: (dto.level ?? 'Orta') as string,
      format: (dto.format ?? '7v7') as string,
      price:
        typeof dto.price === 'number' ? Math.max(0, Math.floor(dto.price)) : null,
      time: dto.time ? new Date(dto.time) : new Date(),
      slots: dto.slots && Array.isArray(dto.slots) ? safeSlots(dto.slots) : [],
      ownerId: ownerId ?? null,
    };

    const created = await this.prisma.match.create({ data: payload });
    return created;
  }

  // Katıl
  @Post('join')
  async join(@Req() req: any, @Body() body: JoinDto) {
    const userId = await ensureUserId(this.prisma, req);
    if (!userId) return { ok: false, reason: 'no_user' };

    const m = await this.prisma.match.findUnique({ where: { id: body.matchId } });
    if (!m) return { ok: false, reason: 'not_found' };

    const pos = String(body.pos || '').toUpperCase().slice(0, 8);
    let slots = safeSlots(m.slots);

    // Kullanıcının eski slotunu boşalt (tek slot kuralı)
    slots = slots.map((s) => (s.userId === userId ? { ...s, userId: null } : s));

    // İstenen pozisyon dolu değilse doldur, yoksa yeni slot ekle
    const free = slots.find((s) => s.pos === pos && !s.userId);
    if (free) free.userId = userId;
    else slots.push({ pos, userId });

    const updated = await this.prisma.match.update({
      where: { id: m.id },
      data: { slots },
    });

    return { ok: true, match: updated };
  }

  // Ayrıl
  @Post('leave')
  async leave(@Req() req: any, @Body() body: LeaveDto) {
    const userId = await ensureUserId(this.prisma, req);
    if (!userId) return { ok: false, reason: 'no_user' };

    const m = await this.prisma.match.findUnique({ where: { id: body.matchId } });
    if (!m) return { ok: false, reason: 'not_found' };

    const slots = safeSlots(m.slots).map((s) =>
      s.userId === userId ? { ...s, userId: null } : s,
    );

    const updated = await this.prisma.match.update({
      where: { id: m.id },
      data: { slots },
    });

    return { ok: true, match: updated };
  }
}
