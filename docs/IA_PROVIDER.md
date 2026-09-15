# Provedor de IA — Sistema Bom Beef

## Regra atual

- Integrações novas de IA devem usar OpenAI, nunca Anthropic/Claude.
- Variável de ambiente: `OPENAI_API_KEY`.
- Modelo padrão para extração documental de baixo custo: `gpt-5.6-luna`.
- O modelo pode ser sobrescrito por `OPENAI_PDF_MODEL`.
- Funções financeiras críticas devem preferir regras determinísticas; IA é apoio/fallback, não autoridade contábil.
- Nenhuma gravação financeira deve depender apenas da resposta de IA sem validação determinística.

## Observação de cobrança

A API da OpenAI possui faturamento separado da assinatura do ChatGPT. A aplicação em produção precisa de uma chave de API com saldo/faturamento habilitado.
