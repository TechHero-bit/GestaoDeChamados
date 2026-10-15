import { randomUUID } from "node:crypto";
import { getSupabase } from "../config/supabase.js";
import {
  INCOMING_ATTACHMENT_BUCKET,
  getIncomingAttachmentForTicket,
} from "./incoming-attachment.service.js";
import {
  choosePhotoCandidate,
  classifyImageCandidates,
  corporateEmailForName,
  extractOnboardingFields,
  isOnboardingSubject,
} from "./signature-onboarding-parser.js";

export const SIGNATURE_BUCKET = "AssinaturasColaboradores";
export const MAX_SIGNATURE_IMAGE_BYTES = 5 * 1024 * 1024;

const REQUEST_FIELDS = [
  "id",
  "source_ticket_id",
  "source_outlook_message_id",
  "source_sender_email",
  "source_subject",
  "employee_name",
  "job_title",
  "phone",
  "corporate_email",
  "status",
  "extraction_warnings",
  "email_conflict",
  "photo_selection_required",
  "photo_confidence",
  "photo_attachment_id",
  "generated_at",
  "created_at",
  "data_atualizacao",
].join(",");

function serviceError(action, cause, statusCode = 502) {
  return Object.assign(new Error(`Não foi possível ${action}.`), {
    statusCode,
    cause,
  });
}

