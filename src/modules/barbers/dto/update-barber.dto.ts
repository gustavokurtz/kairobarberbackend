import { IsBoolean, IsOptional, IsString, IsUrl, MaxLength, MinLength } from 'class-validator';

export class UpdateBarberDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) displayName?: string;
  @IsOptional() @IsString() @MaxLength(500) bio?: string | null;
  @IsOptional() @IsUrl({ require_protocol: true }) avatarUrl?: string | null;
  @IsOptional() @IsBoolean() active?: boolean;
}
