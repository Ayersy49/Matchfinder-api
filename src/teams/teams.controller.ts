// src/teams/teams.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

/* -------------------- DTO'lar -------------------- */
type Formation = '4-3-3' | '3-5-2' | '4-2-3-1';

type CreateTeamDto = {
  name: string;
  bio?: string;
  city?: string;
  district?: string;
  visibility?: 'PUBLIC' | 'PRIVATE';
  formationCode?: Formation;
  size?: number; // 5..11 (DB kolonu olmasa da UI için)
};
type SlotAssignDto = { slotKey: string; userId?: string | null; locked?: boolean };

type CreateOpponentDto = {
  teamId: string;
  date: string; // ISO
  durationMin: number;
  locationText: string;
  format: string; // "6v6" | "7v7" | "11v11" ...
  levelMin?: number;
  levelMax?: number;
  notes?: string;
};
type TeamChatDto = { text: string };

/* -------------------- Helpers -------------------- */
function userIdFromReq(req: any): string {
  const id = req?.user?.id || req?.user?.sub || req?.user?.userId;
  if (!id) throw new ForbiddenException();
  return String(id);
}
async function mustBeMember(prisma: PrismaService, teamId: string, userId: string) {
  const m = await prisma.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
  });
  if (!m || m.status !== 'ACTIVE') throw new ForbiddenException('Yetkin yok');
  return m;
}
function sizeFromFormat(fmt?: string): number | undefined {
  const m = String(fmt || '').match(/^\s*(\d+)\s*v\s*\d+\s*$/i);
  const n = m ? parseInt(m[1], 10) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

// OWNER ya da ADMIN (kaptan/yardımcı kaptan) mı?
async function isCaptainOrOwner(
  prisma: PrismaService,
  teamId: string,
  userId: string,
): Promise<boolean> {
  const m = await (prisma as any).teamMember.findFirst({
    where: { teamId, userId, status: 'ACTIVE' },
    select: { role: true },
  });
  console.log(`[isCaptainOrOwner] teamId=${teamId}, userId=${userId}, role=${m?.role || 'NOT_FOUND'}`);
  return !!m && (m.role === 'OWNER' || m.role === 'ADMIN');
}

async function assertCaptainOrOwner(
  prisma: PrismaService,
  teamId: string,
  userId: string,
) {
  if (!(await isCaptainOrOwner(prisma, teamId, userId))) {
    throw new ForbiddenException('Bu işlem için Kaptan veya Yardımcı Kaptan olmalısın.');
  }
}

// sadece ihtiyacımız olan scalar alanlar (Team.size yok!)
const TEAM_BASE_SELECT = {
  id: true,
  name: true,
  ownerId: true,
  bio: true,
  city: true,
  district: true,
  logoUrl: true,
  visibility: true,
  discoverable: true,
  formationCode: true,
  avgLevel: true,
  avgSportsmanship: true,
  elo: true,
  createdAt: true,
  updatedAt: true,
} as const;

/* -------------------- Slot preset/koordinat -------------------- */
function slotKeysFor(size: number, formation: Formation): string[] {
  const s = Math.max(5, Math.min(11, Number(size || 11)));
  const base: Record<Formation, string[]> = {
    '4-3-3': ['GK', 'LB', 'CB1', 'CB2', 'RB', 'DM', 'CM', 'AM', 'LW', 'RW', 'ST'],
    '3-5-2': ['GK', 'CB1', 'CB2', 'CB3', 'LWB', 'RWB', 'DM', 'CM', 'AM', 'ST1', 'ST2'],
    '4-2-3-1': ['GK', 'LB', 'CB1', 'CB2', 'RB', 'DM1', 'DM2', 'LW', 'AM', 'RW', 'ST'],
  };
  const small: Record<number, string[]> = {
    5: ['GK', 'CB1', 'CB2', 'ST1', 'ST2'],
    6: ['GK', 'CB1', 'CB2', 'CM1', 'CM2', 'ST'],
    7: ['GK', 'CB1', 'CB2', 'CM1', 'CM2', 'ST1', 'ST2'],
    8: ['GK', 'CB1', 'CB2', 'CB3', 'DM', 'AM', 'ST1', 'ST2'],
    9: ['GK', 'CB1', 'CB2', 'CB3', 'DM', 'CM', 'AM', 'ST1', 'ST2'],
    10: ['GK', 'LB', 'CB1', 'CB2', 'RB', 'DM', 'AM', 'LW', 'RW', 'ST'],
  };
  const field = s <= 10 ? (small[s] ?? small[10]) : base[formation];
  return [...field, 'SB1', 'SB2', 'SB3']; // 3 yedek
}

// bench'leri ortalama hesaptan hariç tutacağız
function isBench(slotKey?: string) {
  return /^SB\d+$/i.test(String(slotKey || ''));
}

async function recalcTeamAvgLevel(prisma: PrismaService, teamId: string) {
  // aktif formasyon + slotlar
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: { formationCode: true },
  });
  if (!team) return;

  const slots = await prisma.teamPositionSlot.findMany({
    where: { teamId, formationCode: team.formationCode },
    select: { slotKey: true, userId: true },
  });

  type SlotRow = { slotKey: string; userId: string | null };

  const onFieldUserIds = (slots as SlotRow[])
    .filter((s: SlotRow) => s.userId && !isBench(s.slotKey))
    .map((s: SlotRow) => s.userId!) as string[];

  if (!onFieldUserIds.length) {
    await prisma.team.update({ where: { id: teamId }, data: { avgLevel: null } });
    return;
  }

  const users = await prisma.user.findMany({
    where: { id: { in: onFieldUserIds } },
    select: { id: true, level: true, positionLevels: true },
  });

  const mapToBase = (k?: string | null) => toBasePos(k);
  const levelOf = (
    u: { id: string; level: number | null; positionLevels: any },
    slotKey: string
  ) => {
    const key = mapToBase(slotKey);
    const posLevels = (u.positionLevels as any) || {};
    const val = typeof posLevels[key] === 'number' ? posLevels[key] : (u.level ?? 6);
    return Math.max(1, Math.min(10, Number(val)));
  };

  const levels: number[] = [];
  for (const s of slots as SlotRow[]) {
    if (!s.userId || isBench(s.slotKey)) continue;
    const u = users.find((x: { id: string }) => x.id === s.userId);
    if (!u) continue;
    levels.push(levelOf(u as any, s.slotKey));
  }

  if (!levels.length) {
    await prisma.team.update({ where: { id: teamId }, data: { avgLevel: null } });
    return;
  }

  const avg = Math.round((levels.reduce((a: number, b: number) => a + b, 0) / levels.length) * 10) / 10;
  await prisma.team.update({ where: { id: teamId }, data: { avgLevel: avg } });
}


