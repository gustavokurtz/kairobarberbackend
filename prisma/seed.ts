/* eslint-disable no-console */
/**
 * Seed do KairoBarber — popula DB com dados realistas pra testes manuais
 * via web. Cobre todas as audiências e estados de subscription/tenant.
 *
 * Modos:
 *   pnpm prisma:seed                # idempotente: pula tenants que já existem
 *   SEED_RESET=true pnpm prisma:seed # apaga TUDO antes (dev only)
 *
 * Bloqueado em produção sem ALLOW_PROD_SEED=true.
 */
import {
  AiConsultationStatus,
  AppointmentSource,
  AppointmentStatus,
  PrismaClient,
  SubscriptionStatus,
  UserRole,
} from '@prisma/client';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';
import { DateTime } from 'luxon';

const TZ = 'America/Sao_Paulo';
const DEFAULT_PASSWORD = 'Senha123!';

const closed = { open: false, intervals: [] as Array<{ startMin: number; endMin: number }> };
const weekday = { open: true, intervals: [{ startMin: 9 * 60, endMin: 19 * 60 }] };
const saturday = { open: true, intervals: [{ startMin: 9 * 60, endMin: 17 * 60 }] };

// Sun, Mon, Tue, Wed, Thu, Fri, Sat
const STANDARD_HOURS = {
  days: [closed, weekday, weekday, weekday, weekday, weekday, saturday],
};

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Próxima data D em SP, ajustada pro horário hh:mm. */
function nextDayAt(daysFromNow: number, hour: number, minute = 0): Date {
  return DateTime.now()
    .setZone(TZ)
    .plus({ days: daysFromNow })
    .set({ hour, minute, second: 0, millisecond: 0 })
    .toUTC()
    .toJSDate();
}

async function wipeSeedData(prisma: PrismaClient): Promise<void> {
  console.log('[seed] SEED_RESET=true — apagando todos os dados...');
  // Ordem inversa de dependência. Cascade ajuda mas explicito é mais seguro.
  await prisma.$transaction([
    prisma.auditLog.deleteMany(),
    prisma.aiConsultation.deleteMany(),
    prisma.appointment.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.photo.deleteMany(),
    prisma.serviceBarber.deleteMany(),
    prisma.service.deleteMany(),
    prisma.timeOff.deleteMany(),
    prisma.barberInvitation.deleteMany(),
    prisma.barber.deleteMany(),
    prisma.subscription.deleteMany(),
    prisma.tenant.deleteMany(),
    prisma.oneTimeToken.deleteMany(),
    prisma.refreshToken.deleteMany(),
    prisma.user.deleteMany(),
  ]);
  console.log('[seed] dados apagados.');
}

async function ensureSaasOwner(prisma: PrismaClient): Promise<{ email: string; password: string }> {
  const email = process.env.SAAS_OWNER_EMAIL ?? 'saas-owner@kairobarber.dev';
  const name = process.env.SAAS_OWNER_NAME ?? 'SaaS Owner';
  const password = process.env.SAAS_OWNER_PASSWORD ?? 'ChangeMe!1234';
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (existing.role !== UserRole.saas_owner) {
      throw new Error(`Usuário ${email} já existe mas role é ${existing.role}, não saas_owner.`);
    }
    await prisma.user.update({
      where: { id: existing.id },
      data: { passwordHash, name, emailVerifiedAt: existing.emailVerifiedAt ?? new Date() },
    });
    console.log(`[seed] saas_owner atualizado: ${email}`);
  } else {
    await prisma.user.create({
      data: {
        email,
        name,
        passwordHash,
        role: UserRole.saas_owner,
        emailVerifiedAt: new Date(),
      },
    });
    console.log(`[seed] saas_owner criado: ${email}`);
  }
  return { email, password };
}

interface TenantSeed {
  slug: string;
  name: string;
  bio: string;
  address: string;
  phone: string;
  owner: { email: string; name: string };
  barbers: Array<{ displayName: string; bio?: string; createUserAccount?: boolean }>;
  services: Array<{ name: string; durationMin: number; priceCents: number; description?: string }>;
  customers: Array<{ name: string; phone: string; email?: string }>;
  subscription: {
    status: SubscriptionStatus;
    trialEndsAt?: Date | null;
    currentPeriodEnd?: Date | null;
    mpPreapprovalId?: string | null;
  };
  suspended?: boolean;
  /** appointments[i] = {dayOffset, hour, barberIdx, serviceIdx, customerIdx, status}. */
  appointments: Array<{
    dayOffset: number;
    hour: number;
    minute?: number;
    barberIdx: number;
    serviceIdx: number;
    customerIdx: number;
    status: AppointmentStatus;
    source?: AppointmentSource;
  }>;
}

