import { Module } from '@nestjs/common';
import { BarbersController } from './barbers.controller';
import { BarbersService } from './barbers.service';
import { BarberRepository } from './repositories/barber.repository';
import { TimeOffController } from './time-off.controller';
import { TimeOffService } from './time-off.service';
import { TimeOffRepository } from './repositories/time-off.repository';

@Module({
  controllers: [BarbersController, TimeOffController],
  providers: [BarbersService, BarberRepository, TimeOffService, TimeOffRepository],
  exports: [BarbersService, BarberRepository],
})
export class BarbersModule {}
