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
| BB-001 | Simplificar o Agente Financeiro para uma única tela com Processar agora, resumo, pendências e histórico | EM ANDAMENTO | PR #100 publicado; aguarda verificação do deploy e teste funcional em produção. |
| BB-002 | Fazer o Agente Financeiro processar automaticamente faturas do Drive | EM ANDAMENTO | Fluxo automático iniciado; leitura CAIXA ainda precisa suportar todos os layouts/meses. |
| BB-003 | Corrigir leitura de faturas CAIXA que quebram lançamentos em mais de uma linha | PENDENTE | Caso identificado: fatura 06/2026 perdeu lançamento de R$ 189,03. |
| BB-004 | Adicionar suporte a faturas de outros bancos, começando pelo C6 Bank/C6 Carbon | PENDENTE | Layout C6 identificado, parser específico ainda não concluído. |
| BB-005 | Tratar corretamente créditos, descontos, estornos, cashback e abatimentos nas faturas | EM ANDAMENTO | Regra implantada; ainda precisa validação com várias faturas reais. |
| BB-006 | Manter faturas visíveis após importação para acompanhamento e fechamento | EM ANDAMENTO | Central criada, mas fluxo principal está sendo consolidado na nova tela simplificada. |
| BB-007 | Conciliar automaticamente lançamentos da fatura com NF/NFC-e/XML | PENDENTE | Próximo bloco funcional do Agente Financeiro. |
| BB-008 | Conciliar automaticamente lançamentos da fatura com DRE e evitar duplicidade | PENDENTE | Ainda não concluído de ponta a ponta. |
| BB-009 | Identificar automaticamente o pagamento da fatura no extrato bancário | PENDENTE | Backend possui recursos de status/pagamento, mas automação completa ainda não foi finalizada. |
| BB-010 | Trabalhar por exceção: mostrar ao usuário apenas itens que precisam de decisão | PENDENTE | Faz parte do desenho final da tela única do Agente Financeiro. |
| BB-011 | Criar agente de acompanhamento que registre todos os pedidos e marque concluídos/pendentes | EM ANDAMENTO | Registro criado neste arquivo e passa a ser atualizado a partir de agora. |

## Critério de conclusão do projeto
Uma tarefa só será considerada FINALIZADA quando estiver implementada, validada, publicada e verificada em produção.
