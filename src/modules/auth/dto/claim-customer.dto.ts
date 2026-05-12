import { IsNotEmpty, IsString, Length, MinLength } from 'class-validator';

export class ClaimCustomerDto {
  @IsString() @IsNotEmpty() token!: string;
  @IsString() @MinLength(8) @Length(8, 128) password!: string;
}