interface SeededTenantResult {
  slug: string;
  name: string;
  ownerEmail: string;
  ownerPassword: string;
  subscriptionStatus: SubscriptionStatus;
  suspended: boolean;
  appointmentCancellationLinks: Array<{ id: string; url: string; customer: string }>;
}

async function seedTenant(
  prisma: PrismaClient,
  seed: TenantSeed,
): Promise<SeededTenantResult | null> {
  const existing = await prisma.tenant.findUnique({ where: { slug: seed.slug } });
  if (existing) {
    console.log(`[seed] tenant "${seed.slug}" já existe — pulando.`);
    return null;
  }

  const passwordHash = await argon2.hash(DEFAULT_PASSWORD, { type: argon2.argon2id });
  const cancellationLinks: SeededTenantResult['appointmentCancellationLinks'] = [];

  await prisma.$transaction(async (tx) => {
    const owner = await tx.user.create({
      data: {
        email: seed.owner.email,
        name: seed.owner.name,
        passwordHash,
        role: UserRole.tenant_owner,
        emailVerifiedAt: new Date(),
      },
    });

    const tenant = await tx.tenant.create({
      data: {
        slug: seed.slug,
        name: seed.name,
        bio: seed.bio,
        address: seed.address,
        phone: seed.phone,
        timezone: TZ,
        businessHours: STANDARD_HOURS,
        ownerUserId: owner.id,
        suspendedAt: seed.suspended ? new Date() : null,
      },
    });

    await tx.subscription.create({
      data: {
        tenantId: tenant.id,
        status: seed.subscription.status,
        trialEndsAt: seed.subscription.trialEndsAt ?? null,
        currentPeriodEnd: seed.subscription.currentPeriodEnd ?? null,
        mpPreapprovalId: seed.subscription.mpPreapprovalId ?? null,
      },
    });

    // Owner também aparece como Barber[0] (faz cortes). userId vincula owner.
    const barberRows = await Promise.all(
      seed.barbers.map((b, idx) =>
        tx.barber.create({
          data: {
            tenantId: tenant.id,
            displayName: b.displayName,
            bio: b.bio,
            active: true,
            // primeiro barber = owner (faz cortes ele mesmo); outros são funcionários sem User
            // (em real-life seriam convidados via /admin/barbeiros).
            userId: idx === 0 ? owner.id : null,
          },
        }),
      ),
    );

    const serviceRows = await Promise.all(
      seed.services.map((s) =>
        tx.service.create({
          data: {
            tenantId: tenant.id,
            name: s.name,
            description: s.description,
            durationMin: s.durationMin,
            priceCents: s.priceCents,
            active: true,
          },
        }),
      ),
    );

    // Vínculo many-to-many: cada serviço é oferecido por TODOS os barbeiros.
    for (const svc of serviceRows) {
      for (const b of barberRows) {
        await tx.serviceBarber.create({
          data: { tenantId: tenant.id, serviceId: svc.id, barberId: b.id },
        });
      }
    }

    const customerRows = await Promise.all(
      seed.customers.map((c) =>
        tx.customer.create({
          data: {
            tenantId: tenant.id,
            name: c.name,
            phone: c.phone,
            email: c.email,
          },
        }),
      ),
    );

    for (const ap of seed.appointments) {
      const barber = barberRows[ap.barberIdx];
      const service = serviceRows[ap.serviceIdx];
      const customer = customerRows[ap.customerIdx];
      const startsAt = nextDayAt(ap.dayOffset, ap.hour, ap.minute ?? 0);
      const endsAt = new Date(startsAt.getTime() + service.durationMin * 60 * 1000);
      const plainToken = randomToken();
      const created = await tx.appointment.create({
        data: {
          tenantId: tenant.id,
          barberId: barber.id,
          serviceId: service.id,
          customerId: customer.id,
          startsAt,
          endsAt,
          status: ap.status,
          priceCentsSnapshot: service.priceCents,
          durationMinSnapshot: service.durationMin,
          source: ap.source ?? AppointmentSource.public_storefront,
          cancellationTokenHash: sha256(plainToken),
          cancelledAt: ap.status === AppointmentStatus.cancelled ? new Date() : null,
          cancellationReason: ap.status === AppointmentStatus.cancelled ? 'seed: demo cancel' : null,
        },
      });
      if (
        ap.status === AppointmentStatus.pending ||
        ap.status === AppointmentStatus.confirmed
      ) {
        const baseUrl = process.env.APP_URL ?? 'http://localhost:3001';
        cancellationLinks.push({
          id: created.id,
          customer: customer.name,
          url: `${baseUrl}/agendamento/${created.id}?token=${plainToken}`,
        });
      }
    }
  }, { timeout: 30_000 });

  console.log(`[seed] tenant "${seed.slug}" criado (${seed.subscription.status}${seed.suspended ? '+suspended' : ''}).`);

  return {
    slug: seed.slug,
    name: seed.name,
    ownerEmail: seed.owner.email,
    ownerPassword: DEFAULT_PASSWORD,
    subscriptionStatus: seed.subscription.status,
    suspended: !!seed.suspended,
    appointmentCancellationLinks: cancellationLinks,
  };
}

