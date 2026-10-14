import assert from "node:assert/strict";
import { test } from "node:test";
import {
  choosePhotoCandidate,
  classifyImageCandidates,
  corporateEmailForName,
  extractOnboardingFields,
  isOnboardingSubject,
  ONBOARDING_SUBJECT,
} from "../src/services/signature-onboarding-parser.js";
import { webhookPayloadSchema } from "../src/schemas/webhook.schema.js";

test("identifica somente o assunto de onboarding esperado, ignorando caixa e espaços", () => {
  assert.equal(isOnboardingSubject(ONBOARDING_SUBJECT), true);
  assert.equal(
    isOnboardingSubject("  centauro/interno: chamado - onboarding de ti  "),
    true,
  );
  assert.equal(
    isOnboardingSubject("Centauro/Interno: Chamado - Desligamento de TI"),
    false,
  );
});

test("o webhook aceita o assunto exato de onboarding solicitado", () => {
  const result = webhookPayloadSchema.safeParse({
    message_id: "message-1",
    conversation_id: "conversation-1",
    remetente_email: "rh@centaurotelecom.com.br",
    assunto: ONBOARDING_SUBJECT,
    corpo_mensagem: "Nome: Pessoa de Teste",
    corpo_html: "<p>Nome: Pessoa de Teste</p>",
    data_recebimento: "2026-10-14T18:00:00.000Z",
    attachments: [],
  });
  assert.equal(result.success, true);
});

test("gera e-mail com primeiro e último nome e inclui somente o de antes do último sobrenome", () => {
  assert.equal(
    corporateEmailForName("Kevin Batista de Souza"),
    "kevindesouza@centaurotelecom.com.br",
  );
  assert.equal(
    corporateEmailForName("Iury da Costa Nunes"),
    "iurynunes@centaurotelecom.com.br",
  );
  assert.equal(
    corporateEmailForName("Ulisses Moreira de Melo"),
    "ulissesdemelo@centaurotelecom.com.br",
  );
  assert.equal(
    corporateEmailForName("Álvaro de Sá"),
    "alvarodesa@centaurotelecom.com.br",
  );
  assert.equal(corporateEmailForName("Madonna"), null);
});

test("extrai nome, função e telefone de HTML típico do Outlook", () => {
  const fields = extractOnboardingFields(`
    <table>
      <tr><td>Nome do colaborador:</td><td>Kevin Batista de Souza</td></tr>
      <tr><td>Função:</td><td>Analista de Redes</td></tr>
      <tr><td>Telefone:</td><td>(21) 98476-3729</td></tr>
    </table>
  `);
  assert.equal(fields.employeeName, "Kevin Batista de Souza");
  assert.equal(fields.jobTitle, "Analista de Redes");
  assert.equal(fields.phone, "(21) 98476-3729");
});

test("diferencia foto anexada de logos e imagens inline após a assinatura", () => {
  const candidates = classifyImageCandidates(
    [
      {
        id: "photo",
        file_name: "foto-colaborador.jpg",
        content_type: "image/jpeg",
        file_size: 230_000,
        is_inline: false,
        content_id: null,
      },
      {
        id: "logo",
        file_name: "logo-centauro.png",
        content_type: "image/png",
        file_size: 12_000,
        is_inline: true,
        content_id: "logo-rh",
      },
      {
        id: "icon",
        file_name: "linkedin.png",
        content_type: "image/png",
        file_size: 3_000,
        is_inline: true,
        content_id: "linkedin-rh",
      },
    ],
    "<p>Dados do colaborador</p><p>Atenciosamente</p><img src=\"cid:logo-rh\"><img src=\"cid:linkedin-rh\">",
  );

  assert.equal(candidates[0].attachment_id, "photo");
  assert.equal(candidates[0].classification, "provavel_foto");
  assert.equal(candidates.at(-1).classification, "assinatura_remetente");
  assert.equal(choosePhotoCandidate(candidates)?.attachment_id, "photo");
});

test("não seleciona automaticamente quando duas fotos são igualmente plausíveis", () => {
  const candidates = classifyImageCandidates(
    [
      {
        id: "one",
        file_name: "foto-1.jpg",
        content_type: "image/jpeg",
        file_size: 200_000,
        is_inline: false,
      },
      {
        id: "two",
        file_name: "foto-2.jpg",
        content_type: "image/jpeg",
        file_size: 190_000,
        is_inline: false,
      },
    ],
    "<p>Onboarding</p>",
  );
  assert.equal(choosePhotoCandidate(candidates), null);
});
