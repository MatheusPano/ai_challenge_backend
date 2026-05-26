#!/usr/bin/env bash
# Roda o ingest do RAG para o restante dos cursos.
# - resume=true (padrão do IngestService) → pula cursos já indexados.
# - Em caso de erro (quota, rede), espera e retenta até MAX_RETRIES.
# - Log com timestamp em logs/rag-ingest-<data>.log.
#
# Uso:
#   ./scripts/rag-ingest-remaining.sh                # roda tudo que falta
#   ./scripts/rag-ingest-remaining.sh --limit=10     # só 10 cursos por execução
#   MAX_RETRIES=10 RETRY_DELAY=600 ./scripts/rag-ingest-remaining.sh

set -uo pipefail

cd "$(dirname "$0")/.."

MAX_RETRIES="${MAX_RETRIES:-5}"
RETRY_DELAY="${RETRY_DELAY:-300}"  # 5 min — alivia rate-limit/quota

mkdir -p logs
LOG="logs/rag-ingest-$(date +%Y%m%d-%H%M%S).log"

echo "[$(date)] starting rag ingest (log: $LOG, max_retries=$MAX_RETRIES, retry_delay=${RETRY_DELAY}s)" | tee -a "$LOG"

attempt=1
while [ "$attempt" -le "$MAX_RETRIES" ]; do
  echo "[$(date)] attempt $attempt/$MAX_RETRIES" | tee -a "$LOG"
  if npm run --silent rag:ingest -- "$@" 2>&1 | tee -a "$LOG"; then
    echo "[$(date)] ingest finished successfully" | tee -a "$LOG"
    exit 0
  fi
  echo "[$(date)] ingest failed — sleeping ${RETRY_DELAY}s before retry" | tee -a "$LOG"
  sleep "$RETRY_DELAY"
  attempt=$((attempt + 1))
done

echo "[$(date)] giving up after $MAX_RETRIES attempts" | tee -a "$LOG"
exit 1
