import { randomUUID } from "node:crypto";
import { getSupabase } from "../config/supabase.js";

export const INCOMING_ATTACHMENT_BUCKET = "AnexosChamados";
export const INCOMING_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024 * 1024;
export const DIRECT_UPLOAD_RECOMMENDED_MAX_BYTES = 6 * 1024 * 1024;

const ATTACHMENT_TABLE = "ticket_message_attachments";
const AVAILABLE_STATUS = "Disponivel";
const PENDING_STATUS = "Pendente";
const FAILED_STATUS = "Falhou";

function storageError(action, cause) {
  return Object.assign(new Error(`Não foi possível ${action}.`), {
    statusCode: 502,
    cause,
  });
}

function attachmentNotFoundError() {
  return Object.assign(new Error("Anexo recebido não encontrado."), {
    statusCode: 404,
  });
}

function metadataConflictError() {
  return Object.assign(
    new Error("Os metadados do anexo não correspondem ao e-mail já recebido."),
    { statusCode: 409 },
  );
}

function unavailableAttachmentError(message) {
  return Object.assign(new Error(message), { statusCode: 409 });
}

/**
 * O nome original continua no banco para exibição. Esta versão só é usada no
 * último segmento do path do Storage, sem permitir barras ou traversal.
 */
export function sanitizeStorageFileName(fileName) {
  const normalized = String(fileName || "arquivo")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\\/\u0000-\u001f\u007f]+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/[-._]{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 120);

  return normalized || "arquivo";
}

