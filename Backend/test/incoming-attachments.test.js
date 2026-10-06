import assert from "node:assert/strict";
import { test } from "node:test";
import {
  completeIncomingAttachment,
  DIRECT_UPLOAD_RECOMMENDED_MAX_BYTES,
  getIncomingAttachmentForTicket,
  INCOMING_ATTACHMENT_MAX_BYTES,
  incomingAttachmentStoragePath,
  isAttachmentSizeConsistent,
  prepareIncomingAttachments,
  sanitizeStorageFileName,
} from "../src/services/incoming-attachment.service.js";
import { webhookPayloadSchema } from "../src/schemas/webhook.schema.js";

class AttachmentDatabase {
  constructor() {
    this.messages = [
      { id: "message-1", ticket_id: "ticket-1", outlook_message_id: "outlook-message-1" },
      { id: "message-2", ticket_id: "ticket-2", outlook_message_id: "outlook-message-2" },
    ];
    this.attachments = [];
    this.objects = new Map();
    this.storageError = null;
    this.storage = {
      from: (bucket) => {
        assert.equal(bucket, "AnexosChamados");
        return {
          createSignedUploadUrl: async (path) => ({
            data: { signedUrl: `https://storage.example/upload/${encodeURIComponent(path)}`, token: "signed-token" },
            error: null,
          }),
          list: async (folder, { search }) => {
            if (this.storageError) return { data: null, error: this.storageError };
            const path = `${folder}/${search}`;
            const object = this.objects.get(path);
            return { data: object ? [{ name: search, metadata: object }] : [], error: null };
          },
          createSignedUrl: async (path) => ({
            data: { signedUrl: `https://storage.example/download/${encodeURIComponent(path)}` },
            error: null,
          }),
        };
      },
    };
  }

  from(table) {
    return new AttachmentQuery(this, table);
  }
}

class AttachmentQuery {
  constructor(database, table) {
    this.database = database;
    this.table = table;
    this.filters = [];
    this.operation = "select";
    this.values = null;
    this.singleResult = false;
  }

  select() { return this; }
  eq(field, value) { this.filters.push([field, value]); return this; }
  maybeSingle() { this.singleResult = true; return this; }
  single() { this.singleResult = true; return this; }
  insert(values) { this.operation = "insert"; this.values = values; return this; }
  update(values) { this.operation = "update"; this.values = values; return this; }
  then(resolve, reject) { return Promise.resolve().then(() => this.execute()).then(resolve, reject); }

  execute() {
    const collection = this.table === "ticket_messages"
      ? this.database.messages
      : this.database.attachments;
    const matches = collection.filter((row) =>
      this.filters.every(([field, value]) => row[field] === value),
    );

    if (this.operation === "insert") {
      if (this.table === "ticket_message_attachments") {
        const duplicate = collection.some((row) =>
          row.ticket_message_id === this.values.ticket_message_id
          && row.outlook_attachment_id === this.values.outlook_attachment_id,
        );
        if (duplicate) return { data: null, error: { code: "23505" } };
      }
      const row = { ...this.values };
      collection.push(row);
      return { data: this.singleResult ? row : [row], error: null };
    }

    if (this.operation === "update") {
      matches.forEach((row) => Object.assign(row, this.values));
      return { data: this.singleResult ? matches[0] || null : matches, error: null };
    }

    return { data: this.singleResult ? matches[0] || null : matches, error: null };
  }
}

const ticket = { id: "ticket-1" };
const message = { id: "message-1", outlook_message_id: "outlook-message-1" };

function attachment(overrides = {}) {
  return {
    attachment_id: "outlook-attachment-1",
    file_name: "contrato final.pdf",
    content_type: "application/pdf",
    file_size: 1024,
    is_inline: false,
    content_id: null,
    ...overrides,
  };
}

test("payload sem anexos mantém attachments como lista vazia", () => {
  const result = webhookPayloadSchema.parse({
    message_id: "outlook-message-1",
    conversation_id: "conversation-1",
    remetente_email: "cliente@example.com",
    assunto: "Solicitação (chamado)",
    corpo_mensagem: "Mensagem sem arquivo",
    data_recebimento: "2026-09-14T12:00:00.000Z",
  });
  assert.deepEqual(result.attachments, []);
});

