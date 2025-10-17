import { IsIn } from 'class-validator';

export class RespondInviteDto {
  @IsIn(['accept', 'decline'])
  action!: 'accept' | 'decline';
}
