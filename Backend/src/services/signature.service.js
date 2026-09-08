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

export async function getUserSignatureConfig(
  userId,
  {
    supabase = getSupabase(),
    downloadImage = false,
    includePublicUrl = false,
  } = {},
) {
  const { data, error } = await supabase
    .from("users")
    .select("id, signature_enabled, signature_storage_path, data_atualizacao")
    .eq("id", userId)
    .maybeSingle();

  if (error) throw databaseError("consultar a assinatura do usuário", "database.select", userId, error);
  if (!data || data.id !== userId) {
    const error = databaseError(
      "localizar a configuração da assinatura do usuário autenticado",
      "database.signature_user",
      userId,
      new Error("Usuário autenticado não encontrado na consulta de assinatura."),
    );
    error.signatureDebug = {
      enabled: false,
      profile_enabled: false,
      reply_enabled: false,
      path_found: false,
      has_signature: false,
      same_authenticated_user: false,
    };
    throw error;
  }

  const storagePath =
    typeof data.signature_storage_path === "string"
      ? data.signature_storage_path.trim()
      : "";
  const pathFound = storagePath.length > 0;
  const hasSignature = pathFound && storagePath === signatureStoragePath(userId);
  const enabled = data.signature_enabled === true;
  const config = {
    enabled,
    hasSignature,
    storagePath: hasSignature ? storagePath : null,
    imageBytes: null,
    storageDownloaded: false,
    sameAuthenticatedUser: data.id === userId,
    imageUrl:
      includePublicUrl && enabled && hasSignature
        ? publicUrlWithVersion(supabase, storagePath, data.data_atualizacao)
        : null,
  };

  if (!downloadImage || !enabled) return config;

  if (!hasSignature) {
    throw signatureDownloadError(
      userId,
      new Error("Path da assinatura ausente ou inválido."),
      { pathFound },
    );
  }

  const { data: storageData, error: storageError } = await supabase.storage
    .from(SIGNATURE_BUCKET)
    .download(storagePath);

  if (storageError || !storageData) {
    throw signatureDownloadError(
      userId,
      storageError || new Error("PNG não retornado pelo Storage."),
      { pathFound: true, hasSignature: true },
    );
  }

  let imageBytes;
  try {
    imageBytes = await storageDataToBuffer(storageData);
  } catch (cause) {
    throw signatureDownloadError(userId, cause, {
      pathFound: true,
      hasSignature: true,
      storageDownloaded: true,
    });
  }

  if (!isValidPngBytes(imageBytes)) {
    throw signatureDownloadError(
      userId,
      new Error("O objeto baixado não é um PNG válido."),
      { pathFound: true, hasSignature: true, storageDownloaded: true },
    );
  }

  return {
    ...config,
    imageBytes,
    storageDownloaded: true,
  };
}

function signatureDownloadError(
  userId,
  cause,
  { pathFound = false, hasSignature = false, storageDownloaded = false } = {},
) {
  return Object.assign(new Error("Não foi possível carregar a assinatura PNG ativa."), {
    statusCode: 502,
    publicCode: "SIGNATURE_DOWNLOAD_FAILED",
    safeToFallback: false,
    signatureError: true,
    signatureDebug: {
      enabled: true,
      profile_enabled: true,
      reply_enabled: true,
      path_found: pathFound,
      has_signature: hasSignature,
      same_authenticated_user: true,
      storage_downloaded: storageDownloaded,
    },
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
  const config = await getUserSignatureConfig(userId, {
    supabase,
    includePublicUrl: true,
  });
  return {
    enabled: config.enabled,
    has_signature: config.hasSignature,
    image_url: config.imageUrl,
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