test("PDF recebido cria registro e só fica disponível após confirmar objeto no Storage", async () => {
  const database = new AttachmentDatabase();
  const prepared = await prepareIncomingAttachments(
    { ticket, message, attachments: [attachment()] },
    { supabase: database },
  );

  assert.equal(prepared.length, 1);
  assert.equal(database.attachments.length, 1);
  assert.equal(prepared[0].processing_status, "Pendente");
  assert.equal(prepared[0].upload.strategy, "standard");
  assert.equal("storage_path" in prepared[0], false);

  const row = database.attachments[0];
  database.objects.set(row.storage_path, { size: 1024, mimetype: "application/pdf" });
  const completed = await completeIncomingAttachment(
    { messageId: "outlook-message-1", attachmentId: "outlook-attachment-1" },
    { supabase: database },
  );
  assert.equal(completed.processing_status, "Disponivel");
});

test("vários anexos pertencem à mesma ticket_message e não duplicam em novo processamento", async () => {
  const database = new AttachmentDatabase();
  const attachments = [attachment(), attachment({ attachment_id: "outlook-attachment-2", file_name: "planilha.xlsx" })];
  await prepareIncomingAttachments({ ticket, message, attachments }, { supabase: database });
  await prepareIncomingAttachments({ ticket, message, attachments }, { supabase: database });

  assert.equal(database.attachments.length, 2);
  assert.ok(database.attachments.every((row) => row.ticket_message_id === message.id));
});

test("imagem inline preserva metadados e não é classificada como anexo regular", async () => {
  const database = new AttachmentDatabase();
  const [prepared] = await prepareIncomingAttachments(
    {
      ticket,
      message,
      attachments: [attachment({
        attachment_id: "inline-1",
        file_name: "imagem-assinatura.png",
        content_type: "image/png",
        is_inline: true,
        content_id: "logo-cid",
      })],
    },
    { supabase: database },
  );

  assert.equal(prepared.is_inline, true);
  assert.equal(prepared.content_id, "logo-cid");
});

test("nome original é preservado enquanto o path é sanitizado", () => {
  const path = incomingAttachmentStoragePath({
    ticketId: "ticket-1",
    messageId: "message-1",
    attachmentId: "attachment-1",
    fileName: "../../Contrato çã final?.pdf",
  });
  assert.match(path, /^tickets\/ticket-1\/messages\/message-1\/attachment-1-/);
  assert.equal(path.includes(".."), false);
  assert.equal(sanitizeStorageFileName("../../Contrato çã final?.pdf"), "Contrato-ca-final-pdf");
});

test("falha de confirmação marca o anexo como Falhou sem fingir disponibilidade", async () => {
  const database = new AttachmentDatabase();
  await prepareIncomingAttachments({ ticket, message, attachments: [attachment()] }, { supabase: database });

  await assert.rejects(
    completeIncomingAttachment(
      { messageId: "outlook-message-1", attachmentId: "outlook-attachment-1" },
      { supabase: database },
    ),
    { statusCode: 409 },
  );
  assert.equal(database.attachments[0].processing_status, "Falhou");
  assert.equal(database.attachments[0].processing_error, "OBJECT_NOT_FOUND");
});

test("PDF com upload truncado significativamente no Storage é marcado como Falhou", async () => {
  const database = new AttachmentDatabase();
  const [prepared] = await prepareIncomingAttachments(
    {
      ticket,
      message,
      attachments: [
        attachment({
          attachment_id: "pdf-attachment-1",
          file_name: "documento.pdf",
          content_type: "application/pdf",
          file_size: 97497, // Tamanho declarado pelo Microsoft Graph
        }),
      ],
    },
    { supabase: database },
  );

  assert.equal(prepared.processing_status, "Pendente");
  const row = database.attachments[0];

  // Storage contém apenas 500 bytes de um arquivo de ~97 KB (upload interrompido / truncado)
  database.objects.set(row.storage_path, { size: 500, mimetype: "application/pdf" });

  await assert.rejects(
    completeIncomingAttachment(
      { messageId: "outlook-message-1", attachmentId: "pdf-attachment-1" },
      { supabase: database },
    ),
    { statusCode: 409 },
  );

  assert.equal(database.attachments[0].processing_status, "Falhou");
  assert.equal(database.attachments[0].processing_error, "SIZE_MISMATCH");
});

