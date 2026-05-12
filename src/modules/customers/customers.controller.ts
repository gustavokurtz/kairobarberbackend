import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from 'src/common/guards/tenant.guard';
import { CustomersService } from './customers.service';

@Controller('admin/customers')
@UseGuards(TenantGuard)
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  list(@Query('search') search?: string) {
    return this.customers.list(search);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.customers.getById(id);
  }

  @Get(':id/appointments')
  async listAppointments(@Param('id') id: string) {
    await this.customers.getById(id);
    return this.customers.listAppointments(id);
  }
}
