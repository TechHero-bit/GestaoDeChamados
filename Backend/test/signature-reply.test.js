import assert from "node:assert/strict";
import { test } from "node:test";
import { sendAndPersistTicketReply } from "../src/services/ticket-reply.service.js";

const ticket = {
  id: "00000000-0000-4000-8000-000000000001",
  remetente_email: "requester@example.com",
  assunto: "Teste",
  prioridade: "Normal",
  outlook_last_message_id: "message-id",
};

function dependencies(connected) {
  let externalPayload;
  let persisted;
  return {
    getConnectionStatus: async () => ({ connected, email: "agent@example.com" }),
    getSignature: async (userId) => {
      assert.equal(userId, "user-a");
      return {
        enabled: true,
        has_signature: true,
        image_url: "https://project.supabase.co/signature.png?v=1",
      };
    },
    replyWithMicrosoftGraph: async (_userId, payload) => {
      externalPayload = payload;
    },
    replyWithPowerAutomate: async (payload) => {
      externalPayload = payload;
    },
    persistMessage: async (payload) => {
      persisted = payload;
      return payload;
    },
    helpdeskEmail: () => "helpdesk@example.com",
    getExternalPayload: () => externalPayload,
    getPersisted: () => persisted,
  };
}

test("assinatura habilitada chega ao Graph e a timeline guarda somente a mensagem original", async () => {
  const deps = dependencies(true);
  await sendAndPersistTicketReply(
    { ticket, userId: "user-a", message: "Problema corrigido." },
    deps,
  );

  assert.equal(deps.getExternalPayload().message, "Problema corrigido.");
  assert.match(deps.getExternalPayload().html, /<img src="https:\/\/project\.supabase\.co/);
  assert.equal(deps.getPersisted().corpo_mensagem, "Problema corrigido.");
  assert.equal(deps.getPersisted().corpo_mensagem.includes("<img"), false);
});

test("fallback Power Automate recebe o mesmo HTML final com assinatura", async () => {
  const deps = dependencies(false);
  await sendAndPersistTicketReply(
    { ticket, userId: "user-a", message: "Resposta via fallback" },
    deps,
  );

  assert.match(deps.getExternalPayload().mensagem, /<div>Resposta via fallback<\/div><br><img/);
  assert.equal(deps.getPersisted().corpo_mensagem, "Resposta via fallback");
});

test("assinatura é consultada pelo usuário autenticado e não pode ser reutilizada por outro usuário", async () => {
  const calls = [];
  const deps = dependencies(true);
  deps.getSignature = async (userId) => {
    calls.push(userId);
    return userId === "user-a"
      ? { enabled: true, has_signature: true, image_url: "https://project.supabase.co/a.png" }
      : { enabled: false, has_signature: false, image_url: null };
  };

  await sendAndPersistTicketReply({ ticket, userId: "user-b", message: "Sem assinatura alheia" }, deps);
  assert.deepEqual(calls, ["user-b"]);
  assert.equal(deps.getExternalPayload().html, undefined);
});
