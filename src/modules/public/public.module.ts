import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { PublicTenantMiddleware } from 'src/common/middleware/public-tenant.middleware';
import { BarbersModule } from 'src/modules/barbers/barbers.module';
import { CatalogModule } from 'src/modules/catalog/catalog.module';
import { CustomersModule } from 'src/modules/customers/customers.module';
import { NotificationsModule } from 'src/modules/notifications/notifications.module';
import { SchedulingModule } from 'src/modules/scheduling/scheduling.module';
import { TenantsModule } from 'src/modules/tenants/tenants.module';
import { PublicAppointmentsController } from './public-appointments.controller';
import { PublicAvailabilityController } from './public-availability.controller';
import { PublicCatalogController } from './public-catalog.controller';

@Module({
  imports: [
    TenantsModule,
    BarbersModule,
    CatalogModule,
    CustomersModule,
    SchedulingModule,
    NotificationsModule,
  ],
  controllers: [
    PublicCatalogController,
    PublicAvailabilityController,
    PublicAppointmentsController,
  ],
})
export class PublicModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(PublicTenantMiddleware)
      .forRoutes({ path: 'public/:slug/*', method: RequestMethod.ALL });
    consumer
      .apply(PublicTenantMiddleware)
      .forRoutes({ path: 'public/:slug', method: RequestMethod.GET });
  }
}
