export type TicketStatus = 'Aberto' | 'Em Andamento' | 'Resolvido';
export type TicketPriority = 'Baixa' | 'Normal' | 'Alta';
export type TicketMessageDirection = 'Entrada' | 'Saida';

export interface TicketMessage {
  id: string;
  ticket_id: string;
  direcao: TicketMessageDirection;
  remetente_email: string;
  destinatario_email: string;
  corpo_mensagem: string;
  outlook_message_id?: string | null;
  data_criacao: string;
}

export interface Ticket {
  id: string;
  remetente_email: string;
  remetente_nome?: string | null;
  assunto: string;
  corpo_mensagem: string;
  status: TicketStatus;
  prioridade: TicketPriority;
  outlook_message_id?: string | null;
  data_recebimento?: string | null;
  data_criacao: string;
  data_atualizacao: string;
}

export type TicketUpdatePayload = Partial<Pick<Ticket, 'status' | 'prioridade'>>;

export interface TicketDetail extends Ticket {
  messages: TicketMessage[];
}

export interface TicketListFilters {
  status?: TicketStatus;
  search?: string;
  date?: string;
  page?: number;
  pageSize?: number;
}

export interface TicketListResponse {
  success: true;
  data: Ticket[];
  total: number;
  page: number;
  page_size: number;
}

export interface ApiDataResponse<T> {
  success: true;
  data: T;
  message?: string;
}
