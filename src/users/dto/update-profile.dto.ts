import { IsIn, IsInt, Min, Max, IsArray, ArrayMaxSize, IsString, IsOptional } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  lastname?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  age?: number;

  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(250)
  height?: number;

  @IsOptional()
  @IsInt()
  @Min(20)
  @Max(200)
  weight?: number;

  @IsOptional()
  @IsString()
  gender?: string;

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

  @IsOptional()
  positionLevels?: Record<string, number>;
}