async function seedAiConsultations(prisma: PrismaClient): Promise<void> {
  // Pega o primeiro tenant ativo (Studio Zeus) e cria algumas consultas
  const tenant = await prisma.tenant.findUnique({ where: { slug: 'studio-zeus' } });
  if (!tenant) return;

  const customer = await prisma.customer.findFirst({ where: { tenantId: tenant.id } });
  const barber = await prisma.barber.findFirst({ where: { tenantId: tenant.id } });

  const existing = await prisma.aiConsultation.count({ where: { tenantId: tenant.id } });
  if (existing > 0) {
    console.log('[seed] ai consultations já existem — pulando.');
    return;
  }

  const now = new Date();
  const retention7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const samples: Array<{
    status: AiConsultationStatus;
    analysis: object | null;
    hasOutput: boolean;
    costCents: number;
    errorReason?: string;
  }> = [
    {
      status: AiConsultationStatus.completed,
      analysis: {
        faceShape: 'oval',
        suggestions: [
          { id: 's1', title: 'Undercut moderno', reason: 'Realça a estrutura óssea, mantém o equilíbrio do rosto oval.' },
          { id: 's2', title: 'Pompadour curto', reason: 'Dá volume no topo e prolonga visualmente o rosto.' },
          { id: 's3', title: 'Buzz cut texturizado', reason: 'Opção minimalista que destaca traços naturais.' },
        ],
      },
      hasOutput: false,
      costCents: 3,
    },
    {
      status: AiConsultationStatus.generated,
      analysis: {
        faceShape: 'square',
        suggestions: [
          { id: 's1', title: 'Side part clássico', reason: 'Suaviza ângulos da mandíbula com volume lateral.' },
          { id: 's2', title: 'Crew cut com franja', reason: 'Reduz a percepção de largura da têmpora.' },
        ],
      },
      hasOutput: true,
      costCents: 7,
    },
    {
      status: AiConsultationStatus.failed,
      analysis: null,
      hasOutput: false,
      costCents: 1,
      errorReason: 'photo_too_dark',
    },
    {
      status: AiConsultationStatus.completed,
      analysis: {
        faceShape: 'round',
        suggestions: [
          { id: 's1', title: 'Quiff alto', reason: 'Alonga visualmente o rosto redondo.' },
          { id: 's2', title: 'French crop', reason: 'Cria ângulos contrastantes com a curvatura facial.' },
        ],
      },
      hasOutput: false,
      costCents: 2,
    },
  ];

  for (const s of samples) {
    await prisma.aiConsultation.create({
      data: {
        tenantId: tenant.id,
        customerId: customer?.id ?? null,
        barberId: barber?.id ?? null,
        inputPhotoR2Key: `seed/${tenant.slug}/input-${randomToken().slice(0, 8)}.jpg`,
        outputPhotoR2Key: s.hasOutput
          ? `seed/${tenant.slug}/output-${randomToken().slice(0, 8)}.jpg`
          : null,
        analysisJson: s.analysis ?? undefined,
        status: s.status,
        providerCostCents: s.costCents,
        viewTokenHash: sha256(randomToken()),
        consentAcceptedAt: now,
        expiresAt: retention7d,
        errorReason: s.errorReason,
      },
    });
  }

  // Conta quota usada do mês na subscription
  await prisma.subscription.update({
    where: { tenantId: tenant.id },
    data: { aiQuotaUsedThisMonth: samples.length },
  });

  console.log(`[seed] ${samples.length} ai consultations criadas para "${tenant.slug}".`);
}

