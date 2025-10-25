// src/teams/teams.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PrismaService } from '../prisma/prisma.service';

type CreateTeamDto = {
  name: string;
  bio?: string;
  city?: string;
  district?: string;
  visibility?: 'PUBLIC' | 'PRIVATE';
  formationCode?: '4-3-3' | '3-5-2' | '4-2-3-1';
};

type UpdateTeamDto = Partial<CreateTeamDto>;

type SlotAssignDto = { slotKey: string; userId?: string | null; locked?: boolean };

type CreateOpponentDto = {
  teamId: string;
  date: string;          // ISO
  durationMin: number;
  locationText: string;
  format: string;        // 6v6|7v7|11v11...
  levelMin?: number;
  levelMax?: number;
  notes?: string;
};

type TeamChatDto = { text: string };

function userIdFromReq(req: any): string {
  const id = req?.user?.id || req?.user?.sub || req?.user?.userId;
  if (!id) throw new ForbiddenException();
  return String(id);
}

@UseGuards(AuthGuard('jwt'))
@Controller()
export class TeamsController {
  constructor(private prisma: PrismaService) {}

  // ------- TEAMS -------

  @Get('teams')
  async myTeams(@Req() req: any) {
    const uid = userIdFromReq(req);

    // owner + ACTIVE üyelik OR’u ile getir
    const teams = await this.prisma.team.findMany({
      where: {
        OR: [
          { ownerId: uid },
          { members: { some: { userId: uid, status: 'ACTIVE' } } },
        ],
      },
      include: {
        members: {
          where: { status: 'ACTIVE' },
          select: { userId: true, role: true, number: true, preferredPosition: true },
        },
        positionSlots: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // ÖNEMLİ: Boşsa 404 atma, [] dön.
    return teams;
  }

  @Post('teams')
  async create(@Req() req: any, @Body() dto: CreateTeamDto) {
    const uid = userIdFromReq(req);
    const name = String(dto?.name || '').trim();
    if (!name) throw new BadRequestException('name');

    const formation = (dto?.formationCode as any) || '4-3-3';

    const team = await this.prisma.team.create({
      data: {
        name,
        ownerId: uid,
        bio: dto.bio || null,
        city: dto.city || null,
        district: dto.district || null,
        visibility: (dto.visibility as any) || 'PUBLIC',
        formationCode: formation,
        members: {
          create: [{ userId: uid, role: 'OWNER', status: 'ACTIVE' }],
        },
      },
    });

    // formasyona göre default slotları yaz
    const defaults: Record<string, string[]> = {
      '4-3-3': ['GK','LB','CB1','CB2','RB','DM','CM','AM','LW','RW','ST'],
      '3-5-2': ['GK','CB1','CB2','CB3','LWB','RWB','DM','CM','AM','ST1','ST2'],
      '4-2-3-1': ['GK','LB','CB1','CB2','RB','DM1','DM2','LW','AM','RW','ST'],
    };
    const xy: Record<string, [number, number]> = {
      GK:[10,50], LB:[25,25], CB1:[15,35], CB2:[15,65], RB:[25,75],
      DM:[40,50], DM1:[40,40], DM2:[40,60], CM:[50,50], AM:[60,50],
      LW:[75,25], RW:[75,75], ST:[90,50], ST1:[90,40], ST2:[90,60],
      LWB:[35,25], RWB:[35,75], CB3:[15,50],
    };
    const slots = defaults[formation] || defaults['4-3-3'];
    await this.prisma.teamPositionSlot.createMany({
      data: slots.map((slotKey) => ({
        teamId: team.id,
        formationCode: formation,
        slotKey,
        x: xy[slotKey]?.[0] ?? 50,
        y: xy[slotKey]?.[1] ?? 50,
      })),
    });

    return team;
  }

  @Get('teams/:id')
  async detail(@Req() req: any, @Param('id') id: string) {
    userIdFromReq(req);
    const team = await this.prisma.team.findUnique({
      where: { id },
      include: {
        members: { include: { user: true } },
        positionSlots: true,
      },
    });
    if (!team) throw new BadRequestException('not found');
    return team;
  }

  @Patch('teams/:id')
  async update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateTeamDto) {
    const uid = userIdFromReq(req);
    const t = await this.prisma.team.findUnique({ where: { id } });
    if (!t) throw new BadRequestException('not found');
    if (t.ownerId !== uid) throw new ForbiddenException();

    return this.prisma.team.update({
      where: { id },
      data: {
        name: dto.name ?? undefined,
        bio: dto.bio ?? undefined,
        city: dto.city ?? undefined,
        district: dto.district ?? undefined,
        visibility: (dto.visibility as any) ?? undefined,
        formationCode: dto.formationCode ?? undefined,
      },
    });
  }

  // ------- MEMBERS / INVITES -------

  @Post('teams/:id/invite')
  async invite(
    @Req() req: any,
    @Param('id') teamId: string,
    @Body() body: { toUserId?: string; toPhone?: string; message?: string },
  ) {
    const uid = userIdFromReq(req);
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      include: { members: true },
    });
    if (!team) throw new BadRequestException('not found');
    const self = team.members.find((m) => m.userId === uid);
    if (!self || (self.role !== 'OWNER' && self.role !== 'ADMIN')) throw new ForbiddenException();

    const inv = await this.prisma.teamInvite.create({
      data: {
        teamId,
        invitedBy: uid,
        toUserId: body.toUserId || null,
        toPhone: body.toPhone || null,
        message: body.message || null,
      },
    });
    return { ok: true, id: inv.id };
  }

