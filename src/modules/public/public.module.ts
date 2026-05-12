import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { PublicTenantMiddleware } from 'src/common/middleware/public-tenant.middleware';
import { AiVisagismModule } from 'src/modules/ai-visagism/ai-visagism.module';
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
    AiVisagismModule,
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
      .exclude(
        { path: 'public/appointments/(.*)', method: RequestMethod.ALL },
        { path: 'public/appointments', method: RequestMethod.ALL },
        { path: 'public/ai/visagism/(.*)', method: RequestMethod.ALL },
      )
      .forRoutes({ path: 'public/:slug/*', method: RequestMethod.ALL });
    consumer
      .apply(PublicTenantMiddleware)
      .forRoutes({ path: 'public/:slug', method: RequestMethod.GET });
  }
}
