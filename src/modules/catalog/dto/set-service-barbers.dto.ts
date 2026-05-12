import { ArrayUnique, IsArray, IsString } from 'class-validator';

export class SetServiceBarbersDto {
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  barberIds!: string[];
}
