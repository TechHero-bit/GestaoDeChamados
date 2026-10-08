import { getSupabase } from "../config/supabase.js";

const TICKET_FIELDS = [
  "id",
  "remetente_email",
  "remetente_nome",
  "assunto",
  "corpo_mensagem",
  "status",
  "prioridade",
  "responsavel_id",
  "responsavel:users!tickets_responsavel_id_fkey(id,nome,email,ativo,role)",
  "outlook_message_id",
  "outlook_last_message_id",
  "outlook_conversation_id",
  "data_recebimento",
  "data_criacao",
  "data_atualizacao",
].join(",");

const UPDATEABLE_TICKET_FIELDS = new Set(["status", "prioridade", "responsavel_id"]);

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
  prioridade,
  responsavel_id,
  sort = "created",
  search,
  date,
  page = 1,
  pageSize = 10,
} = {}, { supabase = getSupabase() } = {}) {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabase
    .from("tickets")
    .select(TICKET_FIELDS, { count: "exact" })
    .order(sort === "updated" ? "data_atualizacao" : "data_criacao", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to);

  if (status) {
    query = query.eq("status", status);
  }

  if (prioridade) query = query.eq("prioridade", prioridade);
  if (responsavel_id === "none") query = query.is("responsavel_id", null);
  else if (responsavel_id) query = query.eq("responsavel_id", responsavel_id);

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
    .select(
      "*,ticket_message_attachments(id,file_name,content_type,file_size,is_inline,content_id,processing_status)",
    )
    .eq("ticket_id", id)
    .order("data_criacao", { ascending: true });

  if (messagesError)
    throw databaseError("buscar as mensagens do chamado", messagesError);

  const timelineMessages = (messages || []).map(
    ({ ticket_message_attachments: attachments, ...message }) => ({
      ...message,
      // O contrato da timeline nunca contém storage_path, URL assinada ou erro
      // interno. Mensagens antigas continuam compatíveis com attachments: [].
      attachments: (attachments || []).map((attachment) => ({
        id: attachment.id,
        file_name: attachment.file_name,
        content_type: attachment.content_type,
        file_size: Number(attachment.file_size),
        is_inline: attachment.is_inline === true,
        content_id: attachment.content_id || null,
        processing_status: attachment.processing_status,
      })),
    }),
  );

  return { ...ticket, messages: timelineMessages };
}

/**
 * Verificar se um e-mail já foi processado em tickets ou ticket_messages.
 */
export async function buscarPorMessageId(
  messageId,
  { supabase = getSupabase() } = {},
) {
  const { data, error } = await supabase
    .from("tickets")
    .select("id")
    .eq("outlook_message_id", messageId)
    .limit(1)
    .maybeSingle();

  if (error) throw databaseError("verificar a duplicidade do e-mail", error);
  if (data) return data;

  const { data: message, error: messageError } = await supabase
    .from("ticket_messages")
    .select("ticket_id")
    .eq("outlook_message_id", messageId)
    .limit(1)
    .maybeSingle();

  if (messageError)
    throw databaseError("verificar a duplicidade do e-mail", messageError);

  return message ? { id: message.ticket_id } : null;
}

/** Busca a ticket_message exata para retomar uploads de uma entrega repetida. */
export async function buscarMensagemPorOutlookMessageId(
  messageId,
  { supabase = getSupabase() } = {},
) {
  const { data, error } = await supabase
    .from("ticket_messages")
    .select("id,ticket_id,outlook_message_id")
    .eq("outlook_message_id", messageId)
    .limit(1)
    .maybeSingle();

  if (error) throw databaseError("localizar a mensagem do e-mail", error);
  return data || null;
}

/**
 * Buscar o ticket associado à conversa do Outlook.
 * Não usa assunto ou remetente como critério de correlação.
 */
