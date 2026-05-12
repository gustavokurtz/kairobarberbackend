import { Type } from 'class-transformer';
import { IsDate, IsObject, IsString, ValidateNested } from 'class-validator';
import { CustomerIdentityDto } from 'src/modules/customers/dto/customer-identity.dto';

export class CreatePublicAppointmentDto {
  @IsString() serviceId!: string;
  @IsString() barberId!: string;
  @Type(() => Date) @IsDate() startsAt!: Date;

  @ValidateNested()
  @Type(() => CustomerIdentityDto)
  @IsObject()
  customer!: CustomerIdentityDto;
}
