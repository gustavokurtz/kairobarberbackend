import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from './pagination.dto';

export class ListAuditLogQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  tenantId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  actorUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  action?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}