function normalizedSlug(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function toPublicRequest(row, images = [], history = []) {
  return {
    ...row,
    has_manual_photo: Boolean(row.photo_storage_path),
    photo_storage_path: undefined,
    images,
    history,
  };
}

async function emailIsInUse(supabase, email, excludedRequestId = null) {
  if (!email) return false;
  let requestQuery = supabase
    .from("signature_requests")
    .select("id")
    .ilike("corporate_email", email)
    .limit(1);
  if (excludedRequestId) requestQuery = requestQuery.neq("id", excludedRequestId);

  const [
    { data: request, error: requestError },
    { data: user, error: userError },
  ] = await Promise.all([
    requestQuery.maybeSingle(),
    supabase
      .from("users")
      .select("id")
      .ilike("email", email)
      .limit(1)
      .maybeSingle(),
  ]);
  if (requestError || userError) {
    throw serviceError(
      "verificar a duplicidade do e-mail corporativo",
      requestError || userError,
    );
  }
  return Boolean(request || user);
}

function statusFor(request, emailConflict) {
  const complete =
    request.employee_name &&
    request.job_title &&
    request.phone &&
    request.corporate_email &&
    (request.photo_attachment_id || request.photo_storage_path);
  return complete && !emailConflict ? "Pendente" : "Revisão necessária";
}

function warningsFor(request, emailConflict) {
  const warnings = [];
  if (!request.employee_name) warnings.push("Nome não identificado automaticamente.");
  if (!request.job_title) warnings.push("Função não identificada automaticamente.");
  if (!request.phone) warnings.push("Telefone não identificado automaticamente.");
  if (!request.corporate_email) {
    warnings.push("E-mail não pôde ser gerado automaticamente.");
  }
  if (emailConflict) warnings.push("O e-mail corporativo já está em uso.");
  if (!request.photo_attachment_id && !request.photo_storage_path) {
    warnings.push("Selecione manualmente a fotografia correta.");
  }
  return warnings;
}

export async function processOutlookOnboarding(
  { payload, ticket, message, attachments },
  { supabase = getSupabase() } = {},
) {
  if (!isOnboardingSubject(payload.assunto)) return null;

  const { data: existing, error: existingError } = await supabase
    .from("signature_requests")
    .select(REQUEST_FIELDS)
    .eq("source_outlook_message_id", payload.message_id)
    .maybeSingle();
  if (existingError) {
    throw serviceError("verificar a solicitação de assinatura", existingError);
  }
  if (existing) {
    return { request: toPublicRequest(existing), duplicate: true };
  }

  const content = payload.corpo_html || payload.corpo_mensagem;
  const extracted = extractOnboardingFields(content);
  const corporateEmail = corporateEmailForName(extracted.employeeName);
  const emailConflict = await emailIsInUse(supabase, corporateEmail);
  const candidates = classifyImageCandidates(attachments, content);
  const selectedPhoto = choosePhotoCandidate(candidates);
  const draftRequest = {
    employee_name: extracted.employeeName,
    job_title: extracted.jobTitle,
    phone: extracted.phone,
    corporate_email: corporateEmail,
    photo_attachment_id: selectedPhoto?.attachment_id || null,
    photo_storage_path: null,
  };
  const warnings = warningsFor(draftRequest, emailConflict);

  const id = randomUUID();
  const { data: request, error } = await supabase
    .from("signature_requests")
    .insert({
      id,
      source_ticket_id: ticket?.id || null,
      source_ticket_message_id: message?.id || null,
      source_outlook_message_id: payload.message_id,
      source_conversation_id: payload.conversation_id,
      source_sender_email: payload.remetente_email,
      source_subject: payload.assunto,
      employee_name: extracted.employeeName,
      job_title: extracted.jobTitle,
      phone: extracted.phone,
      corporate_email: corporateEmail,
      status: warnings.length > 0 ? "Revisão necessária" : "Pendente",
      extraction_warnings: warnings,
      email_conflict: emailConflict,
      photo_selection_required: !selectedPhoto,
      photo_confidence: selectedPhoto?.confidence ?? null,
      photo_attachment_id: selectedPhoto?.attachment_id || null,
    })
    .select(REQUEST_FIELDS)
    .single();
  if (error) {
    if (error.code === "23505") {
      const { data: concurrent } = await supabase
        .from("signature_requests")
        .select(REQUEST_FIELDS)
        .eq("source_outlook_message_id", payload.message_id)
        .maybeSingle();
      if (concurrent) {
        return { request: toPublicRequest(concurrent), duplicate: true };
      }
    }
    throw serviceError("criar a solicitação de assinatura", error);
  }

  if (candidates.length > 0) {
    const { error: imageError } = await supabase
      .from("signature_request_images")
      .insert(
        candidates.map((candidate) => ({
          signature_request_id: id,
          attachment_id: candidate.attachment_id,
          position_index: candidate.position_index,
          score: candidate.score,
          confidence: candidate.confidence,
          classification: candidate.classification,
          reasons: candidate.reasons,
        })),
      );
    if (imageError) {
      throw serviceError("registrar as imagens candidatas", imageError);
    }
  }

  return {
    request: toPublicRequest(request, candidates),
    duplicate: false,
  };
}

export async function listSignatureRequests(
  { status, search, page, page_size: pageSize },
  { supabase = getSupabase() } = {},
) {
  const from = (page - 1) * pageSize;
  let query = supabase
    .from("signature_requests")
    .select(REQUEST_FIELDS, { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, from + pageSize - 1);
  if (status) query = query.eq("status", status);
  const normalizedSearch = search?.replace(/[(),]/g, " ").trim();
  if (normalizedSearch) {
    query = query.or(
      `employee_name.ilike.%${normalizedSearch}%,corporate_email.ilike.%${normalizedSearch}%,job_title.ilike.%${normalizedSearch}%`,
    );
  }
  const { data, error, count } = await query;
  if (error) {
    throw serviceError("listar as solicitações de assinatura", error);
  }
  return {
    data: (data || []).map((row) => toPublicRequest(row)),
    total: count || 0,
    page,
    pageSize,
  };
}

export async function getSignatureRequest(
  id,
  { supabase = getSupabase() } = {},
) {
  const [
    { data: request, error },
    { data: images, error: imageError },
    { data: artifacts, error: artifactError },
  ] = await Promise.all([
    supabase
      .from("signature_requests")
      .select(`${REQUEST_FIELDS},photo_storage_path`)
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("signature_request_images")
      .select(
        "id,attachment_id,position_index,score,confidence,classification,reasons,ticket_message_attachments(file_name,content_type,file_size,is_inline,content_id,processing_status,processing_error,available_at)",
      )
      .eq("signature_request_id", id)
      .order("score", { ascending: false }),
    supabase
      .from("signature_artifacts")
      .select("id,file_name,file_size,created_at,created_by")
      .eq("signature_request_id", id)
      .order("created_at", { ascending: false }),
  ]);
  if (error || imageError || artifactError) {
    throw serviceError(
      "buscar a solicitação de assinatura",
      error || imageError || artifactError,
    );
  }
  if (!request) return null;
  const publicImages = (images || []).map(
    ({ ticket_message_attachments: attachment, ...image }) => ({
      ...image,
      score: Number(image.score),
      confidence: Number(image.confidence),
      file_name: attachment?.file_name || "Imagem",
      content_type: attachment?.content_type || "application/octet-stream",
      file_size: Number(attachment?.file_size || 0),
      is_inline: attachment?.is_inline === true,
      content_id: attachment?.content_id || null,
      processing_status: attachment?.processing_status || "Falhou",
      processing_error: attachment?.processing_error || null,
      available_at: attachment?.available_at || null,
    }),
  );
  return toPublicRequest(request, publicImages, artifacts || []);
}

async function getPrivateRequest(id, supabase) {
  const { data, error } = await supabase
    .from("signature_requests")
    .select(`${REQUEST_FIELDS},photo_storage_path`)
    .eq("id", id)
    .maybeSingle();
  if (error) throw serviceError("buscar a solicitação de assinatura", error);
  if (!data) {
    throw serviceError("localizar a solicitação de assinatura", null, 404);
  }
  return data;
}

export async function updateSignatureRequest(
  id,
  updates,
  { supabase = getSupabase() } = {},
) {
  const current = await getPrivateRequest(id, supabase);
  let selectedAttachment = current.photo_attachment_id;
  let manualPhoto = current.photo_storage_path;

  if (updates.photo_attachment_id !== undefined) {
    selectedAttachment = updates.photo_attachment_id;
    manualPhoto = null;
    if (selectedAttachment) {
      const { data: candidate, error } = await supabase
        .from("signature_request_images")
        .select("id,ticket_message_attachments(processing_status)")
        .eq("signature_request_id", id)
        .eq("attachment_id", selectedAttachment)
        .maybeSingle();
      if (error) throw serviceError("validar a fotografia selecionada", error);
      if (!candidate) {
        throw serviceError(
          "selecionar uma imagem que não pertence à solicitação",
          null,
          400,
        );
      }
      if (candidate.ticket_message_attachments?.processing_status !== "Disponivel") {
        throw await unavailableIncomingPhoto(supabase, selectedAttachment);
      }
      const attachment = await getIncomingAttachmentForTicket(
        { ticketId: current.source_ticket_id, attachmentId: selectedAttachment },
        { supabase },
      );
      if (!attachment) throw await unavailableIncomingPhoto(supabase, selectedAttachment);
      await downloadSignatureImage(
        supabase, INCOMING_ATTACHMENT_BUCKET, attachment.storage_path,
        attachment.content_type, { requestId: id, attachmentId: selectedAttachment },
      );
    }
  }

  const next = {
    ...current,
    ...updates,
    photo_attachment_id: selectedAttachment,
    photo_storage_path: manualPhoto,
  };
  const emailConflict = await emailIsInUse(
    supabase,
    next.corporate_email,
    id,
  );
  const patch = {
    ...updates,
    email_conflict: emailConflict,
    status: statusFor(next, emailConflict),
    extraction_warnings: warningsFor(next, emailConflict),
    ...(updates.photo_attachment_id !== undefined
      ? {
          photo_storage_path: null,
          photo_selection_required: !selectedAttachment,
          photo_confidence: selectedAttachment ? 1 : null,
        }
      : {}),
  };

  const { error } = await supabase
    .from("signature_requests")
    .update(patch)
    .eq("id", id);
  if (error) {
    throw serviceError("atualizar a solicitação de assinatura", error);
  }
  return getSignatureRequest(id, { supabase });
}

function assertPhoto(file) {
  if (
    !file ||
    !["image/png", "image/jpeg", "image/webp"].includes(file.mimetype)
  ) {
    throw serviceError(
      "validar a fotografia; use PNG, JPG ou WebP",
      null,
      400,
    );
  }
  if (file.size <= 0 || file.size > MAX_SIGNATURE_IMAGE_BYTES) {
    throw serviceError("validar o tamanho da fotografia", null, 413);
  }
  assertImageBytes(file.buffer, file.mimetype);
}

function imageExtension(contentType) {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  return "jpg";
}

export async function uploadSignaturePhoto(
  id,
  file,
  { supabase = getSupabase() } = {},
) {
  assertPhoto(file);
  const current = await getPrivateRequest(id, supabase);
  const storagePath = `requests/${id}/photos/${randomUUID()}.${imageExtension(file.mimetype)}`;
  const { error: uploadError } = await supabase.storage
    .from(SIGNATURE_BUCKET)
    .upload(storagePath, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
    });
  if (uploadError) throw serviceError("armazenar a fotografia", uploadError);

  const next = {
    ...current,
    photo_storage_path: storagePath,
    photo_attachment_id: null,
  };
  const emailConflict = await emailIsInUse(
    supabase,
    next.corporate_email,
    id,
  );
  const { error } = await supabase
    .from("signature_requests")
    .update({
      photo_storage_path: storagePath,
      photo_attachment_id: null,
      photo_selection_required: false,
      photo_confidence: 1,
      email_conflict: emailConflict,
      status: statusFor(next, emailConflict),
      extraction_warnings: warningsFor(next, emailConflict),
    })
    .eq("id", id);
  if (error) {
    await supabase.storage.from(SIGNATURE_BUCKET).remove([storagePath]);
    throw serviceError("vincular a fotografia à solicitação", error);
  }
  return getSignatureRequest(id, { supabase });
}

async function unavailableIncomingPhoto(supabase, attachmentId) {
  const { data, error } = await supabase
    .from("ticket_message_attachments")
    .select("processing_status,processing_error")
    .eq("id", attachmentId)
    .maybeSingle();
  if (error) throw serviceError("verificar o estado da fotografia", error);
  const status = data?.processing_status || "Ausente";
  const reason = data?.processing_error || null;
  console.warn("[SIGNATURE_PHOTO]", JSON.stringify({
    stage: "attachment_status",
    attachment_id: attachmentId,
    status,
    reason,
  }));
  const message = status === "Pendente"
    ? "O anexo ainda está pendente de confirmação pelo Power Automate. Atualize a solicitação após concluir o fluxo."
    : status === "Falhou"
      ? "O upload do anexo falhou" + (reason ? " (" + reason + ")" : "") + ". Envie a foto novamente ou corrija o fluxo."
      : "A fotografia selecionada não está disponível para esta solicitação.";
  return Object.assign(new Error(message), {
    statusCode: 409,
    publicCode: "SIGNATURE_PHOTO_UNAVAILABLE",
  });
}

function assertImageBytes(buffer, contentType) {
  const valid = contentType === "image/png"
    ? buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    : contentType === "image/jpeg"
      ? buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
      : contentType === "image/webp"
        ? buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP"
        : false;
  if (!valid) {
    throw Object.assign(new Error("A fotografia não é um PNG, JPG ou WebP válido. Envie outra imagem."), {
      statusCode: 415,
      publicCode: "SIGNATURE_PHOTO_FORMAT_INVALID",
    });
  }
}

async function downloadSignatureImage(supabase, bucket, path, contentType, context) {
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error || !data) {
    console.warn("[SIGNATURE_PHOTO]", JSON.stringify({
      stage: "storage_download",
      request_id: context.requestId,
      attachment_id: context.attachmentId || null,
      error_code: error?.statusCode || error?.status || "DOWNLOAD_FAILED",
    }));
    throw Object.assign(new Error(
      "A imagem foi registrada, mas não pôde ser lida no armazenamento. Confira o PUT e a confirmação do anexo no Power Automate.",
    ), { statusCode: 409, publicCode: "SIGNATURE_PHOTO_STORAGE_READ_FAILED", cause: error });
  }
  const buffer = Buffer.from(await data.arrayBuffer());
  if (buffer.length === 0 || buffer.length > MAX_SIGNATURE_IMAGE_BYTES) {
    throw Object.assign(new Error("A fotografia deve ter até 5 MiB. Envie outra imagem."), {
      statusCode: 413,
      publicCode: "SIGNATURE_PHOTO_SIZE_INVALID",
    });
  }
  assertImageBytes(buffer, contentType);
  return { buffer, contentType };
}

