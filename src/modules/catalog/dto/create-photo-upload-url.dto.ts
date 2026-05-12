import { IsString } from 'class-validator';

export class CreatePhotoUploadUrlDto {
  @IsString() contentType!: string;
}
