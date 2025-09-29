import { IsIn, IsInt, Min, Max, IsArray, ArrayMaxSize, IsString } from 'class-validator';

export class UpdateProfileDto {
  @IsIn(['L', 'R', 'N'])
  dominantFoot: 'L' | 'R' | 'N';

  @IsArray()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  positions: string[];

  @IsInt()
  @Min(1)
  @Max(10)
  level: number;
}
