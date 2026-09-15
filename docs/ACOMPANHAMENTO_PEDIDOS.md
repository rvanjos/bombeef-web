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
| BB-004 | Adicionar suporte a outros bancos e layouts de cartão | EM ANDAMENTO | PDFs reais confirmados: Itaucard/Itaú Empresas e Fatura Empresas são Itaú; Cópia de Fatura com vencimento dia 15 usa layout C6. Precisamos seletor automático por banco + parsers Itaú e C6. |
| BB-005 | Tratar corretamente créditos, descontos, estornos, cashback e abatimentos nas faturas | EM ANDAMENTO | Regra implantada; ainda precisa validação com várias faturas reais e também nos novos parsers Itaú/C6. |
| BB-006 | Manter faturas visíveis após importação para acompanhamento e fechamento | EM ANDAMENTO | Histórico está visível na tela única; ainda falta completar conciliação e fechamento automáticos. |
| BB-007 | Conciliar automaticamente lançamentos da fatura com NF/NFC-e/XML | PENDENTE | Próximo bloco funcional do Agente Financeiro após estabilizar leitura das faturas. |
| BB-008 | Conciliar automaticamente lançamentos da fatura com DRE e evitar duplicidade | PENDENTE | Ainda não concluído de ponta a ponta. |
| BB-009 | Identificar automaticamente o pagamento da fatura no extrato bancário | PENDENTE | Backend possui recursos de status/pagamento, mas automação completa ainda não foi finalizada. |
| BB-010 | Trabalhar por exceção: mostrar ao usuário apenas itens que precisam de decisão | EM ANDAMENTO | Tela única já concentra as pendências; ainda precisamos transformar mensagens técnicas em decisões simples quando os parsers multibanco estiverem prontos. |
| BB-011 | Criar agente de acompanhamento que registre todos os pedidos e marque concluídos/pendentes | FINALIZADO | Registro persistente criado e já está sendo atualizado a cada validação do projeto. |

## Critério de conclusão do projeto
Uma tarefa só será considerada FINALIZADA quando estiver implementada, validada, publicada e verificada em produção.