test("PNG inline com tamanho no Storage maior que o declarado é marcado como Falhou", async () => {
  const database = new AttachmentDatabase();
  await prepareIncomingAttachments(
    {
      ticket,
      message,
      attachments: [
        attachment({
          attachment_id: "png-inline-1",
          file_name: "imagem.png",
          content_type: "image/png",
          file_size: 142587, // Tamanho declarado pelo Microsoft Graph
          is_inline: true,
          content_id: "image001.png@01D",
        }),
      ],
    },
    { supabase: database },
  );

  const row = database.attachments[0];
  // Storage contém mais bytes do que o declarado pelo Graph (inconsistência)
  database.objects.set(row.storage_path, { size: 143000, mimetype: "image/png" });

  await assert.rejects(
    completeIncomingAttachment(
      { messageId: "outlook-message-1", attachmentId: "png-inline-1" },
      { supabase: database },
    ),
    { statusCode: 409 },
  );

  assert.equal(database.attachments[0].processing_status, "Falhou");
  assert.equal(database.attachments[0].processing_error, "SIZE_MISMATCH");
});

test("caso Cartesia.txt: declaredSize 211 e objectSize 29 conclui com sucesso e atualiza file_size no banco", async () => {
  const database = new AttachmentDatabase();
  const [prepared] = await prepareIncomingAttachments(
    {
      ticket,
      message,
      attachments: [
        attachment({
          attachment_id: "cartesia-att-1",
          file_name: "Cartesia.txt",
          content_type: "text/plain",
          file_size: 211, // Retornado pelo Graph / Power Automate com overhead MIME
          is_inline: false,
        }),
      ],
    },
    { supabase: database },
  );

  assert.equal(prepared.processing_status, "Pendente");
  const row = database.attachments[0];
  assert.equal(row.file_size, 211);

  // Storage contém os 29 bytes reais decodificados
  database.objects.set(row.storage_path, { size: 29, mimetype: "text/plain" });

  const completed = await completeIncomingAttachment(
    { messageId: "outlook-message-1", attachmentId: "cartesia-att-1" },
    { supabase: database },
  );

  assert.equal(completed.processing_status, "Disponivel");
  assert.equal(completed.file_size, 29);
  assert.equal(database.attachments[0].processing_status, "Disponivel");
  assert.equal(database.attachments[0].file_size, 29);
  assert.equal(database.attachments[0].processing_error, null);
});

test("igualdade exata: declaredSize 29 e objectSize 29 conclui com sucesso", async () => {
  const database = new AttachmentDatabase();
  await prepareIncomingAttachments(
    {
      ticket,
      message,
      attachments: [
        attachment({
          attachment_id: "exact-att-1",
          file_name: "Cartesia.txt",
          content_type: "text/plain",
          file_size: 29,
        }),
      ],
    },
    { supabase: database },
  );

  const row = database.attachments[0];
  database.objects.set(row.storage_path, { size: 29, mimetype: "text/plain" });

  const completed = await completeIncomingAttachment(
    { messageId: "outlook-message-1", attachmentId: "exact-att-1" },
    { supabase: database },
  );

  assert.equal(completed.processing_status, "Disponivel");
  assert.equal(completed.file_size, 29);
  assert.equal(database.attachments[0].file_size, 29);
});

test("rejeição quando objectSize excede declaredSize: declaredSize 29 e objectSize 30", async () => {
  const database = new AttachmentDatabase();
  await prepareIncomingAttachments(
    {
      ticket,
      message,
      attachments: [
        attachment({
          attachment_id: "exceeded-att-1",
          file_name: "Cartesia.txt",
          content_type: "text/plain",
          file_size: 29,
        }),
      ],
    },
    { supabase: database },
  );

  const row = database.attachments[0];
  database.objects.set(row.storage_path, { size: 30, mimetype: "text/plain" });

  await assert.rejects(
    completeIncomingAttachment(
      { messageId: "outlook-message-1", attachmentId: "exceeded-att-1" },
      { supabase: database },
    ),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /O tamanho do arquivo enviado não corresponde ao anexo recebido/);
      return true;
    },
  );

  assert.equal(database.attachments[0].processing_status, "Falhou");
  assert.equal(database.attachments[0].processing_error, "SIZE_MISMATCH");
});

