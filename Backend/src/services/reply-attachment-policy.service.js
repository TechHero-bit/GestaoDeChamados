import path from "node:path";

export const SMALL_ATTACHMENT_LIMIT_BYTES = 3 * 1024 * 1024;
export const MAX_ATTACHMENT_SIZE_BYTES = 150 * 1024 * 1024;
export const REPLY_ATTACHMENT_FILE_FIELD = "attachment";

const MIME_BY_EXTENSION = new Map(Object.entries({
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".txt": "text/plain", ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip", ".rtf": "application/rtf",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".json": "application/json", ".xml": "application/xml", ".eml": "message/rfc822",
}));

const BLOCKED_EXTENSIONS = new Set([
  ".exe", ".bat", ".cmd", ".ps1", ".vbs", ".scr", ".com", ".msi",
  ".js", ".jse", ".wsf", ".wsh", ".hta", ".cpl", ".reg", ".lnk",
]);

function policyError(message, publicCode = "ATTACHMENT_INVALID", statusCode = 400) {
  return Object.assign(new Error(message), { statusCode, publicCode });
}

export function normalizeReplyAttachmentName(name) {
  return String(name || "").normalize("NFC").trim();
}

export function normalizeReplyAttachment(attachment) {
  const name = normalizeReplyAttachmentName(attachment?.name);
  if (!name || name.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(name)) {
    throw policyError("O nome de um dos anexos é inválido.");
  }
  const extension = path.extname(name).toLowerCase();
  if (BLOCKED_EXTENSIONS.has(extension)) {
    throw policyError("Este tipo de arquivo não é permitido.", "ATTACHMENT_TYPE_BLOCKED");
  }
  const contentType = MIME_BY_EXTENSION.get(extension);
  if (!contentType) {
    throw policyError("Este tipo de arquivo não é suportado.", "ATTACHMENT_TYPE_UNSUPPORTED");
  }
  const size = Number(attachment?.size);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw policyError("O tamanho de um dos anexos é inválido.");
  }
  if (size > MAX_ATTACHMENT_SIZE_BYTES) {
    throw policyError(
      "Este arquivo excede o limite máximo suportado pelo Outlook.",
      "ATTACHMENT_TOO_LARGE",
      413,
    );
  }
  return {
    name, size, contentType,
    kind: size < SMALL_ATTACHMENT_LIMIT_BYTES ? "simple" : "upload_session",
  };
}

export const normalizeReplyAttachments = (attachments) => attachments.map(normalizeReplyAttachment);

export function publicAttachmentMetadata(attachment) {
  return { name: attachment.name, size: attachment.size, content_type: attachment.contentType };
}
