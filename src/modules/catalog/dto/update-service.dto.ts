import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class UpdateServiceDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string | null;
  @IsOptional() @IsInt() @Min(5) @Max(480) durationMin?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10_000_00) priceCents?: number;
  @IsOptional() @IsBoolean() active?: boolean;
}
