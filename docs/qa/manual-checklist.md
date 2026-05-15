# Manual QA Checklist

**Só está aqui o que automação NÃO consegue cobrir.** Tudo que é determinístico de backend está em [test-plan.md](./test-plan.md) ou no script `scripts/qa-smoke.sh`.

Rode esta lista antes de:
- Deploy de mudança que toca: IA visagism, emails, billing, storage, ou cron.
- Release de fase nova.
- Quando alguém suspeita que algo "parece funcionar mas tá estranho".

Tempo total: ~30-45 min se já tiver dados de teste prontos.

---

## 1. AI Visagism (qualidade da inferência) {#ai-visagism}

Backend valida que o pipeline funciona (upload → análise → resposta). Só humano valida se a **resposta faz sentido**.

| Cenário | Como executar | Esperado |
|---------|---------------|----------|
| **Rosto real, formato oval** | Fazer upload de foto frontal nítida de um rosto adulto, oval. Esperar `status:completed`. Ler `analysisJson.faceShape`. | `faceShape` deve ser `oval` (ou próximo). Sugestões coerentes com formato oval (não devem dizer "evite cortes que alongam"). |
| **Rosto redondo / quadrado / longo** | 3 fotos distintas, mesma rotina. | Cada análise identifica o formato corretamente. Sugestões diferentes entre formatos. |
| **Sugestões de corte** | Ler `suggestions[]` em 5 análises distintas. | Cada sugestão tem nome de corte, justificativa, e adequação ao formato. Sem texto repetido, sem alucinação ("corte invisível"). |
| **Imagem gerada (opt-in)** | Após análise OK, requisitar geração. Aguardar `hasGeneratedImage:true`. Visualizar pelo `generatedImageUrl`. | Imagem lembra o rosto original (não é outra pessoa). Corte sugerido é visualmente aplicado. Sem artefatos grotescos (olhos extras, mãos retorcidas). |
| **Não-rosto: objeto** | Upload de foto de paisagem ou objeto. | Erro claro tipo `NO_FACE_DETECTED` (ou análise indicando inválido). NUNCA processar e dar resposta absurda. |
| **Não-rosto: múltiplos rostos** | Foto de grupo. | Decidir formato definido: rejeitar OU usar rosto central com aviso. |
| **Foto borrada / escura** | Foto propositalmente fora de foco. | Erro/aviso de qualidade insuficiente, OU análise com `confidence` baixa indicada. |
| **Tempo total percebido** | Cronometrar do POST até `status:completed`. | <30s em dev. <60s em prod sob carga normal. |
| **Cota de tenant esgotada (UX)** | Forçar 100 análises (ou setar `aiQuotaUsedThisMonth=100` no banco) e tentar mais uma. | 429 com mensagem clara em PT-BR; storefront mostra o limite, não exception genérica. |

**Critério de aceite**: 8 de 9 cenários OK. Falhas em "não-rosto" ou "imagem gerada não lembra o rosto" são bloqueantes.

---

## 2. Emails reais (Resend) {#emails}

Em dev, `EMAIL_PROVIDER=console` joga texto no stdout. Em staging/prod com Resend de verdade, é preciso olhar a caixa.

| Cenário | Como | Esperado |
|---------|------|----------|
| **Confirmação de agendamento** | Booking público com `customer.email` válido. Abrir o email. | Renderiza em Gmail/Outlook/Apple Mail. Nome do cliente, barbearia, barbeiro, serviço, data/hora local, preço BR (R$ X,XX) corretos. Link "cancelar" abre a página certa. Link "criar conta" idem. |
| **Anti-spam** | Mesmo email. Olhar headers SPF/DKIM/DMARC. Conferir se cai em Caixa de entrada (não Promoções/Spam) em Gmail. | Tudo PASS. Cai em inbox. |
| **Customer claim (magic link)** | Primeiro booking de um phone novo → claim email. | Link válido por janela X (verificar TTL no domain). Conta criada após reset de senha. |
| **Reset de password** | `POST /auth/forgot-password`. Abrir email. | Link reset funciona. TTL respeitado. |
| **Email para inválido** | Forçar `customer.email` inválido sintaticamente. | Booking ainda criado (`emailDelivered:false`), nenhum log de pânico no servidor. |
| **Provider caído (Resend down)** | Setar API key inválida temporariamente OU bloquear DNS no host. | Booking ainda 201 com `emailDelivered:false`. NÃO derruba o request (regressão coberta pelo commit 78dda83). |

---

## 3. Mercado Pago (sandbox real) {#mercadopago}

`ConsoleBillingProvider` em dev resolve 95%. Os 5% restantes só se vê com sandbox real.

| Cenário | Como | Esperado |
|---------|------|----------|
| **Checkout link abre** | `POST /admin/billing/checkout`. Abrir `checkoutUrl` no navegador. | Página do MP carrega com nome da barbearia, valor correto, opções de pagamento. |
| **Pagamento aprovado (cartão de teste)** | Usar cartão de teste MP (4509 9535 6623 3704, CVV 123, qualquer validade futura). | Sucesso na tela do MP. |
| **Sync pega o pagamento** | `POST /admin/billing/sync` após o pagamento. | `GET /admin/billing/subscription` → `status:"active"`. Geralmente leva 1-2 min após o pagamento. |
| **Pagamento recusado** | Cartão de teste com falha (4000 0000 0000 0002). | Tela de erro no MP. Após sync, status segue `trialing`/`past_due`. |
| **Cancel** | `POST /admin/billing/cancel` com subscription ativa. | Próximo período termina. `currentPeriodEnd` permanece. Após o fim, transita pra `cancelled`. |
| **Trial → past_due → cancelled real** | Em ambiente staging, esperar trial expirar (mover data se necessário) e cron rodar. | Audit log registra transições corretamente. Email opcional disparado, se houver. |