function toBasePos(p?: string | null) {
  const t = String(p || '').toUpperCase();
  if (t.startsWith('CB')) return 'CB';
  if (t.startsWith('CM')) return 'CM';
  if (t.startsWith('DM')) return 'DM';
  if (t.startsWith('ST')) return 'ST';
  return ['GK', 'LB', 'RB', 'LWB', 'RWB', 'AM', 'LW', 'RW'].includes(t) ? t : 'CM';
}

function fillTeamSlots(
  preset: string[],
  members: Array<{ userId: string; preferredPosition?: string | null }>,
  team: 'A' | 'B',
) {
  const pool = [...members];
  const take = (pos: string) => {
    const idx = pool.findIndex((m) => toBasePos(m.preferredPosition) === toBasePos(pos));
    if (idx >= 0) return pool.splice(idx, 1)[0];
    return pool.shift() || null;
  };
  const slots: any[] = [];
  for (const pos of preset) {
    const m = take(pos);
    if (m) slots.push({ team, pos, userId: m.userId });
    else slots.push({ team, pos, placeholder: 'ADMIN' });
  }
  return slots;
}

const XY: Record<string, [number, number]> = {
  GK: [3, 50],
  // DEFANS
  LB: [34, 10],  // ⬅️ önce 70'ti; sol bek üst çizgiye
  CB1: [26, 30],
  CB2: [26, 70],
  CB3: [26, 50],
  RB: [34, 90],  // ⬅️ önce 80'di; sağ bek alt çizgiye
  // ORTA SAHA
  DM: [45, 50],
  DM1: [45, 40],
  DM2: [45, 60],
  CM: [54, 50],
  CM1: [54, 35],
  CM2: [54, 65],
  AM: [66, 50],
  // HÜCUM
  LW: [75, 25],
  RW: [75, 75],
  ST: [90, 50],
  ST1: [90, 40],
  ST2: [90, 60],
  // BENCH – alt taç çizgisi dışına
  SB1: [50, 95],
  SB2: [60, 95],
  SB3: [70, 95],
};


@UseGuards(AuthGuard('jwt'))
@Controller()
export class TeamsController {
  constructor(private prisma: PrismaService) {}

  /* ------- TEAMS ------- */