async function seedAuditSamples(prisma: PrismaClient): Promise<void> {
  const existing = await prisma.auditLog.count();
  if (existing > 5) {
    console.log('[seed] audit log já populado — pulando.');
    return;
  }
  const owner = await prisma.user.findFirst({ where: { role: UserRole.saas_owner } });
  const tenants = await prisma.tenant.findMany({ take: 3 });

  for (const t of tenants) {
    await prisma.auditLog.create({
      data: {
        tenantId: t.id,
        actorUserId: owner?.id,
        action: 'tenant.viewed',
        targetType: 'tenant',
        targetId: t.id,
        ip: '127.0.0.1',
        userAgent: 'seed/1.0',
      },
    });
  }
  console.log(`[seed] ${tenants.length} audit logs adicionados.`);
}

// ---------------- DADOS DOS TENANTS ----------------

function tenantATrialing(): TenantSeed {
  return {
    slug: 'barbearia-do-leo',
    name: 'Barbearia do Leo',
    bio: 'Cortes clássicos e modernos em ambiente acolhedor. Bairro Pinheiros, SP.',
    address: 'R. Augusta, 1234 — Pinheiros, São Paulo, SP',
    phone: '+5511990000001',
    owner: { email: 'leo@kairobarber.dev', name: 'Leonardo Silva' },
    barbers: [
      { displayName: 'Leo (Dono)', bio: '15 anos de experiência. Especialista em degradê.' },
      { displayName: 'Marcos', bio: 'Barba e bigode são minha especialidade.' },
      { displayName: 'Davi', bio: 'Cortes modernos e tendências.' },
    ],
    services: [
      { name: 'Corte simples', durationMin: 30, priceCents: 4500, description: 'Tesoura + máquina, lavagem inclusa.' },
      { name: 'Corte + barba', durationMin: 60, priceCents: 7500, description: 'Pacote completo com finalização.' },
      { name: 'Barba', durationMin: 30, priceCents: 4000, description: 'Toalha quente + navalha.' },
      { name: 'Pezinho', durationMin: 15, priceCents: 2000 },
      { name: 'Sobrancelha', durationMin: 15, priceCents: 1800 },
    ],
    customers: [
      { name: 'Carlos Mendes', phone: '+5511991111111', email: 'carlos@example.com' },
      { name: 'Pedro Santos', phone: '+5511991111112', email: 'pedro@example.com' },
      { name: 'Lucas Oliveira', phone: '+5511991111113' },
      { name: 'Bruno Almeida', phone: '+5511991111114', email: 'bruno@example.com' },
      { name: 'Felipe Rocha', phone: '+5511991111115' },
      { name: 'Ricardo Souza', phone: '+5511991111116', email: 'ricardo@example.com' },
    ],
    subscription: {
      status: SubscriptionStatus.trialing,
      trialEndsAt: DateTime.now().plus({ days: 10 }).toJSDate(),
    },
    appointments: [
      // passados
      { dayOffset: -7, hour: 10, barberIdx: 0, serviceIdx: 1, customerIdx: 0, status: AppointmentStatus.completed },
      { dayOffset: -5, hour: 14, barberIdx: 1, serviceIdx: 0, customerIdx: 1, status: AppointmentStatus.completed },
      { dayOffset: -3, hour: 16, barberIdx: 2, serviceIdx: 2, customerIdx: 2, status: AppointmentStatus.completed },
      { dayOffset: -2, hour: 11, barberIdx: 0, serviceIdx: 0, customerIdx: 3, status: AppointmentStatus.no_show },
      { dayOffset: -1, hour: 15, barberIdx: 1, serviceIdx: 3, customerIdx: 4, status: AppointmentStatus.cancelled },
      // hoje
      { dayOffset: 0, hour: 10, minute: 30, barberIdx: 0, serviceIdx: 1, customerIdx: 5, status: AppointmentStatus.confirmed },
      { dayOffset: 0, hour: 14, barberIdx: 2, serviceIdx: 0, customerIdx: 0, status: AppointmentStatus.confirmed },
      { dayOffset: 0, hour: 16, barberIdx: 1, serviceIdx: 4, customerIdx: 1, status: AppointmentStatus.pending },
      // futuros
      { dayOffset: 1, hour: 9, minute: 30, barberIdx: 0, serviceIdx: 0, customerIdx: 2, status: AppointmentStatus.confirmed },
      { dayOffset: 2, hour: 11, barberIdx: 1, serviceIdx: 1, customerIdx: 3, status: AppointmentStatus.pending },
      { dayOffset: 3, hour: 15, barberIdx: 2, serviceIdx: 2, customerIdx: 4, status: AppointmentStatus.pending },
      { dayOffset: 5, hour: 10, barberIdx: 0, serviceIdx: 3, customerIdx: 5, status: AppointmentStatus.pending },
    ],
  };
}

