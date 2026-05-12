import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { UserRole } from '@prisma/client';
import { PaginationDto } from './pagination.dto';

export class ListUsersQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(Object.values(UserRole))
  role?: UserRole;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;
}
