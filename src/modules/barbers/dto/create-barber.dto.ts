import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateBarberDto {
  @IsString() @MinLength(2) @MaxLength(80) displayName!: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(500) bio?: string;
}
