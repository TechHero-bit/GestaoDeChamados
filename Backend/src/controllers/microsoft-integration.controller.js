import {
  getFrontendUrl,
  getMicrosoftAuthorizationUrl,
} from "../config/microsoft.js";
import * as microsoftOAuthService from "../services/microsoft-oauth.service.js";

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
