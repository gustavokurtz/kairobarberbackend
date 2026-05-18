# Fluxo de teste manual — pós-seed

> Guia operacional para validar a aplicação **inteira** (API + Web) navegando
> manualmente após rodar o seed. Cobre as 3 audiências, todos os estados de
> subscription/tenant, gating, e fluxos críticos.
>
> Complementa (não substitui) [manual-checklist.md](./manual-checklist.md), que
> foca em cenários não-determinísticos (IA, emails reais).

---

## 1. Pré-requisitos

### 1.1 Subir tudo

```bash
# Postgres + Redis
cd kairobarber-api
docker compose up -d postgres redis

# Migrations
pnpm prisma:migrate:dev

# Seed (reset destrutivo no dev local)
SEED_RESET=true pnpm prisma:seed

# Backend (porta 3000)
pnpm start:dev

# Em outro terminal — Front (porta 3001)
cd ../kairobarber-web
pnpm dev
```

Healthcheck rápido:

```bash
curl http://localhost:3000/health/ready    # {"status":"ok",...}
curl -I http://localhost:3001              # 200 OK
```

### 1.2 Recomendação: trocar `BILLING_PROVIDER` pra `console` no dev

O `.env` atual de dev está com `BILLING_PROVIDER=mercadopago` apontando pra
**produção real** do Mercado Pago (`APP_USR-...`). Qualquer clique em
"Assinar" via UI cria preapproval real.

Pra teste manual seguro, ajuste em `kairobarber-api/.env`:

```env
BILLING_PROVIDER=console
# MP_ACCESS_TOKEN= (pode deixar vazio em modo console)
```

Reinicie o backend. O `ConsoleBillingProvider` retorna `initPoint` que aponta
direto pra `/admin/billing/return?ok=1&preapproval_id=...` — sem sair do
ambiente local. O sync polls retorna `pending` por padrão, mas pode ser
forçado via repl/Prisma Studio.

> Se preferir testar com cartão de teste do MP (test users), troque o
> `MP_ACCESS_TOKEN` por um `TEST-...` do painel MP > test users.

### 1.3 Credenciais do seed

| Audiência | Login | Senha | URL inicial |
|---|---|---|---|
| **SaaS Owner** | valor de `SAAS_OWNER_EMAIL` no `.env` (default `saas-owner@kairobarber.dev`) | valor de `SAAS_OWNER_PASSWORD` (default `ChangeMe!1234`) | http://localhost:3001/login → `/saas` |
| Tenant A (trialing) | leo@kairobarber.dev | `Senha123!` | http://localhost:3001/login → `/admin` |
| Tenant B (active) | zeus@kairobarber.dev | `Senha123!` | http://localhost:3001/login → `/admin` |
| Tenant C (past_due) | zeze@kairobarber.dev | `Senha123!` | http://localhost:3001/login → `/admin` |
| Tenant D (suspended) | suspenso@kairobarber.dev | `Senha123!` | http://localhost:3001/login → `/admin` |

### 1.4 Storefronts públicas

| Tenant | Estado | URL | Comportamento esperado |
|---|---|---|---|
| Barbearia do Leo | trialing | http://localhost:3001/b/barbearia-do-leo | **200** — storefront normal, booking funciona |
| Studio Zeus | active | http://localhost:3001/b/studio-zeus | **200** — storefront normal, booking funciona |
| Cortes do Zezé | past_due | http://localhost:3001/b/cortes-do-zeze | **404** — past_due bloqueia storefront pública |
| Barbearia Suspensa | active + `suspendedAt` | http://localhost:3001/b/barbearia-suspensa | **404** — tenant suspenso não aparece |

---

## 2. Mapa de fluxos por audiência

> Cada fluxo abaixo é uma sequência **end-to-end** de cliques que você
> faz manualmente. Marque `[x]` enquanto progride; cada bloco é independente.

### 2.1 Cliente final — storefront + booking (~10 min)

Use o **Tenant B (Studio Zeus, active)** como happy path.

