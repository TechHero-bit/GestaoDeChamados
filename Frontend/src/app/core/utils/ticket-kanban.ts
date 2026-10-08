import type { Ticket, TicketStatus, TicketUpdatePayload } from '../models/ticket.model';

export const KANBAN_COLUMNS: ReadonlyArray<{
  key: string;
  status: TicketStatus;
  label: string;
  icon: string;
}> = [
  { key: 'todo', status: 'Aberto', label: 'A fazer', icon: 'radio_button_unchecked' },
  { key: 'in-progress', status: 'Em Andamento', label: 'Em curso', icon: 'pending' },
  { key: 'done', status: 'Resolvido', label: 'Concluídos', icon: 'task_alt' },
];

export interface KanbanColumn {
  key: string;
  status: TicketStatus;
  label: string;
  icon: string;
  tickets: Ticket[];
  total: number;
  pages: number;
}

export type PersistTicketMove = (id: string, payload: TicketUpdatePayload) => Promise<Ticket>;

/** Estado independente da interface, compartilhado por mouse, touch e teclado. */
export class TicketKanbanState {
  columns: KanbanColumn[] = KANBAN_COLUMNS.map((column) => ({
    ...column,
    tickets: [],
    total: 0,
    pages: 1,
  }));
  pendingId: string | null = null;
  stale = true;
  error = '';
  announcement = '';
  onChange: () => void = () => {};

  replaceColumns(columns: KanbanColumn[]): void {
    if (this.pendingId) return;
    this.columns = columns;
    this.stale = false;
    this.onChange();
  }

  async move(id: string, target: TicketStatus, persist: PersistTicketMove): Promise<boolean> {
    if (this.pendingId || this.stale || !KANBAN_COLUMNS.some((c) => c.status === target))
      return false;
    const ticket = this.columns.flatMap((c) => c.tickets).find((item) => item.id === id);
    if (!ticket || ticket.status === target) return false;
    if (!ticket.data_atualizacao) {
      this.stale = true;
      this.error = 'Atualize o quadro antes de mover este chamado.';
      this.onChange();
      return false;
    }

    const previous = this.columns;
    this.pendingId = id;
    this.error = '';
    this.announcement = 'Salvando a movimentação de ' + ticket.assunto + '.';
    this.columns = this.columns.map((column) => {
      if (column.status === ticket.status)
        return {
          ...column,
          tickets: column.tickets.filter((item) => item.id !== id),
          total: Math.max(0, column.total - 1),
        };
      if (column.status === target)
        return {
          ...column,
          tickets: [{ ...ticket, status: target }, ...column.tickets],
          total: column.total + 1,
        };
      return column;
    });
    this.onChange();

    try {
      const saved = await persist(id, {
        status: target,
        expected_data_atualizacao: ticket.data_atualizacao,
      });
      if (!saved || saved.id !== id || saved.status !== target) {
        throw new Error('O servidor não confirmou a movimentação. Atualize o quadro.');
      }
      this.columns = this.columns.map((column) => ({
        ...column,
        tickets: column.tickets.map((item) => (item.id === id ? saved : item)),
      }));
      this.announcement =
        ticket.assunto +
        ' movido para ' +
        KANBAN_COLUMNS.find((c) => c.status === target)!.label +
        '.';
      return true;
    } catch (error) {
      this.columns = previous;
      // A conexão pode ter falhado depois do commit. Reconciliar antes de outra escrita.
      this.stale = true;
      this.error =
        (error instanceof Error ? error.message : 'Não foi possível salvar o status.') +
        ' O cartão voltou à coluna anterior. Atualize o quadro antes de tentar novamente.';
      this.announcement = this.error;
      return false;
    } finally {
      this.pendingId = null;
      this.onChange();
    }
  }
}
