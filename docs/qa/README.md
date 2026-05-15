# QA — KairoBarber

Este diretório concentra a estratégia de qualidade do backend KairoBarber.

## Documentos

| Arquivo | Propósito | Quem usa |
|---------|-----------|----------|
| [test-plan.md](./test-plan.md) | Plano de teste completo, por módulo e fluxo. Referência canônica do que precisa ser testado. | Devs e QA |
| [automation-coverage.md](./automation-coverage.md) | Mapa "feature → spec E2E → casos cobertos → gaps". Atualizar quando spec for adicionado/removido. | Devs |
| [manual-checklist.md](./manual-checklist.md) | Checklist enxuto do que automação NÃO consegue cobrir (qualidade da IA, conteúdo real de email, Mercado Pago sandbox, R2 do navegador, UX). Rodar antes de releases relevantes. | QA / dev de plantão |
| `../../scripts/qa-smoke.sh` | Smoke contra **API rodando** (não E2E com mock). Cobre auth → tenant → catálogo → storefront → booking → admin → multi-tenant → billing. Cores no terminal, exit code 1 em falha. | Devs no dia-a-dia |

## Estratégia em uma frase

> Tudo que pode ser automatizado roda no `pnpm test:e2e`. O `manual-checklist.md` cobre só o que exige percepção humana ou integração externa real.

## Como decidir onde escrever um teste

```
É comportamento determinístico de backend?
  └─ sim → spec em test/e2e/*.e2e-spec.ts (jest + supertest + testcontainers)

Depende de provedor externo real (Resend, Mercado Pago, OpenAI, R2)?
  └─ no e2e: usar provider "console" (mock interno).
  └─ no manual-checklist: validar com sandbox/prod real.

Envolve julgamento humano (qualidade de imagem/texto da IA, UX, layout de email)?
  └─ manual-checklist.md
```

## Comandos

```bash
pnpm test          # unitários
pnpm test:e2e      # E2E (sobe Postgres + Redis via testcontainers, mocka providers externos)
pnpm test:cov      # cobertura
pnpm qa:smoke      # bate na API real em http://localhost:3000 (precisa do servidor up)
```

### Quando usar cada um

- **`pnpm test:e2e`**: parte do CI. Cada spec sobe seu container (~30-60s/spec). Cobre fluxos com providers mockados.
- **`pnpm qa:smoke`**: rápido (segundos) contra API rodando. Confirma que o sistema vivo responde ao que o cliente vai chamar. Bom pra:
  - Antes de commitar mudança que pode quebrar contrato
  - Validar deploy em staging: `API=https://stg.example.com pnpm qa:smoke`
  - Sanity check após `pnpm start:dev`

### Pré-requisitos do `qa:smoke`

```bash
sudo apt install -y jq curl     # WSL/Linux
# brew install jq curl          # mac
```

```bash
# Em um terminal:
pnpm start:dev

# Em outro:
pnpm qa:smoke                              # roda tudo
pnpm qa:smoke -- auth booking              # só suites listadas
pnpm qa:smoke -- -v                        # verbose (mostra body inteiro nas falhas)
API=https://stg.example.com pnpm qa:smoke  # contra staging
QA_TEST_CHECKOUT=1 pnpm qa:smoke           # força teste de checkout mesmo com BILLING_PROVIDER=mercadopago
```

### Pegadinhas conhecidas

- **Checkout Mercado Pago**: se o servidor tem `BILLING_PROVIDER=mercadopago` no `.env`, o teste `BIL-02` é pulado automaticamente quando o MP retorna 5xx (pra não criar checkouts em prod). Use `BILLING_PROVIDER=console` em dev — é o default do `.env.example`.
- **Race condition (`BOOK-03`)**: usa o último slot disponível pra evitar conflito com bookings anteriores. Se a janela de availability estiver muito apertada, pode falhar — abrir mais slots em `business-hours`.
- **Sufixo único por run**: cada execução cria `bb-<RUN_ID>` como slug. Pode rodar várias vezes sem limpar DB. Se quiser limpar, drop e recria o banco.