function tenantBActive(): TenantSeed {
  return {
    slug: 'studio-zeus',
    name: 'Studio Zeus',
    bio: 'Premium grooming. Atendimento sob agendamento. Vila Madalena.',
    address: 'R. Aspicuelta, 456 — Vila Madalena, São Paulo, SP',
    phone: '+5511990000002',
    owner: { email: 'zeus@kairobarber.dev', name: 'Zeus Andrade' },
    barbers: [
      { displayName: 'Zeus', bio: 'Especialista em cortes executivos.' },
      { displayName: 'Ares', bio: 'Beard styling premium.' },
    ],
    services: [
      { name: 'Executive Cut', durationMin: 45, priceCents: 9000, description: 'Corte premium com hidratação.' },
      { name: 'Royal Beard', durationMin: 45, priceCents: 7000, description: 'Modelagem completa com óleos.' },
      { name: 'Combo Zeus', durationMin: 90, priceCents: 14000, description: 'Cabelo + barba + hidratação.' },
      { name: 'Hot Towel Shave', durationMin: 30, priceCents: 8500 },
    ],
    customers: [
      { name: 'Roberto Lima', phone: '+5511992222221', email: 'roberto@example.com' },
      { name: 'Eduardo Costa', phone: '+5511992222222', email: 'eduardo@example.com' },
      { name: 'Henrique Pinto', phone: '+5511992222223' },
      { name: 'Vitor Cavalcanti', phone: '+5511992222224' },
    ],
    subscription: {
      status: SubscriptionStatus.active,
      currentPeriodEnd: DateTime.now().plus({ days: 28 }).toJSDate(),
      mpPreapprovalId: 'CONSOLE-SEED-ACTIVE-001',
    },
    appointments: [
      { dayOffset: -2, hour: 10, barberIdx: 0, serviceIdx: 0, customerIdx: 0, status: AppointmentStatus.completed },
      { dayOffset: -1, hour: 14, barberIdx: 1, serviceIdx: 1, customerIdx: 1, status: AppointmentStatus.completed },
      { dayOffset: 0, hour: 11, barberIdx: 0, serviceIdx: 2, customerIdx: 2, status: AppointmentStatus.confirmed },
      { dayOffset: 0, hour: 15, barberIdx: 1, serviceIdx: 3, customerIdx: 3, status: AppointmentStatus.confirmed },
      { dayOffset: 1, hour: 10, barberIdx: 0, serviceIdx: 0, customerIdx: 0, status: AppointmentStatus.pending },
      { dayOffset: 2, hour: 16, barberIdx: 1, serviceIdx: 2, customerIdx: 1, status: AppointmentStatus.pending },
    ],
  };
}

function tenantCPastDue(): TenantSeed {
  return {
    slug: 'cortes-do-zeze',
    name: 'Cortes do Zezé',
    bio: 'Tradição há 20 anos. Vila Mariana, SP.',
    address: 'R. Domingos de Morais, 789 — Vila Mariana, São Paulo, SP',
    phone: '+5511990000003',
    owner: { email: 'zeze@kairobarber.dev', name: 'José “Zezé” Pereira' },
    barbers: [{ displayName: 'Zezé', bio: 'O dono que corta cabelo desde 2005.' }],
    services: [
      { name: 'Corte popular', durationMin: 30, priceCents: 3500 },
      { name: 'Barba', durationMin: 30, priceCents: 3000 },
      { name: 'Corte + barba', durationMin: 60, priceCents: 6000 },
    ],
    customers: [
      { name: 'João Silva', phone: '+5511993333331' },
      { name: 'Antonio Pereira', phone: '+5511993333332' },
    ],
    subscription: {
      // trial expirou faz 3 dias, ainda dentro do grace de 7 dias.
      status: SubscriptionStatus.past_due,
      trialEndsAt: DateTime.now().minus({ days: 3 }).toJSDate(),
    },
    appointments: [
      // appointments futuros existem mas storefront fica 404; admin bloqueia c/ 402 exceto billing.
      { dayOffset: 1, hour: 10, barberIdx: 0, serviceIdx: 0, customerIdx: 0, status: AppointmentStatus.pending },
      { dayOffset: 3, hour: 14, barberIdx: 0, serviceIdx: 2, customerIdx: 1, status: AppointmentStatus.confirmed },
    ],
  };
}

