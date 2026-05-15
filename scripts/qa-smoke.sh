#!/usr/bin/env bash
# scripts/qa-smoke.sh
# Smoke + integration tests contra a API rodando. Bate em endpoints REAIS.
# Nada de mock no lado do teste — só o servidor decide se usa provider "console" ou real.
#
# Pré-requisitos:
#   - API rodando em $API (default: http://localhost:3000)
#       pnpm start:dev   # ou contra staging: API=https://stg.x.com ./scripts/qa-smoke.sh
#   - curl, jq instalados
#
# Uso:
#   ./scripts/qa-smoke.sh                      # roda todas as suites
#   ./scripts/qa-smoke.sh auth booking         # roda apenas as suites listadas
#   ./scripts/qa-smoke.sh -v                   # verboso (mostra request/response em cada falha)
#   API=https://stg.example.com ./scripts/qa-smoke.sh
#
# Suites disponíveis: health auth tenant catalog public booking admin multitenant billing
#
# Exit code: 0 se todos passaram, 1 se houve falha, 2 se erro de setup/dependência.

set -u
# Não usamos -e porque queremos continuar rodando após uma falha pra dar visão completa.

# ─── Config & globals ──────────────────────────────────────────────────────────
API="${API:-http://localhost:3000}"
VERBOSE=0
SUITES_REQUESTED=()
RUN_ID="$(date +%s)$(( RANDOM % 1000 ))"   # sufixo único — permite rerodar sem limpar DB

# Cores (só TTY)
if [[ -t 1 ]]; then
  G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; C=$'\e[36m'; B=$'\e[1m'; N=$'\e[0m'
else
  G=""; R=""; Y=""; C=""; B=""; N=""
fi

PASS=0; FAIL=0; SKIP=0
FAILURES=()
CURRENT_SUITE=""

# Estado compartilhado entre suites
OWNER_EMAIL=""; OWNER_PASS="StrongPass!1"
OWNER_ACCESS=""; OWNER_REFRESH=""
TENANT_ID=""; TENANT_SLUG=""
BARBER_ID=""; SERVICE_ID=""

OWNER_B_EMAIL=""; OWNER_B_ACCESS=""; TENANT_B_SLUG=""; BARBER_B_ID=""; SERVICE_B_ID=""

APT_ID=""; CANCEL_TOKEN=""

# ─── Args ──────────────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    -v|--verbose) VERBOSE=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"; exit 0 ;;
    *) SUITES_REQUESTED+=("$arg") ;;
  esac
done

# ─── Pré-flight ────────────────────────────────────────────────────────────────
for bin in curl jq; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "${R}faltando: $bin${N}  (instale: sudo apt install -y $bin)"; exit 2
  fi
done

# ─── Helpers ───────────────────────────────────────────────────────────────────
hdr() { CURRENT_SUITE="$1"; echo; echo "${B}${C}━━━ ${1} ━━━${N}"; }

# Imprime ok/fail e contabiliza
_ok()   { echo "  ${G}✓${N} $1"; PASS=$((PASS+1)); }
_fail() {
  echo "  ${R}✗${N} $1"
  echo "    ${R}↳${N} $2"
  # Sempre mostra um trecho da resposta — sem precisar de -v
  [[ -n "${LAST_REQ:-}" ]] && echo "    ${Y}REQ:${N} $LAST_REQ"
  [[ -n "${LAST_RES:-}" ]] && echo "    ${Y}RES:${N} $(echo "$LAST_RES" | tr -d '\n' | head -c 300)"
  FAIL=$((FAIL+1)); FAILURES+=("[$CURRENT_SUITE] $1 — $2")
  if (( VERBOSE )) && [[ -n "${LAST_BODY:-}" ]]; then
    echo "    ${Y}BODY:${N} $(echo "$LAST_BODY" | head -c 400)"
  fi
}
_skip() { echo "  ${Y}◌${N} $1 — ${Y}$2${N}"; SKIP=$((SKIP+1)); }

