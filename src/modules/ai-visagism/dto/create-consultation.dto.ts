import { IsISO8601, IsOptional, IsString, Length } from 'class-validator';

/**
 * O body deste endpoint é multipart/form-data (campo `photo` é o arquivo).
 * Os campos abaixo são os fields textuais que acompanham o upload.
 */
export class CreateConsultationDto {
  @IsISO8601()
  consentAcceptedAt!: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  customerId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  barberId?: string;
}
