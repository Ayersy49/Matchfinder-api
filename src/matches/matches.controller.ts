// src/matches/matches.controller.ts
import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Param,
  Req,
  UseGuards,
  HttpException,
  HttpStatus,
  NotFoundException,
  ConflictException,
  BadRequestException,
  UnauthorizedException,   // <-- eklendi
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';          // <-- JSON alanına tipli cast için
import { AuthGuard } from '@nestjs/passport';

/** Varsayılan slot listeleri (format -> pozisyon dizisi) */
const DEFAULT_SLOTS: Record<string, string[]> = {
  '5v5': ['GK', 'CB', 'CM', 'LW', 'ST'],
  '7v7': ['GK', 'LB', 'CB', 'RB', 'CM', 'LW', 'ST'],
  '8v8': ['GK', 'LB', 'CB', 'RB', 'CM', 'AM', 'LW', 'ST'],
  '11v11': ['GK', 'LB', 'CB', 'RB', 'LWB', 'RWB', 'DM', 'CM', 'AM', 'LW', 'ST'],
};

type Slot = { pos: string; userId?: string | null };

function getUserIdFromReq(req: any): string | undefined {
  return req?.user?.id || req?.user?.sub || req?.user?.userId || undefined;
}
function makeDefaultSlots(format?: string): Slot[] {
  const fmt = (format || '7v7').toLowerCase();
  const base = DEFAULT_SLOTS[fmt] ?? DEFAULT_SLOTS['7v7'];
  return base.map((pos) => ({ pos, userId: null }));
}
function normalizeSlots(raw: any, format?: string): Slot[] {
  if (Array.isArray(raw)) {
    return raw
      .map((x) => {
        if (!x) return null;
        const pos = String((x as any).pos ?? '').toUpperCase();
        const userId = (x as any).userId ?? null;
        return pos ? ({ pos, userId } as Slot) : null;
      })
      .filter(Boolean) as Slot[];
  }
  return makeDefaultSlots(format);
}
function pickPreferredOpenPos(slots: Slot[], prefs?: string[] | null) {
  const open = (slots || []).filter((s) => !s.userId).map((s) => s.pos);
  if (!open.length) return null;
  for (const p of prefs || []) if (open.includes(p)) return p;
  return open[0];
}

@Controller('matches')
export class MatchesController {
  constructor(private prisma: PrismaService) {}

  /* Liste */
  @Get()
  async list(@Query() q: any) {
    const items = await this.prisma.match.findMany({
      orderBy: [{ time: 'asc' as const }, { createdAt: 'desc' as const }],
      select: {
        id: true, title: true, location: true, level: true, format: true,
        price: true, time: true, createdAt: true, slots: true, ownerId: true,
      },
    });
    return items.map((m: any) => ({ ...m, slots: normalizeSlots(m.slots, m.format) }));
  }

  /* Detay */
  @Get(':id')
  async detail(@Param('id') id: string) {
    const m: any = await this.prisma.match.findUnique({
      where: { id },
      select: {
        id: true, title: true, location: true, level: true, format: true,
        price: true, time: true, createdAt: true, updatedAt: true,
        ownerId: true, slots: true,
      },
    });
    if (!m) throw new NotFoundException('match not found');
    return { ...m, slots: normalizeSlots(m.slots, m.format) };
  }

  /* Oluştur */
  @Post()
  @UseGuards(AuthGuard('jwt'))
  async create(@Req() req: any, @Body() body: any) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new HttpException('unauthorized', HttpStatus.UNAUTHORIZED);

    const data = {
      title: body?.title ?? null,
      location: body?.location ?? null,
      level: body?.level ?? null,
      format: (body?.format ?? '7v7') as string,
      price: typeof body?.price === 'number' ? body.price : null,
      time: body?.time ?? null,
      slots:
        Array.isArray(body?.slots) && body.slots.length
          ? (normalizeSlots(body.slots, body?.format) as unknown as Prisma.JsonArray)
          : (makeDefaultSlots(body?.format) as unknown as Prisma.JsonArray),
      ownerId: userId,
    };

