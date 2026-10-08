export type TicketStatus = 'Aberto' | 'Em Andamento' | 'Resolvido';
export type TicketPriority = 'Baixa' | 'Normal' | 'Alta';
export type TicketMessageDirection = 'Entrada' | 'Saida';
export type IncomingAttachmentStatus = 'Pendente' | 'Disponivel' | 'Falhou';

export interface IncomingAttachment {
  id: string;
  file_name: string;
  content_type: string;
  file_size: number;
  is_inline: boolean;
  content_id?: string | null;
  processing_status: IncomingAttachmentStatus;
}

export interface TicketMessage {
  id: string;
  ticket_id: string;
  direcao: TicketMessageDirection;
  remetente_email: string;
  destinatario_email: string;
  corpo_mensagem: string;
  outlook_message_id?: string | null;
  data_criacao: string;
  attachments: IncomingAttachment[];
}

export interface TicketAssignee {
  id: string;
  nome: string;
  email: string;
}

export interface Ticket {
  id: string;
  remetente_email: string;
  remetente_nome?: string | null;
  assunto: string;
  corpo_mensagem: string;
  status: TicketStatus;
  prioridade: TicketPriority;
  responsavel_id: string | null;
  responsavel?: (TicketAssignee & { ativo: boolean; role: 'ADMIN' | 'AGENT' }) | null;
  outlook_message_id?: string | null;
  data_recebimento?: string | null;
  data_criacao: string;
  data_atualizacao: string;
}

export type TicketUpdatePayload = Partial<
  Pick<Ticket, 'status' | 'prioridade' | 'responsavel_id'>
> & {
  expected_data_atualizacao?: string;
};

export interface TicketDetail extends Ticket {
  messages: TicketMessage[];
}

export interface TicketListFilters {
  status?: TicketStatus;
  prioridade?: TicketPriority;
  responsavel_id?: string;
  sort?: 'created' | 'updated';
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
