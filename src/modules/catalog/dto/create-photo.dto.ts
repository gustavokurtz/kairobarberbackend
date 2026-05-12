import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreatePhotoDto {
  @IsString() @MaxLength(255) r2Key!: string;
  @IsOptional() @IsString() @MaxLength(200) caption?: string;
  @IsOptional() @IsString() serviceId?: string;
  @IsOptional() @IsString() barberId?: string;
}
