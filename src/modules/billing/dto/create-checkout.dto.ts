// Sem campos no corpo — endpoint deriva tudo do tenant autenticado. Mantemos a classe vazia
// para permitir `class-validator` validar `forbidNonWhitelisted` no payload.
export class CreateCheckoutDto {}
