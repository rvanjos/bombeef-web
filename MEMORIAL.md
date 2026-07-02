# 📋 Memorial de Planejamento — Bom Beef Web
Atualizado: 01/07/2026 · Responsável: Rafael

---

## 1. DIRETRIZES DE PROGRAMAÇÃO (obrigatórias em todo código novo)

### 1.1 Frontend (iframes do portal)
- **Toda função chamada por `onclick`/`onchange` inline DEVE ser declarada como `window.fn = function fn(){}`** — o portal carrega módulos em iframe e funções locais não ficam visíveis.
- `onchange`/`onclick` em elementos que existem antes do init devem usar guarda: `typeof fn==='function'&&fn()`.
- `init()` deve ser idempotente (flag `_initDone`) — `onBBReady` re-dispara a cada troca de aba.
- Nunca usar `<div>` wrapper entre scroll container e tabela com `position:sticky` — quebra o sticky.
- CSS dentro de template literals JS: cuidado com pseudo-seletores e `</script>` embutido — quebram o parse da página inteira.
- `async function` não sofre hoisting — declarar antes de usar.
- `splice(-1,1)` quando `findIndex` retorna -1 remove o último item do array — sempre guardar o índice antes.

### 1.2 Backend (Express + PostgreSQL)
- **Parâmetros SQL nunca podem ser `undefined`** — sempre `|| null` e cast explícito `$N::text`/`$N::date` dentro de CASE WHEN.
- `req.user` vs `req.usuario`: conferir qual alias o middleware usa antes de debugar 403.
- Toda rota de UPDATE deve garantir colunas com `ALTER TABLE ADD COLUMN IF NOT EXISTS` (idempotente).
- `const id = parseInt(req.params.id)` — nunca esquecer de declarar.
- CNPJ/CPF: normalizar para dígitos-only ANTES de qualquer INSERT/comparação.

### 1.3 Fluxo de trabalho
- Menor mudança possível → `node --check` → commit → push → Railway (~1-2 min) → testar ao vivo.
- Ao quebrar algo: `git show <commit-estável>:arquivo` e restaurar a função inteira, não remendar.
- Schema drift: tabelas podem ter colunas legadas + novas (`nome_kit` + `nome`) — detectar via `information_schema` e popular ambas.

---

## 2. DRE — MELHORIAS PLANEJADAS

### 2.1 Bugs conhecidos / dívida técnica
- [ ] Sessões multi-mês: `dados_json.transactions` mistura meses — todo filtro DEVE usar `t.mes === mes`. Auditar pontos remanescentes.
- [ ] Erro `carregarMetas innerHTML null` em config.html — adicionar guarda de elemento.
- [ ] Faturas com competência concatenada ainda no banco:
  `DELETE FROM cartao_faturas WHERE competencia LIKE '%+%';`

### 2.2 Melhorias funcionais
- [ ] **Fechamento mensal formal**: botão "Fechar mês" que trava lançamentos e gera snapshot imutável.
- [ ] **Comparativo mês a mês**: variação % por categoria com destaque de outliers (>20%).
- [ ] **Orçado vs Realizado**: metas por categoria DRE com farol verde/amarelo/vermelho.
- [ ] **Anexos por lançamento**: comprovantes (NF, recibo) vinculados a cada transação.
- [ ] **Regras de auto-classificação persistentes**: tabela `regras_classificacao` editável, aprendendo dos ajustes manuais.
- [ ] **Exportação Excel real** client-side (SheetJS) — ExcelJS via CDN é inacessível.

### 2.3 Performance
- [ ] 1500+ transações renderizam lento — paginar ou virtualizar linhas.
- [ ] Boot carrega 21 sessões — carregar só o mês ativo + lazy load.

---

## 3. CARTÃO DE CRÉDITO — MELHORIAS PLANEJADAS

### 3.1 Bugs conhecidos
- [ ] Registros órfãos por variação de nome do cartão (acentos) em dados antigos.
- [ ] Grade tem duas implementações (`renderStatusCartoesGrade` + `_buildGradeCartoes`) — unificar após estabilizar.

### 3.2 Melhorias funcionais
- [ ] **Conciliação pagamento ↔ fatura**: vincular automaticamente débito "PAGAMENTO FATURA" do extrato com a fatura do mês (match valor ±2% + data).
- [ ] **Parcelas futuras projetadas**: compras parceladas geram provisão automática nos meses seguintes.
- [ ] **Alerta de fatura não importada**: dia > 5 e fatura do cartão X ausente → notificação no dashboard.
- [ ] **Detecção de assinaturas recorrentes** (OpenAI, Google Ads): classificação automática + relatório de assinaturas ativas.
- [ ] **Parser genérico configurável** (mapeamento de colunas pelo usuário) para novos bancos.

