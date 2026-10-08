#!/usr/bin/env bash
# Cria uma worktree isolada para uma spec, com banco de teste próprio.
# Uso: scripts/new-task.sh 002 api-auth-admin
# Resultado: ../otilc-store-wt/spec-002-api-auth-admin na branch spec-002-api-auth-admin
# Rode no WSL/Linux/macOS ou no Git Bash do Windows.
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Uso: $0 <numero-da-spec> <slug>   ex.: $0 002 api-auth-admin" >&2
  exit 1
fi

num="$1"
slug="$2"

if ! [[ "$num" =~ ^[0-9]{3}$ ]]; then
  echo "Número da spec deve ter 3 dígitos (ex.: 002)." >&2
  exit 1
fi
if ! [[ "$slug" =~ ^[a-z0-9-]+$ ]]; then
  echo "Slug deve conter só letras minúsculas, números e hífen." >&2
  exit 1
fi

root="$(git rev-parse --show-toplevel)"
spec_file="$(ls "$root"/specs/"$num"-*.md 2>/dev/null | head -n 1 || true)"
if [ -z "$spec_file" ]; then
  echo "Spec $num não encontrada em specs/." >&2
  exit 1
fi

branch="spec-$num-$slug"
wt_dir="$(dirname "$root")/$(basename "$root")-wt/$branch"

git -C "$root" fetch origin main --quiet 2>/dev/null || true
base="origin/main"
git -C "$root" rev-parse --verify --quiet "$base" >/dev/null || base="main"

git -C "$root" worktree add -b "$branch" "$wt_dir" "$base"

# Os .env são ignorados pelo git e os agentes não podem criá-los: copiamos os seus.
for f in apps/api/.env apps/web/.env.local; do
  if [ -f "$root/$f" ]; then
    cp "$root/$f" "$wt_dir/$f"
  else
    echo "Aviso: $f não existe no repositório principal; copie do .env.example antes de rodar a app." >&2
  fi
done

# Banco de teste por worktree: os testes de integração fazem TRUNCATE,
# então agentes em paralelo não podem dividir o mesmo banco.
test_db="otilc_test_$num"
test_url="postgres://otilc:otilc@localhost:5432/$test_db"
if (cd "$root" && docker compose exec -T db psql -U otilc -d otilc -tAc \
    "SELECT 1 FROM pg_database WHERE datname = '$test_db'" 2>/dev/null | grep -q 1); then
  echo "Banco $test_db já existe."
elif (cd "$root" && docker compose exec -T db createdb -U otilc "$test_db" 2>/dev/null); then
  echo "Banco $test_db criado."
else
  echo "Aviso: não consegui criar $test_db. Rode 'docker compose up -d db' e execute de novo," >&2
  echo "       ou crie manualmente: docker compose exec db createdb -U otilc $test_db" >&2
fi

cat <<EOF

Worktree pronta: $wt_dir
Branch:          $branch
Spec:            ${spec_file#$root/}
Banco de teste:  $test_db

Próximos passos:
  1. Na Alethe, abra um painel de shell e rode:
       cd "$wt_dir" && npm install
  2. Inicie o agente nesse mesmo shell, já com o banco de teste próprio:
       export TEST_DATABASE_URL=$test_url
       claude        # ou: codex, opencode...
  3. Cole o prompt de execução de docs/agents/prompts.md trocando NNN por $num.

Só uma worktree por vez deve rodar 'npm run dev' (portas 3000 e 3333).

Depois do merge:
  git worktree remove "$wt_dir" && git branch -d $branch
  docker compose exec db dropdb -U otilc $test_db
EOF
