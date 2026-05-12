import { IsBooleanString, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from './pagination.dto';

export class ListTenantsQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(['trialing', 'active', 'past_due', 'cancelled', 'all'])
  status: 'trialing' | 'active' | 'past_due' | 'cancelled' | 'all' = 'all';

  @IsOptional()
  @IsBooleanString()
  suspended?: 'true' | 'false';

  @IsOptional()
  @IsString()
  @MaxLength(80)
  search?: string;
}