test("schema de entrada rejeita declaredSize acima do limite máximo de 5 GiB", () => {
  assert.throws(
    () => {
      webhookPayloadSchema.parse({
        message_id: "outlook-message-1",
        conversation_id: "conversation-1",
        remetente_email: "cliente@example.com",
        assunto: "Chamado (chamado)",
        corpo_mensagem: "Mensagem com anexo gigante",
        data_recebimento: "2026-09-14T12:00:00.000Z",
        attachments: [
          attachment({
            file_size: INCOMING_ATTACHMENT_MAX_BYTES + 1,
          }),
        ],
      });
    },
    (error) => {
      assert.match(error.message, /file_size excede o limite suportado/);
      return true;
    },
  );
});

test("arquivo de 100 KB declarado com apenas 10 KB no Storage é rejeitado como Falhou", async () => {
  const database = new AttachmentDatabase();
  await prepareIncomingAttachments(
    {
      ticket,
      message,
      attachments: [
        attachment({
          attachment_id: "trunc-100kb",
          file_name: "manual.pdf",
          content_type: "application/pdf",
          file_size: 100 * 1024, // 100 KB declarado
        }),
      ],
    },
    { supabase: database },
  );

  const row = database.attachments[0];
  // Storage recebeu apenas 10 KB (upload severamente truncado)
  database.objects.set(row.storage_path, { size: 10 * 1024, mimetype: "application/pdf" });

  await assert.rejects(
    completeIncomingAttachment(
      { messageId: "outlook-message-1", attachmentId: "trunc-100kb" },
      { supabase: database },
    ),
    { statusCode: 409 },
  );

  assert.equal(database.attachments[0].processing_status, "Falhou");
  assert.equal(database.attachments[0].processing_error, "SIZE_MISMATCH");
});

test("arquivo de 1 MB declarado com apenas 500 KB no Storage é rejeitado como Falhou", async () => {
  const database = new AttachmentDatabase();
  await prepareIncomingAttachments(
    {
      ticket,
      message,
      attachments: [
        attachment({
          attachment_id: "trunc-1mb",
          file_name: "video-curto.mp4",
          content_type: "video/mp4",
          file_size: 1024 * 1024, // 1 MB declarado
        }),
      ],
    },
    { supabase: database },
  );

  const row = database.attachments[0];
  // Storage recebeu apenas 500 KB (upload cortado pela metade)
  database.objects.set(row.storage_path, { size: 500 * 1024, mimetype: "video/mp4" });

  await assert.rejects(
    completeIncomingAttachment(
      { messageId: "outlook-message-1", attachmentId: "trunc-1mb" },
      { supabase: database },
    ),
    { statusCode: 409 },
  );

  assert.equal(database.attachments[0].processing_status, "Falhou");
  assert.equal(database.attachments[0].processing_error, "SIZE_MISMATCH");
});

test("arquivo de 100 KB com overhead legítimo de 236 bytes conclui com sucesso", async () => {
  const database = new AttachmentDatabase();
  await prepareIncomingAttachments(
    {
      ticket,
      message,
      attachments: [
        attachment({
          attachment_id: "overhead-100kb",
          file_name: "relatorio.pdf",
          content_type: "application/pdf",
          file_size: 100 * 1024 + 236, // 100 KB + 236 bytes de overhead MAPI
        }),
      ],
    },
    { supabase: database },
  );

  const row = database.attachments[0];
  // Storage contém os 100 KB exatos
  database.objects.set(row.storage_path, { size: 100 * 1024, mimetype: "application/pdf" });

  const completed = await completeIncomingAttachment(
    { messageId: "outlook-message-1", attachmentId: "overhead-100kb" },
    { supabase: database },
  );

  assert.equal(completed.processing_status, "Disponivel");
  assert.equal(completed.file_size, 100 * 1024);
  assert.equal(database.attachments[0].file_size, 100 * 1024);
});