  @Get('teams')
  async myTeams(@Req() req: any) {
    const uid = userIdFromReq(req);

    return this.prisma.team.findMany({
      where: {
        OR: [{ ownerId: uid }, { members: { some: { userId: uid, status: 'ACTIVE' } } }],
      },
      select: {
        ...TEAM_BASE_SELECT,
        members: {
          where: { status: 'ACTIVE' },
          select: { userId: true, role: true, number: true, preferredPosition: true },
        },
        positionSlots: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Post('teams')
  async create(@Req() req: any, @Body() dto: CreateTeamDto) {
    const uid = userIdFromReq(req);
    const name = String(dto?.name || '').trim();
    if (!name) throw new BadRequestException('name');

    const formation: Formation = (dto?.formationCode as Formation) || '4-3-3';
    const sizeNum = Math.max(5, Math.min(11, Number(dto?.size ?? 11)));

    const team = await this.prisma.team.create({
      data: {
        name,
        ownerId: uid,
        bio: dto.bio || null,
        city: dto.city || null,
        district: dto.district || null,
        visibility: (dto.visibility as any) || 'PUBLIC',
        formationCode: formation,
        members: { create: [{ userId: uid, role: 'OWNER', status: 'ACTIVE' }] },
      },
    });

    const chosenSlots = slotKeysFor(sizeNum, formation);
    await this.prisma.teamPositionSlot.createMany({
      data: chosenSlots.map((slotKey: string) => ({
        teamId: team.id,
        formationCode: formation,
        slotKey,
        x: XY[slotKey]?.[0] ?? 50,
        y: XY[slotKey]?.[1] ?? 50,
      })),
    });

    await recalcTeamAvgLevel(this.prisma, team.id);
    return team;
  }

  @Get('teams/:id')
  async detail(@Req() req: any, @Param('id') id: string) {
    userIdFromReq(req);
    const team = await this.prisma.team.findUnique({
      where: { id },
      select: {
        ...TEAM_BASE_SELECT,
        members: { include: { user: true } },
        positionSlots: true,
      },
    });
    if (!team) throw new BadRequestException('not found');
    return team;
  }

  /** TAKIM DÜZENLE (owner/admin) – aktif formasyon slotlarını senkronize eder */
  @Patch('teams/:id')
  async updateTeam(
    @Param('id') id: string,
    @Body()
    body: Partial<{
      name: string;
      bio: string;
      city: string;
      district: string;
      visibility: 'PUBLIC' | 'PRIVATE';
      formationCode: Formation;
      size: 5 | 6 | 7 | 8 | 9 | 10 | 11;
    }>,
    @Req() req: any,
  ) {
    const meId = req.user?.id ?? req.user?.sub;

    const team = await this.prisma.team.findUnique({
      where: { id },
      include: { positionSlots: true },
    });
    if (!team) throw new NotFoundException('Takım bulunamadı');

    const member = await mustBeMember(this.prisma, id, meId);
    if (!['OWNER', 'ADMIN'].includes(member.role)) {
      throw new ForbiddenException('Yalnızca owner/admin');
    }

    const nextFormation = (body.formationCode as any) ?? team.formationCode;

    const currentSizeInActiveFormation =
      team.positionSlots.filter((s: any) => s.formationCode === nextFormation && !isBench(s.slotKey)).length || 11;


    const nextSize = (typeof body.size === 'number'
      ? body.size
      : currentSizeInActiveFormation) as 5 | 6 | 7 | 8 | 9 | 10 | 11;

    const data: any = {};
    for (const k of ['name', 'bio', 'city', 'district', 'visibility', 'formationCode'] as const) {
      if (k in (body ?? {})) (data as any)[k] = (body as any)[k];
    }

    let benched: Array<{ userId: string; phone?: string; oldSlot: string }> = [];

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.team.update({ where: { id }, data });

      const wanted = slotKeysFor(nextSize, nextFormation);

      const current = await tx.teamPositionSlot.findMany({
        where: { teamId: id, formationCode: nextFormation },
        select: { id: true, slotKey: true, userId: true },
      });

      const have = new Set(current.map((c: any) => c.slotKey));

      // Fazla slotlar (küçültme)
      const extras = current.filter((c: any) => !wanted.includes(c.slotKey));
      if (extras.length) {
        const extrasWithUser = extras.filter((e: any) => e.userId);
        if (extrasWithUser.length) {
          const users = await tx.user.findMany({
            where: { id: { in: extrasWithUser.map((e: any) => e.userId!) } },
            select: { id: true, phone: true },
          });
          const phoneById = new Map<string, string | undefined>(
            users.map((u: { id: string; phone: string | null }) => [u.id, u.phone || undefined])
          );

          benched = extrasWithUser.map((e: any) => ({
            userId: e.userId!,
            phone: phoneById.get(e.userId!),
            oldSlot: e.slotKey,
          }));
        }
        await tx.teamPositionSlot.deleteMany({
          where: { id: { in: extras.map((a: any) => a.id) } },
        });
      }

      // Eksik slotlar (büyütme)
      const toCreate = wanted.filter((k: string) => !have.has(k));
      if (toCreate.length) {
        await tx.teamPositionSlot.createMany({
          data: toCreate.map((k: string) => ({
            teamId: id,
            formationCode: nextFormation,
            slotKey: k,
            x: XY[k]?.[0] ?? 50,
            y: XY[k]?.[1] ?? 50,
          })),
        });
      }

      // Formasyon değiştiyse koordinat düzelt
      if (team.formationCode !== nextFormation) {
        await Promise.all(
          current
            .filter((c: any) => wanted.includes(c.slotKey) && XY[c.slotKey])
            .map((c: any) =>
              tx.teamPositionSlot.update({
                where: { id: c.id },
                data: { x: XY[c.slotKey][0], y: XY[c.slotKey][1] },
              }),
            ),
        );
      }
    });

    await recalcTeamAvgLevel(this.prisma, id);
    return { ok: true, bench: benched };
  }

  /** TAKIMI KAPAT (soft close) – owner */
  @Post('teams/:id/close')
  async closeTeam(@Param('id') id: string, @Req() req: any) {
    const meId = req.user?.id ?? req.user?.sub;
    const t = await this.prisma.team.findUnique({ where: { id }, select: { ownerId: true } });
    if (!t) throw new NotFoundException('Takım bulunamadı');
    if (t.ownerId !== meId) throw new ForbiddenException('Yalnızca owner kapatabilir');

    await this.prisma.team.update({
      where: { id },
      data: { visibility: 'PRIVATE', discoverable: false },
    });
    await this.prisma.teamMatchRequest.updateMany({
      where: { requestingTeamId: id, status: 'OPEN' },
      data: { status: 'CANCELLED' },
    });
    return { ok: true };
  }

  /** TEKRAR AÇ (owner) */
  @Post('teams/:id/open')
  async openTeam(@Param('id') id: string, @Req() req: any) {
    const meId = req.user?.id ?? req.user?.sub;
    const t = await this.prisma.team.findUnique({ where: { id }, select: { ownerId: true } });
    if (!t) throw new NotFoundException('Takım bulunamadı');
    if (t.ownerId !== meId) throw new ForbiddenException('Yalnızca owner açabilir');

    await this.prisma.team.update({
      where: { id },
      data: { visibility: 'PUBLIC', discoverable: true },
    });
    return { ok: true };
  }

  /** TAKIMDAN ÇIK */
  @Post('teams/:id/leave')
  async leaveTeam(@Param('id') id: string, @Req() req: any) {
    const meId = req.user?.id ?? req.user?.sub;
    const t = await this.prisma.team.findUnique({ where: { id }, select: { ownerId: true } });
    if (!t) throw new NotFoundException('Takım bulunamadı');

    await mustBeMember(this.prisma, id, meId);

    if (t.ownerId === meId) {
      const activeCount = await this.prisma.teamMember.count({
        where: { teamId: id, status: 'ACTIVE' },
      });
      if (activeCount > 1) {
        throw new BadRequestException('Önce sahipliği devret ya da diğer üyeleri çıkar');
      }
      await this.prisma.team.delete({ where: { id } });
      return { ok: true, deleted: true };
    }

    await this.prisma.teamMember.delete({
      where: { teamId_userId: { teamId: id, userId: meId } },
    });
    await this.prisma.teamPositionSlot.updateMany({
      where: { teamId: id, userId: meId },
      data: { userId: null },
    });
    await recalcTeamAvgLevel(this.prisma, id);
    return { ok: true };
  }

  /** TAKIMI SİL – owner */
  @Delete('teams/:id')
  async deleteTeamHard(@Param('id') id: string, @Req() req: any) {
    const meId = req.user?.id ?? req.user?.sub;
    const t = await this.prisma.team.findUnique({ where: { id }, select: { ownerId: true } });
    if (!t) throw new NotFoundException('Takım bulunamadı');
    if (t.ownerId !== meId) throw new ForbiddenException('Yalnızca owner silebilir');

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      try {
        const delegate = (tx as any).teamMatchOffer;
        if (delegate?.deleteMany) {
          await delegate.deleteMany({ where: { offerTeamId: id } });
          await delegate
            .deleteMany({
              where: { request: { OR: [{ requestingTeamId: id }, { opponentTeamId: id }] } },
            })
            .catch(() => {});
        }
      } catch (e: any) {
        if (e?.code !== 'P2021') throw e;
      }

      await tx.teamMatchRequest.deleteMany({
        where: { OR: [{ requestingTeamId: id }, { opponentTeamId: id }] },
      });

      await tx.match.updateMany({ where: { teamAId: id }, data: { teamAId: null } });
      await tx.match.updateMany({ where: { teamBId: id }, data: { teamBId: null } });

      await tx.teamEloHistory.deleteMany({ where: { teamId: id } });
      await tx.teamChatMessage.deleteMany({ where: { teamId: id } });
      await tx.teamInvite.deleteMany({ where: { teamId: id } });
      await tx.teamJoinRequest.deleteMany({ where: { teamId: id } });
      await tx.teamPositionSlot.deleteMany({ where: { teamId: id } });
      await tx.teamMember.deleteMany({ where: { teamId: id } });

      await tx.team.delete({ where: { id } });
    });

    return { ok: true };
  }