export async function getSignaturePhoto(
  id,
  { supabase = getSupabase() } = {},
) {
  const request = await getPrivateRequest(id, supabase);
  if (request.photo_attachment_id) {
    const attachment = await getIncomingAttachmentForTicket(
      { ticketId: request.source_ticket_id, attachmentId: request.photo_attachment_id },
      { supabase },
    );
    if (!attachment) throw await unavailableIncomingPhoto(supabase, request.photo_attachment_id);
    return downloadSignatureImage(
      supabase, INCOMING_ATTACHMENT_BUCKET, attachment.storage_path,
      attachment.content_type, { requestId: id, attachmentId: attachment.id },
    );
  }
  if (!request.photo_storage_path) {
    throw Object.assign(new Error("Selecione ou envie uma fotografia."), { statusCode: 404 });
  }
  return downloadSignatureImage(
    supabase, SIGNATURE_BUCKET, request.photo_storage_path,
    request.photo_storage_path.endsWith(".png") ? "image/png"
      : request.photo_storage_path.endsWith(".webp") ? "image/webp" : "image/jpeg",
    { requestId: id },
  );
}

export async function getCandidateImage(
  id,
  attachmentId,
  { supabase = getSupabase() } = {},
) {
  const request = await getPrivateRequest(id, supabase);
  const { data: candidate, error } = await supabase
    .from("signature_request_images")
    .select("id")
    .eq("signature_request_id", id)
    .eq("attachment_id", attachmentId)
    .maybeSingle();
  if (error) throw serviceError("validar a imagem candidata", error);
  if (!candidate) throw serviceError("localizar a imagem candidata", null, 404);
  const attachment = await getIncomingAttachmentForTicket(
    { ticketId: request.source_ticket_id, attachmentId },
    { supabase },
  );
  if (!attachment) throw await unavailableIncomingPhoto(supabase, attachmentId);
  return downloadSignatureImage(
    supabase, INCOMING_ATTACHMENT_BUCKET, attachment.storage_path,
    attachment.content_type, { requestId: id, attachmentId },
  );
}
function assertGeneratedPng(file) {
  const signature = file?.buffer?.subarray(0, 8)?.toString("hex");
  if (
    !file ||
    file.mimetype !== "image/png" ||
    signature !== "89504e470d0a1a0a"
  ) {
    throw serviceError("validar a assinatura gerada como PNG", null, 400);
  }
  if (file.size <= 0 || file.size > MAX_SIGNATURE_IMAGE_BYTES) {
    throw serviceError("validar o tamanho da assinatura gerada", null, 413);
  }
  const width = file.buffer.readUInt32BE(16);
  const height = file.buffer.readUInt32BE(20);
  if (width !== 768 || height !== 200) {
    throw serviceError(
      "validar as dimensões da assinatura (768 × 200 px)",
      null,
      400,
    );
  }
}

