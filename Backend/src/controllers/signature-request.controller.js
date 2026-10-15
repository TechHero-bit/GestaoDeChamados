import {
  listSignatureRequestsSchema,
  signatureRequestIdSchema,
  updateSignatureRequestSchema,
} from "../schemas/signature-request.schema.js";
import * as signatureRequestService from "../services/signature-request.service.js";

function validationError(res, result, message = "Dados inválidos.") {
  return res.status(400).json({
    success: false,
    message,
    errors: result.error.errors.map((error) => ({
      campo: error.path.join("."),
      mensagem: error.message,
    })),
  });
}

function parseId(value, res) {
  const result = signatureRequestIdSchema.safeParse(value);
  if (!result.success) {
    validationError(res, result, "Identificador de assinatura inválido.");
    return null;
  }
  return result.data;
}

export async function listarSolicitacoes(req, res, next) {
  try {
    const result = listSignatureRequestsSchema.safeParse(req.query);
    if (!result.success) return validationError(res, result, "Filtros inválidos.");
    const response = await signatureRequestService.listSignatureRequests(
      result.data,
    );
    return res.json({
      success: true,
      data: response.data,
      total: response.total,
      page: response.page,
      page_size: response.pageSize,
    });
  } catch (error) {
    next(error);
  }
}

export async function buscarSolicitacao(req, res, next) {
  try {
    const id = parseId(req.params.id, res);
    if (!id) return;
    const request = await signatureRequestService.getSignatureRequest(id);
    if (!request) {
      return res.status(404).json({
        success: false,
        message: "Solicitação de assinatura não encontrada.",
      });
    }
    return res.json({ success: true, data: request });
  } catch (error) {
    next(error);
  }
}

export async function atualizarSolicitacao(req, res, next) {
  try {
    const id = parseId(req.params.id, res);
    if (!id) return;
    const result = updateSignatureRequestSchema.safeParse(req.body);
    if (!result.success) return validationError(res, result);
    const request = await signatureRequestService.updateSignatureRequest(
      id,
      result.data,
    );
    return res.json({
      success: true,
      message: "Solicitação atualizada com sucesso.",
      data: request,
    });
  } catch (error) {
    next(error);
  }
}

export async function enviarFotografia(req, res, next) {
  try {
    const id = parseId(req.params.id, res);
    if (!id) return;
    const request = await signatureRequestService.uploadSignaturePhoto(
      id,
      req.file,
    );
    return res.status(201).json({
      success: true,
      message: "Fotografia armazenada com segurança.",
      data: request,
    });
  } catch (error) {
    next(error);
  }
}

export async function abrirFotografia(req, res, next) {
  try {
    const id = parseId(req.params.id, res);
    if (!id) return;
    const image = await signatureRequestService.getSignaturePhoto(id);
    res.setHeader("Cache-Control", "private, no-store");
    return res.type(image.contentType).send(image.buffer);
  } catch (error) {
    next(error);
  }
}

export async function abrirImagemCandidata(req, res, next) {
  try {
    const id = parseId(req.params.id, res);
    if (!id) return;
    const attachmentId = parseId(req.params.attachmentId, res);
    if (!attachmentId) return;
    const image = await signatureRequestService.getCandidateImage(id, attachmentId);
    res.setHeader("Cache-Control", "private, no-store");
    return res.type(image.contentType).send(image.buffer);
  } catch (error) {
    next(error);
  }
}
export async function gerarAssinatura(req, res, next) {
  try {
    const id = parseId(req.params.id, res);
    if (!id) return;
    const generated = await signatureRequestService.saveGeneratedSignature(
      id,
      req.file,
      req.user.id,
    );
    return res.status(201).json({
      success: true,
      message: "Assinatura gerada e registrada no histórico.",
      data: generated,
    });
  } catch (error) {
    next(error);
  }
}

export async function baixarAssinatura(req, res, next) {
  try {
    const id = parseId(req.params.id, res);
    if (!id) return;
    const artifactId = parseId(req.params.artifactId, res);
    if (!artifactId) return;
    const url = await signatureRequestService.getArtifactUrl(id, artifactId);
    return res.redirect(302, url);
  } catch (error) {
    next(error);
  }
}
