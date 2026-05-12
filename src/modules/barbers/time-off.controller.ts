import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from 'src/common/guards/tenant.guard';
import { TimeOffService } from './time-off.service';
import { CreateTimeOffDto } from './dto/create-time-off.dto';

@Controller('admin/barbers/:barberId/time-off')
@UseGuards(TenantGuard)
export class TimeOffController {
  constructor(private readonly timeOff: TimeOffService) {}

  @Get()
  list(@Param('barberId') barberId: string) {
    return this.timeOff.list(barberId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Param('barberId') barberId: string, @Body() dto: CreateTimeOffDto) {
    return this.timeOff.create(barberId, dto);
  }

  @Delete(':timeOffId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('barberId') barberId: string, @Param('timeOffId') timeOffId: string) {
    await this.timeOff.delete(barberId, timeOffId);
  }
}