export function normalizeContentType(contentType) {
  const candidate = String(contentType || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();

  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i.test(
    candidate,
  )
    ? candidate
    : "application/octet-stream";
}

export function incomingAttachmentStoragePath({
  ticketId,
  messageId,
  attachmentId,
  fileName,
}) {
  const safeIdentifier = (value) => String(value || "").replace(/[^A-Za-z0-9-]/g, "");
  const safeTicketId = safeIdentifier(ticketId);
  const safeMessageId = safeIdentifier(messageId);
  const safeAttachmentId = safeIdentifier(attachmentId);

  if (!safeTicketId || !safeMessageId || !safeAttachmentId) {
    throw Object.assign(new Error("Não foi possível preparar o path do anexo."), {
      statusCode: 500,
    });
  }

  return `tickets/${safeTicketId}/messages/${safeMessageId}/${safeAttachmentId}-${sanitizeStorageFileName(fileName)}`;
}

/** Nunca expõe storage_path, token nem URL assinada ao frontend. */
export function toPublicIncomingAttachment(row, upload = null) {
  return {
    id: row.id,
    attachment_id: row.outlook_attachment_id,
    file_name: row.file_name,
    content_type: row.content_type,
    file_size: Number(row.file_size),
    is_inline: row.is_inline === true,
    content_id: row.content_id || null,
    processing_status: row.processing_status,
    ...(upload ? { upload } : {}),
  };
}

function sameAttachmentMetadata(row, attachment) {
  return (
    row.file_name === attachment.file_name &&
    Number(row.file_size) === Number(attachment.file_size) &&
    row.content_type === normalizeContentType(attachment.content_type) &&
    row.is_inline === (attachment.is_inline === true) &&
    (row.content_id || null) === (attachment.content_id || null)
  );
}

async function listMessageAttachments(supabase, messageId) {
  const { data, error } = await supabase
    .from(ATTACHMENT_TABLE)
    .select("*")
    .eq("ticket_message_id", messageId);

  if (error) throw storageError("consultar os anexos recebidos", error);
  return data || [];
}

async function insertAttachment(supabase, ticket, message, attachment) {
  const id = randomUUID();
  const storagePath = incomingAttachmentStoragePath({
    ticketId: ticket.id,
    messageId: message.id,
    attachmentId: id,
    fileName: attachment.file_name,
  });

  const { data, error } = await supabase
    .from(ATTACHMENT_TABLE)
    .insert({
      id,
      ticket_message_id: message.id,
      outlook_attachment_id: attachment.attachment_id,
      file_name: attachment.file_name,
      content_type: normalizeContentType(attachment.content_type),
      file_size: attachment.file_size,
      storage_path: storagePath,
      is_inline: attachment.is_inline === true,
      content_id: attachment.content_id || null,
      processing_status: PENDING_STATUS,
    })
    .select()
    .single();

  if (error) {
    // A unique key da migration protege contra execuções concorrentes do Flow.
    if (error.code === "23505") return null;
    throw storageError("registrar o anexo recebido", error);
  }
  return data;
}

async function updateAttachment(supabase, id, values) {
  const { data, error } = await supabase
    .from(ATTACHMENT_TABLE)
    .update(values)
    .eq("id", id)
    .select()
    .single();

  if (error) throw storageError("atualizar o estado do anexo recebido", error);
  return data;
}

async function findAttachmentByMessageAndOutlookId(
  supabase,
  messageId,
  outlookAttachmentId,
) {
  const { data, error } = await supabase
    .from(ATTACHMENT_TABLE)
    .select("*")
    .eq("ticket_message_id", messageId)
    .eq("outlook_attachment_id", outlookAttachmentId)
    .maybeSingle();

  if (error) throw storageError("consultar o anexo recebido", error);
  return data;
}

async function findAttachmentByOutlookMessageAndAttachmentId(
  supabase,
  outlookMessageId,
  outlookAttachmentId,
) {
  const { data: message, error: messageError } = await supabase
    .from("ticket_messages")
    .select("id")
    .eq("outlook_message_id", outlookMessageId)
    .maybeSingle();

  if (messageError) throw storageError("localizar a mensagem do anexo recebido", messageError);
  if (!message) return null;
  return findAttachmentByMessageAndOutlookId(supabase, message.id, outlookAttachmentId);
}

function resumableUploadEndpoint(supabaseUrl = process.env.SUPABASE_URL) {
  try {
    const url = new URL(supabaseUrl);
    if (url.hostname.endsWith(".supabase.co")) {
      url.hostname = url.hostname.replace(/\.supabase\.co$/, ".storage.supabase.co");
    }
    url.pathname = "/storage/v1/upload/resumable";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    throw Object.assign(new Error("Supabase Storage não configurado no servidor."), {
      statusCode: 503,
    });
  }
}

function tusMetadata(row) {
  const encode = (value) => Buffer.from(String(value), "utf8").toString("base64");
  return [
    `bucketName ${encode(INCOMING_ATTACHMENT_BUCKET)}`,
    `objectName ${encode(row.storage_path)}`,
    `contentType ${encode(row.content_type)}`,
    `cacheControl ${encode("3600")}`,
  ].join(",");
}

async function signedUploadCapability(supabase, row) {
  const { data, error } = await supabase.storage
    .from(INCOMING_ATTACHMENT_BUCKET)
    .createSignedUploadUrl(row.storage_path, { upsert: true });

  if (error || !data?.signedUrl || !data?.token) {
    throw storageError("autorizar o upload do anexo recebido", error);
  }

  if (Number(row.file_size) > DIRECT_UPLOAD_RECOMMENDED_MAX_BYTES) {
    return {
      strategy: "resumable",
      endpoint: resumableUploadEndpoint(),
      headers: {
        "Tus-Resumable": "1.0.0",
        "x-signature": data.token,
        "Upload-Metadata": tusMetadata(row),
        "x-upsert": "true",
      },
      upload_length: Number(row.file_size),
      chunk_size: DIRECT_UPLOAD_RECOMMENDED_MAX_BYTES,
    };
  }

  return {
    strategy: "standard",
    method: "PUT",
    url: data.signedUrl,
    headers: {
      "Content-Type": row.content_type,
      "x-upsert": "true",
    },
  };
}

/**
 * Cria ou recupera registros para os anexos de uma message. Os anexos não
 * disponíveis recebem apenas uma capability temporária, destinada ao Flow.
 */
export async function prepareIncomingAttachments(
  { ticket, message, attachments = [] },
  { supabase = getSupabase() } = {},
) {
  if (!message?.id || !ticket?.id || attachments.length === 0) return [];

  const existingRows = await listMessageAttachments(supabase, message.id);
  const existingByOutlookId = new Map(
    existingRows.map((row) => [row.outlook_attachment_id, row]),
  );
  const results = [];

  for (const attachment of attachments) {
    let row = existingByOutlookId.get(attachment.attachment_id);

    if (row && !sameAttachmentMetadata(row, attachment)) {
      throw metadataConflictError();
    }

    if (!row) {
      row = await insertAttachment(supabase, ticket, message, attachment);
      if (!row) {
        row = await findAttachmentByMessageAndOutlookId(
          supabase,
          message.id,
          attachment.attachment_id,
        );
        if (!row) throw storageError("recuperar o anexo recebido após concorrência");
        if (!sameAttachmentMetadata(row, attachment)) throw metadataConflictError();
      }
      existingByOutlookId.set(row.outlook_attachment_id, row);
    }

    if (row.processing_status === AVAILABLE_STATUS) {
      results.push(toPublicIncomingAttachment(row));
      continue;
    }

    if (row.processing_status === FAILED_STATUS) {
      row = await updateAttachment(supabase, row.id, {
        processing_status: PENDING_STATUS,
        processing_error: null,
      });
    }

    try {
      results.push(toPublicIncomingAttachment(row, await signedUploadCapability(supabase, row)));
    } catch (_error) {
      row = await updateAttachment(supabase, row.id, {
        processing_status: FAILED_STATUS,
        processing_error: "UPLOAD_URL_UNAVAILABLE",
      });
      results.push(toPublicIncomingAttachment(row));
    }
  }

  return results;
}

async function storageObjectForAttachment(supabase, row) {
  const separator = row.storage_path.lastIndexOf("/");
  const folder = row.storage_path.slice(0, separator);
  const objectName = row.storage_path.slice(separator + 1);
  const { data, error } = await supabase.storage
    .from(INCOMING_ATTACHMENT_BUCKET)
    .list(folder, { limit: 100, search: objectName });

  if (error) throw storageError("verificar o arquivo enviado", error);
  return (data || []).find((item) => item.name === objectName) || null;
}

async function markFailed(supabase, row, code) {
  return updateAttachment(supabase, row.id, {
    processing_status: FAILED_STATUS,
    processing_error: code,
  });
}

export const MAX_TRANSPORT_HEADER_OVERHEAD_BYTES = 512;

/**
 * Valida a integridade do tamanho binário armazenado em relação ao tamanho
 * declarado pelo Microsoft Graph / Power Automate.
 *
 * No Microsoft Graph / Exchange, a propriedade size do anexo reflete o tamanho
 * de transporte (PR_ATTACH_SIZE), que inclui uma sobrecarga fixa de metadados
 * MAPI e cabeçalhos MIME (tipicamente entre 150 e 300 bytes).
 *
 * Regras de integridade:
 * 1. objectSize e declaredSize devem ser inteiros estritamente positivos;
 * 2. objectSize não pode ser maior que declaredSize;
 * 3. objectSize === declaredSize é aceito diretamente;
 * 4. A diferença (declaredSize - objectSize) deve estar dentro do overhead
 *    legítimo de transporte (até 512 bytes). Uploads truncados além dessa
 *    margem são estritamente rejeitados.
 */
export function isAttachmentSizeConsistent(objectSize, declaredSize) {
  if (!Number.isSafeInteger(objectSize) || objectSize <= 0) return false;
  if (!Number.isSafeInteger(declaredSize) || declaredSize <= 0) return false;
  if (objectSize > declaredSize) return false;
  if (objectSize === declaredSize) return true;

  const difference = declaredSize - objectSize;
  return difference <= MAX_TRANSPORT_HEADER_OVERHEAD_BYTES;
}

export async function completeIncomingAttachment(
  { messageId, attachmentId },
  { supabase = getSupabase() } = {},
) {
  const row = await findAttachmentByOutlookMessageAndAttachmentId(
    supabase,
    messageId,
    attachmentId,
  );
  if (!row) throw attachmentNotFoundError();
  if (row.processing_status === AVAILABLE_STATUS) return toPublicIncomingAttachment(row);

  const object = await storageObjectForAttachment(supabase, row);

  if (!object) {
    await markFailed(supabase, row, "OBJECT_NOT_FOUND");
    throw unavailableAttachmentError("O arquivo enviado não foi encontrado no armazenamento.");
  }

  const objectSize = Number(object?.metadata?.size);
  const declaredSize = Number(row.file_size);

  if (!Number.isSafeInteger(objectSize) || objectSize <= 0) {
    await markFailed(supabase, row, "INVALID_SIZE");
    throw unavailableAttachmentError("O tamanho do arquivo enviado é inválido.");
  }

  if (objectSize > INCOMING_ATTACHMENT_MAX_BYTES) {
    await markFailed(supabase, row, "SIZE_EXCEEDED");
    throw unavailableAttachmentError("O tamanho do arquivo enviado excede o limite suportado.");
  }

  if (!isAttachmentSizeConsistent(objectSize, declaredSize)) {
    await markFailed(supabase, row, "SIZE_MISMATCH");
    throw unavailableAttachmentError(
      "O tamanho do arquivo enviado não corresponde ao anexo recebido.",
    );
  }

  const actualContentType = normalizeContentType(object.metadata?.mimetype);
  const updated = await updateAttachment(supabase, row.id, {
    processing_status: AVAILABLE_STATUS,
    processing_error: null,
    available_at: new Date().toISOString(),
    file_size: objectSize,
    content_type:
      actualContentType === "application/octet-stream"
        ? row.content_type
        : actualContentType,
  });
  return toPublicIncomingAttachment(updated);
}

export async function failIncomingAttachment(
  { messageId, attachmentId, failureCode },
  { supabase = getSupabase() } = {},
) {
  const row = await findAttachmentByOutlookMessageAndAttachmentId(
    supabase,
    messageId,
    attachmentId,
  );
  if (!row) throw attachmentNotFoundError();
  if (row.processing_status === AVAILABLE_STATUS) return toPublicIncomingAttachment(row);

  return toPublicIncomingAttachment(await markFailed(supabase, row, failureCode));
}

export async function getIncomingAttachmentForTicket(
  { ticketId, attachmentId },
  { supabase = getSupabase() } = {},
) {
  const { data: attachment, error } = await supabase
    .from(ATTACHMENT_TABLE)
    .select("*")
    .eq("id", attachmentId)
    .maybeSingle();

  if (error) throw storageError("consultar o anexo recebido", error);
  if (!attachment || attachment.processing_status !== AVAILABLE_STATUS) return null;

  const { data: message, error: messageError } = await supabase
    .from("ticket_messages")
    .select("ticket_id")
    .eq("id", attachment.ticket_message_id)
    .maybeSingle();

  if (messageError) throw storageError("validar o contexto do anexo recebido", messageError);
  if (!message || message.ticket_id !== ticketId) return null;
  return attachment;
}

export async function createIncomingAttachmentDownloadUrl(
  attachment,
  { download = false, supabase = getSupabase() } = {},
) {
  const { data, error } = await supabase.storage
    .from(INCOMING_ATTACHMENT_BUCKET)
    .createSignedUrl(attachment.storage_path, 60, {
      ...(download ? { download: attachment.file_name } : {}),
    });

  if (error || !data?.signedUrl) {
    throw storageError("autorizar o acesso ao anexo recebido", error);
  }
  return data.signedUrl;
}
