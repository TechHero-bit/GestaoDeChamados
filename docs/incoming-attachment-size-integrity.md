# Integridade do tamanho de anexos recebidos

## Diagnóstico

A propriedade `size` devolvida pelo Outlook/Graph não representa
necessariamente o tamanho do conteúdo binário decodificado. Nos casos
confirmados:

- `Image (1).jfif`: Outlook `4.027.326`; `contentBytes`, arquivo original e
  objeto no Storage `3.161.947` bytes;
- `image.png`: Outlook `142.587`; objeto no Storage `142.344` bytes.

A validação anterior aceitava apenas uma diferença de até 512 bytes e, por
isso, devolvia 409 no primeiro caso. Além disso, a conclusão sobrescrevia
`file_size` com o tamanho real; um retry do webhook comparava esse valor com o
tamanho declarado e podia devolver outro 409.

## Solução

A migration 013 separa:

- `outlook_declared_size`: tamanho de transporte do Outlook;
- `source_content_size`: bytes decodificados de `contentBytes` no Flow;
- `file_size`: tamanho efetivamente armazenado e exibido.

Com `content_bytes_size`, a confirmação exige igualdade exata com o Storage.
Uploads truncados, valor zero, divergência entre POST inicial e HTTP 08 e
objetos acima de 5 GiB são rejeitados. A tolerância legada de 512 bytes existe
somente para chamadas sem o novo campo durante a transição.

## Power Automate

Na ação **Compor - Tamanho binario**:

```text
length(base64ToBinary(body('Obter_anexo_(V2)')?['contentBytes']))
```

No array `attachments` do POST inicial e no body do HTTP 08:

```text
outputs('Compor_-_Tamanho_binario')
```

Body completo do HTTP 08:

```text
{
  "message_id": "<Message Id do gatilho>",
  "attachment_id": "<Attachment Id do item>",
  "content_bytes_size": @{outputs('Compor_-_Tamanho_binario')}
}
```

O corpo do PUT continua sendo:

```text
base64ToBinary(body('Obter_anexo_(V2)')?['contentBytes'])
```

Para upload TUS, `Upload-Length` deve receber o mesmo resultado de
`Compor - Tamanho binario`. Não persista nem registre `contentBytes`.

## Implantação

1. Revisar e executar manualmente a migration 013.
2. Publicar o backend, que mantém compatibilidade temporária com o Flow atual.
3. Atualizar o Flow com `content_bytes_size` no POST inicial e no HTTP 08.
4. Homologar no fluxo Teste IT e confirmar HTTP 200, estado `Disponivel` e a
   fotografia associada em `/signatures`.

Nenhuma migration ou deploy foi executado automaticamente.
