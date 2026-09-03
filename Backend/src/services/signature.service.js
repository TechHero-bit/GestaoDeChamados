import { getSupabase } from "../config/supabase.js";

export const SIGNATURE_BUCKET = "Assinaturas";
const PNG_MAGIC_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function safeSupabaseMessage(error) {
  const message = String(error?.message || "Erro retornado pelo Supabase.")
    .replace(/[\r\n]+/g, " ")
    .replace(/(?:service_role|secret|access_token|eyJ[a-zA-Z0-9._-]+)/gi, "[redacted]")
    .trim();

  return message.slice(0, 300);
}

function isMissingSignatureColumn(error) {
  return error?.code === "42703" || error?.code === "PGRST204" || /signature_(?:enabled|storage_path).*does not exist|schema cache/i.test(String(error?.message));
}

function databaseError(action, stage, userId, cause) {
  const supabaseMessage = safeSupabaseMessage(cause);
  const message = isMissingSignatureColumn(cause)
    ? "A configuração da assinatura não está disponível no banco de dados. A migration anterior não foi aplicada."
    : `Não foi possível ${action}: ${supabaseMessage}`;

  return Object.assign(new Error(message), {
    statusCode: 502,
    signatureError: true,
    signatureLog: {
      stage,
      status: 502,
      supabaseMessage,
      userId,
    },
  });
}

export function signatureStoragePath(userId) {
  if (typeof userId !== "string" || !userId || /[^a-zA-Z0-9-]/.test(userId)) {
    throw Object.assign(new Error("Usuário autenticado inválido."), { statusCode: 401 });
  }
  return `${userId}/signature.png`;
}

export function isValidPngFile(file) {
  return Boolean(
    file &&
      file.mimetype === "image/png" &&
      typeof file.originalname === "string" &&
      /\.png$/i.test(file.originalname) &&
      Buffer.isBuffer(file.buffer) &&
      file.buffer.length >= PNG_MAGIC_BYTES.length &&
      PNG_MAGIC_BYTES.equals(file.buffer.subarray(0, PNG_MAGIC_BYTES.length)),
  );
}

function publicUrlWithVersion(supabase, path, updatedAt) {
  const { data } = supabase.storage.from(SIGNATURE_BUCKET).getPublicUrl(path);
  const publicUrl = data?.publicUrl;
  if (!publicUrl) {
    throw Object.assign(new Error("Não foi possível gerar a URL pública da assinatura."), {
      statusCode: 502,
    });
  }

  if (!updatedAt) return publicUrl;
  const version = Date.parse(updatedAt);
  if (Number.isNaN(version)) return publicUrl;

  const url = new URL(publicUrl);
  url.searchParams.set("v", String(version));
  return url.toString();
}

function formatSignature(userId, row, supabase) {
  const path = row?.signature_storage_path;
  const expectedPath = signatureStoragePath(userId);
  const pathFound = typeof path === "string" && path.trim().length > 0;
  const hasSignature = pathFound && path === expectedPath;
  const enabled = row?.signature_enabled === true;

  return {
    enabled,
    has_signature: hasSignature,
    image_url: enabled && hasSignature ? publicUrlWithVersion(supabase, path, row?.data_atualizacao) : null,
  };
}

async function getSignatureRow(userId, supabase) {
  const { data, error } = await supabase
    .from("users")
    .select("signature_enabled, signature_storage_path")
    .eq("id", userId)
    .maybeSingle();

  if (error) throw databaseError("consultar a assinatura do usuário", "database.select", userId, error);
  return data;
}

function signatureLoadError(userId, cause) {
  return Object.assign(new Error("Não foi possível carregar a assinatura PNG ativa."), {
    statusCode: 502,
    publicCode: "SIGNATURE_LOAD_FAILED",
    safeToFallback: false,
    signatureError: true,
    signatureLog: {
      stage: "storage.download",
      status: 502,
      supabaseMessage: safeSupabaseMessage(cause),
      userId,
    },
  });
}

async function storageDataToBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data?.arrayBuffer === "function") return Buffer.from(await data.arrayBuffer());
  return null;
}

