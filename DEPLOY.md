# Deploy no Railway — Passo a Passo

## Pré-requisitos
- Conta no [Railway.app](https://railway.app)
- Git instalado
- Node.js 18+ instalado localmente

---

## 1. Testar localmente antes do deploy

```bash
# 1. Instalar dependências
npm install

# 2. Criar .env local (copiar do exemplo)
cp .env.example .env
# Editar .env com DATABASE_URL e JWT_SECRET reais

# 3. Executar o schema no banco
psql $DATABASE_URL -f schema.sql

# 4. Criar usuários iniciais
npm run seed

# 5. Iniciar o servidor
npm start
# → Acesse: http://localhost:3000
```

---

## 2. Criar o projeto no Railway

1. Acesse [railway.app](https://railway.app) → **New Project**
2. Escolha **Deploy from GitHub repo**
3. Conecte sua conta GitHub e selecione o repositório
4. Railway detecta automaticamente Node.js

---

## 3. Adicionar PostgreSQL

1. No projeto Railway → **New** → **Database** → **Add PostgreSQL**
2. Railway cria a variável `DATABASE_URL` automaticamente
3. Clique no banco → aba **Connect** → copie a `DATABASE_URL` para uso local

---

## 4. Configurar variáveis de ambiente

No Railway → seu serviço → **Variables** → **Add Variable**:

| Variável       | Valor                                         |
|---------------|-----------------------------------------------|
| `DATABASE_URL` | (preenchida automaticamente pelo plugin PG)   |
| `JWT_SECRET`   | string longa e aleatória (mín. 32 chars)      |
| `NODE_ENV`     | `production`                                  |

**Gerar JWT_SECRET seguro:**
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## 5. Executar o schema SQL

No Railway → banco PostgreSQL → **Query** (ou via psql local):

```bash
# Via psql local (substitua pela sua DATABASE_URL do Railway)
psql postgresql://user:pass@host:5432/railway -f schema.sql
```

Ou copie e cole o conteúdo de `schema.sql` direto no editor SQL do Railway.

---

## 6. Criar usuários iniciais (seed)

Após o schema, rode localmente com a DATABASE_URL do Railway:

```bash
DATABASE_URL=postgresql://... npm run seed
```

Isso cria:
| E-mail                        | Senha         | Perfil    |
|-------------------------------|---------------|-----------|
| admin@bombeef.com.br          | gabriel1306   | admin     |
| financeiro@bombeef.com.br     | bombeef2026   | financeiro|
| estoque@bombeef.com.br        | estoque123    | estoque   |

**⚠️ Mude as senhas em produção!**

---

## 7. Deploy

```bash
git init
git add .
git commit -m "feat: sistema bom beef v2.0"
git remote add origin https://github.com/SEU_USUARIO/bombeef-sistema.git
git push -u origin main
```

Railway detecta o push e faz o deploy automaticamente.

---

## 8. Verificar funcionamento

Após deploy, acesse a URL gerada pelo Railway (ex: `https://bombeef-production.up.railway.app`):

- `GET /health` → deve retornar `{ "status": "ok" }`
- Tela de login → entre com `admin@bombeef.com.br` / `gabriel1306`

---

## 9. Primeira importação do TOTVS

1. Acesse o portal → módulo **Gestão de NF-e** ou via:
2. `POST /api/totvs/importar` com o arquivo CSV/XLSX do TOTVS Chef Web
3. O sistema detecta automaticamente as colunas e faz UPSERT de todos os produtos
4. Verifique o status em `GET /api/totvs/status`

---

## Estrutura do projeto

```
bombeef/
├── server.js            ← Entry point
├── package.json
├── schema.sql           ← DDL completo (rodar 1x antes do start)
├── seed.js              ← Cria usuários iniciais
├── .env.example         ← Template de variáveis
├── middleware/
│   └── auth.js          ← Verificação JWT
├── routes/
│   ├── auth.js          ← POST /auth/login, GET /auth/me, /usuarios
│   ├── produtos.js      ← GET/PATCH /api/produtos
│   ├── totvs.js         ← GET /api/totvs/status, POST /api/totvs/importar
│   ├── lotes.js         ← CRUD /api/lotes
│   ├── perdas.js        ← CRUD /api/perdas
│   ├── kits.js          ← CRUD /api/kits
│   ├── boletos.js       ← CRUD /api/boletos
│   ├── fornecedores.js  ← CRUD /api/fornecedores
│   └── dashboard.js     ← GET /api/dashboard, /api/dashboard/kpis
└── public/
    ├── index.html                    ← Portal principal (API mode)
    ├── nfe_boletos_bombeef.html      ← Módulo NF-e
    ├── classificador_bom_beef_v5.html← Módulo financeiro
    ├── bom_beef_validade.html        ← Módulo validades
    └── kit_precificacao.html         ← Módulo kits
```

---

## Endpoints da API

### Auth
| Método | Rota                | Perfis        | Descrição           |
|--------|---------------------|---------------|---------------------|
| POST   | /auth/login         | público       | Login, retorna JWT  |
| GET    | /auth/me            | qualquer      | Dados do usuário    |
| GET    | /auth/usuarios      | admin         | Lista usuários      |
| POST   | /auth/usuarios      | admin         | Cria usuário        |
| PUT    | /auth/usuarios/:id  | admin         | Edita usuário       |

### Produtos / TOTVS
| Método | Rota                       | Perfis        | Descrição              |
|--------|----------------------------|---------------|------------------------|
| GET    | /api/produtos              | todos         | Lista produtos         |
| GET    | /api/totvs/status          | todos         | Status da base         |
| POST   | /api/totvs/importar        | admin/gerente | Importa CSV/XLSX       |
| GET    | /api/totvs/historico       | admin/gerente | Histórico importações  |

### Estoque / Perdas
| Método | Rota                   | Perfis               | Descrição           |
|--------|------------------------|----------------------|---------------------|
| GET    | /api/lotes             | todos                | Lista lotes         |
| GET    | /api/lotes/alertas     | todos                | Lotes críticos      |
| POST   | /api/lotes             | estoque/operacao/+   | Novo lote           |
| PATCH  | /api/lotes/:id/baixa   | estoque/operacao/+   | Baixa de estoque    |
| GET    | /api/perdas            | todos                | Lista perdas        |
| POST   | /api/perdas            | estoque/operacao/+   | Registra perda      |

### Kits / Boletos
| Método | Rota              | Perfis         | Descrição          |
|--------|-------------------|----------------|--------------------|
| GET    | /api/kits         | todos          | Lista kits         |
| POST   | /api/kits         | admin/gerente  | Cria kit           |
| GET    | /api/boletos      | financeiro/+   | Lista boletos      |
| POST   | /api/boletos      | financeiro/+   | Cria boleto        |
| PATCH  | /api/boletos/:id/pagar | financeiro/+ | Registra pagamento |

### Dashboard
| Método | Rota                 | Perfis | Descrição        |
|--------|----------------------|--------|------------------|
| GET    | /api/dashboard       | todos  | KPIs + alertas   |
| GET    | /api/dashboard/kpis  | todos  | KPIs resumidos   |