- [ ] Abrir `http://localhost:3001/b/studio-zeus` em aba anônima (sem cookies)
- [ ] Verificar: nome, bio, endereço, telefone, lista de serviços com preço BR (R$ X,XX), tabs/links pra barbeiros e fotos
- [ ] Navegar `/b/studio-zeus/barbeiros` — listar Zeus e Ares
- [ ] Navegar `/b/studio-zeus/servicos` — 4 serviços com duração e preço
- [ ] Clicar em "Agendar" (ou ir em `/b/studio-zeus/agendar`)
- [ ] **Wizard passo 1:** selecionar serviço (ex.: "Executive Cut")
- [ ] **Passo 2:** selecionar barbeiro (ex.: "Zeus")
- [ ] **Passo 3:** ver calendário de disponibilidade (deve mostrar slots livres respeitando horário 09–19 seg-sex, 09–17 sáb)
- [ ] Selecionar um slot futuro vazio
- [ ] **Passo 4:** preencher nome, telefone, email
- [ ] Confirmar — deve receber página de sucesso com **magic link de cancelamento**
- [ ] Conferir backend log: `appointment.created` (e tentativa de email)
- [ ] Abrir o magic link em outra aba — ver detalhes do agendamento
- [ ] Cancelar (janela > 2h antes) — confirmar que ficou `cancelled`
- [ ] Tentar cancelar **um agendamento a menos de 2h** (use um do seed que está hoje no Tenant A): deve falhar com mensagem clara

#### Edge cases storefront

- [ ] Storefront do tenant `cortes-do-zeze` deve retornar **404** (past_due)
- [ ] Storefront do tenant `barbearia-suspensa` deve retornar **404** (suspended)
- [ ] Storefront de slug inexistente (`/b/xxx`) deve retornar **404**

### 2.2 Cliente final — IA Visagismo (~5 min)

> Requer `GROQ_API_KEY` ativa (já configurada no `.env` real). Custa fração de centavo por análise.

- [ ] Abrir `http://localhost:3001/b/studio-zeus/visagismo` em aba anônima
- [ ] Aceitar consentimento LGPD
- [ ] Fazer upload de uma foto de rosto frontal (>=256px, <5MB, JPG/PNG/WebP)
- [ ] Ver chat polling — bolha "analisando..." aparece e atualiza
- [ ] Aguardar análise — `faceShape` + 2-3 sugestões justificadas
- [ ] **Opt-in:** clicar em uma sugestão para gerar imagem (custa ~4 centavos)
- [ ] Aguardar `status:generated`, ver imagem
- [ ] Voltar pra storefront e seguir pra agendar com um barbeiro

#### Edge cases visagismo

- [ ] Subir foto < 256px ou > 5MB → erro claro
- [ ] Subir foto não-rosto (paisagem) → análise sinaliza ou erro
- [ ] Fechar e reabrir a página — o `viewToken` está em memória, não persiste (é o esperado)
- [ ] Repetir > 3 uploads em 1 min → throttle 429

### 2.3 Barbeiro — admin do tenant trialing (~15 min)

Login com **leo@kairobarber.dev / Senha123!** (Tenant A — Barbearia do Leo).

#### Perfil & horários
- [ ] Após login, ir pra `/admin/perfil` — ver dados do tenant (nome, bio, endereço, telefone, avatar placeholder)
- [ ] Editar bio, salvar — deve persistir após refresh
- [ ] Ir pra `/admin/horarios` — UI deve mostrar grid Dom–Sáb com seg-sex 9-19, sáb 9-17, dom fechado
- [ ] Alterar dom para aberto 10-14, salvar — recarregar e validar

#### Barbeiros
- [ ] `/admin/barbeiros` — lista mostra Leo (você), Marcos, Davi
- [ ] Criar novo barbeiro com email novo (`teste-barber@example.com`) — deve mostrar mensagem "convite enviado" + (em dev console mode) token aparece nos logs do backend
- [ ] Abrir o link `/convite/{token}` em aba anônima, completar cadastro com senha
- [ ] Confirmar que o novo barbeiro aparece na lista como "ativo"
- [ ] Adicionar uma folga (time-off) pra um barbeiro existente
- [ ] Voltar pra storefront e verificar que slots na folga não aparecem mais

#### Serviços
- [ ] `/admin/servicos` — 5 serviços listados
- [ ] Criar serviço novo "Acabamento" (15 min, R$ 25)
- [ ] Atribuir só Davi a esse serviço
- [ ] Editar "Corte simples" — alterar preço pra R$ 50
- [ ] Desativar "Sobrancelha" — ver que some da storefront pública
- [ ] Deletar "Pezinho" (soft delete)

