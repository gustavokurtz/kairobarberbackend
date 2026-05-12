import { Type } from 'class-transformer';
import { IsDate } from 'class-validator';

export class UpdateAppointmentDto {
  @Type(() => Date) @IsDate() startsAt!: Date;
}
