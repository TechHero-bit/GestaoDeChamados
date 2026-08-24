# Help Desk Backend

Backend do sistema de Help Desk — Node.js + Express + Supabase.

## Pré-requisitos

- Node.js 20+
- Projeto Supabase configurado com as migrations executadas

## Instalação

```bash
cd backend
npm install
```

## Configuração

Copie o arquivo de exemplo e preencha com suas credenciais:

```bash
cp .env.example .env
```

Variáveis obrigatórias:

| Variável                      | Descrição                                         |
| ----------------------------- | ------------------------------------------------- |
| `PORT`                        | Porta do servidor (padrão: 3000)                  |
| `SUPABASE_URL`                | URL do projeto Supabase                           |
| `SUPABASE_SECRET_KEY`         | Service role key do Supabase                      |
| `WEBHOOK_SECRET`              | Segredo para autenticação do webhook              |
| `FRONTEND_URL`                | URL do frontend para CORS                         |
| `POWER_AUTOMATE_REPLY_URL`    | URL do fluxo de saída do Power Automate           |
| `POWER_AUTOMATE_REPLY_SECRET` | Segredo para autenticação do fluxo de saída       |
| `HELPDESK_EMAIL`              | Caixa corporativa usada no registro das mensagens |

## Executar

```bash
# Desenvolvimento (hot reload)
npm run dev

# Produção
npm start
```

O processo pode iniciar sem credenciais para disponibilizar `/health`, mas endpoints que acessam dados retornam indisponibilidade até o Supabase estar configurado.

## Endpoints

| Método | Rota                     | Descrição                        |
| ------ | ------------------------ | -------------------------------- |
| GET    | `/health`                | Health check                     |
| POST   | `/api/webhooks/outlook`  | Receber e-mail do Power Automate |
| GET    | `/api/tickets`           | Listar tickets                   |
| GET    | `/api/tickets/:id`       | Buscar ticket com mensagens      |
| PUT    | `/api/tickets/:id`       | Atualizar status                 |
| DELETE | `/api/tickets/:id`       | Excluir ticket                   |
| POST   | `/api/tickets/:id/reply` | Responder ao solicitante         |

`GET /api/tickets` aceita os parâmetros `status`, `search`, `date`, `page` e `pageSize`.

## Testes

```bash
npm test
```

Os testes cobrem o contrato HTTP que não depende de serviços externos. CRUD, idempotência e envio real devem ser validados em um projeto Supabase/Power Automate configurado.

## Debug

Pressione **F5** no VS Code para iniciar o debug com breakpoints.