---

## 4. Storage R2 (presigned PUT do navegador) {#r2-upload}

Backend gera presigned URL — E2E só testa isso. **Só com navegador real você sabe se o R2 aceita.**

| Cenário | Como | Esperado |
|---------|------|----------|
| **Upload de JPEG via presigned PUT** | Pegar `uploadUrl` de `POST /admin/photos/upload-url`. Fazer `fetch(url, {method:'PUT', body: file})` no DevTools do navegador. | 200/204 do R2. |
| **Foto aparece em storefront** | `POST /admin/photos` confirmando, depois `GET /public/:slug/photos`. | Lista contém a foto. URL é acessível (clicar abre a imagem). |
| **CORS do R2** | Mesmo teste mas do navegador hospedado em domínio que será usado em prod. | Sem erro de CORS. Se der, ajustar regra do bucket. |
| **Content-type errado entre presigned e PUT** | Pedir presigned com `image/jpeg`, fazer PUT com header `image/png`. | R2 rejeita ou aceita conforme política. Confirmar comportamento esperado. |
| **Lifecycle de cleanup AI** | Verificar que regra "delete tenants/*/ai-visagism/* older than 30 days" está ativa no bucket. | Regra existe (rede de segurança ao cron). |

---

## 5. Crons em produção (Railway) {#crons}

Crons funcionam no E2E (rodando manualmente), mas em prod precisa confirmar que o **scheduler dispara**.

| Cron | Schedule (UTC) | Como confirmar em prod |
|------|----------------|------------------------|
| `billing-sync` | `0 6,18 * * *` | Logs do Railway mostram execução. Audit log tem entrada nova após o horário. |
| `trial-check` | `15 6 * * *` | Logs do Railway. Tenant com trial expirado realmente transita. |
| `ai-photo-cleanup` | (verificar valor) | Logs. Row antiga (>7 dias) marcada como cleaned. Foto sumiu do R2. |

**Pegada**: timezone do Railway. Confirmar que o cron expression UTC corresponde ao horário pretendido em SP.

---

## 6. UX & mensagens de erro {#ux}

Backend retorna `code` + `message`. Front renderiza. Validar a experiência.

| Cenário | Como | Esperado |
|---------|------|----------|
| **Mensagens em PT-BR** | Forçar 5 erros distintos via UI (login errado, slot ocupado, cota AI esgotada, password fraca, sem subscription). | Todas em PT-BR claro, sem stack/exception leaking. |
| **Formatação de preço** | Catálogo público mostra R$ X,XX (vírgula, não ponto). | OK. |
| **Formatação de telefone** | Booking aceita +55 11 99999-9999, 11999999999, e variações. | Tudo normalizado para E.164 internamente. |
| **Formatação de data/hora** | Confirmação de booking, lista admin. | Timezone do tenant respeitado. America/Sao_Paulo, não UTC. |
| **Acessibilidade básica** | Storefront com leitor de tela (NVDA/VoiceOver) em 1 fluxo: listar serviços → escolher horário → preencher form. | Tudo navegável. Labels presentes. |
| **Mobile** | Storefront em iPhone SE (375px) e Android Pixel (412px). | Layout não quebra. Botões clicáveis. |

---

## 7. Performance percebida {#perf}

| Cenário | Como medir | Esperado |
|---------|------------|----------|
| **Storefront pública (1ª request)** | Lighthouse contra `/public/:slug`. | LCP <2.5s, TTFB <500ms. |
| **Availability em janela 7d** | `time curl ...` | <800ms p95. |
| **Booking público** | `time curl ...` | <1.2s p95 (inclui email best-effort). |
| **Listagem admin /appointments (mês cheio)** | `time curl ...` | <600ms p95. |

Se algo está consistentemente acima, **abrir issue** — não é falha de QA, é regressão de performance.

---

## 8. Segurança operacional {#sec-ops}

| Verificação | Como | Esperado |
|-------------|------|----------|
| **Logs não vazam tokens** | `grep -iE 'Bearer [A-Za-z0-9._-]{20,}\|refreshToken=' logs/` | Zero hits. Tokens redacted. |
| **CORS** | `curl -i -H "Origin: https://evil.com" $API/admin/tenant` | Não retorna `Access-Control-Allow-Origin: *` em rotas admin. |
| **Headers de segurança** | `curl -I $API/health/live` | `X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security` (em HTTPS). |
| **Stack trace não vaza em prod** | Forçar erro 500 conhecido em staging. | Body do response não contém arquivo/linha. |

---

## Template de execução

Cole isto no PR / changelog ao fechar uma release:

```
QA Manual — release X.Y.Z
Data: ____  Executor: ____

[ ] AI Visagism: __/9 cenários OK
[ ] Emails reais: __/6 cenários OK
[ ] Mercado Pago sandbox: __/6 cenários OK
[ ] R2 upload navegador: __/5 cenários OK
[ ] Crons prod (Railway): __/3 confirmados
[ ] UX & i18n: __/6 cenários OK
[ ] Performance: dentro do esperado
[ ] Segurança operacional: __/4 verificações OK

Bloqueantes encontrados: ___
Notas: ___
```