    const created: any = await this.prisma.match.create({ data });
    return { ...created, slots: normalizeSlots(created.slots, created.format) };
  }

  /* Katıl (quick veya buton tıklama)  */
  // body: { matchId: string; pos?: string; strict?: boolean }
  @Post('join')
  @UseGuards(AuthGuard('jwt'))
  async join(@Req() req: any, @Body() body: { matchId: string; pos?: string; strict?: boolean }) {
    const user = req.user;
    if (!user?.id) throw new UnauthorizedException();

    const match = await this.prisma.match.findUnique({ where: { id: body.matchId } });
    if (!match) throw new NotFoundException('match not found');

    const slots: Slot[] = normalizeSlots((match as any).slots, (match as any).format);

    // zaten slottaysan aynısını döndür
    const mine = slots.find((s) => s.userId === user.id);
    if (mine) return { ok: true, pos: mine.pos };

    let desired = body.pos?.trim().toUpperCase();

    if (!desired) {
      const me = await this.prisma.user.findUnique({ where: { id: user.id }, select: { positions: true } });
      const prefs: string[] = Array.isArray(me?.positions) ? me!.positions.map(String) : [];
      const open = slots.filter((s) => !s.userId).map((s) => s.pos);

      if (prefs.length) desired = prefs.find((p) => open.includes(p));
      if (!desired && body.strict) throw new ConflictException('no preferred open slot');
      if (!desired) desired = open[0];
    }
    if (!desired) throw new ConflictException('no empty slot');

    // transaction
    await this.prisma.$transaction(async (tx) => {
      const fresh = await tx.match.findUnique({ where: { id: match.id } });
      const arr: Slot[] = normalizeSlots((fresh as any)?.slots, (fresh as any)?.format);

      const i = arr.findIndex((s) => s.pos === desired);
      if (i === -1) throw new BadRequestException('invalid pos (fresh)');
      if (arr[i].userId && arr[i].userId !== user.id) throw new ConflictException('slot already taken');

      // kullanıcının varsa önceki slotlarını temizle
      for (const s of arr) if (s.userId === user.id) s.userId = null;

      arr[i] = { ...arr[i], userId: user.id };

      await tx.match.update({
        where: { id: match.id },
        data: { slots: arr as unknown as Prisma.JsonArray }, // <-- tipli cast
        select: { id: true },
      });
    });

    return { ok: true, pos: desired };
  }

  /* Ayrıl */
  @Post('leave')
  @UseGuards(AuthGuard('jwt'))
  async leave(@Req() req: any, @Body() body: any) {
    const userId = getUserIdFromReq(req);
    if (!userId) throw new HttpException('unauthorized', HttpStatus.UNAUTHORIZED);

    const matchId: string = body?.matchId;
    if (!matchId) throw new BadRequestException('matchId required');

    const m: any = await this.prisma.match.findUnique({ where: { id: matchId }, select: { id: true, format: true, slots: true } });
    if (!m) throw new NotFoundException('not_found');

    const slots = normalizeSlots(m.slots, m.format);
    for (const s of slots) if (s.userId === userId) s.userId = null;

    await this.prisma.match.update({
      where: { id: matchId },
      data: { slots: slots as unknown as Prisma.JsonArray }, // <-- tipli cast
    });

    return { ok: true };
  }

  /* Eski maçları sil */
  @Post('delete-old')
  @UseGuards(AuthGuard('jwt'))
  async deleteOld() {
    const now = new Date();
    const nowISO = now.toISOString();

    const res = await this.prisma.match.deleteMany({
      where: {
        OR: [
          { AND: [{ time: { not: null } }, { time: { lt: nowISO } }] }, // time string ise ISO
          { AND: [{ time: null as any }, { createdAt: { lt: new Date(now.getTime() - 1000 * 60 * 60 * 24 * 3) } }] },
        ],
      },
    });
    return { ok: true, deleted: res.count };
  }

  /* Eski maçlara default slot bas */
  @Post('backfill-slots')
  @UseGuards(AuthGuard('jwt'))
  async backfill() {
    const all = await this.prisma.match.findMany({ select: { id: true, format: true, slots: true } });
    let updated = 0;
    for (const m of all as any[]) {
      const normalized = normalizeSlots(m.slots, m.format);
      if (!Array.isArray(m.slots) || m.slots?.length === 0) {
        await this.prisma.match.update({
          where: { id: m.id },
          data: { slots: normalized as unknown as Prisma.JsonArray }, // <-- tipli cast
        });
        updated++;
      }
    }
    return { ok: true, updated };
  }
}