#### Fotos
- [ ] `/admin/fotos` — vazio inicialmente (seed não popula fotos)
- [ ] Upload de uma foto local (presigned R2) — confirma que aparece na grid e na storefront pública
- [ ] Deletar foto

#### Agenda
- [ ] `/admin/agenda` — ver appointments do seed (hoje deve ter 3, passados/futuros listados conforme filtro)
- [ ] Trocar filtro por barbeiro/status
- [ ] Confirmar um appointment `pending`
- [ ] Completar um `confirmed` que tá no passado
- [ ] Marcar `no_show` em um `confirmed`
- [ ] Cancelar um `pending` com motivo
- [ ] Criar walk-in manual (passo 3 vai pular wizard)
- [ ] Remarcar um pending pra outro horário
- [ ] Tentar criar dois agendamentos no mesmo slot/barbeiro → erro `APPOINTMENT_SLOT_TAKEN`

#### Clientes
- [ ] `/admin/clientes` — listar os 6 customers do seed
- [ ] Buscar por nome ("Carlos") — filtra
- [ ] Clicar em um — ver detalhes + histórico de appointments

#### Onboarding (caso queira testar do zero)
- [ ] Deslogar, abrir `/registrar` em aba anônima
- [ ] Cadastrar novo owner com slug livre (ex.: `teste-novo`)
- [ ] Backend deve criar User + Tenant + Subscription(trialing) na mesma transação
- [ ] Logar e navegar — admin vazio, storefront `/b/teste-novo` funciona

### 2.4 Barbeiro — gating em `/admin` (~5 min)

Login com **zeze@kairobarber.dev / Senha123!** (Tenant C — past_due).

- [ ] Após login, ao tentar acessar `/admin/perfil`, deve **redirecionar pra `/admin/billing`** com banner global "Assinatura vencida"
- [ ] Tentar acessar `/admin/barbeiros` direto na URL → mesma redireção
- [ ] `/admin/billing` é a única rota permitida → renderiza CTA "Renovar agora"
- [ ] Clicar "Renovar" → (em modo console) redirect para `/admin/billing/return?ok=1&preapproval_id=...`
- [ ] Após retorno, front chama `POST /admin/billing/sync` automaticamente
- [ ] Para forçar `active` no console mode: rodar no `psql` ou Prisma Studio
  ```sql
  UPDATE "Subscription" SET status='active', "currentPeriodEnd"=NOW()+INTERVAL '30 days', "lastSyncedAt"=NOW() WHERE "tenantId"=(SELECT id FROM "Tenant" WHERE slug='cortes-do-zeze');
  ```
- [ ] Refresh — banner some, `/admin/perfil` etc voltam a abrir

### 2.5 Barbeiro — cancelamento da própria assinatura (~3 min)

Login com **zeus@kairobarber.dev / Senha123!** (Tenant B — active).

- [ ] Ir em `/admin/billing` — ver status "Ativa", `currentPeriodEnd`, lista de invoices (em console mode pode estar vazia)
- [ ] Clicar "Cancelar assinatura" — modal de confirmação
- [ ] Confirmar — status muda pra `cancelled` no DB
- [ ] Tentar acessar `/admin/perfil` → 402 + redireção pra `/admin/billing`
- [ ] Storefront pública `/b/studio-zeus` agora deve retornar **404**
- [ ] Pra "destruir" o teste e reseedar, rodar `SEED_RESET=true pnpm prisma:seed` na API

### 2.6 SaaS Owner — dashboard global (~10 min)

Login com **gustavoocontact@gmail.com / 83441983gG!** (saas owner do `.env`).
O `LoginForm` detecta `role === 'saas_owner'` e redireciona automaticamente
pra `/saas`.

- [ ] `/saas` — métricas: MRR, ARR, tenants ativos, churn 30d, conversão trial→paid + chart
  - Esperado: MRR/ARR refletem o tenant `active` (R$ 49,90 → MRR 4990, ARR 59880)
  - Tenants ativos: 2 (active + trialing são contados como "saudáveis")
