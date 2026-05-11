import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class RegisterOwnerDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(8) @MaxLength(128) password!: string;
  @IsString() @MinLength(2) @MaxLength(80) name!: string;
  @IsString() @MinLength(2) @MaxLength(80) tenantName!: string;
  @IsString()
  @MinLength(3)
  @MaxLength(30)
  @Matches(/^[a-z0-9-]+$/, { message: 'slug must match ^[a-z0-9-]+$' })
  slug!: string;
}
