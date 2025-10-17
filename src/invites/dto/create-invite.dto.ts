import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateInviteDto {
  @IsOptional() @IsArray()
  toUserIds?: string[];

  @IsOptional() @IsArray()
  toPhones?: string[]; // "9055..."

  @IsOptional() @IsString() @MaxLength(280)
  message?: string;
}
