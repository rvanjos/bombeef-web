'use strict';

function saldoAbertoSQL(alias = '') {
  const p = alias ? alias + '.' : '';
  return `CASE WHEN COALESCE(${p}status,'pendente')='pago' THEN 0 ELSE GREATEST(COALESCE(${p}saldo_restante,${p}valor_total),0) END`;
}
const centavos = valor => Math.round(Number(valor) * 100);
function erro(status, mensagem, extra = {}) { return Object.assign(new Error(mensagem), { status, ...extra }); }

async function registrarRetirada(pool, req, ret) {
  const lojaId = Number(req.user?.lojaId), funcionarioId = Number(ret.funcionarioId);
  const itens = ret.itens === undefined ? [ret] : ret.itens;
  if (!Number.isSafeInteger(lojaId) || lojaId <= 0 || !Number.isSafeInteger(funcionarioId) || funcionarioId <= 0 ||
      !Array.isArray(itens) || !itens.length || itens.length > 100)
    throw erro(400, 'Informe funcionário e de 1 a 100 produtos válidos.');
  const valorPago = Number(ret.valorPagoAgora ?? 0);
  if (!Number.isFinite(valorPago) || valorPago < 0 || !Number.isSafeInteger(centavos(valorPago)) || Math.abs(valorPago * 100 - centavos(valorPago)) > 0.0001)
    throw erro(400, 'Pagamento imediato inválido.');
  if (valorPago > 0 && !req.podeRetirada('retiradas_pagamentos'))
    throw erro(403, 'O pagamento imediato deve ser confirmado por um usuário autorizado a registrar pagamentos.');
  const formas = ['dinheiro', 'pix', 'debito', 'credito', 'transferencia', 'outro'];
  if (valorPago > 0 && !formas.includes(ret.formaPagamento))
    throw erro(400, 'Selecione uma forma de pagamento imediato válida.');
  const dt = ret.dtRetirada || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dt) || !Number.isFinite(Date.parse(dt))) throw erro(400, 'Data inválida.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serializa novas retiradas do mesmo funcionário, inclusive quando ainda não há dívida.
    const { rows: funcionarios } = await client.query(`SELECT id, nome, limite_retirada FROM funcionarios
      WHERE id=$1 AND loja_id=$2 AND ativo=true FOR UPDATE`, [funcionarioId, lojaId]);
    if (!funcionarios.length) throw erro(404, 'Funcionário não encontrado nesta loja.');
    const calculados = [];
    for (const item of itens) {
      if (!item || typeof item.descricao !== 'string' || !item.descricao.trim()) throw erro(400, 'Informe a descrição de cada produto.');
      let preco = Number(item.precoUnitario ?? 0);
      if (item.produtoId) {
        const { rows } = await client.query('SELECT preco_custo FROM produtos WHERE id=$1 AND loja_id=$2', [item.produtoId, lojaId]);
        if (!rows.length) throw erro(404, 'Produto não encontrado nesta loja.');
        preco = Number(rows[0].preco_custo);
      } else if (req.user.perfil !== 'admin') throw erro(400, 'Selecione um produto cadastrado.');
      const qtd = Number(item.qtd ?? 1), desconto = Number(item.descontoPct ?? 0);
      const total = centavos(preco * qtd * (1 - desconto / 100));
      if (![preco, qtd, desconto].every(Number.isFinite) || preco < 0 || qtd <= 0 || desconto < 0 || desconto > 100 ||
          !Number.isSafeInteger(total) || total < 0 || total > 9999999999)
        throw erro(400, 'Quantidade, preço ou desconto inválidos.');
      calculados.push({ ...item, preco, qtd, desconto, total });
    }
    const total = calculados.reduce((s, x) => s + x.total, 0), pago = centavos(valorPago);
    if (!Number.isSafeInteger(total) || total > 9999999999) throw erro(400, 'Valor total da retirada inválido.');
    if (pago > total) throw erro(400, 'O pagamento imediato não pode exceder o valor desta retirada.');
    const { rows: saldos } = await client.query(`SELECT COALESCE(SUM(${saldoAbertoSQL()}),0) AS total
      FROM retiradas WHERE funcionario_id=$1 AND loja_id=$2`, [funcionarioId, lojaId]);
    const aberto = centavos(saldos[0].total), limite = Math.max(0, centavos(funcionarios[0].limite_retirada || 0));
    const disponivel = Math.max(0, limite - aberto), minimo = Math.max(0, total - disponivel);
    if (pago < minimo) throw erro(422, 'O saldo devedor ultrapassaria o limite. Registre o pagamento imediato mínimo indicado.', {
      saldo: disponivel / 100, pagamento_minimo: minimo / 100, total_retirada: total / 100,
    });
    let pagamento = null;
    if (pago > 0) {
      const { rows } = await client.query(`INSERT INTO pagamentos_retiradas
        (funcionario_id,data_pagamento,valor_pago,forma_pagamento,observacao,usuario_id,loja_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [funcionarioId, dt, pago / 100, ret.formaPagamento, ret.observacao || 'Pagamento no ato da retirada', req.user.id, lojaId]);
      pagamento = rows[0];
    }
    const retiradas = [];
    let restante = pago;
    for (const item of calculados) {
      const abatido = Math.min(restante, item.total), saldo = item.total - abatido;
      const status = saldo === 0 ? 'pago' : abatido > 0 ? 'parcial' : 'pendente';
      const { rows } = await client.query(`INSERT INTO retiradas
        (funcionario_id,produto_id,descricao,qtd,preco_unitario,desconto_pct,valor_total,mes,dt_retirada,
         observacao,autorizado_por,usuario_id,loja_id,saldo_restante,status,dt_pagamento,pago_por)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [funcionarioId, item.produtoId || null, item.descricao.trim(), item.qtd, item.preco, item.desconto, item.total / 100,
        dt.slice(5, 7) + '/' + dt.slice(0, 4), dt, ret.observacao || null, req.user.id, req.user.id, lojaId,
        saldo / 100, status, saldo === 0 ? dt : null, abatido > 0 ? req.user.id : null]);
      retiradas.push(rows[0]);
      if (abatido > 0) await client.query(`INSERT INTO pagamento_retirada_itens
        (pagamento_id,retirada_id,valor_abatido,loja_id) VALUES ($1,$2,$3,$4)`, [pagamento.id, rows[0].id, abatido / 100, lojaId]);
      restante -= abatido;
    }
    await client.query('COMMIT');
    return { data: ret.itens === undefined ? retiradas[0] : retiradas, pagamento,
      total: total / 100, valor_pago: pago / 100, saldo_aberto: (aberto + total - pago) / 100,
      limite_disponivel: Math.max(0, disponivel - total + pago) / 100 };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
async function alterarRetirada(pool, req, id, ret, reabrir = false) {
  const lojaId = req.user.lojaId, client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: referencias } = await client.query('SELECT funcionario_id FROM retiradas WHERE id=$1 AND loja_id=$2', [id, lojaId]);
    if (!referencias.length) throw erro(404, 'Retirada não encontrada nesta loja.');
    const funcionarioId = referencias[0].funcionario_id;
    const { rows: funcs } = await client.query('SELECT limite_retirada FROM funcionarios WHERE id=$1 AND loja_id=$2 FOR UPDATE', [funcionarioId, lojaId]);
    if (!funcs.length) throw erro(404, 'Funcionário não encontrado nesta loja.');
    const { rows } = await client.query(`SELECT *, ${saldoAbertoSQL()} AS aberto FROM retiradas WHERE id=$1 AND loja_id=$2 FOR UPDATE`, [id, lojaId]);
    if (!rows.length) throw erro(404, 'Retirada não encontrada nesta loja.');
    const atual = rows[0], pago = centavos(atual.valor_total) - centavos(atual.aberto);
    const qtd = Number(ret.qtd ?? atual.qtd), preco = Number(ret.precoUnitario ?? atual.preco_unitario), desconto = Number(ret.descontoPct ?? atual.desconto_pct);
    const total = reabrir ? centavos(atual.valor_total) : centavos(ret.valorTotal ?? (qtd * preco * (1 - desconto / 100)));
    if (![qtd, preco, desconto].every(Number.isFinite) || qtd <= 0 || preco < 0 || desconto < 0 || desconto > 100 || !Number.isSafeInteger(total) || total < 0 || total > 9999999999)
      throw erro(400, 'Valores da retirada inválidos.');
    if (!reabrir && total < pago) throw erro(409, 'O valor não pode ficar menor que o pagamento já registrado.');
    const novoAberto = reabrir ? total : total - pago;
    const { rows: saldos } = await client.query(`SELECT COALESCE(SUM(${saldoAbertoSQL()}),0) AS total FROM retiradas WHERE funcionario_id=$1 AND loja_id=$2`, [funcionarioId, lojaId]);
    const abertoTotal = centavos(saldos[0].total), limite = Math.max(0, centavos(funcs[0].limite_retirada || 0));
    if (novoAberto > centavos(atual.aberto) && abertoTotal - centavos(atual.aberto) + novoAberto > limite)
      throw erro(422, 'Esta alteração ultrapassaria o limite de saldo em aberto. Registre o pagamento antes de continuar.');
    const status = novoAberto === 0 ? 'pago' : (!reabrir && pago > 0 ? 'parcial' : 'pendente');
    await client.query(`UPDATE retiradas SET descricao=COALESCE($1,descricao),qtd=$2,preco_unitario=$3,desconto_pct=$4,
      valor_total=$5,observacao=COALESCE($6,observacao),saldo_restante=$7,status=$8,
      dt_pagamento=CASE WHEN $8='pago' THEN dt_pagamento ELSE NULL END,
      pago_por=CASE WHEN $9 THEN NULL ELSE pago_por END WHERE id=$10 AND loja_id=$11`,
    [ret.descricao || null, qtd, preco, desconto, total / 100, ret.observacao || null, novoAberto / 100, status, reabrir, id, lojaId]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
module.exports = { saldoAbertoSQL, registrarRetirada, alterarRetirada };
