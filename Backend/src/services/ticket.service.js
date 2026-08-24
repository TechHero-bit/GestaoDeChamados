import { getSupabase } from "../config/supabase.js";

const TICKET_FIELDS = [
  "id",
  "remetente_email",
  "remetente_nome",
  "assunto",
  "corpo_mensagem",
  "status",
  "outlook_message_id",
  "data_recebimento",
  "data_criacao",
  "data_atualizacao",
].join(",");

function databaseError(action, cause) {
  return Object.assign(new Error(`Não foi possível ${action}.`), {
    statusCode: 502,
    cause,
  });
}

export function getHelpdeskEmail() {
  const email = process.env.HELPDESK_EMAIL?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw Object.assign(
      new Error("E-mail corporativo do Help Desk não configurado."),
      { statusCode: 503 },
    );
  }
  return email;
}

/**
 * Listar tickets com filtros opcionais e paginação.
 */
export async function listar({
  status,
  search,
  date,
  page = 1,
  pageSize = 10,
} = {}) {
  const supabase = getSupabase();
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabase
    .from("tickets")
    .select(TICKET_FIELDS, { count: "exact" })
    .order("data_criacao", { ascending: false })
    .range(from, to);

  if (status) {
    query = query.eq("status", status);
  }

  const normalizedSearch = search?.replace(/[(),]/g, " ").trim();
  if (normalizedSearch) {
    query = query.or(
      `assunto.ilike.%${normalizedSearch}%,remetente_nome.ilike.%${normalizedSearch}%,remetente_email.ilike.%${normalizedSearch}%`,
    );
  }

  if (date) {
    const nextDate = new Date(`${date}T00:00:00.000Z`);
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
    query = query
      .gte("data_criacao", `${date}T00:00:00.000Z`)
      .lt("data_criacao", nextDate.toISOString());
  }

  const { data, error, count } = await query;

  if (error) throw databaseError("listar os chamados", error);
  return {
    tickets: data || [],
    total: count || 0,
    page,
    pageSize,
  };
}

/**
 * Buscar ticket por ID com suas mensagens.
 */
export async function buscarPorId(id) {
  const supabase = getSupabase();
  const { data: ticket, error: ticketError } = await supabase
    .from("tickets")
    .select(TICKET_FIELDS)
    .eq("id", id)
    .maybeSingle();

  if (ticketError) throw databaseError("buscar o chamado", ticketError);
  if (!ticket) return null;

  const { data: messages, error: messagesError } = await supabase
    .from("ticket_messages")
    .select("*")
    .eq("ticket_id", id)
    .order("data_criacao", { ascending: true });

  if (messagesError)
    throw databaseError("buscar as mensagens do chamado", messagesError);

  return { ...ticket, messages: messages || [] };
}

/**
 * Verificar se um e-mail já foi processado pelo outlook_message_id.
 */
export async function buscarPorMessageId(messageId) {
  const { data, error } = await getSupabase()
    .from("tickets")
    .select("id")
    .eq("outlook_message_id", messageId)
    .maybeSingle();

  if (error) throw databaseError("verificar a duplicidade do e-mail", error);
  return data;
}

/**
 * Criar ticket e primeira mensagem. Se a mensagem falhar, o ticket é removido
 * para que o Power Automate possa repetir a entrega sem deixar dados parciais.
 */
export async function criar(dados) {
  const supabase = getSupabase();
  const helpdeskEmail = getHelpdeskEmail();
  const { data: ticket, error: ticketError } = await supabase
    .from("tickets")
    .insert({
      remetente_email: dados.remetente_email,
      remetente_nome: dados.remetente_nome || null,
      assunto: dados.assunto,
      corpo_mensagem: dados.corpo_mensagem,
      status: "Aberto",
      outlook_message_id: dados.message_id,
      data_recebimento: dados.data_recebimento,
      payload_original: dados.payload_original || dados,
    })
    .select(TICKET_FIELDS)
    .single();

  if (ticketError) {
    if (ticketError.code === "23505") {
      const existing = await buscarPorMessageId(dados.message_id);
      if (existing) return { ...existing, duplicate: true };
    }
    throw databaseError("criar o chamado", ticketError);
  }

  const { error: messageError } = await supabase
    .from("ticket_messages")
    .insert({
      ticket_id: ticket.id,
      direcao: "Entrada",
      remetente_email: dados.remetente_email,
      destinatario_email: helpdeskEmail,
      corpo_mensagem: dados.corpo_mensagem,
      outlook_message_id: dados.message_id,
      data_criacao: dados.data_recebimento || new Date().toISOString(),
    });

  if (messageError) {
    const { error: cleanupError } = await supabase
      .from("tickets")
      .delete()
      .eq("id", ticket.id);

    if (cleanupError) {
      console.error(
        "Falha ao reverter ticket sem mensagem:",
        cleanupError.message,
      );
    }
    throw databaseError(
      "registrar a mensagem inicial do chamado",
      messageError,
    );
  }

  return ticket;
}

export async function atualizarStatus(id, status) {
  const { data, error } = await getSupabase()
    .from("tickets")
    .update({ status })
    .eq("id", id)
    .select(TICKET_FIELDS)
    .maybeSingle();

  if (error) throw databaseError("atualizar o chamado", error);
  return data;
}

export async function excluir(id) {
  const { error } = await getSupabase().from("tickets").delete().eq("id", id);

  if (error) throw databaseError("excluir o chamado", error);
}

export async function adicionarMensagem({
  ticket_id,
  direcao,
  remetente_email,
  destinatario_email,
  corpo_mensagem,
  outlook_message_id,
}) {
  const { data, error } = await getSupabase()
    .from("ticket_messages")
    .insert({
      ticket_id,
      direcao,
      remetente_email,
      destinatario_email,
      corpo_mensagem,
      outlook_message_id: outlook_message_id || null,
    })
    .select()
    .single();

  if (error) throw databaseError("adicionar a mensagem ao chamado", error);
  return data;
}
