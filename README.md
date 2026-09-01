# Helpdesk Central

Sistema corporativo de gestão de chamados integrado ao Microsoft Outlook, Power Automate, Supabase (PostgreSQL) e interface moderna em Angular com Tailwind CSS baseada nas telas do Stitch. Inclui sistema completo de autenticação com JWT via cookies HttpOnly, sessões seguras com expiração por inatividade (10 minutos), autorização por perfil (RBAC), rate limiting distribuído e arquitetura serverless pronta para deploy na Vercel.

---

## Arquitetura Geral

```text
                     INTERNET
                         │
              ┌──────────┴──────────┐
              │                     │
              ▼                     ▼
        Vercel Frontend       Vercel Backend
            Angular              Express
              │                     │
              │  Cookie HttpOnly    │
              └────────────────────►│
                                    │
                         ┌──────────┴──────────┐
                         │                     │
                         ▼                     ▼
                     Supabase               Upstash
                    PostgreSQL               Redis
                         │               (Rate Limiting
               ┌─────────┴─────────┐      Distribuído)
               │                   │
             users           user_sessions
             tickets
          ticket_messages


                ENTRADA DE CHAMADOS

Outlook
   ↓
Power Automate
   ↓
Webhook Secret (x-webhook-secret)
   ↓
Express
   ↓
Supabase


                 RESPOSTA AO CLIENTE

Usuário autenticado (Cookie HttpOnly)
   ↓
Angular
   ↓
Express (/api/tickets/:id/reply)
   ↓
Power Automate
   ↓
Outlook
   ↓
Solicitante
```

---

## Estrutura do Monorepo

```text
GestaoDeChamados/
├── Backend/                 API Node.js/Express (ES Modules, JWT, jose, bcrypt, serverless)
│   ├── api/index.js         Entrypoint serverless para Vercel Functions
│   ├── scripts/             Script CLI para criação segura de administradores
│   ├── src/                 Controllers, services, middlewares, schemas Zod, rotas
│   ├── test/                Suíte de testes automatizados (node --test)
│   └── vercel.json          Configuração de rotas e rewrites da Vercel
├── Frontend/                Aplicação Angular standalone + Tailwind CSS
│   ├── src/                 Páginas (/login, /tickets), guards, interceptors, services
│   └── vercel.json          Rewrites para roteamento SPA no Angular
├── database/migrations/     Migrations SQL versionadas para Supabase
└── README.md                Documentação completa do projeto e deploy
```

---

## 1. Banco de Dados (Supabase)

Execute no SQL Editor do Supabase, rigorosamente nesta ordem:

1. `database/migrations/001_create_tickets.sql`
2. `database/migrations/002_create_ticket_messages.sql`
3. `database/migrations/003_create_users.sql`
4. `database/migrations/004_create_user_sessions.sql`
5. `database/migrations/005_audit_and_security.sql`
6. `database/migrations/006_add_outlook_threading.sql`
7. `database/migrations/007_create_microsoft_oauth.sql`

### Estrutura das Tabelas Principais:
- **`users`**: Armazena colaboradores (`nome`, `email`, `password_hash`, `role: ADMIN | AGENT`, `ativo`, `ultimo_login`).
- **`user_sessions`**: Gerencia sessões ativas (`user_id`, `jti`, `last_activity_at`, `expires_at`, `revoked_at`).
- **`tickets`**: Dados principais do chamado (`assunto`, `remetente_email`, `status`, `outlook_message_id`).
- **`ticket_messages`**: Timeline de mensagens com suporte ao campo `created_by` para auditoria.

---

## 2. Inicialização do Primeiro Administrador

Para inicializar o primeiro usuário administrador com segurança (sem credenciais fixas no Git):

```bash
cd Backend
npm install
npm run create-admin
```

O script interativo solicitará:
1. Nome do administrador;
2. E-mail corporativo;
3. Senha (mínimo 8 caracteres) — será feito o hash com `bcryptjs` (salt rounds = 12).

---

## 3. Execução Local

### Backend

```bash
cd Backend
npm install
cp .env.example .env
npm run dev
```

