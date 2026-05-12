import { IsString, Length } from 'class-validator';

export class GenerateImageDto {
  @IsString()
  @Length(2, 64)
  suggestionId!: string;
}
