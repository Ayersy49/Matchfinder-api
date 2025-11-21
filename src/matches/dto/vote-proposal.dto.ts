// Matchfinder-api/src/matches/dto/vote-proposal.dto.ts

import { IsEnum, IsNotEmpty } from 'class-validator';

// VoteType enum'unu Prisma'dan değil, burada tanımla (çünkü import sorunu yaşıyorsun)
export enum VoteType {
  ACCEPT = 'ACCEPT',
  REJECT = 'REJECT',
}

export class VoteMatchProposalDto {
  @IsEnum(VoteType)
  @IsNotEmpty()
  vote!: VoteType; // ! işareti TypeScript strict mode için
}