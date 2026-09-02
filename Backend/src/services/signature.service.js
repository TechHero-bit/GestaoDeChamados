import { getSupabase } from "../config/supabase.js";

export const SIGNATURE_BUCKET = "Assinaturas";
const PNG_MAGIC_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function databaseError(action, cause) {
  return Object.assign(new Error(`Não foi possível ${action}.`), {
    statusCode: 502,
    cause,
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
  const hasSignature = path === expectedPath;

  return {
    enabled: row?.signature_enabled === true,
    has_signature: hasSignature,
    image_url: hasSignature ? publicUrlWithVersion(supabase, path, row?.data_atualizacao) : null,
  };
}

export async function getUserSignature(userId, { supabase = getSupabase() } = {}) {
  const { data, error } = await supabase
    .from("users")
    .select("signature_enabled, signature_storage_path, data_atualizacao")
    .eq("id", userId)
    .maybeSingle();

  if (error) throw databaseError("consultar a assinatura do usuário", error);
  return formatSignature(userId, data, supabase);
}

export async function uploadUserSignature(userId, file, { supabase = getSupabase() } = {}) {
  if (!isValidPngFile(file)) {
    throw Object.assign(new Error("A assinatura deve ser um arquivo PNG válido."), {
      statusCode: 400,
    });
  }

  const path = signatureStoragePath(userId);
  const { error: uploadError } = await supabase.storage.from(SIGNATURE_BUCKET).upload(path, file.buffer, {
    contentType: "image/png",
    upsert: true,
  });

  if (uploadError) throw databaseError("salvar a assinatura no Storage", uploadError);

  const { error: updateError } = await supabase
    .from("users")
    .update({ signature_enabled: true, signature_storage_path: path })
    .eq("id", userId);

  if (updateError) {
    await supabase.storage.from(SIGNATURE_BUCKET).remove([path]).catch(() => undefined);
    throw databaseError("salvar a configuração da assinatura", updateError);
  }

  return getUserSignature(userId, { supabase });
}

export async function updateUserSignatureSettings(userId, enabled, { supabase = getSupabase() } = {}) {
  const { error } = await supabase
    .from("users")
    .update({ signature_enabled: enabled })
    .eq("id", userId);

  if (error) throw databaseError("atualizar as configurações da assinatura", error);
  return getUserSignature(userId, { supabase });
}

export async function deleteUserSignature(userId, { supabase = getSupabase() } = {}) {
  const path = signatureStoragePath(userId);
  const { error: removeError } = await supabase.storage.from(SIGNATURE_BUCKET).remove([path]);
  if (removeError) throw databaseError("remover a assinatura do Storage", removeError);

  const { error: updateError } = await supabase
    .from("users")
    .update({ signature_enabled: false, signature_storage_path: null })
    .eq("id", userId);

  if (updateError) throw databaseError("limpar a configuração da assinatura", updateError);
}
