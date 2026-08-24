# Helpdesk Central

Sistema interno de gestão de chamados recebidos pelo Microsoft Outlook. O Power Automate entrega os e-mails ao backend Express, o Supabase persiste tickets e mensagens, e a equipe atende os chamados por uma interface Angular baseada nas telas do Stitch.

## Arquitetura

```text
Entrada:  Outlook → Power Automate → Express → Supabase
Atendimento: Angular → Express → Supabase
Resposta: Angular → Express → Power Automate → Outlook → Solicitante
```

O frontend nunca acessa o Supabase diretamente. Segredos e a chave `service_role` permanecem somente no backend.

## Estrutura

```text
GestaoDeChamados/
├── Backend/             API Node.js/Express em JavaScript (ES Modules)
├── Frontend/            Angular standalone + Tailwind CSS
├── database/migrations/ migrations PostgreSQL/Supabase
└── README.md
```

## Requisitos

- Node.js 20 ou superior
- npm
- Projeto no Supabase
- Dois fluxos no Power Automate: entrada e saída de e-mail

## 1. Banco de dados

Execute no SQL Editor do Supabase, nesta ordem:

1. `database/migrations/001_create_tickets.sql`
2. `database/migrations/002_create_ticket_messages.sql`

As migrations criam os enums, tabelas, índices, trigger de atualização, relacionamento com exclusão em cascata e RLS restrita ao papel `service_role`.

## 2. Backend

```bash
cd Backend
npm install
cp .env.example .env
npm run dev
```

Preencha o `.env`:

| Variável                      | Uso                                               |
| ----------------------------- | ------------------------------------------------- |
| `PORT`                        | Porta da API; padrão `3000`                       |
| `SUPABASE_URL`                | URL do projeto Supabase                           |
| `SUPABASE_SECRET_KEY`         | Chave `service_role`; nunca usar no frontend      |
| `WEBHOOK_SECRET`              | Autentica o fluxo de entrada                      |
| `FRONTEND_URL`                | Origem liberada no CORS                           |
| `POWER_AUTOMATE_REPLY_URL`    | URL HTTP do fluxo de saída                        |
| `POWER_AUTOMATE_REPLY_SECRET` | Autentica o backend no fluxo de saída             |
| `HELPDESK_EMAIL`              | Caixa corporativa que envia e recebe as mensagens |

A API estará em `http://localhost:3000`; o health check é `GET /health`.

## 3. Frontend

```bash
cd Frontend
npm install
npm start
```

Abra `http://localhost:4200`. Em desenvolvimento, a API é centralizada em `src/environments/environment.development.ts`. A build de produção usa `/api`, adequada para um proxy/reverse proxy no mesmo domínio.

## Endpoints

| Método   | Rota                     | Descrição                     |
| -------- | ------------------------ | ----------------------------- |
| `GET`    | `/health`                | Estado da API                 |
| `POST`   | `/api/webhooks/outlook`  | Recebe e-mail do Outlook      |
| `GET`    | `/api/tickets`           | Lista e filtra chamados       |
| `GET`    | `/api/tickets/:id`       | Retorna ticket e timeline     |
| `PUT`    | `/api/tickets/:id`       | Atualiza o status             |
| `DELETE` | `/api/tickets/:id`       | Exclui ticket e mensagens     |
| `POST`   | `/api/tickets/:id/reply` | Envia e registra uma resposta |

A listagem aceita `status`, `search`, `date` (`AAAA-MM-DD`), `page` e `pageSize` (máximo 100).

## Power Automate — fluxo de entrada

1. Use o gatilho de novo e-mail do Outlook na caixa corporativa.
2. Prossiga somente se o assunto contiver `(chamado)`.
3. Adicione uma ação HTTP `POST` para `https://SEU_BACKEND/api/webhooks/outlook`.
4. Envie `Content-Type: application/json` e `x-webhook-secret` com o mesmo valor de `WEBHOOK_SECRET`.
5. Mapeie o corpo:

```json
{
  "message_id": "OUTLOOK-TESTE-0001",
  "remetente_email": "joao@empresa.com",
  "remetente_nome": "João Silva",
  "assunto": "(chamado) Computador não inicia",
  "corpo_mensagem": "Meu computador não está iniciando.",
  "data_recebimento": "2026-08-20T15:00:00Z"
}
```

O `message_id` é único. Repetir a entrega retorna `duplicate: true` sem criar outro ticket.

## Power Automate — fluxo de saída

Configure um segundo fluxo com gatilho HTTP. Valide `x-webhook-secret` contra `POWER_AUTOMATE_REPLY_SECRET`, use a ação “Enviar um e-mail” do Outlook e devolva uma resposta HTTP 2xx somente após o envio.

O backend envia:

```json
{
  "ticket_id": "UUID",
  "destinatario": "joao@empresa.com",
  "assunto": "RE: (chamado) Computador não inicia",
  "mensagem": "Olá João, estamos analisando seu chamado."
}
```

A mensagem de saída só é adicionada à timeline após o Power Automate confirmar o envio.

## Verificação

```bash
cd Backend
npm test

cd ../Frontend
npm run build
```

Os testes locais não exercitam serviços externos. Para validar o fluxo completo, aplique as migrations, configure `.env`, envie duas vezes o mesmo payload de entrada e responda ao ticket pela tela de detalhes.

## Escopo do MVP

Funcionam: listagem, busca, filtros, paginação, detalhe, timeline, alteração de status e resposta via Power Automate. Dashboard, relatórios, autenticação, atribuição, anexos, rascunhos, rich text e respostas rápidas estão preparados visualmente, mas permanecem desabilitados até suas integrações existirem.