- [ ] `/saas/tenants` — listagem com 4 tenants
- [ ] Filtrar por `status=trialing` → só Tenant A
- [ ] Filtrar por `suspended=true` → só Tenant D
- [ ] Clicar em Tenant A → `/saas/tenants/[id]` (detalhe)
- [ ] No Tenant A, clicar "Suspender" (server action) → confirmar
- [ ] Verificar que storefront `/b/barbearia-do-leo` agora retorna 404
- [ ] Reativar (botão "Reativar") — storefront volta a abrir
- [ ] `/saas/ai-usage` — ver consumo do Studio Zeus (4 consultations no seed, custos somados)
- [ ] `/saas/audit-log` — ver os audits do seed (3 `tenant.viewed`) + audits gerados durante o teste (suspend/unsuspend, subscription.cancelled). Filtrar por `action` e `from/to`
- [ ] `/saas/usuarios` — lista todos os users (saas_owner + 4 owners + barbers convidados se houver), filtrar por role
- [ ] Logout → próximo `/saas` deve redirecionar pra `/login`
- [ ] Logar como Leo (tenant_owner) → tentar abrir `/saas` direto → deve redirecionar (guard `requireRole('saas_owner')`)

---

## 3. Cenários transversais críticos

### 3.1 Multi-tenant isolation

Conta vivendo nesse risco. Sempre testar:

- [ ] Logado como Leo (Tenant A), tentar acessar appointment ID de outro tenant via URL/cURL → 404 (não 403, pra não vazar existência)
- [ ] Buscar service ID de outro tenant via `GET /admin/services/{id}` → 404
- [ ] Listar `/admin/customers?search=Roberto` (cliente do Zeus) sendo Leo → vazio

### 3.2 Cookies HttpOnly + refresh transparente

- [ ] DevTools → Application → Cookies: deve haver `kb_access` e `kb_refresh` httponly, secure (em prod), samesite=lax
- [ ] **Não deve haver** token em localStorage/sessionStorage
- [ ] Esperar 15min (TTL do access) ou forçar invalidação via DevTools → próximo request deve disparar refresh automático invisível (network: 401 seguido de retry 200)
- [ ] Logout limpa ambos os cookies

### 3.3 Email externo (best-effort)

Em dev com `EMAIL_PROVIDER=resend` e API key configurada:

- [ ] Cadastrar novo owner com email real → recebe verify-email
- [ ] Disparar `/auth/forgot-password` com email real → recebe link
- [ ] Booking com customer.email → recebe confirmação + magic links

Se quiser dev sem custo: trocar `EMAIL_PROVIDER=console` no `.env` — emails saem no stdout do backend.

### 3.4 LGPD / retenção IA

- [ ] Ver `aiConsultation.expiresAt` na seed (7 dias no futuro)
- [ ] Forçar cleanup: rodar manualmente o job (via `/admin` debug endpoint, ou avançar `Date` no DB)
- [ ] Após cleanup, `inputPhotoR2Key`/`outputPhotoR2Key` removidos, registro marcado `expired`

---

## 4. Reset rápido entre rodadas

Se durante o teste você sujou demais o DB e quer recomeçar:

```bash
cd kairobarber-api
SEED_RESET=true pnpm prisma:seed
```

O reset apaga **todos** os dados (User, Tenant, Subscription, etc) e recria do
zero. Bloqueado em produção sem `ALLOW_PROD_SEED=true`.

Pra resetar **só um tenant** sem afetar outros, use Prisma Studio
(`pnpm prisma:studio`) e delete manualmente — o cascade limpa filhos.

---

## 5. Acceptance final

A aplicação está OK pra integrar com os endpoints do backend se:

- ✅ Cliente final consegue agendar end-to-end na Barbearia do Leo OU Studio Zeus
- ✅ Magic link de cancelamento funciona (janela > 2h)
- ✅ Barbeiro consegue confirmar/completar/cancelar/no-show appointments
- ✅ Storefront vira 404 para tenants `past_due`, `cancelled` ou `suspended`
- ✅ `/admin/*` (exceto billing) bloqueia com 402 quando subscription não está saudável
- ✅ Login persiste via cookies httponly e refresh transparente funciona
- ✅ Isolation: usuário de um tenant não vê dados de outro
- ✅ SaaS dashboard mostra métricas coerentes (mesmo que via cURL)

Falhas em qualquer item acima são **bloqueantes** — abra issue ou retoma a fase.
