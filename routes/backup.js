/**
 * routes/backup.js — Backup e monitoramento do banco
 *
 * Rotas (todas exigem perfil admin):
 *   GET  /api/admin/backup/stats     → tamanho e contagem de cada tabela
 *   GET  /api/admin/backup/download  → baixa JSON completo de todas as tabelas
 */

const express    = require('express');
const autenticar = require('../middleware/auth');

// Tabelas para backup (em ordem que respeita FK)
const TABELAS = [
  'usuarios',
  'produtos',
  'categorias_dre',
  'kits',
  'kit_itens',
  'boletos',
  'validade_items',
  'perdas',
  'dre_sessoes',
  'dre_lancamentos',
  'faturamento_mensal',
  'fornecedores',
  'vld_estoque',
  'vld_faturamento',
  'vld_retiradas',
  'vld_config',
  'funcionarios',
];

module.exports = function (pool) {
  const r = express.Router();
  r.use(autenticar('admin'));

  // ── GET /stats — resumo do banco ────────────────────────────────────────────
  r.get('/stats', async (req, res) => {
    try {
      const stats = [];
      for (const tabela of TABELAS) {
        try {
          const { rows } = await pool.query(
            `SELECT COUNT(*) AS total,
                    pg_size_pretty(pg_total_relation_size($1)) AS tamanho
             FROM ${tabela}`, [tabela]
          );
          stats.push({ tabela, total: parseInt(rows[0].total), tamanho: rows[0].tamanho });
        } catch (_) {
          stats.push({ tabela, total: null, tamanho: null, erro: 'Tabela não existe' });
        }
      }

      // Tamanho total do banco
      const { rows: dbSize } = await pool.query(
        `SELECT pg_size_pretty(pg_database_size(current_database())) AS total`
      );

      res.json({ ok: true, banco: dbSize[0].total, tabelas: stats });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── GET /download — exporta JSON completo ───────────────────────────────────
  r.get('/download', async (req, res) => {
    try {
      const backup = {
        gerado_em:  new Date().toISOString(),
        versao:     '1.0',
        banco:      'bombeef',
        tabelas:    {},
      };

      for (const tabela of TABELAS) {
        try {
          const { rows } = await pool.query(`SELECT * FROM ${tabela} ORDER BY id ASC`);
          backup.tabelas[tabela] = rows;
        } catch (_) {
          backup.tabelas[tabela] = []; // tabela não existe ainda — pula
        }
      }

      const json     = JSON.stringify(backup, null, 2);
      const data     = new Date().toISOString().slice(0, 10);
      const filename = `bombeef_backup_${data}.json`;

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(json);
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  return r;
};