  @Post('teams/:id/members/accept')
  async acceptInvite(@Req() req: any, @Param('id') teamId: string, @Body() body: { inviteId?: string }) {
    const uid = userIdFromReq(req);
    const inv = await this.prisma.teamInvite.findFirst({ where: { id: body.inviteId, teamId, status: 'PENDING' } });
    if (!inv) throw new BadRequestException('no invite');

    await this.prisma.$transaction([
      this.prisma.teamInvite.update({ where: { id: inv.id }, data: { status: 'ACCEPTED', respondedAt: new Date() } }),
      this.prisma.teamMember.upsert({
        where: { teamId_userId: { teamId, userId: uid } },
        update: { status: 'ACTIVE' },
        create: { teamId, userId: uid, role: 'PLAYER', status: 'ACTIVE' },
      }),
    ]);
    return { ok: true };
  }

  // ------- FORMATION SLOTS -------

  @Get('teams/:id/slots')
  async slots(@Req() req: any, @Param('id') teamId: string) {
    userIdFromReq(req);
    return this.prisma.teamPositionSlot.findMany({ where: { teamId }, orderBy: { slotKey: 'asc' } });
  }

  @Post('teams/:id/slots/assign')
  async assign(
    @Req() req: any,
    @Param('id') teamId: string,
    @Body() body: SlotAssignDto,
  ) {
    const uid = userIdFromReq(req);
    // Sadece takım üyesi düzenleyebilir
    const mem = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId: uid } },
    });
    if (!mem) throw new ForbiddenException();

    const s = await this.prisma.teamPositionSlot.findFirst({ where: { teamId, slotKey: body.slotKey } });
    if (!s) throw new BadRequestException('no slot');

    return this.prisma.teamPositionSlot.update({
      where: { id: s.id },
      data: {
        userId: body.userId === undefined ? s.userId : body.userId,
        locked: body.locked === undefined ? s.locked : !!body.locked,
      },
    });
  }

  // ------- TEAM CHAT -------

  @Get('teams/:id/chat')
  async chatList(@Req() req: any, @Param('id') teamId: string, @Query('after') after?: string) {
    userIdFromReq(req);
    const where = { teamId, ...(after ? { createdAt: { gt: new Date(after) } } : {}) };
    const items = await this.prisma.teamChatMessage.findMany({
      where,
      include: { user: true },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });
    return items.map((m) => ({
      id: m.id,
      teamId: m.teamId,
      text: m.text,
      createdAt: m.createdAt,
      user: {
        id: m.userId,
        phone: m.user.phone,
        nickname: 'U' + (m.user.phone?.slice(-3) ?? '***'),
      },
    }));
  }

  @Post('teams/:id/chat')
  async chatPost(@Req() req: any, @Param('id') teamId: string, @Body() dto: TeamChatDto) {
    const uid = userIdFromReq(req);
    const mem = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId: uid } },
    });
    if (!mem) throw new ForbiddenException();

    const text = String(dto?.text || '').trim().slice(0, 500);
    if (!text) throw new BadRequestException('text');

    const m = await this.prisma.teamChatMessage.create({
      data: { teamId, userId: uid, text },
      include: { user: true },
    });

    return {
      id: m.id,
      teamId: m.teamId,
      text: m.text,
      createdAt: m.createdAt,
      user: {
        id: m.userId,
        phone: m.user.phone,
        nickname: 'U' + (m.user.phone?.slice(-3) ?? '***'),
      },
    };
  }

  // ------- RAKİP ARA (home/away yok) -------

  @Post('team-requests')
  async createOpponent(@Req() req: any, @Body() dto: CreateOpponentDto) {
    const uid = userIdFromReq(req);
    const team = await this.prisma.team.findUnique({
      where: { id: dto.teamId },
      include: { members: true },
    });
    if (!team) throw new BadRequestException('team');
    const self = team.members.find((m) => m.userId === uid);
    if (!self || (self.role !== 'OWNER' && self.role !== 'ADMIN')) throw new ForbiddenException();

    const r = await this.prisma.teamMatchRequest.create({
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
    return r;
  }

  @Get('team-requests')
  async listOpen(@Query('format') format?: string) {
    return this.prisma.teamMatchRequest.findMany({
      where: { status: 'OPEN', ...(format ? { format } : {}) },
      include: { reqTeam: true, oppTeam: true },
      orderBy: { date: 'asc' },
      take: 100,
    });
  }

  @Post('team-requests/:id/offer')
  async offer(@Req() req: any, @Param('id') id: string, @Body() body: { opponentTeamId: string }) {
    const uid = userIdFromReq(req);
    // sadece admin/owner teklif edebilsin
    const hasRole = await this.prisma.teamMember.findFirst({
      where: { teamId: body.opponentTeamId, userId: uid, status: 'ACTIVE', role: { in: ['OWNER','ADMIN'] } },
    });
    if (!hasRole) throw new ForbiddenException();

    return this.prisma.teamMatchRequest.update({
      where: { id },
      data: { opponentTeamId: body.opponentTeamId, status: 'MATCHED' },
    });
  }
}
