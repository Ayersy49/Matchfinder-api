import { IsIn, IsInt, Min, Max, IsArray, ArrayMaxSize, IsString, IsOptional } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsIn(['L', 'R', 'N'])
  dominantFoot?: 'L' | 'R' | 'N';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  positions?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  level?: number;
}
