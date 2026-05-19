import { IsOptional, IsString, Matches, MaxLength, MinLength, IsUrl } from 'class-validator';

export class UpdateTenantDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(500) bio?: string | null;
  @IsOptional() @IsString() @MaxLength(200) address?: string | null;
  @IsOptional() @IsString() @MaxLength(40) phone?: string | null;
  // Apenas dígitos: 11 (CPF) ou 14 (CNPJ). Front é responsável por limpar pontuação.
  @IsOptional()
  @IsString()
  @Matches(/^(\d{11}|\d{14})$/, { message: 'documentNumber deve ter 11 (CPF) ou 14 (CNPJ) dígitos' })
  documentNumber?: string | null;
  @IsOptional() @IsUrl({ require_protocol: true }) avatarUrl?: string | null;
  @IsOptional() @IsString() @MaxLength(60) timezone?: string;
}
