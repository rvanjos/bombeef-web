// routes/classificador.js
// Salva e carrega sessões do Classificador de Extrato no PostgreSQL
'use strict';
const { Router } = require('express');
const autenticar = require('../middleware/auth');

module.exports = (pool) => {
  const r = Router();
  r.use(autenticar());

  // ── Garante que as tabelas existem ────────────────────────────────────────
  pool.query(`
    CREATE TABLE IF NOT EXISTS classificador_sessoes (
      id            SERIAL PRIMARY KEY,
      usuario_id    INTEGER NOT NULL,
      mes_ref       VARCHAR(7),          -- ex: "2026-03"
      descricao     TEXT,
      dados_json    JSONB NOT NULL,
      criado_em     TIMESTAMPTZ DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS classificador_transacoes (
      id            SERIAL PRIMARY KEY,
      sessao_id     INTEGER REFERENCES classificador_sessoes(id) ON DELETE CASCADE,
      usuario_id    INTEGER NOT NULL,
      data_tx       DATE,
      mes_dre       VARCHAR(7),
      fonte         VARCHAR(30),
      lancamento    TEXT,
      razao_social  TEXT,
      cpf_cnpj      VARCHAR(20),
      portador      TEXT,
      parcela       VARCHAR(10),
      valor         NUMERIC(15,2),
      categoria     TEXT,
      ignorar       BOOLEAN DEFAULT false,
      extra_json    JSONB,
      criado_em     TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(e => console.error('[classificador] Erro ao criar tabelas:', e.message));

  // ── GET /api/classificador/sessoes ─────────────────────────────────────────
  // Lista sessões do usuário
  r.get('/sessoes', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT id, mes_ref, descricao, criado_em, atualizado_em,
               (dados_json->>'totalTransacoes')::int AS total_transacoes
        FROM classificador_sessoes
        WHERE usuario_id = $1
        ORDER BY atualizado_em DESC
        LIMIT 20
      `, [req.usuario.id]);
      res.json({ ok: true, sessoes: rows });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── GET /api/classificador/ultima ──────────────────────────────────────────
  // Retorna a última sessão salva (para carregar ao abrir o sistema)
  r.get('/ultima', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT id, mes_ref, descricao, dados_json, atualizado_em
        FROM classificador_sessoes
        WHERE usuario_id = $1
        ORDER BY atualizado_em DESC
        LIMIT 1
      `, [req.usuario.id]);
      if (!rows.length) return res.json({ ok: true, sessao: null });
      res.json({ ok: true, sessao: rows[0] });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── POST /api/classificador/salvar ─────────────────────────────────────────
  // Salva ou atualiza sessão completa
  r.post('/salvar', async (req, res) => {
    const { sessao_id, mes_ref, descricao, dados } = req.body;
    if (!dados || !dados.transactions) {
      return res.status(400).json({ ok: false, erro: 'dados.transactions obrigatório' });
    }

    try {
      // Monta JSON resumido para metadados
      const dadosJson = {
        totalTransacoes: dados.transactions.length,
        totalFuncionarios: (dados.employees || []).length,
        loadedFiles: dados.loadedFiles || [],
        globalId: dados.globalId || 0,
        customCats: dados.customCats || {},
        supplierCatMemory: dados.supplierCatMemory || {},
        transactions: dados.transactions,
        employees: dados.employees || [],
        _savedAt: new Date().toISOString(),
        _version: 'v5'
      };

      let id;
      if (sessao_id) {
        // Atualiza sessão existente
        const { rows } = await pool.query(`
          UPDATE classificador_sessoes
          SET dados_json = $1, mes_ref = $2, descricao = $3, atualizado_em = NOW()
          WHERE id = $4 AND usuario_id = $5
          RETURNING id
        `, [dadosJson, mes_ref || null, descricao || null, sessao_id, req.usuario.id]);
        id = rows[0]?.id;
      } else {
        // Cria nova sessão
        const { rows } = await pool.query(`
          INSERT INTO classificador_sessoes (usuario_id, mes_ref, descricao, dados_json)
          VALUES ($1, $2, $3, $4)
          RETURNING id
        `, [req.usuario.id, mes_ref || null, descricao || null, dadosJson]);
        id = rows[0].id;
      }

      res.json({ ok: true, sessao_id: id });
    } catch (e) {
      console.error('[classificador/salvar]', e.message);
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  // ── DELETE /api/classificador/sessoes/:id ─────────────────────────────────
  r.delete('/sessoes/:id', async (req, res) => {
    try {
      await pool.query(
        'DELETE FROM classificador_sessoes WHERE id = $1 AND usuario_id = $2',
        [req.params.id, req.usuario.id]
      );
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, erro: e.message });
    }
  });

  return r;
};