  @UseGuards(JwtAuthGuard)
  @Post('teams/:teamId/captains/:userId/add')
  async makeCaptain(@Req() req: any, @Param('teamId') teamId: string, @Param('userId') userId: string) {
    const meId = req.user?.id || req.user?.sub;

    const me = await (this.prisma as any).teamMember.findFirst({ where: { teamId, userId: meId, status: 'ACTIVE' }, select: { role: true }});
    if (!me || me.role !== 'OWNER') throw new ForbiddenException('only_owner');

    const exists = await (this.prisma as any).teamMember.findFirst({ where: { teamId, userId, status: 'ACTIVE' }});
    if (!exists) throw new NotFoundException('member_not_found');

    await (this.prisma as any).teamMember.update({
      where: { teamId_userId: { teamId, userId } },
      data: { role: 'ADMIN' },
    });
    return { ok: true };  
  }

  @UseGuards(JwtAuthGuard)
  @Post('teams/:teamId/captains/:userId/remove')
  async removeCaptain(@Req() req: any, @Param('teamId') teamId: string, @Param('userId') userId: string) {
    const meId = req.user?.id || req.user?.sub;

    const me = await (this.prisma as any).teamMember.findFirst({ where: { teamId, userId: meId, status: 'ACTIVE' }, select: { role: true }});
    if (!me || me.role !== 'OWNER') throw new ForbiddenException('only_owner');

    const target = await (this.prisma as any).teamMember.findFirst({ where: { teamId, userId, status: 'ACTIVE' }, select: { role: true }});
    if (!target) throw new NotFoundException('member_not_found');
    if (target.role === 'OWNER') throw new ForbiddenException('cannot_demote_owner');

    await (this.prisma as any).teamMember.update({
      where: { teamId_userId: { teamId, userId } },
      data: { role: 'PLAYER' },
    });
    return { ok: true };
  }

