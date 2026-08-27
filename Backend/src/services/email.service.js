/**
 * Serviço de envio de e-mail via Power Automate.
 * Express → Power Automate → Outlook → Solicitante
 */
export async function sendTicketReply({
  ticketId,
  messageId,
  destinatario,
  assunto,
  mensagem,
  prioridade = "Normal",
}) {
  if (typeof messageId !== "string" || !messageId.trim()) {
    throw Object.assign(
      new Error("O chamado não possui identificador de mensagem para resposta."),
      { statusCode: 400 },
    );
  }

  const replyUrl = process.env.POWER_AUTOMATE_REPLY_URL;
  const replySecret = process.env.POWER_AUTOMATE_REPLY_SECRET;

  if (!replyUrl) {
    throw Object.assign(
      new Error("POWER_AUTOMATE_REPLY_URL não configurado."),
      { statusCode: 503 },
    );
  }

  const payload = {
    ticket_id: ticketId,
    message_id: messageId,
    destinatario,
    assunto,
    mensagem,
    prioridade,
  };

  const headers = {
    "Content-Type": "application/json",
  };

  // Adicionar autenticação se configurada
  if (replySecret) {
    headers["x-webhook-secret"] = replySecret;
  }

  let response;
  try {
    response = await fetch(replyUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
  } catch (cause) {
    console.error("Falha de comunicação com o Power Automate:", cause.message);
    throw Object.assign(
      new Error("O serviço de envio de e-mail está indisponível."),
      { statusCode: 502, cause },
    );
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Sem detalhes");
    console.error(`Power Automate respondeu ${response.status}: ${errorText}`);
    throw Object.assign(
      new Error("O serviço de envio de e-mail recusou a solicitação."),
      { statusCode: 502 },
    );
  }

  return { success: true };
}
