import {
  getFrontendUrl,
  getMicrosoftAuthorizationUrl,
} from "../config/microsoft.js";
import { microsoftTestEmailSchema } from "../schemas/microsoft-email.schema.js";
import * as microsoftGraphService from "../services/microsoft-graph.service.js";
import * as microsoftOAuthService from "../services/microsoft-oauth.service.js";

function validationError(res, resultado, message = "Dados inválidos.") {
  return res.status(400).json({
    success: false,
    message,
    errors: resultado.error.errors.map((error) => ({
      campo: error.path.join("."),
      mensagem: error.message,
    })),
  });
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

export function textToSafeHtml(text) {
  return escapeHtml(text).replace(/\r?\n/g, "<br>");
}

function integrationRedirect(result) {
  const url = new URL("/settings/integrations", getFrontendUrl());
  url.searchParams.set("microsoft", result);
  return url.toString();
}

export async function connectMicrosoft(req, res, next) {
  try {
    const state = await microsoftOAuthService.createMicrosoftOAuthState(req.user.id);
    return res.redirect(getMicrosoftAuthorizationUrl(state));
  } catch (error) {
    next(error);
  }
}

export async function microsoftCallback(req, res, next) {
  const { state, code, error } = req.query;
  if (typeof state !== "string" || state.length < 32 || state.length > 256) {
    return res.status(400).json({ success: false, message: "State OAuth inválido ou ausente." });
  }

  try {
    if (error || typeof code !== "string" || code.length === 0) {
      // Consumir e validar o state mesmo quando o usuário cancela o consentimento.
      const stateData = await microsoftOAuthService.consumeMicrosoftOAuthState(state);
      if (!stateData) {
        return res.status(400).json({ success: false, message: "State OAuth inválido ou expirado." });
      }
      return res.redirect(integrationRedirect("error"));
    }

    await microsoftOAuthService.completeMicrosoftConnection({ state, code });
    return res.redirect(integrationRedirect("connected"));
  } catch (callbackError) {
    if (callbackError.statusCode === 400 && callbackError.message.startsWith("State OAuth")) {
      return res.status(400).json({ success: false, message: "State OAuth inválido ou expirado." });
    }
    return res.redirect(integrationRedirect("error"));
  }
}

export async function microsoftStatus(req, res, next) {
  try {
    const status = await microsoftOAuthService.getMicrosoftConnectionStatus(req.user.id);
    return res.json(status);
  } catch (error) {
    next(error);
  }
}

export async function disconnectMicrosoft(req, res, next) {
  try {
    await microsoftOAuthService.disconnectMicrosoftConnection(req.user.id);
    return res.json({ success: true });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/integrations/microsoft/test-email
 * Envio temporário para validar a conta Outlook conectada do usuário logado.
 */
export async function sendMicrosoftTestEmail(req, res, next) {
  const resultado = microsoftTestEmailSchema.safeParse(req.body);
  if (!resultado.success) {
    return validationError(res, resultado, "Dados do e-mail inválidos.");
  }

  try {
    await microsoftGraphService.sendMicrosoftEmail(req.user.id, {
      to: resultado.data.destinatario,
      subject: resultado.data.assunto,
      html: textToSafeHtml(resultado.data.mensagem),
    });

    return res.status(200).json({
      success: true,
      message: "E-mail enviado pelo Microsoft Outlook.",
    });
  } catch (error) {
    if (error?.statusCode === 404) {
      return res.status(409).json({
        success: false,
        message: "Conecte sua conta Microsoft antes de enviar e-mails.",
      });
    }
    return next(error);
  }
}
