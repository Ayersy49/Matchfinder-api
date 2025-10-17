import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';

/* ---------------- Types / Helpers ---------------- */

type MetricsIn = {
  punctual?: number;      // 1..5
  respect?: number;
  sportsman?: number;     // FE alternatif anahtar
  sportsmanship?: number; // FE alternatif anahtar
  profanity?: number;     // FE alternatif anahtar
  swearing?: number;      // FE alternatif anahtar
  aggression?: number;
};

// Bulk body: tek satır
type RateItem = {
  rateeId: string;
  traits?: MetricsIn;
  pos?: string;         // ör: 'ST','CB' ...
  posScore?: number;    // 1..10
};

const HALF_LIFE_DAYS = 180;
const TOGETHER_HALFLIFE = 5;

const mapPos = (p?: string | null) => (p === 'STP' ? 'CB' : (p || ''));

@Controller('ratings')
export class RatingsController {
  constructor(private prisma: PrismaService) {}

  private norm(x: number) {
    return Math.max(0, Math.min(1, (x - 1) / 4));
  }
  private weights = {
    punctuality: 0.15,
    respect: 0.25,
    sportsmanship: 0.25,
    swearing: 0.2,
    aggression: 0.15,
  };

  private colorForTotal(s: number) {
    if (s >= 90) return 'blue';
    if (s >= 60) return 'green';
    if (s >= 40) return 'yellow';
    return 'red';
  }

  private toTraitsJSON(input?: MetricsIn) {
    const src = input || {};
    // FE farklı anahtarlarla gönderebilir; normalize et
    const get = (v: unknown) => (typeof v === 'number' ? v : undefined);

    const punctuality = get(src.punctual);
    const respect = get(src.respect);
    const sportsmanship = get(src.sportsmanship ?? src.sportsman);
    const swearing = get(src.swearing ?? src.profanity);
    const aggression = get(src.aggression);

    const all = { punctuality, respect, sportsmanship, swearing, aggression };
    for (const [k, v] of Object.entries(all)) {
      if (typeof v !== 'number' || v < 1 || v > 5) {
        throw new BadRequestException(`range_${k}`);
      }
    }
    return all as Required<typeof all>;
  }

  private async isFriend(a: string, b: string) {
    const f = await this.prisma.friendship.findFirst({
      where: { OR: [{ userId: a, friendId: b }, { userId: b, friendId: a }] },
      select: { id: true },
    });
    return !!f;
  }

  private async togetherCount(a: string, b: string) {
    const since = new Date(Date.now() - 180 * 24 * 3600 * 1000);
    const matches = await this.prisma.match.findMany({
      where: { time: { gte: since } as any },
      select: { slots: true },
    });
    let n = 0;
    for (const m of matches) {
      const slots = Array.isArray(m.slots) ? (m.slots as any[]) : [];
      const hasA = slots.some((s: any) => s?.userId === a);
      const hasB = slots.some((s: any) => s?.userId === b);
      if (hasA && hasB) n++;
    }
    return n;
  }

  private weightRel(isFriend: boolean, together: number) {
    const base = isFriend ? 0.1 : 0.5;
    const lam = Math.log(2) / TOGETHER_HALFLIFE;
    return Math.max(0.05, base * Math.exp(-lam * together));
  }

  private weightTime(matchTime?: Date | null) {
    if (!matchTime) return 0.5;
    const ageDays = (Date.now() - matchTime.getTime()) / (24 * 3600 * 1000);
    const lam = Math.log(2) / HALF_LIFE_DAYS;
    return Math.max(0.3, Math.exp(-lam * ageDays));
  }

  private score100(avg: {
    punctuality: number;
    respect: number;
    sportsmanship: number;
    swearing: number;
    aggression: number;
  }) {
    const w = this.weights;
    const s =
      100 *
      (w.punctuality * this.norm(avg.punctuality) +
        w.respect * this.norm(avg.respect) +
        w.sportsmanship * this.norm(avg.sportsmanship) +
        w.swearing * this.norm(avg.swearing) +
        w.aggression * this.norm(avg.aggression));
    return Math.round(s);
  }

