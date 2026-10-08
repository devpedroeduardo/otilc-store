#!/usr/bin/env bash
# Cria uma worktree isolada para uma spec.
# Uso: scripts/new-task.sh 002 api-catalogo
# Resultado: ../otilc-store-wt/spec-002-api-catalogo na branch spec-002-api-catalogo
# Funciona no Linux, macOS e no Git Bash do Windows.
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Uso: $0 <numero-da-spec> <slug>   ex.: $0 002 api-catalogo" >&2
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

echo
echo "Worktree pronta: $wt_dir"
echo "Branch:          $branch"
echo "Spec:            ${spec_file#$root/}"
echo
echo "Próximos passos:"
echo "  1. Na Alethe, abra $wt_dir como painel do agente escolhido."
echo "  2. Rode 'pnpm install' dentro da worktree."
echo "  3. Cole o prompt de execução de docs/agents/prompts.md trocando NNN por $num."
echo
echo "Para remover depois do merge: git worktree remove \"$wt_dir\" && git branch -d $branch"
