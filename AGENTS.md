# Agente de Desenvolvimento — Sistema de Gestão Bom Beef

## Missão

Manter e evoluir o sistema administrativo da Bom Beef, preservando as regras de negócio, a separação entre lojas, a segurança dos dados e a estabilidade da produção.

## Repositório e produção

- Repositório: `rvanjos/bombeef-web`
- Branch principal: `main`
- Produção: Railway com deploy automático após atualização da `main`
- Endpoint de saúde: `https://bombeef-web-production.up.railway.app/health`

## Escopo

Estas instruções se aplicam a todo o repositório.

## Fluxo obrigatório de desenvolvimento

1. Verificar o comportamento atual antes de alterar.
2. Identificar frontend, backend, banco de dados e regras de negócio afetados.
3. Verificar o estado da `main` e preservar mudanças existentes fora da tarefa.
4. Criar uma branch específica para a alteração.
5. Implementar a menor alteração segura que resolva a necessidade.
6. Executar testes, lint, verificação de tipos e build aplicáveis ao projeto.
7. Revisar permissões, autenticação e isolamento por loja.
8. Executar `node tests/multiloja.test.js` quando a alteração alcançar banco, autenticação, módulos operacionais ou dados segregados.
9. Executar `git diff --check` antes da publicação.
10. Criar commit e publicar a branch.
11. Criar pull request e integrar na `main` somente após as validações.
12. Aguardar o deploy automático do Railway.
13. Confirmar HTTP 200 em `/health` e na página inicial.
14. Informar o que foi alterado, o que foi testado, o resultado, o PR, o commit final e o estado da produção.

## Regras obrigatórias

- Nunca expor, copiar, registrar em logs ou solicitar tokens, senhas, `DATABASE_URL` ou outros segredos.
- Nunca apagar ou alterar dados de produção sem autorização específica do Rafael.
- Nunca fazer push direto na `main`; usar branch, pull request e merge.
- Nunca misturar dados entre lojas.
- Preservar `loja_id`, o contexto da loja ativa e o isolamento multi-loja.
- Não remover registros para resolver conflitos de migração sem autorização específica.
- Não duplicar regras financeiras, cálculos, lançamentos ou fontes de dados.
- Pedidos cancelados não entram nos indicadores de vendas; devem permanecer identificados no histórico.
- Preservar alterações existentes que não façam parte da tarefa.
- Não ampliar o escopo com funcionalidades não solicitadas.
- Preferir migrações idempotentes e compatíveis com bancos já existentes.
- Manter o sistema funcional em desktop e celular quando houver alteração de interface.
- Reutilizar o design system e os componentes existentes.
- Não considerar apenas o código local como prova de conclusão: verificar o resultado publicado.

## Tratamento de incidentes

- Em caso de erro em produção, priorizar diagnóstico e correção mínima.
- Consultar logs e identificar a etapa exata da falha antes de aplicar correções adicionais.
- Não ocultar falhas de migração indispensáveis à funcionalidade.
- Se uma correção não resolver o problema, reabrir o diagnóstico com evidências novas.
- Preservar banco, documentos, anexos e histórico durante a recuperação.

## Critério de conclusão

Uma tarefa somente está concluída quando foi implementada, validada, publicada e verificada em produção, salvo quando Rafael pedir somente análise ou diagnóstico.

Se houver bloqueio de permissão, credencial, serviço externo ou decisão de negócio que altere materialmente o resultado, interromper a execução e solicitar orientação objetiva.
