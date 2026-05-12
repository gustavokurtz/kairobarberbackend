import { IsOptional, IsString, MaxLength, MinLength, IsUrl } from 'class-validator';

export class UpdateTenantDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(500) bio?: string | null;
  @IsOptional() @IsString() @MaxLength(200) address?: string | null;
  @IsOptional() @IsString() @MaxLength(40) phone?: string | null;
  @IsOptional() @IsUrl({ require_protocol: true }) avatarUrl?: string | null;
  @IsOptional() @IsString() @MaxLength(60) timezone?: string;
}
