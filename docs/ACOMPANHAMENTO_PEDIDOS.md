# Agente de Acompanhamento — Sistema Bom Beef

Este arquivo é o registro vivo dos pedidos feitos pelo usuário no projeto Sistema Bom Beef.

## Regras de status
- PENDENTE: pedido registrado, ainda não iniciado.
- EM ANDAMENTO: implementação ou validação em curso.
- BLOQUEADO: depende de correção, acesso, dado externo ou decisão antes de continuar.
- FINALIZADO: implementado, publicado e verificado em produção.

## Fluxo do agente
1. Registrar cada novo pedido com ID sequencial.
2. Atualizar o status quando o trabalho começar.
3. Registrar observações, PR/commit/deploy quando existirem.
4. Só marcar FINALIZADO após validação real em produção.
5. Manter pedidos não concluídos visíveis até terem sequência ou serem cancelados pelo usuário.

## Pedidos atuais

| ID | Pedido | Status | Observação |
|---|---|---|---|
| BB-001 | Simplificar o Agente Financeiro para uma única tela com Processar agora, resumo, pendências e histórico | FINALIZADO | Publicado e validado em produção. A tela única processou 27 PDFs e exibiu resultado/pendências sem travar o lote. |
| BB-002 | Fazer o Agente Financeiro processar automaticamente faturas do Drive | EM ANDAMENTO | Lote automático funciona. No teste em produção: 27 PDFs, 4 processados, 65 lançamentos e 23 pendências. Próximo gargalo é leitura multibanco. |
| BB-003 | Corrigir leitura de faturas CAIXA que quebram lançamentos em mais de uma linha | PENDENTE | Casos reais ainda pendentes: fatura 06/2026 com divergência de R$ 189,03 e outra CAIXA com divergência de R$ 967,13. |
| BB-004 | Adicionar suporte a outros bancos e layouts de cartão | EM ANDAMENTO | Parser Itaú já entrou na main; C6 e outras variações ainda precisam ser concluídas e validadas. |
| BB-005 | Tratar corretamente créditos, descontos, estornos, cashback e abatimentos nas faturas | EM ANDAMENTO | Regra implantada; ainda precisa validação com várias faturas reais e também nos novos parsers Itaú/C6. |
| BB-006 | Manter faturas visíveis após importação para acompanhamento e fechamento | EM ANDAMENTO | Histórico está visível na tela única; ainda falta completar conciliação e fechamento automáticos. |
| BB-007 | Conciliar automaticamente lançamentos da fatura com NF/NFC-e/XML | PENDENTE | Próximo bloco funcional do Agente Financeiro após estabilizar leitura das faturas. |
| BB-008 | Conciliar automaticamente lançamentos da fatura com DRE e evitar duplicidade | PENDENTE | Ainda não concluído de ponta a ponta. |
| BB-009 | Identificar automaticamente o pagamento da fatura no extrato bancário | EM ANDAMENTO | PR #106 implementa identificação por texto + valor + período, unifica a categoria e mantém o pagamento bancário neutro. Aguarda validação real em produção. |
| BB-010 | Trabalhar por exceção: mostrar ao usuário apenas itens que precisam de decisão | EM ANDAMENTO | Tela única já concentra as pendências; ainda precisamos transformar mensagens técnicas em decisões simples quando os parsers multibanco estiverem prontos. |
| BB-011 | Criar agente de acompanhamento que registre todos os pedidos e marque concluídos/pendentes | FINALIZADO | Registro persistente criado e já está sendo atualizado a cada validação do projeto. |
| BB-012 | Fazer uma melhoria geral no DRE, principalmente visualização e tratamento dos lançamentos | EM ANDAMENTO | PRs #105, #108, #109, #111, #112, #113 e #114 publicados. Visual, conferência, lançamentos, fechamento mensal e motor único já estão em produção. Falta validar conciliação/planejamento do bloco final. |
| BB-013 | Unificar a regra de pagamento de cartão: pagamento total neutro e despesas pelos itens da fatura | EM ANDAMENTO | PR #106 está na main e a nova área de Conciliação torna o vínculo fatura ↔ pagamento visível. Aguarda validação real de casos da loja. |

| BB-014 | Criar fechamento mensal seguro do DRE com checklist, snapshot, bloqueio e reabertura auditada | FINALIZADO | PR #112 publicado e deploy validado com SUCCESS. |
| BB-015 | Unificar cálculo do DRE entre demonstrativo, cards e exportações | FINALIZADO | PRs #113 e #114 publicados e deploy validado com SUCCESS. |
| BB-016 | Criar planejamento anual projetado x realizado por categoria e mês | EM ANDAMENTO | Implementação no bloco final do DRE; persistência por loja e tela anual adicionadas na branch atual. |
| BB-017 | Criar visão de conciliação financeira dentro do DRE | EM ANDAMENTO | Implementação no bloco final: cartões, pagamento bancário, boletos e pendências em uma visão própria. |

## Regra estrutural — Cartões de crédito
- O débito bancário referente ao pagamento total da fatura é uma liquidação e NÃO é uma nova despesa do DRE.
- Os itens individuais da fatura são as despesas reais e mantêm categorias próprias.
- O pagamento total deve permanecer neutro mesmo enquanto aguarda vínculo com a fatura.
- Quando houver uma única fatura compatível por valor/período, o vínculo pode ser automático.
- Em caso de ambiguidade, o lançamento fica pendente de vínculo, sem entrar no resultado.

## Critério de conclusão do projeto
Uma tarefa só será considerada FINALIZADA quando estiver implementada, validada, publicada e verificada em produção.
