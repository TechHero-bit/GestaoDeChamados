import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import dotenv from "dotenv";
import { getSupabase } from "../src/config/supabase.js";
import { webhookPayloadSchema } from "../src/schemas/webhook.schema.js";
import { signatureRequestIdSchema } from "../src/schemas/signature-request.schema.js";
import { isOnboardingSubject } from "../src/services/signature-onboarding-parser.js";
import { processOutlookOnboarding } from "../src/services/signature-request.service.js";

// Somente consulta por padrão. --apply grava a solicitação e seus candidatos;
// não recria chamado, não faz upload e não altera o fluxo do Power Automate.
dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)), quiet: true });

async function main() {
  const { values } = parseArgs({ options: {
    ticket: { type: "string" },
    apply: { type: "boolean", default: false },
  } });
  const id = signatureRequestIdSchema.safeParse(values.ticket);
  if (!id.success) throw new Error("Use --ticket <UUID> para consultar; --apply somente após autorização de escrita.");
  const supabase = getSupabase();
  const { data: ticket, error } = await supabase.from("tickets")
    .select("id,outlook_message_id,payload_original").eq("id", id.data).maybeSingle();
  if (error || !ticket) throw new Error("Não foi possível consultar o chamado informado.");
  const parsed = webhookPayloadSchema.safeParse(ticket.payload_original);
  if (!parsed.success) throw new Error("O chamado não possui payload original válido para recuperação segura.");
  const payload = parsed.data;
  if (payload.message_id !== ticket.outlook_message_id || !isOnboardingSubject(payload.assunto)) {
    throw new Error("A mensagem original deste chamado não é um onboarding elegível.");
  }
  const { data: message, error: messageError } = await supabase.from("ticket_messages")
    .select("id,ticket_id").eq("ticket_id", ticket.id)
    .eq("outlook_message_id", payload.message_id).maybeSingle();
  if (messageError || !message) throw new Error("Mensagem original não localizada no chamado.");
  const { data: attachments, error: attachmentError } = await supabase.from("ticket_message_attachments")
    .select("id,file_name,content_type,file_size,is_inline,content_id,processing_status")
    .eq("ticket_message_id", message.id);
  if (attachmentError) throw new Error("Não foi possível consultar os anexos já recebidos.");
  const { data: existing, error: existingError } = await supabase.from("signature_requests")
    .select("id").eq("source_outlook_message_id", payload.message_id).maybeSingle();
  if (existingError) throw new Error("Não foi possível verificar a idempotência da assinatura.");
  if (!values.apply) {
    console.log(JSON.stringify({ dry_run: true, ticket_id: ticket.id, eligible: true,
      existing_request_id: existing?.id || null, attachment_count: attachments.length,
      action: existing ? "already_processed" : "create_signature_request" }));
    return;
  }
  const result = await processOutlookOnboarding({ payload, ticket, message, attachments }, { supabase });
  console.log(JSON.stringify({ dry_run: false, ticket_id: ticket.id,
    signature_request_id: result.request.id, duplicate: result.duplicate }));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
