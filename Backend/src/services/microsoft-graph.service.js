import { getValidMicrosoftAccessToken } from "./microsoft-oauth.service.js";

const GRAPH_SEND_MAIL_URL = "https://graph.microsoft.com/v1.0/me/sendMail";

function serviceError(message, statusCode = 502) {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * Envia um e-mail usando a conta Microsoft conectada ao usuário do Help Desk.
 * O token é obtido e utilizado somente no backend.
 */
export async function sendMicrosoftEmail(
  userId,
  { to, subject, html },
  { getAccessToken = getValidMicrosoftAccessToken, fetchImpl = globalThis.fetch } = {},
) {
  let accessToken;
  try {
    accessToken = await getAccessToken(userId);
  } catch (error) {
    // Mantém o erro funcional do OAuth, mas nunca propaga dados de credenciais.
    if (error?.statusCode === 404) {
      throw serviceError("Conta Microsoft não conectada.", 404);
    }
    throw serviceError("Não foi possível obter a conexão Microsoft para envio.", 502);
  }

  let response;
  try {
    response = await fetchImpl(GRAPH_SEND_MAIL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          subject,
          body: {
            contentType: "HTML",
            content: html,
          },
          toRecipients: [
            {
              emailAddress: {
                address: to,
              },
            },
          ],
        },
        saveToSentItems: true,
      }),
    });
  } catch (error) {
    throw serviceError("Não foi possível comunicar com o Microsoft Outlook.", 502);
  }

  if (response.status !== 202) {
    throw serviceError("A Microsoft não aceitou o envio do e-mail.", 502);
  }
}


function safeHtmlFromText(text) {
  return String(text).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]).replace(/\r?\n/g, "<br>");
}

function graphReplyError(status) {
  const errors = {
    400: {
      code: "GRAPH_BAD_REQUEST",
      message: "A Microsoft rejeitou o payload ou o identificador da mensagem.",
    },
    401: {
      code: "GRAPH_UNAUTHORIZED",
      message: "A Microsoft não autorizou a resposta com a conta conectada.",
    },
    403: {
      code: "GRAPH_FORBIDDEN",
      message: "A conta Microsoft conectada não tem acesso para responder esta mensagem.",
    },
    404: {
      code: "GRAPH_MESSAGE_NOT_FOUND",
      message: "A mensagem original não foi encontrada na conta Microsoft conectada.",
    },
    408: {
      code: "GRAPH_REQUEST_REJECTED",
      message: "A Microsoft não processou a resposta dentro do prazo.",
      safeToFallback: true,
    },
    429: {
      code: "GRAPH_RATE_LIMITED",
      message: "A Microsoft limitou temporariamente o envio da resposta.",
      safeToFallback: true,
    },
  };
  const details =
    errors[status] ||
    (status >= 500 && status <= 599
      ? {
          code: "GRAPH_TEMPORARY_FAILURE",
          message: "A Microsoft está temporariamente indisponível para responder.",
          safeToFallback: true,
        }
      : {
          code: "GRAPH_REPLY_FAILED",
          message: "A Microsoft não aceitou a resposta da mensagem.",
        });
  return Object.assign(new Error(details.message), {
    statusCode: 502,
    publicCode: details.code,
    graphStatus: status,
    safeToFallback: details.safeToFallback === true,
  });
}

function isPreSendNetworkError(error) {
  return (
    error instanceof TypeError ||
    error?.name === "AbortError" ||
    error?.name === "TimeoutError"
  );
}

/**
 * Responde diretamente a uma mensagem existente na mailbox Microsoft conectada.
 * Este método não persiste nada no Help Desk.
 */
export async function replyToMicrosoftMessage(
  userId,
  { messageId, message },
  { getAccessToken = getValidMicrosoftAccessToken, fetchImpl = globalThis.fetch } = {},
) {
  if (typeof messageId !== "string" || messageId.trim().length === 0) {
    throw Object.assign(new Error("Identificador da mensagem inválido."), { statusCode: 400 });
  }

  let accessToken;
  try {
    accessToken = await getAccessToken(userId);
  } catch (error) {
    if (error?.statusCode === 404) {
      throw Object.assign(new Error("Conta Microsoft não conectada."), {
        statusCode: 404,
        publicCode: "MICROSOFT_NOT_CONNECTED",
        safeToFallback: true,
      });
    }
    if (isPreSendNetworkError(error)) {
      throw Object.assign(
        new Error("A conexão Microsoft está temporariamente indisponível."),
        {
          statusCode: 502,
          publicCode: "MICROSOFT_TOKEN_NETWORK_ERROR",
          safeToFallback: true,
        },
      );
    }
    throw Object.assign(new Error("Não foi possível obter a conexão Microsoft para responder."), {
      statusCode: 502,
      publicCode: "MICROSOFT_TOKEN_UNAVAILABLE",
      safeToFallback: false,
    });
  }

  let response;
  try {
    response = await fetchImpl(
      `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/reply`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            body: {
              contentType: "HTML",
              content: safeHtmlFromText(message),
            },
          },
        }),
        signal: AbortSignal.timeout(15000),
      },
    );
  } catch {
    throw Object.assign(new Error("Não foi possível confirmar se o Microsoft Outlook enviou a resposta."), {
      statusCode: 502,
      publicCode: "GRAPH_DELIVERY_UNKNOWN",
      safeToFallback: false,
    });
  }

  if (response.status !== 202) {
    throw graphReplyError(response.status);
  }
}