  @UseGuards(JwtAuthGuard)
  @Post('teams/:teamId/transfer-ownership/:userId')
  async transferOwnership(@Req() req: any, @Param('teamId') teamId: string, @Param('userId') newOwnerId: string) {
    const meId = req.user?.id || req.user?.sub;

    const me = await (this.prisma as any).teamMember.findFirst({ where: { teamId, userId: meId, status: 'ACTIVE' }, select: { role: true }});
    if (!me || me.role !== 'OWNER') throw new ForbiddenException('only_owner');

    const target = await (this.prisma as any).teamMember.findFirst({ where: { teamId, userId: newOwnerId, status: 'ACTIVE' }, select: { userId: true }});
    if (!target) throw new NotFoundException('member_not_found');

    await this.prisma.$transaction(async (tx: any) => {
      await tx.teamMember.update({ where: { teamId_userId: { teamId, userId: meId } }, data: { role: 'ADMIN' }});
      await tx.teamMember.update({ where: { teamId_userId: { teamId, userId: newOwnerId } }, data: { role: 'OWNER' }});
      await tx.team.update({ where: { id: teamId }, data: { ownerId: newOwnerId }});
    });
    return { ok: true };
  }

  /* ------- SLOTS ------- */
  @Get('teams/:id/slots')
  async slots(@Req() req: any, @Param('id') teamId: string) {
    userIdFromReq(req);
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { formationCode: true },
    });
    if (!team) throw new BadRequestException('not found');

    return this.prisma.teamPositionSlot.findMany({
      where: { teamId, formationCode: team.formationCode },
      orderBy: { slotKey: 'asc' },
    });
  }

  // src/teams/teams.controller.ts -> assign()
  @Post('teams/:id/slots/assign')
  async assign(@Req() req: any, @Param('id') teamId: string, @Body() body: SlotAssignDto) {
    const uid = userIdFromReq(req);
    const mem = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId: uid } },
    });
    if (!mem) throw new ForbiddenException();

    const s = await this.prisma.teamPositionSlot.findFirst({
      where: { teamId, slotKey: body.slotKey },
    });
    if (!s) throw new BadRequestException('no slot');

    // ❗ aynı anda iki slota girmeyi engelle
    if (body.userId) {
      const other = await this.prisma.teamPositionSlot.findFirst({
        where: {
          teamId,
          formationCode: s.formationCode,
          id: { not: s.id },
          userId: body.userId
        },
      });
      if (other) {
        throw new BadRequestException('already_in_slot'); // FE uyarı mesajı gösterir
      }
    }

    const updated = await this.prisma.teamPositionSlot.update({
      where: { id: s.id },
      data: {
        userId: body.userId === undefined ? s.userId : body.userId,
        locked: body.locked === undefined ? s.locked : !!body.locked,
      },
    });

    await recalcTeamAvgLevel(this.prisma, teamId);
    return updated;
  }

  /* ------- CHAT ------- */

  // Mesajları getir (FE: GET /teams/:id/chat?after=ISO)
  @Get('teams/:id/chat')
  async teamChat(
    @Req() req: any,
    @Param('id') teamId: string,
    @Query('after') after?: string,
  ) {
    const meId = userIdFromReq(req);
    await mustBeMember(this.prisma, teamId, meId);

    const where: any = { teamId };
    if (after) {
      const d = new Date(after);
      if (!isNaN(d.getTime())) where.createdAt = { gt: d };
    }

    const items = await this.prisma.teamChatMessage.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { id: true, username: true, phone: true } } },
      take: 200,
    });

    return items.map((m: any) => ({
      id: m.id,
      text: m.text,
      createdAt: m.createdAt,
      user: {
        id: m.user.id,
        username: m.user.username || null,
        phone: m.user.phone ? m.user.phone.slice(-3) : null,
      },
    }));
  }

  // Mesaj oluştur (FE: POST /teams/:id/chat { text })
  @Post('teams/:id/chat')
  async createTeamChat(
    @Req() req: any,
    @Param('id') teamId: string,
    @Body() body: TeamChatDto,
  ) {
    const meId = userIdFromReq(req);
    await mustBeMember(this.prisma, teamId, meId);

    const text = String(body?.text || '').trim();
    if (!text) throw new BadRequestException('text');

    const m = await this.prisma.teamChatMessage.create({
      data: { teamId, userId: meId, text },
      include: { user: { select: { id: true, username: true, phone: true } } },
    });

    return {
      id: m.id,
      text: m.text,
      createdAt: m.createdAt,
      user: {
        id: m.user.id,
        username: m.user.username || null,
        phone: m.user.phone ? m.user.phone.slice(-3) : null,
      },
    };
  }

  /* ------- RAKİP İLANLARI ------- */

  // ALIAS: FE /team-match-requests?status=OPEN&includeOffers=1 çağırıyor
  @Get('team-match-requests')
  async listOpenAlias(
    @Req() req: any,
    @Query('format') format?: string,
    @Query('includeOffers') includeOffers?: string,
    @Query('status') _status?: string,
  ) {
    const uid = userIdFromReq(req);

    const myTeams = await this.prisma.team.findMany({
      where: { OR: [{ ownerId: uid }, { members: { some: { userId: uid, status: 'ACTIVE' } } }] },
      select: { id: true },
    });
    const myTeamIds = myTeams.map((t: any) => t.id);

    return this.prisma.teamMatchRequest.findMany({
      where: {
        status: 'OPEN',
        requestingTeamId: { notIn: myTeamIds },
        ...(format ? { format } : {}),
      },
      include: {
        reqTeam: { select: { id: true, name: true } },
        oppTeam: { select: { id: true, name: true } },
        ...(includeOffers === '1' ? { offers: true } : {}),
      },
      orderBy: { date: 'asc' },
      take: 100,
    });
  }

  // Kendi ilanlarını liste dışı bırakarak açık ilanları döner.
  @Get('team-requests')
  async listOpen(
    @Req() req: any,
    @Query('format') format?: string,
    @Query('includeOffers') includeOffers?: string,
  ) {
    const uid = userIdFromReq(req);

    const myTeams = await this.prisma.team.findMany({
      where: { OR: [{ ownerId: uid }, { members: { some: { userId: uid, status: 'ACTIVE' } } }] },
      select: { id: true },
    });
    const myTeamIds = myTeams.map((t: any) => t.id);

    return this.prisma.teamMatchRequest.findMany({
      where: {
        status: 'OPEN',
        requestingTeamId: { notIn: myTeamIds },
        ...(format ? { format } : {}),
      },
      include: {
        reqTeam: { select: { id: true, name: true } },
        oppTeam: { select: { id: true, name: true } },
        ...(includeOffers === '1' ? { offers: true } : {}),
      },
      orderBy: { date: 'asc' },
      take: 100,
    });
  }

  // İlan oluştur
  @Post('team-requests')
  async createOpponent(@Req() req: any, @Body() dto: CreateOpponentDto) {
    const uid = userIdFromReq(req);
    const team = await this.prisma.team.findUnique({
      where: { id: dto.teamId },
      include: { members: true },
    });
    if (!team) throw new BadRequestException('team');
    const self = team.members.find((m: any) => m.userId === uid);
    if (!self || (self.role !== 'OWNER' && self.role !== 'ADMIN')) {
      throw new ForbiddenException();
    }

    return this.prisma.teamMatchRequest.create({
      data: {
        requestingTeamId: dto.teamId,
        date: new Date(dto.date),
        durationMin: Math.max(30, Number(dto.durationMin || 60)),
        locationText: String(dto.locationText || ''),
        format: String(dto.format || '7v7'),
        levelMin: dto.levelMin ?? null,
        levelMax: dto.levelMax ?? null,
        notes: dto.notes || null,
        createdBy: uid,
      },
    });
  }

  /* ------- TEKLİF (Offer) ------- */

  @Post('team-match-requests/:id/offers')
  async createOffer(
    @Req() req: any,
    @Param('id') requestId: string,
    @Body() body: { teamId: string },
  ) {
    const uid = req.user?.id ?? req.user?.sub;
    const { teamId } = body || {};
    if (!teamId) throw new BadRequestException('teamId');

    const request = await this.prisma.teamMatchRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        status: true,
        requestingTeamId: true,
        format: true,
        date: true,
        locationText: true,
      },
    });
    if (!request) throw new NotFoundException('request');
    if (request.status !== 'OPEN') throw new BadRequestException('İlan açık değil');

    if (request.requestingTeamId === teamId) {
      throw new BadRequestException('Kendi ilanına teklif gönderilemez');
    }

    const member = await this.prisma.teamMember.findFirst({
      where: { teamId, userId: uid, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
    });
    if (!member) throw new ForbiddenException('Bu takımla teklif gönderemezsin');

    const exists = await this.prisma.teamMatchOffer.findFirst({
      where: { requestId, offerTeamId: teamId },
    });
    if (exists) throw new BadRequestException('Bu takımla zaten teklif gönderdin');

    const reqSize = sizeFromFormat(request.format);
    const offerTeam = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { id: true, formationCode: true },
    });
    if (!offerTeam) throw new BadRequestException('Takım bulunamadı');

    const offerSize = await this.prisma.teamPositionSlot.count({
      where: {
        teamId,
        formationCode: offerTeam.formationCode,
        slotKey: { notIn: ['SB1', 'SB2', 'SB3'] },
      },
    });

    if (reqSize && offerSize && offerSize !== reqSize) {
      throw new BadRequestException(
        `Takım boyutları uyuşmuyor (ilan: ${reqSize}v${reqSize}, takım: ${offerSize}v${offerSize}).`,
      );
    }

    const offer = await this.prisma.teamMatchOffer.create({
      data: { requestId, offerTeamId: teamId, status: 'PENDING' },
    });

    return { ok: true, id: offer.id };
  }

  @Get('team-match-offers/inbox')
  async offersInbox(@Req() req: any) {
    const uid = req.user?.id ?? req.user?.sub;

    const myTeams = await this.prisma.teamMember.findMany({
      where: { userId: uid, status: 'ACTIVE', role: { in: ['OWNER', 'ADMIN'] } },
      select: { teamId: true },
    });
    const teamIds = myTeams.map((t: any) => t.teamId);
    if (!teamIds.length) return [];

    return this.prisma.teamMatchOffer.findMany({
      where: { status: 'PENDING', request: { requestingTeamId: { in: teamIds }, status: 'OPEN' } },
      include: {
        offerTeam: { select: { id: true, name: true, formationCode: true } },
        request: {
          select: {
            id: true,
            date: true,
            format: true,
            locationText: true,
            reqTeam: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  @Post('team-match-offers/:id/respond')
  async respondOffer(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { action: 'accept' | 'decline' },
  ) {
    const uid = req.user?.id ?? req.user?.sub;
    const action = body?.action;
    if (!['accept', 'decline'].includes(action as any)) {
      throw new BadRequestException('action');
    }

    const offer = await this.prisma.teamMatchOffer.findUnique({
      where: { id },
      select: {
        id: true,
        requestId: true,
        offerTeamId: true,
        status: true,
        request: {
          select: {
            id: true,
            requestingTeamId: true,
            format: true,
            date: true,
            locationText: true,
          },
        },
      },
    });
    if (!offer) throw new NotFoundException('offer');

    const ownerAdmin = await this.prisma.teamMember.findFirst({
      where: {
        teamId: offer.request.requestingTeamId,
        userId: uid,
        status: 'ACTIVE',
        role: { in: ['OWNER', 'ADMIN'] },
      },
    });
    if (!ownerAdmin) throw new ForbiddenException();

    if (action === 'decline') {
      await this.prisma.teamMatchOffer.update({ where: { id }, data: { status: 'DECLINED' } });
      return { ok: true, declined: true };
    }

    // ACCEPT → ilanı eşleştir + maç oluştur + diğer teklifleri kapat
    let createdMatchId: string | null = null;

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.teamMatchOffer.update({
        where: { id },
        data: { status: 'ACCEPTED' },
      });

      const updatedReq = await tx.teamMatchRequest.update({
        where: { id: offer.requestId },
        data: {
          opponentTeamId: offer.offerTeamId,
          status: 'MATCHED',
        },
        include: {
          reqTeam: { select: { id: true, name: true } },
        },
      });

      await tx.teamMatchOffer.updateMany({
        where: { requestId: offer.requestId, id: { not: id } },
        data: { status: 'DECLINED' },
      });

      const offerTeam = await tx.team.findUnique({
        where: { id: offer.offerTeamId },
        select: { id: true, name: true },
      });

      const n = sizeFromFormat(updatedReq.format) ?? 7;
      const preset = slotKeysFor(n, '4-3-3').slice(0, n);

      const [teamAMembers, teamBMembers] = await Promise.all([
        tx.teamMember.findMany({
          where: { teamId: updatedReq.requestingTeamId, status: 'ACTIVE' },
          select: { userId: true, preferredPosition: true, role: true },
          orderBy: [{ role: 'asc' }],
        }),
        tx.teamMember.findMany({
          where: { teamId: offer.offerTeamId, status: 'ACTIVE' },
          select: { userId: true, preferredPosition: true, role: true },
          orderBy: [{ role: 'asc' }],
        }),
      ]);

      const slotsA = fillTeamSlots(preset, teamAMembers as any, 'A');
      const slotsB = fillTeamSlots(preset, teamBMembers as any, 'B');

      const title = `${updatedReq.reqTeam?.name ?? 'A'} vs ${offerTeam?.name ?? 'B'}`;
      const highlightUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const createdMatch = await tx.match.create({
        data: {
          title,
          location: updatedReq.locationText || null,
          time: updatedReq.date,
          format: updatedReq.format || '7v7',
          price: null,
          inviteOnly: true,
          listed: true,
          teamAId: updatedReq.requestingTeamId,
          teamBId: offer.offerTeamId,
          createdFrom: 'TEAM_MATCH',
          highlightUntil,
          slots: [...(slotsA as any[]), ...(slotsB as any[])] as any,
        },
      });

      createdMatchId = createdMatch.id;
    });

    return { ok: true, accepted: true, matchId: createdMatchId };
  }

  /* ------- TAKIM DAVETLERİ ------- */

  // Takıma davet oluştur (owner/admin) – toUserIds ve/veya toPhones
  @Post('teams/:id/invites')
  async createTeamInvites(
    @Req() req: any,
    @Param('id') teamId: string,
    @Body() body: { toUserIds?: string[]; toPhones?: string[]; message?: string },
  ) {
    const meId = userIdFromReq(req);
    await assertCaptainOrOwner(this.prisma, teamId, meId);

    const toUserIds = Array.from(new Set(body?.toUserIds || [])).filter(Boolean);
    const toPhones = Array.from(new Set(body?.toPhones || [])).filter(Boolean);

    // Username veya ID olabilir - username'leri ID'ye çevir
    const resolvedUserIds: string[] = [];
    const notFoundUsernames: string[] = [];
    
    for (const input of toUserIds) {
      // CUID formatında mı kontrol et (cm ile başlar ve 25 karakter)
      const isCuid = /^c[a-z0-9]{24,}$/i.test(input);
      
      if (isCuid) {
        // Direkt ID olarak kullan
        const exists = await this.prisma.user.findUnique({ where: { id: input }, select: { id: true } });
        if (exists) {
          resolvedUserIds.push(input);
        } else {
          notFoundUsernames.push(input);
        }
      } else {
        // Username olarak ara
        const user = await this.prisma.user.findUnique({ where: { username: input }, select: { id: true } });
        if (user) {
          resolvedUserIds.push(user.id);
        } else {
          notFoundUsernames.push(input);
        }
      }
    }

    // aktif üyeler hariç
    const existing = await this.prisma.teamMember.findMany({
      where: { teamId, userId: { in: resolvedUserIds }, status: 'ACTIVE' },
      select: { userId: true },
    });
    const existingIds = new Set(
      existing.map((x: { userId: string }) => x.userId)
    );

    const finalUserIds = resolvedUserIds.filter((id) => !existingIds.has(id));

    // telefon -> kayıtlı kullanıcıya map
    let phoneTargets: Array<{ toUserId?: string; toPhone?: string }> = [];
    if (toPhones.length) {
      const users = await this.prisma.user.findMany({
        where: { phone: { in: toPhones } },
        select: { id: true, phone: true },
      });
      const byPhone = new Map<string, string>(
        users.map((u: { id: string; phone: string }) => [u.phone, u.id])
      );
    

      phoneTargets = toPhones.map((ph: string) => {
        const got = byPhone.get(ph);
        if (typeof got === 'string') {
          return { toUserId: got } as { toUserId: string };
        }
        return { toPhone: ph } as { toPhone: string };
      });
    }

    const payload: any[] = [
      ...finalUserIds.map((id) => ({
        teamId,
        invitedBy: meId,
        toUserId: id,
        status: 'PENDING',
        message: body?.message || null,
      })),
      ...phoneTargets.map((t) => ({
        teamId,
        invitedBy: meId,
        ...t,
        status: 'PENDING',
        message: body?.message || null,
      })),
    ];
    
    if (!payload.length) {
      if (notFoundUsernames.length) {
        throw new BadRequestException(`Kullanıcı bulunamadı: ${notFoundUsernames.join(', ')}`);
      }
      return { created: 0 };
    }

    await this.prisma.teamInvite.createMany({ data: payload });
    return { created: payload.length, notFound: notFoundUsernames };
  }

  // Kaptanlar davet listesini görsün
  @Get('teams/:id/invites')
  async listTeamInvites(
    @Req() req: any,
    @Param('id') teamId: string,
    @Query('status') status?: string,
  ) {
    const uid = userIdFromReq(req);
    await assertCaptainOrOwner(this.prisma, teamId, uid);

    return this.prisma.teamInvite.findMany({
      where: { teamId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      include: { toUser: { select: { id: true, phone: true } } },
    });
  }

  // Kullanıcının gelen davet kutusu
  @Get('team-invites/inbox')
  async myTeamInviteInbox(@Req() req: any) {
    const uid = userIdFromReq(req);
    const me = await this.prisma.user.findUnique({ where: { id: uid }, select: { phone: true } });

    return this.prisma.teamInvite.findMany({
      where: {
        status: 'PENDING',
        OR: [{ toUserId: uid }, ...(me?.phone ? [{ toPhone: me.phone }] : [])],
      },
      orderBy: { createdAt: 'desc' },
      include: { team: { select: { id: true, name: true } } },
      take: 200,
    });
  }

  // Davete cevap ver
  @Post('team-invites/:id/respond')
  async respondTeamInvite(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { action: 'accept' | 'decline' },
  ) {
    const uid = userIdFromReq(req);
    const action = body?.action;
    if (!['accept', 'decline'].includes(action as any)) throw new BadRequestException('action');

    const inv = await this.prisma.teamInvite.findUnique({ where: { id } });
    if (!inv || inv.status !== 'PENDING') throw new NotFoundException('invite');

    const me = await this.prisma.user.findUnique({ where: { id: uid }, select: { phone: true } });
    const iAmTarget =
      (inv.toUserId && inv.toUserId === uid) || (!!inv.toPhone && !!me?.phone && inv.toPhone === me.phone);
    if (!iAmTarget) throw new ForbiddenException();

    if (action === 'decline') {
      await this.prisma.teamInvite.update({
        where: { id },
        data: { status: 'REJECTED', respondedAt: new Date() },
      });
      return { ok: true, declined: true };
    }

    // ACCEPT ⇒ üyeliğe ekle (otomatik slot ataması yapılmaz, kullanıcı kendisi seçer)
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const exists = await tx.teamMember.findUnique({
        where: { teamId_userId: { teamId: inv.teamId, userId: uid } },
      });
      if (!exists) {
        await tx.teamMember.create({
          data: { teamId: inv.teamId, userId: uid, role: 'PLAYER', status: 'ACTIVE' },
        });
      }

      // NOT: Otomatik slot ataması kaldırıldı.
      // Yeni üye takım sayfasına girdiğinde boş mevkilerden birini kendisi seçecek.

      await tx.teamInvite.update({
        where: { id },
        data: { status: 'ACCEPTED', respondedAt: new Date(), toUserId: inv.toUserId ?? uid },
      });
    });

    await recalcTeamAvgLevel(this.prisma, inv.teamId);
    return { ok: true, accepted: true };
  }
}
