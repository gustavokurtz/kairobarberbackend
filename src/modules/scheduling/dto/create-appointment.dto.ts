import { Type } from 'class-transformer';
import { IsDate, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
import { CustomerIdentityDto } from 'src/modules/customers/dto/customer-identity.dto';

export class CreateAppointmentDto {
  @IsString() serviceId!: string;
  @IsString() barberId!: string;
  @Type(() => Date) @IsDate() startsAt!: Date;

  @IsOptional() @IsString() customerId?: string;
  @IsOptional()
  @ValidateNested()
  @Type(() => CustomerIdentityDto)
  @IsObject()
  customer?: CustomerIdentityDto;
}