  private computeWeightedAvg(rows: Array<{ traits: any; weight: number | null }>) {
    let wsum = 0,
      P = 0,
      R = 0,
      S = 0,
      W = 0,
      A = 0;
    for (const r of rows) {
      const w = r.weight ?? 1;
      const t = (r.traits || {}) as any;
      const p = Number(t.punctuality) || 0;
      const rs = Number(t.respect) || 0;
      const sp = Number(t.sportsmanship) || 0;
      const sw = Number(t.swearing) || 0;
      const ag = Number(t.aggression) || 0;
      wsum += w;
      P += w * p;
      R += w * rs;
      S += w * sp;
      W += w * sw;
      A += w * ag;
    }
    const avg = {
      punctuality: wsum ? P / wsum : 0,
      respect: wsum ? R / wsum : 0,
      sportsmanship: wsum ? S / wsum : 0,
      swearing: wsum ? W / wsum : 0,
      aggression: wsum ? A / wsum : 0,
    };
    return { avg, wsum };
  }

  private slotsOf(m: any): Array<{ userId: string; pos?: string | null }> {
    const slots = Array.isArray(m?.slots) ? (m.slots as any[]) : [];
    return slots
      .map((s) => ({ userId: String(s?.userId || ''), pos: s?.pos ?? null }))
      .filter((s) => !!s.userId);
  }

  /* ---------------- PENDING (modal listesi) ---------------- */
  @UseGuards(JwtAuthGuard)
  @Get('pending')
  async pending(@Req() req: any) {
    const me = req?.user?.sub || req?.user?.id;
    if (!me) throw new UnauthorizedException();

    const now = new Date();
    const since = new Date(now.getTime() - 24 * 3600 * 1000);

    // Son 24 saatte oynadığım maçlar
    const matches = await this.prisma.match.findMany({
      where: {
        time: { gte: since, lte: now } as any,
      },
      select: { id: true, title: true, time: true, slots: true },
      orderBy: { time: 'desc' },
      take: 20,
    });

    const items: any[] = [];
    for (const m of matches) {
      const slots = this.slotsOf(m);
      const played = slots.some((s) => s.userId === me);
      if (!played) continue;

      const otherIds = slots.filter((s) => s.userId && s.userId !== me);
      if (!otherIds.length) continue;

      const uniqIds = Array.from(new Set(otherIds.map((s) => s.userId)));
      const users = await this.prisma.user.findMany({
        where: { id: { in: uniqIds } },
        select: { id: true, phone: true },
      });
      const phoneMap = new Map(users.map((u) => [u.id, u.phone]));

      const players = otherIds.map((s) => ({
        id: s.userId,
        phone: phoneMap.get(s.userId) ?? null,
        pos: s.pos ?? null,
      }));

      items.push({
        matchId: m.id,
        title: m.title,
        time: m.time,
        players,
      });
    }

    return { items };
  }

