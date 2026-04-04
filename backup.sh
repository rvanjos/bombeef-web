#!/bin/bash
# Backup manual do banco Bom Beef
# Uso: ./backup.sh
# Requer: pg_dump instalado (brew install postgresql no Mac, ou use Docker)

DB_URL="postgresql://postgres:jGWTThNjdlglfTAUGAJzzgWpcSHEwtsT@nozomi.proxy.rlwy.net:13902/railway"
DATA=$(date +"%Y-%m-%d_%H-%M")
ARQUIVO="backup_bombeef_${DATA}.sql"

echo "📦 Fazendo backup do banco Bom Beef..."
pg_dump "$DB_URL" -F p -f "$ARQUIVO"

if [ $? -eq 0 ]; then
  echo "✅ Backup salvo: $ARQUIVO ($(du -sh $ARQUIVO | cut -f1))"
else
  echo "❌ Erro ao fazer backup"
  exit 1
fi
