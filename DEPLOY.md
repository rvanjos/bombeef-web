# Deploy — Bom Beef Sistema de Gestão

## Pré-requisitos

- Conta no [GitHub](https://github.com)
- Conta no [Railway](https://railway.app)
- Node.js 18+ instalado localmente

---

## 1. Configurar o repositório GitHub

```bash
# Clone ou crie o repositório
git init bombeef-gestao
cd bombeef-gestao

# Copie todos os arquivos do projeto aqui
# (server.js, routes/, public/, middleware/, package.json, etc.)

# Commit inicial
git add .
git commit -m "feat: sistema de gestão integrado v1.0"

# Suba para o GitHub
git remote add origin https://github.com/SEU_USUARIO/bombeef-gestao.git
git push -u origin main
```

---

## 2. Criar projeto no Railway

1. Acesse [railway.app](https://railway.app) e faça login
2. Clique em **New Project**
3. Selecione **Deploy from GitHub repo**
4. Autorize e selecione o repositório `bombeef-gestao`
5. Railway irá detectar Node.js automaticamente

---

## 3. Adicionar PostgreSQL

1. No projeto Railway, clique em **+ Add Service**
2. Selecione **Database → PostgreSQL**
3. A variável `DATABASE_URL` é injetada automaticamente

---

## 4. Configurar variáveis de ambiente

No painel do Railway, vá em **Variables** e adicione:

| Variável        | Valor                                          |
|-----------------|------------------------------------------------|
| `JWT_SECRET`    | String aleatória longa (veja abaixo)          |
| `JWT_EXPIRES_IN`| `8h`                                           |
| `NODE_ENV`      | `production`                                   |
| `UPLOAD_MAX_MB` | `15`                                           |
| `ADMIN_EMAIL`   | `admin@bombeef.com.br`                         |
| `ADMIN_SENHA`   | Senha forte para o admin inicial               |

**Gerar JWT_SECRET seguro:**
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## 5. Seed inicial (opcional)

Após o primeiro deploy, rode o seed para criar o admin e dados iniciais:

```bash
# Via Railway CLI
railway run node seed.js

# Ou localmente com DATABASE_URL do Railway
DATABASE_URL="..." node seed.js
```

---

## 6. Deploy automático

Após a configuração, todo push para `main` dispara deploy automático:

```bash
git add .
git commit -m "feat: nova funcionalidade"
git push
# Railway faz deploy automático em ~2 minutos
```

---

## 7. Acessar o sistema

Após o deploy, Railway fornece uma URL pública como:
`https://bombeef-gestao-production.up.railway.app`

**Primeiro acesso:**
- E-mail: valor de `ADMIN_EMAIL`
- Senha: valor de `ADMIN_SENHA`

---

## Estrutura de arquivos esperada

```
/
├── server.js
├── package.json
├── seed.js
├── .env.example
├── middleware/
│   └── auth.js
├── routes/
│   ├── auth.js
│   ├── boletos.js
│   ├── dre.js
│   ├── produtos.js
│   ├── kits.js
│   ├── validade.js
│   ├── perdas.js
│   ├── retiradas.js
│   ├── config.js
│   └── dashboard.js
└── public/
    ├── index.html
    ├── boletos.html
    ├── dre.html
    ├── produtos.html
    ├── validade.html
    ├── retiradas.html
    ├── config.html
    └── js/
        └── api.js
```

---

## Desenvolvimento local

```bash
# Instalar dependências
npm install

# Copiar .env.example
cp .env.example .env
# Editar .env com suas credenciais locais

# Criar banco local (PostgreSQL)
createdb bombeef

# Rodar o seed
node seed.js

# Iniciar em modo desenvolvimento
npm run dev
# Acesse: http://localhost:3000
```

---

## Troubleshooting

**Erro de conexão com banco:**
- Verifique se `DATABASE_URL` está correto
- Railway: confirme que o PostgreSQL está no mesmo projeto

**Erro 401 em todas as requisições:**
- Verifique se `JWT_SECRET` está configurado
- Limpe sessionStorage do navegador e faça login novamente

**Upload de arquivo falha:**
- Verifique `UPLOAD_MAX_MB` (padrão: 15MB)
- Confirme que o arquivo está no formato correto

**Tabelas não criadas:**
- As tabelas são criadas automaticamente na inicialização
- Verifique os logs do Railway para erros de SQL