---

## 4. ANÁLISE DE VENDAS — MELHORIAS PLANEJADAS

### 4.1 Bugs conhecidos
- [x] Ordenação string vs número (corrigido b426f5a) — validar nas demais colunas.
- [ ] KPI "Descontos Concedidos" com importação PDV de período incompleto — validar comportamento.

### 4.2 Melhorias funcionais
- [ ] **Curva ABC com ações**: produto C com margem baixa → sugerir descontinuar / promocionar / reprecificar.
- [ ] **Elasticidade simples**: variação preço × quantidade entre períodos (top 50).
- [ ] **Análise de cesta**: produtos vendidos juntos → sugestões de kits baseadas em dados.
- [ ] **Sazonalidade semanal**: heatmap dia-da-semana × categoria.
- [ ] **Margem real por produto**: custo médio de compra (NF) × preço médio de venda — custo cadastrado fica defasado.
- [ ] **Metas por vendedor/período** integradas ao módulo Metas.

---

## 5. CONTROLE DE VALIDADE — MELHORIAS PLANEJADAS

### 5.1 Bugs conhecidos
- [ ] **PENDENTE ATUAL**: itens "vendido" voltam à lista após reload. Confirmar persistência no banco:
  ```sql
  SELECT id, descricao, status, resolucao, dt_resolucao, atualizado_em
  FROM validade_items WHERE status = 'vendido'
  ORDER BY atualizado_em DESC LIMIT 5;
  ```
  Banco não salva → bug na rota PATCH. Salva → `atualizarStatus()` sobrescreve no reload.

### 5.2 Melhorias funcionais
- [ ] **Notificação proativa diária** (WhatsApp/e-mail): itens vencendo em ≤3 dias.
- [ ] **Sugestão de desconto por urgência**: vence em 2 dias → % baseado na margem do produto.
- [ ] **Integração com Promoções**: botão "criar promoção" direto do item.
- [ ] **Histórico de perdas por vencimento**: R$ perdido/mês por categoria — alimenta decisão de compra.
- [ ] **Leitura de código de barras mobile** (BarcodeDetector API).
- [ ] **Previsão de risco**: giro baixo + validade próxima = alerta antecipado (cruza com análise de vendas).

---

## 6. AUDITORIA DE ESTOQUE (arquitetura aprovada — implementar)

```
Estoque teórico = Entradas NF − Saídas PDV − Retiradas c/ baixa PDV − Perdas + Ajustes
Auditoria = Contagem física vs teórico → divergências → recontagem / perda / ajuste
```

Fases:
1. [ ] Tabela `contagens_fisicas` (id, data, produto_id, qtd_contada, usuario_id)
2. [ ] Tela de importação/entrada de contagem (CSV + manual)
3. [ ] Cálculo do teórico por produto com drill-down das origens
4. [ ] Tela de divergências com ações: recontagem / perda / ajuste
5. [ ] Histórico de auditorias com evolução da acuracidade

---

## 7. PRIORIZAÇÃO SUGERIDA

| # | Item | Módulo | Esforço | Impacto |
|---|------|--------|---------|---------|
| 1 | Bug validade "vendido" volta | Validade | Baixo | Alto |
| 2 | Limpeza faturas competência concatenada | DRE/CC | Baixo | Médio |
| 3 | Conciliação pagamento ↔ fatura | CC | Médio | Alto |
| 4 | Auditoria de estoque fases 1-3 | Estoque | Alto | Alto |
| 5 | Regras auto-classificação persistentes | DRE | Médio | Alto |
| 6 | Margem real por produto | Vendas | Médio | Alto |
| 7 | Notificação validade diária | Validade | Médio | Médio |
| 8 | Orçado vs Realizado | DRE | Médio | Médio |
| 9 | Parcelas futuras projetadas | CC | Médio | Médio |
| 10 | Análise de cesta / kits | Vendas | Alto | Médio |

---

## 8. REGRAS DE OURO (aprendidas em produção)

1. PDV é a fonte de verdade do estoque — sistema não desconta estoque em retiradas.
2. Fonte de verdade das faturas CC = tabela `cartao_faturas`, não localStorage.
3. Modo Caixa vs Competência: respeitar `getModo()` em qualquer cálculo novo do DRE.
4. Exclusão em massa exige rota dedicada com confirmação — nunca DELETE sem WHERE auditável.
5. Deploy = push na main = produção. `node --check` SEMPRE antes do push.
