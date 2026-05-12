import { Module } from '@nestjs/common';
import { BarbersController } from './barbers.controller';
import { BarbersService } from './barbers.service';
import { BarberRepository } from './repositories/barber.repository';

@Module({
  controllers: [BarbersController],
  providers: [BarbersService, BarberRepository],
  exports: [BarbersService, BarberRepository],
})
export class BarbersModule {}
