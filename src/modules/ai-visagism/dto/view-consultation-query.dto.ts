import { IsString, Length } from 'class-validator';

export class ViewConsultationQueryDto {
  @IsString()
  @Length(20, 128)
  token!: string;
}
