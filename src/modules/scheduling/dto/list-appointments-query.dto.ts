import { Type } from 'class-transformer';
import { IsDate, IsEnum, IsOptional, IsString } from 'class-validator';
import { AppointmentStatus } from '@prisma/client';

export class ListAppointmentsQueryDto {
  @Type(() => Date) @IsDate() from!: Date;
  @Type(() => Date) @IsDate() to!: Date;
  @IsOptional() @IsString() barberId?: string;
  @IsOptional() @IsEnum(AppointmentStatus) status?: AppointmentStatus;
}
