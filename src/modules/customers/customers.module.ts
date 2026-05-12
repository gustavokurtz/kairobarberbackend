import { Module } from '@nestjs/common';
import { CustomersService } from './customers.service';
import { CustomerRepository } from './repositories/customer.repository';

@Module({
  providers: [CustomersService, CustomerRepository],
  exports: [CustomersService, CustomerRepository],
})
export class CustomersModule {}
