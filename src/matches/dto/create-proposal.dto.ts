// Matchfinder-api/src/matches/dto/create-proposal.dto.ts

import { IsDateString, IsNotEmpty } from 'class-validator';

export class CreateMatchProposalDto {
  @IsDateString()
  @IsNotEmpty()
  proposedDate!: string; // ! işareti TypeScript strict mode için
}