import { IsObject } from 'class-validator';

export class UpdateBusinessHoursDto {
  // Estrutura completa validada por validateBusinessHours dentro do service.
  // class-validator só garante que é objeto; semântica fica no domain validator.
  @IsObject() businessHours!: unknown;
}
