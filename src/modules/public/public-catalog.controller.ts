import { Controller, Get, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from 'src/common/decorators/public.decorator';
import { BarberRepository } from 'src/modules/barbers/repositories/barber.repository';
import { PhotoRepository } from 'src/modules/catalog/repositories/photo.repository';
import { ServiceRepository } from 'src/modules/catalog/repositories/service.repository';
import { TenantRepository } from 'src/modules/tenants/repositories/tenant.repository';

@Controller('public/:slug')
@Public()
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class PublicCatalogController {
  constructor(
    private readonly tenants: TenantRepository,
    private readonly barbers: BarberRepository,
    private readonly services: ServiceRepository,
    private readonly photos: PhotoRepository,
  ) {}

  @Get()
  async getTenant(@Param('slug') slug: string) {
    const t = await this.tenants.findBySlug(slug);
    if (!t) return null;
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      bio: t.bio,
      address: t.address,
      phone: t.phone,
      avatarUrl: t.avatarUrl,
      timezone: t.timezone,
      businessHours: t.businessHours ?? null,
    };
  }

  @Get('barbers')
  async listBarbers() {
    const list = await this.barbers.list();
    return list
      .filter((b) => b.active && !b.deletedAt)
      .map((b) => ({ id: b.id, displayName: b.displayName, bio: b.bio, avatarUrl: b.avatarUrl }));
  }

  @Get('services')
  async listServices() {
    const list = await this.services.list();
    return list
      .filter((s) => s.active && !s.deletedAt)
      .map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        durationMin: s.durationMin,
        priceCents: s.priceCents,
        barberIds: s.serviceBarbers.map((sb) => sb.barberId),
      }));
  }

  @Get('photos')
  async listPhotos() {
    const list = await this.photos.list();
    return list
      .filter((p) => !p.deletedAt)
      .map((p) => ({
        id: p.id,
        r2Key: p.r2Key,
        caption: p.caption,
        serviceId: p.serviceId,
        barberId: p.barberId,
      }));
  }
}