  /* ---------------- BULK (davranış + mevki performansı) ---------------- */
  @UseGuards(JwtAuthGuard)
  @Post(':matchId/bulk')
  async bulk(
    @Req() req: any,
    @Param('matchId') matchId: string,
    @Body() body: { items: RateItem[] }
  ) {
    const raterId = req?.user?.sub || req?.user?.id;
    if (!raterId) throw new UnauthorizedException();
    if (!Array.isArray(body?.items) || body.items.length === 0)
      throw new BadRequestException('no_items');

    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { time: true, slots: true },
    });
    if (!match) throw new NotFoundException('match');

    const slots = this.slotsOf(match);
    const played = slots.some((s) => s.userId === raterId);
    if (!played) throw new UnauthorizedException('not_participant');

    const tooLate =
      match.time && Date.now() - new Date(match.time).getTime() > 24 * 3600 * 1000;
    if (tooLate) throw new BadRequestException('window_closed');

    for (const it of body.items) {
      const ratedId = String(it?.rateeId || '');
      if (!ratedId || ratedId === raterId) continue;

      const friend = await this.isFriend(raterId, ratedId);
      const together = await this.togetherCount(raterId, ratedId);
      const weight = this.weightRel(friend, together) * this.weightTime(match.time ?? null);

      // Davranış (1..5) — opsiyonel: varsa yazarız
      if (it.traits) {
        const traits = this.toTraitsJSON(it.traits);
        const existing = await this.prisma.rating.findUnique({
          where: { matchId_raterId_ratedId: { matchId, raterId, ratedId } },
          select: { id: true },
        });
        if (existing) {
          await this.prisma.rating.update({
            where: { id: existing.id },
            data: { traits, weight, editCount: { increment: 1 } },
          });
        } else {
          await this.prisma.rating.create({
            data: { matchId, raterId, ratedId, traits, weight, editCount: 1 },
          });
        }
      }

      // Mevki performansı (1..10) — opsiyonel: varsa yazarız
      const posScore = Number(it?.posScore);
      if (Number.isFinite(posScore) && posScore >= 1 && posScore <= 10) {
        // pos gelmemişse slotlardan bul
        let pos =
          it?.pos ||
          slots.find((s) => s.userId === ratedId)?.pos ||
          undefined;
        pos = mapPos(pos);
        if (pos) {
          await this.prisma.positionRating.upsert({
            where: {
              matchId_raterId_rateeId_pos: { matchId, raterId, rateeId: ratedId, pos },
            },
            update: { score: posScore, weight, updatedAt: new Date() },
            create: { matchId, raterId, rateeId: ratedId, pos, score: posScore, weight },
          });
        }
      }
    }

    return { ok: true };
  }

  /* ---------------- Tekil SUBMIT (sadece davranış) ---------------- */
  @UseGuards(JwtAuthGuard)
  @Post(':matchId/submit')
  async submit(
    @Req() req: any,
    @Param('matchId') matchId: string,
    @Body() body: { rateeId: string; metrics: MetricsIn }
  ) {
    const raterId = req?.user?.sub || req?.user?.id;
    if (!raterId) throw new UnauthorizedException();

    const ratedId = String(body?.rateeId || '');
    const traits = this.toTraitsJSON(body?.metrics || {});
    if (!ratedId) throw new BadRequestException('invalid');
    if (ratedId === raterId) throw new BadRequestException('self_rate');

    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { time: true, slots: true },
    });
    if (!match) throw new NotFoundException('match');

    const slots = this.slotsOf(match);
    const playedRater = slots.some((s) => s.userId === raterId);
    const playedRated = slots.some((s) => s.userId === ratedId);
    if (!playedRater || !playedRated) throw new UnauthorizedException('not_participant');

    const tooLate =
      match.time && Date.now() - new Date(match.time).getTime() > 24 * 3600 * 1000;
    if (tooLate) throw new BadRequestException('window_closed');

    const friend = await this.isFriend(raterId, ratedId);
    const together = await this.togetherCount(raterId, ratedId);
    const weight =
      this.weightRel(friend, together) * this.weightTime(match.time ?? null);

    const existing = await this.prisma.rating.findUnique({
      where: { matchId_raterId_ratedId: { matchId, raterId, ratedId } },
      select: { id: true },
    });

    if (existing) {
      await this.prisma.rating.update({
        where: { id: existing.id },
        data: { traits, weight, editCount: { increment: 1 } },
      });
    } else {
      await this.prisma.rating.create({
        data: { matchId, raterId, ratedId, traits, weight, editCount: 1 },
      });
    }

    // Dönen özet
    const rows = await this.prisma.rating.findMany({
      where: { ratedId },
      select: { traits: true, weight: true },
    });
    const { avg } = this.computeWeightedAvg(rows);
    const total = this.score100(avg);
    const color = this.colorForTotal(total);

    return { ok: true, total, color, avg };
  }

  /* ---------------- SUMMARY ---------------- */
  @Get('/user/:id/summary')
  async summary(@Param('id') ratedId: string) {
    const rows = await this.prisma.rating.findMany({
      where: { ratedId },
      select: { traits: true, weight: true },
    });
    if (!rows.length) return { count: 0, total: null, color: null, avg: null };

    const { avg } = this.computeWeightedAvg(rows);
    const total = this.score100(avg);
    const color = this.colorForTotal(total);
    return { count: rows.length, total, color, avg };
  }
}
