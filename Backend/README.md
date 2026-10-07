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
| POST   | `/api/tickets/:id/reply/draft` | Criar reply draft com manifesto de anexos |
| POST   | `/api/tickets/:id/reply/draft/attachments` | Adicionar um anexo menor que 3 MiB |
| POST   | `/api/tickets/:id/reply/draft/upload-session` | Criar sessão Graph para um anexo grande |
| POST   | `/api/tickets/:id/reply/draft/send` | Validar anexos e enviar o draft |
| POST   | `/api/tickets/:id/reply/draft/cancel` | Excluir um draft abandonado |

`GET /api/tickets` aceita os parâmetros `status`, `search`, `date`, `page` e `pageSize`.

## Testes

```bash
npm test
```

Os testes cobrem o contrato HTTP que não depende de serviços externos. CRUD, idempotência e envio real devem ser validados em um projeto Supabase/Power Automate configurado.

## Debug

Pressione **F5** no VS Code para iniciar o debug com breakpoints.

## Integração Microsoft Outlook (OAuth)

A migration `database/migrations/007_create_microsoft_oauth.sql` cria `user_microsoft_connections` (uma conexão por usuário) e `microsoft_oauth_states` (state com hash, expiração e uso único). Execute-a após as migrations anteriores, manualmente no SQL Editor do Supabase.

Configure no backend: `MICROSOFT_CLIENT_ID`, `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_REDIRECT_URI` e `MICROSOFT_TOKEN_ENCRYPTION_KEY`. A última é exclusiva da integração e é derivada para uma chave AES-256-GCM; não reutilize segredos JWT, webhook ou Power Automate.

Rotas autenticadas: `GET /api/integrations/microsoft/connect`, `GET /api/integrations/microsoft/status` e `POST /api/integrations/microsoft/disconnect`. O callback `GET /api/integrations/microsoft/callback` é público por necessidade do OAuth, mas só aceita state válido, vinculado ao usuário e de uso único.

Os tokens permanecem no backend, cifrados no Supabase, e nunca são devolvidos ao frontend. O disconnect marca `revoked_at`; a revogação da sessão Microsoft não é chamada nesta etapa, pois não há endpoint Graph necessário para isso.

### Anexos em respostas

O frontend envia inicialmente apenas a mensagem e o manifesto dos arquivos. Anexos menores que 3 MiB passam individualmente pelo backend; anexos de 3 a 150 MiB usam `createUploadSession` e são enviados pelo navegador diretamente à capability URL temporária do Microsoft Graph em chunks de 3.276.800 bytes. O draft só é enviado depois que o backend lista e confere todos os anexos reais no Graph.

O handle do draft é assinado com a `JWT_SECRET` já existente, expira em duas horas e é vinculado ao usuário autenticado, ticket, mensagem e manifesto. Não há migration ou variável de ambiente adicional para esse fluxo. A capability URL não deve ser registrada em logs nem armazenada no navegador.
## Anexos recebidos do Outlook

A migration manual [009_create_ticket_message_attachments.sql](../database/migrations/009_create_ticket_message_attachments.sql) deve ser executada **uma vez**, depois das migrations anteriores. Ela cria `ticket_message_attachments`, seus índices e RLS, além do bucket privado `AnexosChamados`. Não altera migrations existentes, não transfere dados e não torna nenhum bucket público.

O bucket mantém o limite configurado no projeto Supabase. Antes de habilitar o Flow, confira no Dashboard do Supabase o *Global file size limit* e o limite específico do bucket; ambos devem acomodar o tamanho corporativo que será aceito. O backend valida metadados até 5 GiB, mas não pode aumentar os limites remotos por conta própria.

### Contrato do fluxo de entrada

`POST /api/webhooks/outlook` continua autenticado por `x-webhook-secret`. O JSON inicial não transporta `contentBytes`:

```json
{
  "message_id": "<id da mensagem Outlook>",
  "conversation_id": "<conversation id>",
  "remetente_email": "cliente@empresa.com",
  "remetente_nome": "Cliente",
  "assunto": "Contrato (chamado)",
  "corpo_mensagem": "Segue o arquivo.",
  "data_recebimento": "2026-09-14T12:00:00.000Z",
  "attachments": [
    {
      "attachment_id": "<id estável do Outlook>",
      "file_name": "contrato.pdf",
      "content_type": "application/pdf",
      "file_size": 1468006,
      "is_inline": false,
      "content_id": null
    }
  ]
}
```

A resposta inclui `ticket_id`, `message_id` e um item por anexo. Um arquivo pendente recebe uma capacidade temporária `upload`; ela é destinada **somente ao Power Automate**, não ao frontend:

- `strategy: "standard"`: faça `PUT` diretamente em `upload.url`, com os headers retornados e o corpo binário do arquivo.
- `strategy: "resumable"`: use TUS no `upload.endpoint`, com os headers retornados, `Upload-Length: upload.upload_length` e chunks de `upload.chunk_size` (6 MiB). Depois do `POST` inicial, envie cada chunk por `PATCH` ao header `Location`, com `Tus-Resumable: 1.0.0`, `Upload-Offset` e `Content-Type: application/offset+octet-stream`.

Após o Storage concluir a escrita, o mesmo Flow chama `POST /api/webhooks/outlook/attachments/complete` com:

```json
{ "message_id": "<id da mensagem Outlook>", "attachment_id": "<id do Outlook>" }
```

Se o upload não puder ser concluído, use um ramo *run after = failed/timed out* para chamar `POST /api/webhooks/outlook/attachments/fail` com os mesmos identificadores e `failure_code` igual a `UPLOAD_FAILED`, `SOURCE_UNAVAILABLE` ou `CONTENT_UNAVAILABLE`. A mensagem permanece na timeline e o anexo é exibido como indisponível; o sistema não afirma que um arquivo inexistente está disponível.

### Configuração manual do Power Automate

Use o fluxo de entrada já existente, sem criar outro fluxo:

1. Mantenha o gatilho **Quando um novo email é recebido (V3)** e os campos atuais de mensagem.
2. Para cada item de **Obter anexos (V2)**, chame **Obter anexo (V2)** com o `Message Id` do gatilho e o `Attachment Id` do item. A ação retorna `id`, `name`, `contentType`, `size`, `contentBytes`, `isInline` e `contentId`.
3. Monte o array `attachments` somente com `id/name/contentType/size/isInline/contentId` e faça o POST inicial acima. Não inclua `contentBytes` nesse POST nem em logs/variáveis persistidas.
4. Para cada item retornado pelo backend, associe-o pelo `attachment_id` ao resultado de **Obter anexo (V2)**. Para `standard`, a ação HTTP deve enviar `base64ToBinary(contentBytes)` diretamente à URL assinada. Preserve o header `Content-Type` retornado.
5. Para `resumable`, configure no **mesmo** fluxo as etapas TUS descritas acima. O conector HTTP genérico precisa conseguir enviar `POST`/`PATCH`, ler `Location`, controlar `Upload-Offset` e produzir chunks binários alinhados a Base64. Se o ambiente do Flow não permitir isso de forma confiável, não envie o arquivo ao backend como fallback: habilite uma etapa/worker compatível com TUS no fluxo existente antes de aceitar anexos maiores que 6 MiB.
6. Só chame `complete` após a última confirmação do Storage. Configure o ramo de falha conforme a seção anterior.

A ação HTTP usada para upload direto pode exigir licença Premium do Power Automate. Os anexos nunca passam pela Vercel: o JSON de metadados continua abaixo do parser de 100 KB e o binário vai do Flow para o Supabase Storage. Isso evita o limite de payload da Function.

### Leitura no SmartDesk

`GET /api/tickets/:id` devolve cada mensagem com `attachments: []` ou metadados seguros (`id`, nome, MIME, tamanho, `is_inline`, status); `storage_path`, token e URL assinada não são expostos. Imagens CID (`is_inline: true`) são preservadas no banco e exibidas como arquivos na timeline e na seção lateral Anexos. O corpo permanece em texto simples.

O frontend abre ou baixa arquivos disponíveis por `GET /api/tickets/:ticketId/attachments/:attachmentId[?download=1]`. A rota exige a sessão existente, confirma que o anexo pertence ao ticket solicitado e só então redireciona para uma URL privada temporária de 60 segundos.

## Atribuição de responsáveis

Execute manualmente a migration 010_add_ticket_assignee.sql após a 009 antes de publicar esta versão. Ela adiciona tickets.responsavel_id, uma chave estrangeira para users com ON DELETE SET NULL e um índice. Chamados existentes começam sem responsável.

GET /api/tickets/responsaveis exige autenticação e retorna somente id, nome e e-mail de administradores ativos. PUT /api/tickets/:id aceita responsavel_id como UUID de administrador ativo ou null para remover a atribuição, junto de status e prioridade. Administradores inativos, agentes e usuários inexistentes são rejeitados. As consultas de chamados incluem responsavel_id e o objeto responsavel com id, nome, e-mail, perfil e situação, sem dados de autenticação.