test("função isAttachmentSizeConsistent valida integridade de tamanhos", () => {
  // 1. Arquivo de 29 bytes / declarado 211 bytes → deve aceitar (overhead de 182 bytes)
  assert.equal(isAttachmentSizeConsistent(29, 211), true);

  // 2. Arquivo de 100 KB / declarado 100 KB → deve aceitar (igualdade exata)
  assert.equal(isAttachmentSizeConsistent(100 * 1024, 100 * 1024), true);

  // 3. Arquivo de 100 KB / declarado 100 KB + overhead legítimo de 236 bytes → deve aceitar
  assert.equal(isAttachmentSizeConsistent(100 * 1024, 100 * 1024 + 236), true);

  // 4. Arquivo de 100 KB / Storage com apenas 10 KB → deve rejeitar
  assert.equal(isAttachmentSizeConsistent(10 * 1024, 100 * 1024), false);

  // 5. Arquivo de 1 MB / Storage com apenas 500 KB → deve rejeitar
  assert.equal(isAttachmentSizeConsistent(500 * 1024, 1024 * 1024), false);

  // 6. objectSize > declaredSize → deve rejeitar
  assert.equal(isAttachmentSizeConsistent(30, 29), false);
  assert.equal(isAttachmentSizeConsistent(100 * 1024 + 1, 100 * 1024), false);

  // Casos de borda: inválido, zero ou negativo
  assert.equal(isAttachmentSizeConsistent(0, 29), false);
  assert.equal(isAttachmentSizeConsistent(-10, 29), false);
  assert.equal(isAttachmentSizeConsistent(29, 0), false);
  assert.equal(isAttachmentSizeConsistent(NaN, 29), false);
  assert.equal(isAttachmentSizeConsistent(29, NaN), false);
});

test("Caso 2 — objeto inexistente no Storage marca anexo como Falhou com HTTP 409", async () => {
  const database = new AttachmentDatabase();
  await prepareIncomingAttachments(
    { ticket, message, attachments: [attachment()] },
    { supabase: database },
  );

  await assert.rejects(
    completeIncomingAttachment(
      { messageId: "outlook-message-1", attachmentId: "outlook-attachment-1" },
      { supabase: database },
    ),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /não foi encontrado no armazenamento/i);
      return true;
    },
  );

  assert.equal(database.attachments[0].processing_status, "Falhou");
  assert.equal(database.attachments[0].processing_error, "OBJECT_NOT_FOUND");
});

test("Caso 3 — tamanho do objeto inválido no Storage marca anexo como Falhou com HTTP 409", async () => {
  const invalidSizes = [0, -10, NaN, null, "invalido", undefined];

  for (const size of invalidSizes) {
    const database = new AttachmentDatabase();
    await prepareIncomingAttachments(
      { ticket, message, attachments: [attachment()] },
      { supabase: database },
    );
    const row = database.attachments[0];
    database.objects.set(row.storage_path, { size, mimetype: "application/pdf" });

    await assert.rejects(
      completeIncomingAttachment(
        { messageId: "outlook-message-1", attachmentId: "outlook-attachment-1" },
        { supabase: database },
      ),
      (error) => {
        assert.equal(error.statusCode, 409);
        assert.match(error.message, /tamanho do arquivo enviado é inválido/i);
        return true;
      },
    );

    assert.equal(database.attachments[0].processing_status, "Falhou");
    assert.equal(database.attachments[0].processing_error, "INVALID_SIZE");
  }
});

test("Caso 3 — tamanho do objeto excedendo limite máximo marca anexo como Falhou com HTTP 409", async () => {
  const database = new AttachmentDatabase();
  await prepareIncomingAttachments(
    { ticket, message, attachments: [attachment()] },
    { supabase: database },
  );
  const row = database.attachments[0];
  database.objects.set(row.storage_path, { size: INCOMING_ATTACHMENT_MAX_BYTES + 1, mimetype: "application/pdf" });

  await assert.rejects(
    completeIncomingAttachment(
      { messageId: "outlook-message-1", attachmentId: "outlook-attachment-1" },
      { supabase: database },
    ),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /excede o limite suportado/i);
      return true;
    },
  );

  assert.equal(database.attachments[0].processing_status, "Falhou");
  assert.equal(database.attachments[0].processing_error, "SIZE_EXCEEDED");
});

