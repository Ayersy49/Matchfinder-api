// src/invites/invites.service.ts
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeSlots, Slot, Team } from '../matches/slots';

@Injectable()
export class InvitesService {
  constructor(private prisma: PrismaService) {}

  // Prisma'nın MatchInvite delegesi – TS tipi takılmasın diye any
  private get MI() {
    return (this.prisma as any).matchInvite;
  }

  /** Sahibi mi / katılımcı mı? (slots JSON içinde id geçiyorsa katılımcı say) */
  private async canInvite(matchId: string, userId: string) {
    const match = await this.prisma.match.findUnique({ where: { id: matchId } });
    if (!match) throw new NotFoundException('match_not_found');
    if (match.ownerId === userId) return true;

    try {
      return JSON.stringify(match.slots ?? {}).includes(userId);
    } catch {
      return false;
    }
  }

  async create(
    matchId: string,
    fromUserId: string,
    dto: { toUserIds?: string[]; toPhones?: string[]; message?: string }
  ) {
    if (!(await this.canInvite(matchId, fromUserId))) {
      throw new ForbiddenException('no_invite_permission');
    }

    const cutoff = new Date(Date.now() - 10 * 60 * 1000); // 10 dk rate-limit
    const rows: any[] = [];

    for (const id of dto.toUserIds ?? []) {
      const recent = await this.MI.findFirst({
        where: { matchId, fromUserId, toUserId: id, status: 'PENDING', createdAt: { gte: cutoff } },
      });
      if (!recent) rows.push({ matchId, fromUserId, toUserId: id, message: dto.message ?? null });
    }

    for (const phone of dto.toPhones ?? []) {
      const recent = await this.MI.findFirst({
        where: { matchId, fromUserId, toPhone: phone, status: 'PENDING', createdAt: { gte: cutoff } },
      });
      if (!recent) rows.push({ matchId, fromUserId, toPhone: phone, message: dto.message ?? null });
    }

    if (!rows.length) return { created: 0 };
    await this.MI.createMany({ data: rows });
    return { created: rows.length };
  }

  async inbox(userId: string) {
    return this.MI.findMany({
      where: { toUserId: userId },
      orderBy: { createdAt: 'desc' },
      include: { match: true, fromUser: true },
    });
  }

  async sent(userId: string) {
    return this.MI.findMany({
      where: { fromUserId: userId },
      orderBy: { createdAt: 'desc' },
      include: { match: true, toUser: true },
    });
  }

  /** Davet kabul/red – kabulde otomatik yerleştirmeyi dener */
  async respond(inviteId: string, userId: string, action: 'accept' | 'decline') {
    const inv = await this.MI.findUnique({ where: { id: inviteId } });
    if (!inv || inv.toUserId !== userId) throw new NotFoundException('invite_not_found');

    if (inv.status !== 'PENDING') {
      return { ok: true, already: true, matchId: inv.matchId };
    }

    if (action === 'decline') {
      await this.MI.update({
        where: { id: inviteId },
        data: { status: 'DECLINED', respondedAt: new Date() },
      });
      return { ok: true, matchId: inv.matchId };
    }

    // ACCEPT
    await this.MI.update({
      where: { id: inviteId },
      data: { status: 'ACCEPTED', respondedAt: new Date() },
    });

    const auto = await this.autoJoinPreferred(inv.matchId, userId, inv.fromUserId);

    return {
      ok: true,
      matchId: inv.matchId,
      autoJoined: auto.joined,
      team: auto.team ?? undefined,
      pos: auto.pos ?? undefined,
    };
  }

  /** Gönderen kendi davetini iptal eder */
  async cancel(inviteId: string, userId: string) {
    const inv = await this.MI.findUnique({ where: { id: inviteId } });
    if (!inv) return { ok: false, message: 'invite_not_found' };
    if (inv.fromUserId !== userId) return { ok: false, message: 'forbidden' };
    if (inv.status !== 'PENDING') return { ok: true, already: true };

    await this.MI.update({
      where: { id: inviteId },
      data: { status: 'CANCELLED', respondedAt: new Date() },
    });
    return { ok: true };
  }

  /**
   * Kabulde otomatik yerleştirme:
   * 1) Daveti yollayanın takımı öncelikli
   * 2) Kullanıcının ilk 3 pozisyon tercihi sırayla denenir
   * 3) Boş yoksa yerleştirmez (detaydan mevki seçmesi gerekir)
   */
  private async autoJoinPreferred(
    matchId: string,
    invitedUserId: string,
    inviterUserId?: string,
  ): Promise<{ joined: boolean; team?: Team; pos?: string }> {
    const m = await this.prisma.match.findUnique({
      where: { id: matchId },
      select: { format: true, slots: true },
    });
    if (!m) return { joined: false };

    const slots: Slot[] = normalizeSlots(m.slots, m.format);

    // Zaten içerde mi?
    const mine = slots.find((s) => s.userId === invitedUserId);
    if (mine) return { joined: true, team: mine.team, pos: mine.pos };

    // Davet edenin takımı
    const inviterTeam: Team | null =
      inviterUserId ? (slots.find((s) => s.userId === inviterUserId)?.team ?? null) : null;

    // Kullanıcı pozisyon tercihleri (ilk 3)
    const user = await this.prisma.user.findUnique({
      where: { id: invitedUserId },
      select: { positions: true },
    });
    const prefs: string[] = Array.isArray(user?.positions)
      ? (user!.positions as any[]).map(String).slice(0, 3).map((p) => p.toUpperCase())
      : [];

    const findIndex = (teamPref: Team | null) => {
      for (const p of prefs) {
        const idx = slots.findIndex((s) => !s.userId && s.pos === p && (!teamPref || s.team === teamPref));
        if (idx !== -1) return idx;
      }
      return -1;
    };

    // 1) Davet edenin takımı
    let idx = inviterTeam ? findIndex(inviterTeam) : -1;

    // 2) Takım kısıtı olmadan
    if (idx === -1) idx = findIndex(null);

    if (idx === -1) {
      return { joined: false };
    }

    const chosen = slots[idx];
    slots[idx] = { ...chosen, userId: invitedUserId };

    await this.prisma.match.update({
      where: { id: matchId },
      data: { slots: slots as any },
      select: { id: true },
    });

    return { joined: true, team: chosen.team, pos: chosen.pos };
  }
}
