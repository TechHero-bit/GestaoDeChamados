# Módulo Assinaturas

O módulo transforma e-mails de onboarding em solicitações revisáveis de
assinatura corporativa. Ele é separado da assinatura pessoal dos usuários
administradores (`users.signature_*`) e não altera o fluxo já existente de
respostas aos chamados.

## Fluxo

1. O Power Automate envia o e-mail para `POST /api/webhooks/outlook` usando o
   mesmo `x-webhook-secret` atual.
2. O chamado e seus anexos continuam sendo criados normalmente.
3. Quando o assunto é exatamente
   `Centauro/Interno: Chamado - Onboarding de TI` (comparação sem diferenciar
   maiúsculas, acentos e espaços externos), o backend cria uma linha em
   `signature_requests`.
4. Nome, função e telefone são extraídos do corpo. O e-mail corporativo é
   sugerido com o primeiro nome e o último sobrenome, incluindo `de` somente
   quando ele aparece imediatamente antes do último sobrenome.
5. Imagens são pontuadas pelo tipo, nome, tamanho, `is_inline`, `Content-ID` e
   posição relativa ao início da assinatura do remetente. Uma foto só é
   escolhida automaticamente com alta confiança e distância suficiente da
   segunda candidata. Nos demais casos a solicitação fica em
   `Revisão necessária`.
6. Um usuário autenticado revisa os dados em `/signatures`, escolhe ou envia a
   fotografia e gera o PNG. Cada geração é gravada no histórico.

## Contrato do Power Automate

O payload atual permanece compatível. Para melhorar a distinção entre a foto
do colaborador e imagens da assinatura do RH, envie também `corpo_html` com o
HTML original do Outlook:

```json
{
  "message_id": "id estável da mensagem",
  "conversation_id": "id estável da conversa",
  "remetente_email": "rh@centaurotelecom.com.br",
  "remetente_nome": "Recursos Humanos",
  "assunto": "Centauro/Interno: Chamado - Onboarding de TI",
  "corpo_mensagem": "versão textual ou conteúdo já usado pelo fluxo",
  "corpo_html": "<html>conteúdo original, incluindo referências cid:</html>",
  "data_recebimento": "2026-10-14T18:00:00.000Z",
  "attachments": [
    {
      "attachment_id": "id estável do anexo",
      "file_name": "foto-colaborador.jpg",
      "content_type": "image/jpeg",
      "file_size": 245000,
      "is_inline": false,
      "content_id": null
    }
  ]
}
```

A resposta do webhook mantém os campos existentes e, apenas para onboarding,
acrescenta `signature_request_id` e `signature_request_duplicate`.

## Segurança e idempotência

- `source_outlook_message_id` é único e impede duplicação em retries do Flow.
- Todas as rotas `/api/signatures` exigem a sessão normal do SmartDesk.
- O bucket `AssinaturasColaboradores` é privado e só é acessado pela service
  role. Downloads passam por URLs assinadas de 60 segundos.
- `storage_path`, service key e HTML original não são devolvidos ao frontend.
- Uploads aceitam somente PNG, JPEG ou WebP com até 5 MiB.
- O PNG final é validado por assinatura binária e por dimensão exata
  (768 × 200 px) antes de ser persistido.
- E-mails são comparados com solicitações e usuários existentes. Um conflito
  bloqueia a geração até ser corrigido.

## Banco de dados

A migration revisável está em
`database/migrations/012_create_signature_requests.sql`. Ela cria:

- `signature_requests`: estado atual da solicitação;
- `signature_request_images`: candidatos e explicações da classificação;
- `signature_artifacts`: histórico imutável das gerações;
- bucket privado `AssinaturasColaboradores`.

Não execute a migration em produção sem revisão e autorização. A migration 008
e as assinaturas pessoais dos administradores não são modificadas.

## Modelo visual

O arquivo original permanece sem alteração em
`Frontend/public/assets/signatures/modelo-centauro-17.png`. Sua dimensão real
é **800 × 200 px**. O canvas desenha fundo, foto e textos no mesmo sistema de
coordenadas do original e reduz toda a composição horizontalmente para a
exportação exigida pelo módulo, **768 × 200 px**. A faixa gráfica, logotipo,
ícones, endereço e site continuam provenientes do PNG; apenas foto, nome,
função, telefone e e-mail são substituídos. A referência
`MODELO CENTAURO (18).png` também mede 800 × 200 px.

## Rotas

- `GET /api/signatures`
- `GET /api/signatures/:id`
- `PUT /api/signatures/:id`
- `GET /api/signatures/:id/images/:attachmentId`
- `GET|POST /api/signatures/:id/photo`
- `POST /api/signatures/:id/generate`
- `GET /api/signatures/:id/history/:artifactId`

## Ativação

1. Revisar e executar a migration 012 no ambiente desejado.
2. Confirmar que `SUPABASE_URL`, `SUPABASE_SECRET_KEY` e `WEBHOOK_SECRET`
   continuam configurados.
3. Adicionar `corpo_html` ao Flow (recomendado).
4. Publicar backend e frontend juntos, pois a página depende das novas tabelas.
5. Enviar um onboarding de teste com foto e assinatura completa do remetente.
6. Confirmar seleção manual em caso ambíguo e validar o PNG exportado.

## Diagnóstico da fotografia

Em cada item de Fotografia, o portal mostra o estado do anexo recebido
(Pendente, Disponivel ou Falhou) e o `processing_error` quando existir.
A seleção só é confirmada visualmente após a foto ser lida e decodificada.
O botão de geração informa a condição que ainda falta. A API serve as fotos
pela rota autenticada, lendo os buckets privados no servidor. O histórico
continua imutável e a assinatura pessoal dos administradores fica isolada.

`Baixar prévia de teste` exporta o canvas localmente, sem gravar artefato e
sem exigir unicidade do e-mail. Requer os quatro campos preenchidos, o modelo
carregado e uma fotografia legível. `Gerar e baixar PNG` continua sujeito à
verificação de duplicidade e registra a versão no histórico. Uma imagem muito
larga gera aviso de possível assinatura de e-mail; os candidatos são exibidos
inteiros para facilitar a escolha de um retrato verdadeiro. Esse aviso visual
não substitui a revisão humana da fotografia.

Para homologar um anexo vindo do Flow, confira a execução: o PUT da ação
`HTTP_1` deve terminar com sucesso, seguido do POST da ação `HTTP_2` em
`/api/webhooks/outlook/attachments/complete` com HTTP 200 e
`data.processing_status = "Disponivel"`. No backend, os logs
`[INBOUND_ATTACHMENT_COMPLETE]`, `[INBOUND_ATTACHMENT_FAILED]` e
`[SIGNATURE_PHOTO]` registram somente UUID interno, estado, tamanho e códigos
de falha; nunca URL assinada, token ou bytes. Se a rota da foto indicar
`SIGNATURE_PHOTO_UNAVAILABLE`, verifique o estado/erro do anexo. Se indicar
`SIGNATURE_PHOTO_STORAGE_READ_FAILED`, compare o objeto armazenado com o PUT
e a confirmação do Flow. Uma foto enviada manualmente ao portal usa o
bucket privado `AssinaturasColaboradores` e não depende do Flow.