function tenantDSuspended(): TenantSeed {
  return {
    slug: 'barbearia-suspensa',
    name: 'Barbearia Suspensa',
    bio: 'Tenant suspenso pelo saas_owner pra fins de teste.',
    address: 'R. Teste, 0 — São Paulo, SP',
    phone: '+5511990000004',
    owner: { email: 'suspenso@kairobarber.dev', name: 'Owner Suspenso' },
    barbers: [{ displayName: 'Barbeiro Único' }],
    services: [{ name: 'Corte', durationMin: 30, priceCents: 4000 }],
    customers: [{ name: 'Cliente Demo', phone: '+5511994444441' }],
    subscription: {
      status: SubscriptionStatus.active,
      currentPeriodEnd: DateTime.now().plus({ days: 15 }).toJSDate(),
      mpPreapprovalId: 'CONSOLE-SEED-SUSPENDED-001',
    },
    suspended: true,
    appointments: [],
  };
}

// ---------------- MAIN ----------------

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PROD_SEED !== 'true') {
    throw new Error(
      'Seed bloqueado em produção. Defina ALLOW_PROD_SEED=true se realmente quer rodar.',
    );
  }

  const prisma = new PrismaClient();
  const reset = process.env.SEED_RESET === 'true';
  const results: SeededTenantResult[] = [];

  try {
    if (reset) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('SEED_RESET=true não é permitido em produção.');
      }
      await wipeSeedData(prisma);
    }

    const saasOwner = await ensureSaasOwner(prisma);

    for (const fn of [tenantATrialing, tenantBActive, tenantCPastDue, tenantDSuspended]) {
      const r = await seedTenant(prisma, fn());
      if (r) results.push(r);
    }

    await seedAiConsultations(prisma);
    await seedAuditSamples(prisma);

    printSummary(saasOwner, results);
  } finally {
    await prisma.$disconnect();
  }
}

function printSummary(
  saasOwner: { email: string; password: string },
  tenants: SeededTenantResult[],
): void {
  const line = '─'.repeat(70);
  console.log('\n' + line);
  console.log('  KAIROBARBER — SEED RESUMO');
  console.log(line);
  console.log('\n  SaaS Owner ───────────────────────────────────────────────────────');
  console.log(`    Login: ${saasOwner.email}`);
  console.log(`    Senha: ${saasOwner.password}`);
  console.log(`    URL:   http://localhost:3001/saas`);

  if (tenants.length === 0) {
    console.log('\n  (Nenhum tenant criado — todos já existiam. Use SEED_RESET=true pra recriar.)');
  }

  for (const t of tenants) {
    console.log(`\n  ${t.name} — ${t.subscriptionStatus}${t.suspended ? ' + suspended' : ''}`);
    console.log('  ' + '─'.repeat(68));
    console.log(`    Admin URL:      http://localhost:3001/admin (após login)`);
    console.log(`    Storefront:     http://localhost:3001/b/${t.slug}`);
    console.log(`    Owner login:    ${t.ownerEmail}  /  ${t.ownerPassword}`);
    if (t.appointmentCancellationLinks.length > 0) {
      console.log(`    Magic links de cancelamento (cliente):`);
      for (const l of t.appointmentCancellationLinks.slice(0, 3)) {
        console.log(`      ${l.customer}: ${l.url}`);
      }
      if (t.appointmentCancellationLinks.length > 3) {
        console.log(`      (+${t.appointmentCancellationLinks.length - 3} mais — vide DB)`);
      }
    }
  }
  console.log('\n' + line);
  console.log('  Próximo passo: ler docs/qa/manual-test-flow.md');
  console.log(line + '\n');
}

void main().catch((err: unknown) => {
  console.error('[seed] erro:', err);
  process.exit(1);
});
