import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsString } from 'class-validator';

export class AvailabilityQueryDto {
  @Type(() => Date) @IsDate() from!: Date;
  @Type(() => Date) @IsDate() to!: Date;
  @IsOptional() @IsString() serviceId?: string;
}