export async function buscarPorConversationId(
  conversationId,
  { supabase = getSupabase() } = {},
) {
  const { data, error } = await supabase
    .from("tickets")
    .select(TICKET_FIELDS)
    .eq("outlook_conversation_id", conversationId)
    .order("data_atualizacao", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw databaseError("localizar a conversa do chamado", error);
  return data;
}

async function inserirMensagemDeEntrada(
  supabase,
  ticketId,
  dados,
  helpdeskEmail,
) {
  const { data, error } = await supabase
    .from("ticket_messages")
    .insert({
      ticket_id: ticketId,
      direcao: "Entrada",
      remetente_email: dados.remetente_email,
      destinatario_email: helpdeskEmail,
      corpo_mensagem: dados.corpo_mensagem,
      outlook_message_id: dados.message_id,
      data_criacao: dados.data_recebimento || new Date().toISOString(),
    })
    .select()
    .single();

  if (error)
    throw databaseError("registrar a mensagem de entrada do chamado", error);
  return { ...data, attachments: [] };
}

/**
 * Processar uma mensagem recebida respeitando, nesta ordem, message_id e
 * depois outlook_conversation_id.
 */
export async function processarEntrada(
  dados,
  { supabase = getSupabase(), helpdeskEmail = getHelpdeskEmail() } = {},
) {
  const existente = await buscarPorMessageId(dados.message_id, { supabase });
  if (existente) {
    return {
      ticket: existente,
      message: await buscarMensagemPorOutlookMessageId(dados.message_id, { supabase }),
      duplicate: true,
      threaded: false,
    };
  }

  const ticketDaConversa = await buscarPorConversationId(dados.conversation_id, {
    supabase,
  });

  if (ticketDaConversa) {
    const mensagem = await inserirMensagemDeEntrada(
      supabase,
      ticketDaConversa.id,
      dados,
      helpdeskEmail,
    );

    const { data: ticketAtualizado, error } = await supabase
      .from("tickets")
      .update({ outlook_last_message_id: dados.message_id })
      .eq("id", ticketDaConversa.id)
      .select(TICKET_FIELDS)
      .maybeSingle();

    if (error)
      throw databaseError("atualizar a última mensagem do chamado", error);

    return {
      ticket: ticketAtualizado || {
        ...ticketDaConversa,
        outlook_last_message_id: dados.message_id,
      },
      message: mensagem,
      duplicate: false,
      threaded: true,
    };
  }

  const created = await criar(dados, { supabase, helpdeskEmail });
  if (created.duplicate) {
    return {
      ticket: created.ticket,
      message: await buscarMensagemPorOutlookMessageId(dados.message_id, { supabase }),
      duplicate: true,
      threaded: false,
    };
  }
  return {
    ticket: created.ticket,
    message: created.message,
    duplicate: false,
    threaded: false,
  };
}
/**
 * Criar ticket e primeira mensagem. Se a mensagem falhar, o ticket é removido
 * para que o Power Automate possa repetir a entrega sem deixar dados parciais.
 */
export async function criar(
  dados,
  { supabase = getSupabase(), helpdeskEmail = getHelpdeskEmail() } = {},
) {
  const { data: ticket, error: ticketError } = await supabase
    .from("tickets")
    .insert({
      remetente_email: dados.remetente_email,
      remetente_nome: dados.remetente_nome || null,
      assunto: dados.assunto,
      corpo_mensagem: dados.corpo_mensagem,
      status: "Aberto",
      outlook_message_id: dados.message_id,
      outlook_last_message_id: dados.message_id,
      outlook_conversation_id: dados.conversation_id,
      data_recebimento: dados.data_recebimento,
      payload_original: dados.payload_original || dados,
    })
    .select(TICKET_FIELDS)
    .single();

  if (ticketError) {
    if (ticketError.code === "23505") {
      const existing = await buscarPorMessageId(dados.message_id, { supabase });
      if (existing) return { ticket: existing, duplicate: true };
    }
    throw databaseError("criar o chamado", ticketError);
  }

  let message;
  try {
    message = await inserirMensagemDeEntrada(
      supabase,
      ticket.id,
      dados,
      helpdeskEmail,
    );
  } catch (error) {
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
    throw error;
  }

  return { ticket, message };
}

export async function listarResponsaveis({ supabase = getSupabase() } = {}) {
  const { data, error } = await supabase
    .from("users")
    .select("id,nome,email")
    .eq("role", "ADMIN")
    .eq("ativo", true)
    .order("nome", { ascending: true });

  if (error) throw databaseError("listar os administradores responsáveis", error);
  return data || [];
}

export async function atualizarTicket(id, dados, { supabase = getSupabase() } = {}) {
  const updates = Object.fromEntries(
    Object.entries(dados || {}).filter(
      ([field, value]) =>
        UPDATEABLE_TICKET_FIELDS.has(field) && value !== undefined,
    ),
  );

  if (Object.keys(updates).length === 0) {
    throw Object.assign(
      new Error("Informe ao menos um campo para atualizar."),
      { statusCode: 400 },
    );
  }

  if (updates.responsavel_id !== undefined && updates.responsavel_id !== null) {
    const { data: responsavel, error } = await supabase
      .from("users")
      .select("id")
      .eq("id", updates.responsavel_id)
      .eq("role", "ADMIN")
      .eq("ativo", true)
      .maybeSingle();

    if (error) throw databaseError("validar o responsável pelo chamado", error);
    if (!responsavel) {
      throw Object.assign(new Error("Selecione um administrador ativo como responsável."), {
        statusCode: 400,
      });
    }
  }

  // Incrementar a versão também quando um ambiente não possui o trigger histórico.
  const previousTime = Date.parse(dados.expected_data_atualizacao || "");
  updates.data_atualizacao = new Date(Number.isFinite(previousTime)
    ? Math.max(Date.now(), previousTime + 1)
    : Date.now()).toISOString();
  let query = supabase.from("tickets").update(updates).eq("id", id);
  // A condição participa do UPDATE; uma leitura prévia sozinha não evita corridas.
  if (dados.expected_data_atualizacao !== undefined) {
    query = query.eq("data_atualizacao", dados.expected_data_atualizacao);
  }
  const { data, error } = await query.select(TICKET_FIELDS).maybeSingle();
  if (error) throw databaseError("atualizar o chamado", error);
  if (!data && dados.expected_data_atualizacao !== undefined) {
    throw Object.assign(new Error("O chamado foi alterado ou removido por outro atendente. Atualize o quadro e tente novamente."), {
      statusCode: 409, publicCode: "TICKET_CONFLICT",
    });
  }
  return data;
}

export async function atualizarStatus(id, status) {
  return atualizarTicket(id, { status });
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
  created_by,
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
      created_by: created_by || null,
    })
    .select()
    .single();

  if (error) throw databaseError("adicionar a mensagem ao chamado", error);
  return { ...data, attachments: [] };
}