function isValidPngBytes(buffer) {
  return Buffer.isBuffer(buffer) &&
    buffer.length >= PNG_MAGIC_BYTES.length &&
    PNG_MAGIC_BYTES.equals(buffer.subarray(0, PNG_MAGIC_BYTES.length));
}

export async function getUserSignature(userId, { supabase = getSupabase() } = {}) {
  const { data, error } = await supabase
    .from("users")
    .select("signature_enabled, signature_storage_path, data_atualizacao")
    .eq("id", userId)
    .maybeSingle();

  if (error) throw databaseError("consultar a assinatura do usuário", "database.select", userId, error);
  return formatSignature(userId, data, supabase);
}

export async function getUserSignatureForReply(userId, { supabase = getSupabase() } = {}) {
  const row = await getSignatureRow(userId, supabase);
  const enabled = row?.signature_enabled === true;
  if (!enabled) {
    return {
      enabled: false,
      has_signature: false,
      storage_path: null,
      image_bytes: null,
      storage_downloaded: false,
    };
  }

  const path = typeof row?.signature_storage_path === "string"
    ? row.signature_storage_path.trim()
    : "";
  const expectedPath = signatureStoragePath(userId);
  if (!path || path !== expectedPath) {
    throw signatureLoadError(userId, new Error("Path da assinatura ausente ou inválido."));
  }

  const { data, error } = await supabase.storage
    .from(SIGNATURE_BUCKET)
    .download(path);

  if (error || !data) throw signatureLoadError(userId, error || new Error("PNG não retornado pelo Storage."));

  let imageBytes;
  try {
    imageBytes = await storageDataToBuffer(data);
  } catch (cause) {
    throw signatureLoadError(userId, cause);
  }

  if (!isValidPngBytes(imageBytes)) {
    throw signatureLoadError(userId, new Error("O objeto baixado não é um PNG válido."));
  }

  return {
    enabled: true,
    has_signature: true,
    storage_path: path,
    image_bytes: imageBytes,
    storage_downloaded: true,
  };
}

export async function uploadUserSignature(userId, file, { supabase = getSupabase() } = {}) {
  if (!isValidPngFile(file)) {
    throw Object.assign(new Error("A assinatura deve ser um arquivo PNG válido."), {
      statusCode: 400,
      signatureError: true,
      signatureLog: {
        stage: "validation",
        status: 400,
        supabaseMessage: null,
        userId,
      },
    });
  }

  const path = signatureStoragePath(userId);
  const { error: uploadError } = await supabase.storage.from(SIGNATURE_BUCKET).upload(path, file.buffer, {
    contentType: "image/png",
    upsert: true,
  });

  if (uploadError) throw databaseError("salvar a assinatura no Storage", "storage.upload", userId, uploadError);

  const { error: updateError } = await supabase
    .from("users")
    .update({ signature_enabled: true, signature_storage_path: path })
    .eq("id", userId);

  if (updateError) {
    await supabase.storage.from(SIGNATURE_BUCKET).remove([path]).catch(() => undefined);
    throw databaseError("salvar a configuração da assinatura", "database.update", userId, updateError);
  }

  return getUserSignature(userId, { supabase });
}

export async function updateUserSignatureSettings(userId, enabled, { supabase = getSupabase() } = {}) {
  const { error } = await supabase
    .from("users")
    .update({ signature_enabled: enabled })
    .eq("id", userId);

  if (error) throw databaseError("atualizar as configurações da assinatura", "database.update", userId, error);
  return getUserSignature(userId, { supabase });
}

export async function deleteUserSignature(userId, { supabase = getSupabase() } = {}) {
  const path = signatureStoragePath(userId);
  const { error: removeError } = await supabase.storage.from(SIGNATURE_BUCKET).remove([path]);
  if (removeError) throw databaseError("remover a assinatura do Storage", "storage.remove", userId, removeError);

  const { error: updateError } = await supabase
    .from("users")
    .update({ signature_enabled: false, signature_storage_path: null })
    .eq("id", userId);

  if (updateError) throw databaseError("limpar a configuração da assinatura", "database.update", userId, updateError);
}
