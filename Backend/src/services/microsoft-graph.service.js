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

