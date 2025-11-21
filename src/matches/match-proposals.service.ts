// Matchfinder-api/src/matches/match-proposals.service.ts

import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

console.log('🔥 MatchProposalsService LOADED - NEW VERSION 2024');

@Injectable()
export class MatchProposalsService {
  constructor(private readonly prisma: PrismaService) {
    console.log('🔥 MatchProposalsService constructor called');
    console.log('🔥 prisma instance:', !!this.prisma);
    console.log('🔥 prisma type:', typeof this.prisma);
  }

  async createProposal(
    matchId: string,
    userId: string,
    proposedDate: string,
  ) {
    console.log('🔥 createProposal called:', { matchId, userId });
    console.log('🔥 this.prisma exists:', !!this.prisma);

    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
    });

    if (!match) {
      throw new NotFoundException('Maç bulunamadı');
    }

    const slots = (match.slots as any) || [];
    const isParticipant = Array.isArray(slots)
      ? slots.some((s: any) => s.userId === userId)
      : false;
    const isOwner = match.ownerId === userId;

    if (!isParticipant && !isOwner) {
      throw new ForbiddenException('Bu maça erişim yetkiniz yok');
    }

    const proposal = await this.prisma.matchProposal.create({
      data: {
        matchId,
        proposedBy: userId,
        proposedDate: new Date(proposedDate),
      },
      include: {
        proposer: { select: { id: true, phone: true } },
      },
    });

    return {
      id: proposal.id,
      matchId: proposal.matchId,
      proposedBy: proposal.proposedBy,
      proposedDate: proposal.proposedDate.toISOString(),
      proposer: proposal.proposer,
      votes: [],
      acceptCount: 0,
      rejectCount: 0,
      userVote: null,
      createdAt: proposal.createdAt.toISOString(),
    };
  }

  async listProposals(matchId: string, userId: string) {
    console.log('🔥 listProposals called:', { matchId, userId });
    console.log('🔥 this.prisma exists:', !!this.prisma);
    console.log('🔥 this.prisma.matchProposal:', !!this.prisma?.matchProposal);

    const match = await this.prisma.match.findUnique({
      where: { id: matchId },
    });

    if (!match) {
      throw new NotFoundException('Maç bulunamadı');
    }

    const slots = (match.slots as any) || [];
    const isParticipant = Array.isArray(slots)
      ? slots.some((s: any) => s.userId === userId)
      : false;
    const isOwner = match.ownerId === userId;

    if (!isParticipant && !isOwner) {
      throw new ForbiddenException('Bu maça erişim yetkiniz yok');
    }

    console.log('🔥 About to call prisma.matchProposal.findMany');
    const proposals = await this.prisma.matchProposal.findMany({
      where: { matchId },
      include: {
        proposer: { select: { id: true, phone: true } },
        votes: {
          include: {
            user: { select: { id: true, phone: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    console.log('🔥 Proposals fetched:', proposals.length);

    // @ts-ignore - Prisma inference works fine
    return proposals.map((p: any) => {  // ← TİP EKLENDİ
      const acceptCount = p.votes.filter((v: any) => v.vote === 'ACCEPT').length;
      const rejectCount = p.votes.filter((v: any) => v.vote === 'REJECT').length;
      const userVote = p.votes.find((v: any) => v.userId === userId)?.vote || null;

      return {
        id: p.id,
        matchId: p.matchId,
        proposedBy: p.proposedBy,
        proposedDate: p.proposedDate.toISOString(),
        proposer: p.proposer,
        votes: p.votes.map((v: any) => ({
          id: v.id,
          userId: v.userId,
          vote: v.vote,
          user: v.user,
        })),
        acceptCount,
        rejectCount,
        userVote,
        createdAt: p.createdAt.toISOString(),
      };
    });
  }

  async voteProposal(
    proposalId: string,
    userId: string,
    vote: 'ACCEPT' | 'REJECT',
  ) {
    console.log('🔥 voteProposal called:', { proposalId, userId, vote });

    const proposal = await this.prisma.matchProposal.findUnique({
      where: { id: proposalId },
      include: { match: true },
    });

    if (!proposal) {
      throw new NotFoundException('Öneri bulunamadı');
    }

    if (proposal.proposedBy === userId) {
      throw new BadRequestException('Kendi önerinize oy veremezsiniz');
    }

    const slots = (proposal.match.slots as any) || [];
    const isParticipant = Array.isArray(slots)
      ? slots.some((s: any) => s.userId === userId)
      : false;
    const isOwner = proposal.match.ownerId === userId;

    if (!isParticipant && !isOwner) {
      throw new ForbiddenException('Bu maça erişim yetkiniz yok');
    }

    await this.prisma.matchProposalVote.upsert({
      where: {
        proposalId_userId: {
          proposalId,
          userId,
        },
      },
      update: { vote },
      create: {
        proposalId,
        userId,
        vote,
      },
    });

    return { ok: true };
  }

  async deleteProposal(proposalId: string, userId: string) {
    console.log('🔥 deleteProposal called:', { proposalId, userId });

    const proposal = await this.prisma.matchProposal.findUnique({
      where: { id: proposalId },
    });

    if (!proposal) {
      throw new NotFoundException('Öneri bulunamadı');
    }

    if (proposal.proposedBy !== userId) {
      throw new ForbiddenException('Bu öneriyi silme yetkiniz yok');
    }

    await this.prisma.matchProposal.delete({
      where: { id: proposalId },
    });

    return { message: 'Öneri silindi' };
  }
}