Variáveis do `.env`:

| Variável | Descrição |
| --- | --- |
| `NODE_ENV` | `development` ou `production` |
| `PORT` | Porta da API; padrão `3000` |
| `SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_SECRET_KEY` | Chave `service_role` (nunca expor no frontend) |
| `WEBHOOK_SECRET` | Segredo para autenticar webhook do Outlook |
| `JWT_SECRET` | Segredo JWT com no mínimo 32 caracteres |
| `JWT_COOKIE_NAME` | Nome do cookie de sessão (padrão `helpdesk_session`) |
| `COOKIE_SAME_SITE` | `lax` (desenvolvimento) ou `none` (produção cross-site) |
| `SESSION_IDLE_TIMEOUT_MINUTES` | Limite de inatividade (padrão `10`) |
| `SESSION_ABSOLUTE_TIMEOUT_HOURS` | Limite máximo da sessão (padrão `8`) |
| `FRONTEND_URL` | Origem liberada no CORS (ex: `http://localhost:4200`) |
| `ALLOW_VERCEL_PREVIEWS` | `true` ou `false` para permitir previews da Vercel |
| `POWER_AUTOMATE_REPLY_URL` | URL HTTP do fluxo de saída do Power Automate |
| `POWER_AUTOMATE_REPLY_SECRET` | Segredo do fluxo de saída |
| `HELPDESK_EMAIL` | E-mail corporativo do Help Desk |
| `UPSTASH_REDIS_REST_URL` | URL do Upstash Redis (rate limiting distribuído) |
| `UPSTASH_REDIS_REST_TOKEN` | Token do Upstash Redis |

A API iniciará em `http://localhost:3000`; o health check está em `GET /health`.

### Frontend

```bash
cd Frontend
npm install
npm start
```

Abra `http://localhost:4200`.

---

## 4. Endpoints da API

| Método | Rota | Autenticação | Descrição |
| --- | --- | --- | --- |
| `GET` | `/health` | Pública | Health check da API |
| `POST` | `/api/auth/login` | Pública (Rate Limit 5/15m) | Login com e-mail/senha, emite cookie HttpOnly |
| `POST` | `/api/auth/logout` | Autenticada | Revoga sessão server-side e limpa cookie |
| `GET` | `/api/auth/me` | Autenticada | Retorna dados do usuário autenticado |
| `POST` | `/api/auth/activity` | Autenticada | Touch de atividade throttled |
| `POST` | `/api/webhooks/outlook` | `x-webhook-secret` | Recebe novos e-mails do Power Automate |
| `GET` | `/api/tickets` | Autenticada (Rate Limit) | Lista e filtra chamados |
| `GET` | `/api/tickets/:id` | Autenticada | Retorna ticket e histórico de mensagens |
| `PUT` | `/api/tickets/:id` | Autenticada | Atualiza o status do chamado |
| `DELETE` | `/api/tickets/:id` | Autenticada (Apenas `ADMIN`) | Exclui chamado e mensagens associadas |
| `POST` | `/api/tickets/:id/reply` | Autenticada (Rate Limit 10/min) | Envia resposta ao solicitante via Outlook |
| `GET` | `/api/integrations/microsoft/connect` | Autenticada | Inicia conexão OAuth da conta Microsoft do usuário |
| `GET` | `/api/integrations/microsoft/callback` | Microsoft OAuth | Finaliza OAuth e persiste tokens cifrados |
| `GET` | `/api/integrations/microsoft/status` | Autenticada | Retorna somente status e identidade conectada |
| `POST` | `/api/integrations/microsoft/disconnect` | Autenticada | Revoga a conexão local |

---

## 5. Deploy na Vercel

O mesmo repositório Git alimenta dois projetos independentes na Vercel:

### Projeto 1 — Frontend (Angular)

1. No dashboard da Vercel, clique em **Add New... > Project** e selecione o repositório.
2. Em **Root Directory**, defina: `Frontend`.
3. O framework preset será detectado automaticamente como **Angular**.
4. Em **Build Command**: `ng build` (padrão).
5. Em **Output Directory**: `dist/frontend/browser` (padrão Angular 22).
6. Configure as variáveis de ambiente necessárias (ex: `NG_APP_API_URL` caso utilize proxy reverso ou subdomínio).
7. Clique em **Deploy**.

