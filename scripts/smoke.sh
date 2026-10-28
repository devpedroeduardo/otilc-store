#!/bin/sh
# Smoke test de leitura da OTILC em produção (ou local).
# Uso: scripts/smoke.sh <URL_DA_API> <URL_DA_LOJA>
#   ex.: scripts/smoke.sh http://localhost:3333 http://localhost:3000
# Só faz GET: não cria pedido, não faz login, não envia segredo.
# Sai com código diferente de zero na primeira falha.
set -eu

if [ $# -ne 2 ]; then
  echo "Uso: $0 <URL_DA_API> <URL_DA_LOJA>" >&2
  exit 2
fi

api="${1%/}"
web="${2%/}"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

# get <rótulo> <url>: guarda o corpo em $tmp e exige HTTP 200.
get() {
  label="$1"
  url="$2"
  status="$(curl -sS -o "$tmp" -w '%{http_code}' --connect-timeout 10 --max-time 30 "$url" || true)"
  if [ "$status" != "200" ]; then
    echo "FALHOU  $label ($url): HTTP ${status:-000}" >&2
    exit 1
  fi
  echo "OK      $label"
}

get "API /api/health" "$api/api/health"

get "API lista pública de produtos" "$api/api/products"
slug="$(grep -o '"slug":"[^"]*"' "$tmp" | head -n 1 | cut -d '"' -f 4)"
if [ -z "$slug" ]; then
  echo "FALHOU  a listagem pública não trouxe nenhum produto" >&2
  exit 1
fi

get "Loja: home" "$web/"
get "Loja: página de produto ($slug)" "$web/produto/$slug"

get "Loja: login do admin" "$web/admin/login"
if ! grep -q 'Entrar' "$tmp"; then
  echo "FALHOU  a tela de login do admin não mostrou o formulário" >&2
  exit 1
fi

echo "Smoke test concluído: tudo certo."