export async function saveGeneratedSignature(
  id,
  file,
  userId,
  { supabase = getSupabase() } = {},
) {
  assertGeneratedPng(file);
  const request = await getPrivateRequest(id, supabase);
  const emailConflict = await emailIsInUse(
    supabase,
    request.corporate_email,
    id,
  );
  if (statusFor(request, emailConflict) !== "Pendente") {
    throw serviceError(
      "gerar a assinatura enquanto há campos pendentes ou e-mail duplicado",
      null,
      409,
    );
  }
  if (request.photo_attachment_id) {
    const availablePhoto = await getIncomingAttachmentForTicket(
      {
        ticketId: request.source_ticket_id,
        attachmentId: request.photo_attachment_id,
      },
      { supabase },
    );
    if (!availablePhoto) {
      throw serviceError(
        "gerar a assinatura porque a fotografia selecionada não está disponível",
        null,
        409,
      );
    }
    await downloadSignatureImage(
      supabase, INCOMING_ATTACHMENT_BUCKET, availablePhoto.storage_path,
      availablePhoto.content_type, { requestId: id, attachmentId: availablePhoto.id },
    );
  }

  const artifactId = randomUUID();
  const fileName = `assinatura-${normalizedSlug(request.employee_name) || "colaborador"}.png`;
  const storagePath = `requests/${id}/history/${artifactId}.png`;
  const { error: uploadError } = await supabase.storage
    .from(SIGNATURE_BUCKET)
    .upload(storagePath, file.buffer, {
      contentType: "image/png",
      upsert: false,
    });
  if (uploadError) {
    throw serviceError("armazenar a assinatura gerada", uploadError);
  }

  const snapshot = {
    employee_name: request.employee_name,
    job_title: request.job_title,
    phone: request.phone,
    corporate_email: request.corporate_email,
    template: "MODELO CENTAURO (17).png",
    dimensions: { width: 768, height: 200 },
    source_dimensions: { width: 800, height: 200 },
  };
  const { error: artifactError } = await supabase
    .from("signature_artifacts")
    .insert({
      id: artifactId,
      signature_request_id: id,
      storage_path: storagePath,
      file_name: fileName,
      content_type: "image/png",
      file_size: file.size,
      snapshot,
      created_by: userId,
    });
  if (artifactError) {
    await supabase.storage.from(SIGNATURE_BUCKET).remove([storagePath]);
    throw serviceError("registrar o histórico da assinatura", artifactError);
  }

  const { error: updateError } = await supabase
    .from("signature_requests")
    .update({
      status: "Gerada",
      generated_at: new Date().toISOString(),
      generated_by: userId,
    })
    .eq("id", id);
  if (updateError) {
    throw serviceError("concluir a solicitação de assinatura", updateError);
  }
  return {
    request: await getSignatureRequest(id, { supabase }),
    artifact_id: artifactId,
    file_name: fileName,
  };
}

export async function getArtifactUrl(
  id,
  artifactId,
  { supabase = getSupabase() } = {},
) {
  const { data: artifact, error } = await supabase
    .from("signature_artifacts")
    .select("storage_path,file_name")
    .eq("id", artifactId)
    .eq("signature_request_id", id)
    .maybeSingle();
  if (error) throw serviceError("buscar a assinatura gerada", error);
  if (!artifact) {
    throw serviceError("localizar a assinatura gerada", null, 404);
  }
  const { data, error: signedError } = await supabase.storage
    .from(SIGNATURE_BUCKET)
    .createSignedUrl(artifact.storage_path, 60, {
      download: artifact.file_name,
    });
  if (signedError || !data?.signedUrl) {
    throw serviceError(
      "autorizar o download da assinatura",
      signedError,
    );
  }
  return data.signedUrl;
}