### Projeto 2 — Backend (Express Serverless)

1. No dashboard da Vercel, clique em **Add New... > Project** e importe o **mesmo** repositório Git.
2. Em **Root Directory**, defina: `Backend`.
3. O framework preset pode permanecer como **Other** (Node.js Serverless).
4. Configure as seguintes **Environment Variables** no projeto:
   - `NODE_ENV=production`
   - `SUPABASE_URL=https://xxxx.supabase.co`
   - `SUPABASE_SECRET_KEY=eyJhbGciOi...`
   - `WEBHOOK_SECRET=sua-chave-webhook`
   - `JWT_SECRET=chave-secreta-jwt-com-mais-de-32-caracteres`
   - `JWT_COOKIE_NAME=helpdesk_session`
   - `COOKIE_SAME_SITE=none` (se frontend e backend estiverem em subdomínios diferentes) ou `lax` (se utilizarem o mesmo domínio)
   - `SESSION_IDLE_TIMEOUT_MINUTES=10`
   - `SESSION_ABSOLUTE_TIMEOUT_HOURS=8`
   - `FRONTEND_URL=https://seu-frontend.vercel.app`
   - `ALLOW_VERCEL_PREVIEWS=true` (opcional, para testes de preview)
   - `POWER_AUTOMATE_REPLY_URL=https://prod-xx.brazilsouth.logic.azure.com/...`
   - `POWER_AUTOMATE_REPLY_SECRET=seu-segredo-de-resposta`
   - `HELPDESK_EMAIL=helpdesk@empresa.com`
   - `UPSTASH_REDIS_REST_URL=https://xxxx.upstash.io`
   - `UPSTASH_REDIS_REST_TOKEN=AXXXXX...`
5. Clique em **Deploy**.

---

## 6. Checklist de Homologação e Produção

- [ ] Git atualizado e sem arquivos `.env` ou secrets versionados
- [ ] Build de produção do Frontend passa (`npm run build` em `Frontend/`)
- [ ] Backend passa em todos os testes automatizados (`npm test` em `Backend/`)
- [ ] Migrations 001 a 005 executadas no Supabase
- [ ] Primeiro administrador criado com `npm run create-admin`
- [ ] Projeto Frontend criado na Vercel com Root Directory `Frontend`
- [ ] Projeto Backend criado na Vercel com Root Directory `Backend`
- [ ] `SUPABASE_SECRET_KEY` configurada **exclusivamente** no Backend
- [ ] `JWT_SECRET` configurada **exclusivamente** no Backend
- [ ] Upstash Redis configurado no Backend para rate limiting distribuído
- [ ] `FRONTEND_URL` apontando para o domínio oficial do frontend
- [ ] Cookies `HttpOnly` e `Secure` validados em produção
- [ ] Login e validação de credenciais testados
- [ ] Logout revogando a sessão e limpando o cookie testado
- [ ] Timeout de 10 minutos de inatividade testado (frontend e backend)
- [ ] Atualização de página (F5) mantendo a sessão do usuário
- [ ] Bloqueio de acesso a páginas privadas via Guard e botão voltar
- [ ] Webhook do Outlook (`/api/webhooks/outlook`) funcionando com `x-webhook-secret`
- [ ] Resposta ao chamado (`/api/tickets/:id/reply`) enviando e-mail via Power Automate
- [ ] Exclusão de tickets restrita ao perfil `ADMIN`

### Microsoft OAuth

A primeira etapa da integração Outlook permite conectar a conta Microsoft individual de cada usuário. Configure as cinco variáveis `MICROSOFT_*` no backend e registre no Microsoft Entra o redirect URI `https://gestao-de-chamados-backend.vercel.app/api/integrations/microsoft/callback`. Execute a migration 007 manualmente no Supabase; nenhum deploy ou migration é executado automaticamente.