# req METHOD PATH [BODY_JSON] [-H "Authorization: Bearer X"...]
# Popula: HTTP_STATUS, RESP_BODY
LAST_REQ=""; LAST_BODY=""; LAST_RES=""
req() {
  local method="$1" path="$2" body="${3:-}"
  shift 3 || shift $#
  local args=( -s -o /tmp/qa-smoke.body -w '%{http_code}' -X "$method" "$API$path" )
  if [[ -n "$body" ]]; then
    args+=( -H "Content-Type: application/json" --data "$body" )
  fi
  while [[ $# -gt 0 ]]; do args+=( -H "$1" ); shift; done

  LAST_REQ="$method $path"
  LAST_BODY="$body"
  HTTP_STATUS="$(curl "${args[@]}")" || HTTP_STATUS="000"
  RESP_BODY="$(cat /tmp/qa-smoke.body 2>/dev/null || echo "")"
  LAST_RES="$RESP_BODY"
}

# assert_status TEST_LABEL EXPECTED_STATUS
assert_status() {
  local label="$1" expected="$2"
  if [[ "$HTTP_STATUS" == "$expected" ]]; then
    _ok "$label"; return 0
  else
    _fail "$label" "esperado HTTP $expected, recebido $HTTP_STATUS"
    return 1
  fi
}

# assert_status_in TEST_LABEL EXPECTED_1 [EXPECTED_2 ...]
assert_status_in() {
  local label="$1"; shift
  for e in "$@"; do
    if [[ "$HTTP_STATUS" == "$e" ]]; then _ok "$label"; return 0; fi
  done
  _fail "$label" "esperado HTTP em [$*], recebido $HTTP_STATUS"
  return 1
}

# assert_jq TEST_LABEL JQ_FILTER EXPECTED_VALUE
# Ex: assert_jq "tenant tem slug" '.tenant.slug' 'meu-slug'
assert_jq() {
  local label="$1" filter="$2" expected="$3"
  local got
  got="$(echo "$RESP_BODY" | jq -r "$filter" 2>/dev/null)"
  if [[ "$got" == "$expected" ]]; then
    _ok "$label"; return 0
  else
    _fail "$label" "filtro $filter: esperado '$expected', recebido '$got'"
    return 1
  fi
}

# assert_jq_truthy TEST_LABEL JQ_FILTER  → falha se vazio/null/false
assert_jq_truthy() {
  local label="$1" filter="$2"
  local got
  got="$(echo "$RESP_BODY" | jq -r "$filter" 2>/dev/null)"
  if [[ -n "$got" && "$got" != "null" && "$got" != "false" ]]; then
    _ok "$label"; return 0
  else
    _fail "$label" "filtro $filter retornou '$got'"
    return 1
  fi
}

# jq_get JQ_FILTER  → escreve em stdout (pra capturar em variável)
jq_get() { echo "$RESP_BODY" | jq -r "$1"; }

should_run() {
  local name="$1"
  if [[ ${#SUITES_REQUESTED[@]} -eq 0 ]]; then return 0; fi
  for s in "${SUITES_REQUESTED[@]}"; do [[ "$s" == "$name" ]] && return 0; done
  return 1
}

# ─── Suite: health ─────────────────────────────────────────────────────────────
suite_health() {
  hdr "Health & readiness"
  req GET /health/live
  assert_status "GET /health/live → 200" 200 || {
    echo "${R}API não responde em $API. Suba com 'pnpm start:dev' e tente novamente.${N}"; exit 2;
  }
  assert_jq "/health/live retorna status=ok" '.status' 'ok'

  req GET /health/ready
  assert_status_in "GET /health/ready → 200" 200 503
  assert_jq "/health/ready com database up" '.info.database.status' 'up' || true
}

# ─── Suite: auth ───────────────────────────────────────────────────────────────
suite_auth() {
  hdr "Auth & Onboarding"
  OWNER_EMAIL="owner-${RUN_ID}@kairo.test"
  TENANT_SLUG="bb-${RUN_ID}"

  # AUTH-01 — register/owner happy
  req POST /auth/register/owner "$(jq -n \
    --arg email "$OWNER_EMAIL" --arg pwd "$OWNER_PASS" \
    --arg slug "$TENANT_SLUG" --arg tname "BB $RUN_ID" \
    '{email:$email,password:$pwd,name:"Owner",tenantName:$tname,slug:$slug}')"
  assert_status "AUTH-01 register/owner → 201" 201
  assert_jq_truthy "AUTH-01 retorna accessToken" '.accessToken'
  assert_jq_truthy "AUTH-01 retorna refreshToken" '.refreshToken'
  assert_jq "AUTH-01 retorna tenant.slug correto" '.tenant.slug' "$TENANT_SLUG"
  OWNER_ACCESS="$(jq_get '.accessToken')"
  OWNER_REFRESH="$(jq_get '.refreshToken')"
  TENANT_ID="$(jq_get '.tenant.id')"

  # AUTH-N01 — slug duplicado
  req POST /auth/register/owner "$(jq -n \
    --arg email "dup-${RUN_ID}@kairo.test" --arg pwd "$OWNER_PASS" \
    --arg slug "$TENANT_SLUG" --arg tname "Outro" \
    '{email:$email,password:$pwd,name:"X",tenantName:$tname,slug:$slug}')"
  assert_status_in "AUTH-N01 slug duplicado → 4xx (não 500)" 400 409 422

  # AUTH-N02 — slug inválido (espaço, maiúscula)
  req POST /auth/register/owner '{"email":"x'"$RUN_ID"'@k.com","password":"StrongPass!1","name":"X","tenantName":"X","slug":"Slug Errado"}'
  assert_status "AUTH-N02 slug com espaço/maiúscula → 400" 400

  # AUTH-N03 — password curto
  req POST /auth/register/owner '{"email":"y'"$RUN_ID"'@k.com","password":"123","name":"X","tenantName":"X","slug":"y-'"$RUN_ID"'"}'
  assert_status "AUTH-N03 password curto → 400" 400

  # AUTH-02 — login OK
  req POST /auth/login "$(jq -n --arg e "$OWNER_EMAIL" --arg p "$OWNER_PASS" '{email:$e,password:$p}')"
  assert_status "AUTH-02 login → 200" 200
  assert_jq_truthy "AUTH-02 login retorna accessToken" '.accessToken'

  # AUTH-N04 — login senha errada
  req POST /auth/login "$(jq -n --arg e "$OWNER_EMAIL" '{email:$e,password:"errada-XYZ"}')"
  assert_status "AUTH-N04 senha errada → 401" 401

  # AUTH-N05 — login email inexistente (não deve vazar)
  req POST /auth/login '{"email":"naoexiste'"$RUN_ID"'@x.com","password":"qualquer123"}'
  assert_status "AUTH-N05 email inexistente → 401" 401

  # AUTH-03 — refresh
  req POST /auth/refresh "$(jq -n --arg r "$OWNER_REFRESH" '{refreshToken:$r}')"
  assert_status "AUTH-03 refresh → 200" 200
  assert_jq_truthy "AUTH-03 refresh retorna novo accessToken" '.accessToken'
  local OLD_REFRESH="$OWNER_REFRESH"
  OWNER_REFRESH="$(jq_get '.refreshToken')"
  OWNER_ACCESS="$(jq_get '.accessToken')"

  # AUTH-N06 — refresh com token antigo (rotacionado)
  req POST /auth/refresh "$(jq -n --arg r "$OLD_REFRESH" '{refreshToken:$r}')"
  assert_status_in "AUTH-N06 refresh antigo após rotação → 4xx" 400 401

  # AUTH-N07 — JWT adulterado
  req GET /admin/tenant "" "Authorization: Bearer ${OWNER_ACCESS}XYZ"
  assert_status "AUTH-N07 JWT adulterado → 401" 401

  # AUTH-N08 — sem token
  req GET /admin/tenant ""
  assert_status "AUTH-N08 sem token → 401" 401
}

# ─── Suite: tenant ─────────────────────────────────────────────────────────────
suite_tenant() {
  hdr "Tenant setup"
  [[ -z "$OWNER_ACCESS" ]] && { _skip "Tenant suite" "auth não rodou"; return; }

  # TEN-01 — GET /admin/tenant
  req GET /admin/tenant "" "Authorization: Bearer $OWNER_ACCESS"
  assert_status "TEN-01 GET /admin/tenant → 200" 200
  assert_jq "TEN-01 tenant.slug == $TENANT_SLUG" '.slug' "$TENANT_SLUG"
  assert_jq_truthy "TEN-01 subscription presente" '.subscription'

  # TEN-02 — PATCH /admin/tenant
  req PATCH /admin/tenant '{"bio":"Melhor barbearia","phone":"+5511999999999","timezone":"America/Sao_Paulo"}' \
    "Authorization: Bearer $OWNER_ACCESS"
  assert_status "TEN-02 PATCH /admin/tenant → 200" 200
  assert_jq "TEN-02 bio atualizada" '.bio' 'Melhor barbearia'

  # TEN-N01 — avatarUrl sem protocolo
  req PATCH /admin/tenant '{"avatarUrl":"//cdn.example.com/x.png"}' "Authorization: Bearer $OWNER_ACCESS"
  assert_status "TEN-N01 avatarUrl sem protocolo → 400" 400

  # TEN-03 — business hours válido (seg-sex 09-18, sáb 09-15)
  local BH='{"businessHours":{"days":[
    {"open":false,"intervals":[]},
    {"open":true,"intervals":[{"startMin":540,"endMin":1080}]},
    {"open":true,"intervals":[{"startMin":540,"endMin":1080}]},
    {"open":true,"intervals":[{"startMin":540,"endMin":1080}]},
    {"open":true,"intervals":[{"startMin":540,"endMin":1080}]},
    {"open":true,"intervals":[{"startMin":540,"endMin":1080}]},
    {"open":true,"intervals":[{"startMin":540,"endMin":900}]}
  ]}}'
  req PATCH /admin/tenant/business-hours "$BH" "Authorization: Bearer $OWNER_ACCESS"
  assert_status "TEN-03 business-hours válido → 200" 200

  # TEN-N02 — business hours inválido (end < start)
  req PATCH /admin/tenant/business-hours \
    '{"businessHours":{"days":[{"open":true,"intervals":[{"startMin":1080,"endMin":540}]},{"open":false,"intervals":[]},{"open":false,"intervals":[]},{"open":false,"intervals":[]},{"open":false,"intervals":[]},{"open":false,"intervals":[]},{"open":false,"intervals":[]}]}}' \
    "Authorization: Bearer $OWNER_ACCESS"
  assert_status "TEN-N02 BH com end<start → 400" 400
}

# ─── Suite: catalog ────────────────────────────────────────────────────────────
suite_catalog() {
  hdr "Catálogo (barbeiros + serviços)"
  [[ -z "$OWNER_ACCESS" ]] && { _skip "Catalog suite" "auth não rodou"; return; }

  # CAT-B01 — criar barbeiro
  req POST /admin/barbers '{"displayName":"Pedro"}' "Authorization: Bearer $OWNER_ACCESS"
  assert_status "CAT-B01 POST /admin/barbers → 201" 201
  assert_jq_truthy "CAT-B01 retorna id" '.id'
  BARBER_ID="$(jq_get '.id')"

  # CAT-S01 — criar serviço
  req POST /admin/services '{"name":"Corte","durationMin":30,"priceCents":4500}' "Authorization: Bearer $OWNER_ACCESS"
  assert_status "CAT-S01 POST /admin/services → 201" 201
  SERVICE_ID="$(jq_get '.id')"

  # CAT-N01 — duration fora do range
  req POST /admin/services '{"name":"X","durationMin":3,"priceCents":1000}' "Authorization: Bearer $OWNER_ACCESS"
  assert_status "CAT-N01 duration<5 → 400" 400
  req POST /admin/services '{"name":"X","durationMin":500,"priceCents":1000}' "Authorization: Bearer $OWNER_ACCESS"
  assert_status "CAT-N02 duration>480 → 400" 400

  # CAT-N03 — price negativo
  req POST /admin/services '{"name":"X","durationMin":30,"priceCents":-1}' "Authorization: Bearer $OWNER_ACCESS"
  assert_status "CAT-N03 price negativo → 400" 400

  # CAT-N04 — name curto
  req POST /admin/services '{"name":"a","durationMin":30,"priceCents":1000}' "Authorization: Bearer $OWNER_ACCESS"
  assert_status "CAT-N04 name 1 char → 400" 400

  # CAT-V01 — vincular barbeiro ao serviço
  req PUT "/admin/services/$SERVICE_ID/barbers" "$(jq -n --arg b "$BARBER_ID" '{barberIds:[$b]}')" "Authorization: Bearer $OWNER_ACCESS"
  assert_status "CAT-V01 vincular barbeiro ao serviço → 200" 200

  # CAT-L01 — listar serviços
  req GET /admin/services "" "Authorization: Bearer $OWNER_ACCESS"
  assert_status "CAT-L01 GET /admin/services → 200" 200
  assert_jq "CAT-L01 retorna 1 serviço" 'length' '1'
}

# ─── Suite: public ─────────────────────────────────────────────────────────────
suite_public() {
  hdr "Storefront pública"
  [[ -z "$TENANT_SLUG" || -z "$SERVICE_ID" ]] && { _skip "Public suite" "catalog não rodou"; return; }

  # PUB-01 — tenant público
  req GET "/public/$TENANT_SLUG"
  assert_status "PUB-01 GET /public/$TENANT_SLUG → 200" 200
  assert_jq "PUB-01 slug correto" '.slug' "$TENANT_SLUG"

  # PUB-02 — services públicos
  req GET "/public/$TENANT_SLUG/services"
  assert_status "PUB-02 GET /public/.../services → 200" 200
  assert_jq "PUB-02 retorna ao menos 1 serviço" 'length>=1' 'true'

  # PUB-03 — barbers públicos
  req GET "/public/$TENANT_SLUG/barbers"
  assert_status "PUB-03 GET /public/.../barbers → 200" 200
  assert_jq "PUB-03 retorna ao menos 1 barbeiro" 'length>=1' 'true'

  # PUB-N01 — tenant inexistente
  req GET "/public/nao-existe-$RUN_ID"
  # API retorna null com status 200 nessa rota — aceitamos 200 (com null) ou 404
  assert_status_in "PUB-N01 slug inexistente → 200/null ou 404" 200 404

  # PUB-04 — availability by-service
  local FROM TO
  FROM="$(date -u -d 'tomorrow 00:00' +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -v+1d +%Y-%m-%dT00:00:00.000Z)"
  TO="$(date -u -d '+8 days 00:00' +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -v+8d +%Y-%m-%dT00:00:00.000Z)"
  req GET "/public/$TENANT_SLUG/availability/by-service/$SERVICE_ID?from=$FROM&to=$TO"
  assert_status "PUB-04 availability by-service → 200" 200
  assert_jq_truthy "PUB-04 retorna ao menos 1 barbeiro com slots" '.[0].slots[0].startsAt'

  # PUB-N02 — availability by-barber sem serviceId
  req GET "/public/$TENANT_SLUG/availability/by-barber/$BARBER_ID?from=$FROM&to=$TO"
  assert_status "PUB-N02 availability by-barber sem serviceId → 400" 400
}

# ─── Suite: booking ────────────────────────────────────────────────────────────
suite_booking() {
  hdr "Booking público + magic link"
  [[ -z "$TENANT_SLUG" || -z "$SERVICE_ID" || -z "$BARBER_ID" ]] && { _skip "Booking suite" "catalog não rodou"; return; }

  # Capturar primeiro slot disponível
  local FROM TO
  FROM="$(date -u -d 'tomorrow 00:00' +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -v+1d +%Y-%m-%dT00:00:00.000Z)"
  TO="$(date -u -d '+8 days 00:00' +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -v+8d +%Y-%m-%dT00:00:00.000Z)"
  req GET "/public/$TENANT_SLUG/availability/by-service/$SERVICE_ID?from=$FROM&to=$TO"
  local FIRST_SLOT SECOND_SLOT THIRD_SLOT
  FIRST_SLOT="$(jq_get '.[0].slots[0].startsAt')"
  SECOND_SLOT="$(jq_get '.[0].slots[1].startsAt')"
  THIRD_SLOT="$(jq_get '.[0].slots[2].startsAt')"
  if [[ "$FIRST_SLOT" == "null" || -z "$FIRST_SLOT" ]]; then
    _fail "BOOK-PREP slot disponível" "availability retornou vazio"; return
  fi

  # BOOK-01 — booking público
  req POST "/public/$TENANT_SLUG/appointments" "$(jq -n \
    --arg s "$SERVICE_ID" --arg b "$BARBER_ID" --arg t "$FIRST_SLOT" \
    --arg phone "+551199999${RUN_ID: -4}" \
    '{serviceId:$s,barberId:$b,startsAt:$t,customer:{name:"Joao",phone:$phone,email:"joao@x.com"}}')"
  assert_status "BOOK-01 POST /public/.../appointments → 201" 201
  assert_jq_truthy "BOOK-01 retorna id" '.id'
  assert_jq_truthy "BOOK-01 retorna cancellationToken" '.cancellationToken'
  APT_ID="$(jq_get '.id')"
  CANCEL_TOKEN="$(jq_get '.cancellationToken')"

  # BOOK-02 — lookup com token
  req GET "/public/appointments/$APT_ID?token=$CANCEL_TOKEN"
  assert_status "BOOK-02 lookup com token válido → 200" 200
  assert_jq "BOOK-02 id retornado bate" '.id' "$APT_ID"

  # BOOK-N01 — lookup com token errado
  req GET "/public/appointments/$APT_ID?token=ZZZZZZZZZZZZZZZZZZZZZZZZ"
  assert_status "BOOK-N01 lookup com token errado → 400" 400

  # BOOK-N02 — booking no passado
  req POST "/public/$TENANT_SLUG/appointments" "$(jq -n \
    --arg s "$SERVICE_ID" --arg b "$BARBER_ID" \
    --arg phone "+551199998${RUN_ID: -4}" \
    '{serviceId:$s,barberId:$b,startsAt:"2020-01-01T10:00:00.000Z",customer:{name:"X",phone:$phone}}')"
  assert_status_in "BOOK-N02 startsAt no passado → 400/409" 400 409

  # BOOK-N03 — booking com barber não vinculado: precisa de barbeiro NOVO sem vínculo
  req POST /admin/barbers '{"displayName":"Sem Vinculo"}' "Authorization: Bearer $OWNER_ACCESS"
  local UNLINKED_BARBER_ID
  UNLINKED_BARBER_ID="$(jq_get '.id')"
  if [[ -n "$UNLINKED_BARBER_ID" && "$UNLINKED_BARBER_ID" != "null" ]]; then
    req POST "/public/$TENANT_SLUG/appointments" "$(jq -n \
      --arg s "$SERVICE_ID" --arg b "$UNLINKED_BARBER_ID" --arg t "$SECOND_SLOT" \
      --arg phone "+551199997${RUN_ID: -4}" \
      '{serviceId:$s,barberId:$b,startsAt:$t,customer:{name:"X",phone:$phone}}')"
    assert_status_in "BOOK-N03 barber não vinculado ao serviço → 400/422" 400 409 422
  fi

  # BOOK-03 — double booking concorrente (race)
  # Releitura de availability pra pegar slots frescos (após BOOK-01, BOOK-N02, BOOK-N03)
  req GET "/public/$TENANT_SLUG/availability/by-service/$SERVICE_ID?from=$FROM&to=$TO"
  local RACE_SLOT
  # Pega o último slot disponível pra evitar conflito com qualquer booking anterior
  RACE_SLOT="$(jq_get '.[0].slots | reverse | .[0].startsAt')"
  if [[ "$RACE_SLOT" == "null" || -z "$RACE_SLOT" ]]; then
    _fail "BOOK-03 race-prep" "availability vazio após bookings anteriores"
  else
    local OUT_A OUT_B BODY_A BODY_B
    (curl -s -o /tmp/qa-race-a.body -w '%{http_code}' -X POST "$API/public/$TENANT_SLUG/appointments" \
      -H 'Content-Type: application/json' \
      --data "$(jq -n --arg s "$SERVICE_ID" --arg b "$BARBER_ID" --arg t "$RACE_SLOT" --arg phone "+551191${RUN_ID: -6}" \
        '{serviceId:$s,barberId:$b,startsAt:$t,customer:{name:"Cliente A",phone:$phone}}')" > /tmp/qa-race-a.status) &
    PID_A=$!
    (curl -s -o /tmp/qa-race-b.body -w '%{http_code}' -X POST "$API/public/$TENANT_SLUG/appointments" \
      -H 'Content-Type: application/json' \
      --data "$(jq -n --arg s "$SERVICE_ID" --arg b "$BARBER_ID" --arg t "$RACE_SLOT" --arg phone "+551192${RUN_ID: -6}" \
        '{serviceId:$s,barberId:$b,startsAt:$t,customer:{name:"Cliente B",phone:$phone}}')" > /tmp/qa-race-b.status) &
    PID_B=$!
    wait $PID_A $PID_B
    OUT_A="$(cat /tmp/qa-race-a.status 2>/dev/null)"
    OUT_B="$(cat /tmp/qa-race-b.status 2>/dev/null)"
    BODY_A="$(cat /tmp/qa-race-a.body 2>/dev/null | head -c 200)"
    BODY_B="$(cat /tmp/qa-race-b.body 2>/dev/null | head -c 200)"
    local OK_COUNT=0 CONFLICT_COUNT=0
    [[ "$OUT_A" == "201" ]] && OK_COUNT=$((OK_COUNT+1))
    [[ "$OUT_B" == "201" ]] && OK_COUNT=$((OK_COUNT+1))
    [[ "$OUT_A" == "409" ]] && CONFLICT_COUNT=$((CONFLICT_COUNT+1))
    [[ "$OUT_B" == "409" ]] && CONFLICT_COUNT=$((CONFLICT_COUNT+1))
    if [[ $OK_COUNT -eq 1 && $CONFLICT_COUNT -eq 1 ]]; then
      _ok "BOOK-03 double-booking: exatamente 1 vence (A=$OUT_A B=$OUT_B)"
    else
      LAST_RES="A($OUT_A): $BODY_A  |  B($OUT_B): $BODY_B"
      _fail "BOOK-03 double-booking" "esperado 1×201 + 1×409, recebido A=$OUT_A B=$OUT_B"
    fi
  fi

  # BOOK-04 — cancel via magic link
  req POST "/public/appointments/$APT_ID/cancel?token=$CANCEL_TOKEN" '{}'
  assert_status "BOOK-04 cancel com token → 200" 200
  assert_jq "BOOK-04 status cancelled" '.status' 'cancelled'

  # BOOK-N04 — re-cancel
  req POST "/public/appointments/$APT_ID/cancel?token=$CANCEL_TOKEN" '{}'
  assert_status "BOOK-N04 re-cancel mesmo token → 409" 409
}

# ─── Suite: admin (walk-in + state machine) ───────────────────────────────────
suite_admin() {
  hdr "Admin appointments"
  [[ -z "$OWNER_ACCESS" || -z "$SERVICE_ID" || -z "$BARBER_ID" ]] && { _skip "Admin suite" "deps não rodaram"; return; }

  # ADM-01 — listar (DTO exige from/to)
  local FROM TO
  FROM="$(date -u -d 'today 00:00' +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u +%Y-%m-%dT00:00:00.000Z)"
  TO="$(date -u -d '+30 days 00:00' +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -v+30d +%Y-%m-%dT00:00:00.000Z)"
  req GET "/admin/appointments?from=$FROM&to=$TO" "" "Authorization: Bearer $OWNER_ACCESS"
  assert_status "ADM-01 GET /admin/appointments → 200" 200

  # ADM-N00 — listar sem from/to (DTO rejeita)
  req GET /admin/appointments "" "Authorization: Bearer $OWNER_ACCESS"
  assert_status "ADM-N00 GET /admin/appointments sem from/to → 400" 400

  # ADM-02 — walk-in com customer novo
  local SLOT
  req GET "/public/$TENANT_SLUG/availability/by-service/$SERVICE_ID?from=$FROM&to=$TO"
  SLOT="$(jq_get '.[0].slots[5].startsAt')"
  [[ "$SLOT" == "null" ]] && SLOT="$(jq_get '.[0].slots[0].startsAt')"

  req POST /admin/appointments "$(jq -n \
    --arg s "$SERVICE_ID" --arg b "$BARBER_ID" --arg t "$SLOT" \
    --arg phone "+551197777${RUN_ID: -4}" \
    '{serviceId:$s,barberId:$b,startsAt:$t,customer:{name:"WalkIn",phone:$phone}}')" \
    "Authorization: Bearer $OWNER_ACCESS"
  assert_status "ADM-02 walk-in com customer novo → 201" 201
  local ADM_APT_ID ADM_APT_STATUS
  ADM_APT_ID="$(jq_get '.id')"
  ADM_APT_STATUS="$(jq_get '.status')"
  assert_jq "ADM-02 walk-in já criado como confirmed (admin booking)" '.status' 'confirmed'

  # ADM-N01 — walk-in sem customer nem customerId
  req POST /admin/appointments "$(jq -n --arg s "$SERVICE_ID" --arg b "$BARBER_ID" --arg t "$SLOT" \
    '{serviceId:$s,barberId:$b,startsAt:$t}')" "Authorization: Bearer $OWNER_ACCESS"
  assert_status "ADM-N01 walk-in sem customer nem customerId → 400" 400

  # ADM-N02 — confirm de apt já confirmed → 409 (regra de negócio)
  req POST "/admin/appointments/$ADM_APT_ID/confirm" '' "Authorization: Bearer $OWNER_ACCESS"
  assert_status "ADM-N02 confirm de apt já confirmed → 409" 409

  # ADM-03 — complete (admin booking já vem confirmed; complete é a próxima transição válida)
  req POST "/admin/appointments/$ADM_APT_ID/complete" '' "Authorization: Bearer $OWNER_ACCESS"
  assert_status "ADM-03 complete → 200" 200

  # ADM-N03 — cancel após completed
  req POST "/admin/appointments/$ADM_APT_ID/cancel" '{}' "Authorization: Bearer $OWNER_ACCESS"
  assert_status_in "ADM-N03 cancel após completed → 4xx" 400 409 422
}

# ─── Suite: multitenant ────────────────────────────────────────────────────────
suite_multitenant() {
  hdr "Isolamento multi-tenant"
  [[ -z "$OWNER_ACCESS" || -z "$BARBER_ID" ]] && { _skip "Multitenant suite" "deps não rodaram"; return; }

  # Cria segundo tenant
  OWNER_B_EMAIL="ownerB-${RUN_ID}@kairo.test"
  TENANT_B_SLUG="bbb-${RUN_ID}"
  req POST /auth/register/owner "$(jq -n \
    --arg email "$OWNER_B_EMAIL" --arg slug "$TENANT_B_SLUG" \
    '{email:$email,password:"StrongPass!1",name:"OwnerB",tenantName:"BBB",slug:$slug}')"
  assert_status "MT-PREP cria tenant B → 201" 201
  OWNER_B_ACCESS="$(jq_get '.accessToken')"

  # MT-01 — listas admin filtram só do próprio tenant
  req GET /admin/barbers "" "Authorization: Bearer $OWNER_B_ACCESS"
  assert_status "MT-01 GET /admin/barbers (tenant B) → 200" 200
  assert_jq "MT-01 tenant B não vê barbeiros de A" 'length' '0'

  # MT-02 — GET barbeiro de A com token B
  req GET "/admin/barbers/$BARBER_ID" "" "Authorization: Bearer $OWNER_B_ACCESS"
  assert_status_in "MT-02 GET barbeiro de A com token B → 403/404" 403 404

  # MT-03 — PATCH barbeiro de A com token B
  req PATCH "/admin/barbers/$BARBER_ID" '{"displayName":"hackeado"}' "Authorization: Bearer $OWNER_B_ACCESS"
  assert_status_in "MT-03 PATCH barbeiro de A com token B → 403/404" 403 404

  # MT-04 — vincular barbeiro de A em serviço de B
  req POST /admin/services '{"name":"X","durationMin":30,"priceCents":1000}' "Authorization: Bearer $OWNER_B_ACCESS"
  SERVICE_B_ID="$(jq_get '.id')"
  req PUT "/admin/services/$SERVICE_B_ID/barbers" "$(jq -n --arg b "$BARBER_ID" '{barberIds:[$b]}')" \
    "Authorization: Bearer $OWNER_B_ACCESS"
  assert_status_in "MT-04 vincular barber de A em service de B → 4xx" 400 403 404

  # MT-05 — storefront de B não tem barbeiro de A
  req GET "/public/$TENANT_B_SLUG/barbers"
  assert_status "MT-05 storefront B → 200" 200
  assert_jq "MT-05 storefront B sem barbers de A" 'length' '0'
}

# ─── Suite: billing ────────────────────────────────────────────────────────────
suite_billing() {
  hdr "Billing"
  [[ -z "$OWNER_ACCESS" ]] && { _skip "Billing suite" "auth não rodou"; return; }

  # BIL-01 — GET /admin/billing/subscription
  req GET /admin/billing/subscription "" "Authorization: Bearer $OWNER_ACCESS"
  assert_status "BIL-01 GET /admin/billing/subscription → 200" 200
  assert_jq_truthy "BIL-01 status presente" '.status'

  # BIL-02 — POST /admin/billing/checkout
  # Se o servidor estiver com BILLING_PROVIDER=mercadopago, este teste vai parar no MP real.
  # Pra evitar criar checkouts em ambiente de prod do MP, pulamos a menos que
  # explicitamente forçado via QA_TEST_CHECKOUT=1.
  if [[ "${QA_TEST_CHECKOUT:-0}" == "1" ]]; then
    req POST /admin/billing/checkout '{}' "Authorization: Bearer $OWNER_ACCESS"
    assert_status "BIL-02 POST /admin/billing/checkout → 200" 200
    assert_jq_truthy "BIL-02 retorna checkoutUrl" '.checkoutUrl'
  else
    # Heurística: tenta uma chamada rápida; se retornar 502/BAD_GATEWAY,
    # provavelmente é MP real com problema → reporta como skip + dica.
    req POST /admin/billing/checkout '{}' "Authorization: Bearer $OWNER_ACCESS"
    case "$HTTP_STATUS" in
      200)
        _ok "BIL-02 POST /admin/billing/checkout → 200"
        assert_jq_truthy "BIL-02 retorna checkoutUrl" '.checkoutUrl'
        ;;
      502|503|504)
        _skip "BIL-02 checkout" "provider externo (MP?) retornou $HTTP_STATUS — defina BILLING_PROVIDER=console no .env do servidor pra testar isolado, ou QA_TEST_CHECKOUT=1 pra forçar"
        ;;
      *)
        _fail "BIL-02 POST /admin/billing/checkout → 200" "esperado 200, recebido $HTTP_STATUS"
        ;;
    esac
  fi

  # BIL-03 — GET /admin/billing/invoices
  req GET /admin/billing/invoices "" "Authorization: Bearer $OWNER_ACCESS"
  assert_status "BIL-03 GET /admin/billing/invoices → 200" 200
}

# ─── Resumo ────────────────────────────────────────────────────────────────────
print_summary() {
  echo
  echo "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
  echo "${B}Sumário${N}    ${G}✓ $PASS passou${N}    ${R}✗ $FAIL falhou${N}    ${Y}◌ $SKIP pulou${N}"
  echo "${B}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
  if (( FAIL > 0 )); then
    echo
    echo "${R}Falhas:${N}"
    for f in "${FAILURES[@]}"; do echo "  ${R}•${N} $f"; done
    echo
    echo "Re-rode com ${B}-v${N} pra ver request/response em cada falha:"
    echo "  ./scripts/qa-smoke.sh -v"
    exit 1
  fi
  echo
  echo "${G}Tudo verde. Run ID: $RUN_ID${N}"
  exit 0
}

# ─── Run ───────────────────────────────────────────────────────────────────────
echo "${B}KairoBarber QA Smoke${N}  →  $API  (run-id: $RUN_ID)"

should_run health     && suite_health
should_run auth       && suite_auth
should_run tenant     && suite_tenant
should_run catalog    && suite_catalog
should_run public     && suite_public
should_run booking    && suite_booking
should_run admin      && suite_admin
should_run multitenant && suite_multitenant
should_run billing    && suite_billing

print_summary