test("Caso 4 — objeto já disponível retorna sem reprocessar mantendo idempotência", async () => {
  const database = new AttachmentDatabase();
  await prepareIncomingAttachments(
    { ticket, message, attachments: [attachment({ file_size: 97497 })] },
    { supabase: database },
  );
  const row = database.attachments[0];
  database.objects.set(row.storage_path, { size: 97497, mimetype: "application/pdf" });

  const firstComplete = await completeIncomingAttachment(
    { messageId: "outlook-message-1", attachmentId: "outlook-attachment-1" },
    { supabase: database },
  );
  assert.equal(firstComplete.processing_status, "Disponivel");

  const originalAvailableAt = database.attachments[0].available_at;
  assert.ok(originalAvailableAt);

  // Segunda chamada (idempotente)
  const secondComplete = await completeIncomingAttachment(
    { messageId: "outlook-message-1", attachmentId: "outlook-attachment-1" },
    { supabase: database },
  );

  assert.equal(secondComplete.processing_status, "Disponivel");
  assert.equal(database.attachments[0].available_at, originalAvailableAt);
});

test("Caso 5 — preserva ou atualiza content_type conforme metadados do Storage", async () => {
  // Subcaso A: Storage informa mimetype específico
  const db1 = new AttachmentDatabase();
  await prepareIncomingAttachments(
    {
      ticket,
      message,
      attachments: [attachment({ content_type: "application/octet-stream", file_size: 97497 })],
    },
    { supabase: db1 },
  );
  db1.objects.set(db1.attachments[0].storage_path, { size: 97497, mimetype: "application/pdf" });
  const completed1 = await completeIncomingAttachment(
    { messageId: "outlook-message-1", attachmentId: "outlook-attachment-1" },
    { supabase: db1 },
  );
  assert.equal(completed1.content_type, "application/pdf");

  // Subcaso B: Storage informa application/octet-stream genérico, preserva o tipo original do Outlook
  const db2 = new AttachmentDatabase();
  await prepareIncomingAttachments(
    {
      ticket,
      message,
      attachments: [attachment({ content_type: "application/pdf", file_size: 97497 })],
    },
    { supabase: db2 },
  );
  db2.objects.set(db2.attachments[0].storage_path, { size: 97497, mimetype: "application/octet-stream" });
  const completed2 = await completeIncomingAttachment(
    { messageId: "outlook-message-1", attachmentId: "outlook-attachment-1" },
    { supabase: db2 },
  );
  assert.equal(completed2.content_type, "application/pdf");
});

test("erro ao consultar o Storage retorna 502 sem marcar anexo como Falhou", async () => {
  const database = new AttachmentDatabase();
  await prepareIncomingAttachments(
    { ticket, message, attachments: [attachment()] },
    { supabase: database },
  );
  database.storageError = new Error("Falha temporária de rede no Storage");

  await assert.rejects(
    completeIncomingAttachment(
      { messageId: "outlook-message-1", attachmentId: "outlook-attachment-1" },
      { supabase: database },
    ),
    (error) => {
      assert.equal(error.statusCode, 502);
      assert.match(error.message, /Não foi possível verificar o arquivo enviado/i);
      return true;
    },
  );

  // Não deve marcar como Falhou pois foi um erro transitório de infraestrutura
  assert.equal(database.attachments[0].processing_status, "Pendente");
});

test("anexo só pode ser aberto no ticket ao qual sua mensagem pertence", async () => {
  const database = new AttachmentDatabase();
  await prepareIncomingAttachments({ ticket, message, attachments: [attachment()] }, { supabase: database });
  const row = database.attachments[0];
  row.processing_status = "Disponivel";

  assert.ok(await getIncomingAttachmentForTicket({ ticketId: "ticket-1", attachmentId: row.id }, { supabase: database }));
  assert.equal(
    await getIncomingAttachmentForTicket({ ticketId: "ticket-2", attachmentId: row.id }, { supabase: database }),
    null,
  );
});

test("arquivos acima de 6 MiB recebem estratégia resumable, sem passar pela função", async () => {
  const previousUrl = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = "https://project.supabase.co";
  try {
    const database = new AttachmentDatabase();
    const [prepared] = await prepareIncomingAttachments(
      {
        ticket,
        message,
        attachments: [attachment({ file_size: DIRECT_UPLOAD_RECOMMENDED_MAX_BYTES + 1 })],
      },
      { supabase: database },
    );

    assert.equal(prepared.upload.strategy, "resumable");
    assert.equal(prepared.upload.chunk_size, DIRECT_UPLOAD_RECOMMENDED_MAX_BYTES);
    assert.match(prepared.upload.endpoint, /\/storage\/v1\/upload\/resumable$/);
  } finally {
    if (previousUrl) process.env.SUPABASE_URL = previousUrl;
    else delete process.env.SUPABASE_URL;
  }
});
