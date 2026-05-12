import { Module } from '@nestjs/common';
import { BarbersModule } from 'src/modules/barbers/barbers.module';
import { CatalogModule } from 'src/modules/catalog/catalog.module';
import { CustomersModule } from 'src/modules/customers/customers.module';
import { TenantsModule } from 'src/modules/tenants/tenants.module';
import { AppointmentRepository } from './repositories/appointment.repository';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';
import { AvailabilityService } from './availability.service';
import { CancellationService } from './cancellation.service';

@Module({
  imports: [BarbersModule, CatalogModule, CustomersModule, TenantsModule],
  controllers: [AppointmentsController],
  providers: [AppointmentRepository, AppointmentsService, AvailabilityService, CancellationService],
  exports: [AppointmentRepository, AppointmentsService, AvailabilityService, CancellationService],
})
export class SchedulingModule {}
