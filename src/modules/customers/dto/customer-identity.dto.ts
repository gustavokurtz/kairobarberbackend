import { IsEmail, IsNotEmpty, IsOptional, IsString, Length, Matches } from 'class-validator';

export class CustomerIdentityDto {
  @IsString()
  @IsNotEmpty()
  @Length(2, 80)
  name!: string;

  @IsString()
  @Matches(/^\+?[0-9\s-()]{8,20}$/, { message: 'phone inválido' })
  phone!: string;

  @IsOptional()
  @IsEmail()
  email?: string;
}
