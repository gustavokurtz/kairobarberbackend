import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

/**
 * Update parcial. Campos ausentes mantêm o valor atual.
 * Pra remover vínculo (caption/serviceId/barberId), envie explicitamente `null`.
 */
export class UpdatePhotoDto {
  @IsOptional()
  @ValidateIf((_, v: unknown) => v !== null)
  @IsString()
  @MaxLength(200)
  caption?: string | null;

  @IsOptional()
  @ValidateIf((_, v: unknown) => v !== null)
  @IsString()
  serviceId?: string | null;

  @IsOptional()
  @ValidateIf((_, v: unknown) => v !== null)
  @IsString()
  barberId?: string | null;
}
