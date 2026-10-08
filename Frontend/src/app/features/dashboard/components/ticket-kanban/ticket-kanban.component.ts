import {
  Component,
  DestroyRef,
  ElementRef,
  inject,
  OnDestroy,
  OnInit,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  CdkDrag,
  CdkDragDrop,
  CdkDragHandle,
  CdkDragPlaceholder,
  CdkDropList,
  CdkDropListGroup,
} from '@angular/cdk/drag-drop';
import { firstValueFrom, forkJoin, map, Subscription } from 'rxjs';
import {
  Ticket,
  TicketAssignee,
  TicketListFilters,
  TicketPriority,
  TicketStatus,
} from '../../../../core/models/ticket.model';
import { TicketService } from '../../../../core/services/ticket.service';
import { KanbanColumn, TicketKanbanState } from '../../../../core/utils/ticket-kanban';
import { PriorityBadgeComponent } from '../../../../shared/components/priority-badge/priority-badge.component';
import {
  formatDate,
  requesterName,
  shortTicketId,
} from '../../../../shared/utils/ticket-formatters';

@Component({
  selector: 'app-ticket-kanban',
  imports: [
    FormsModule,
    RouterLink,
    CdkDrag,
    CdkDragHandle,
    CdkDragPlaceholder,
    CdkDropList,
    CdkDropListGroup,
    PriorityBadgeComponent,
  ],
  templateUrl: './ticket-kanban.component.html',
  styleUrl: './ticket-kanban.component.css',
})
export class TicketKanbanComponent implements OnInit, OnDestroy {
  private readonly service = inject(TicketService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);
  private request?: Subscription;
  private assigneeRequest?: Subscription;
  private readonly state = new TicketKanbanState();
  private appliedFilters: TicketListFilters = {};

  readonly statusChanged = output<void>();
  readonly columns = signal(this.state.columns);
  readonly loading = signal(true);
  readonly pendingId = signal<string | null>(null);
  readonly stale = signal(true);
  readonly error = signal('');
  readonly announcement = signal('');
  readonly dragging = signal(false);
  readonly dropTarget = signal<TicketStatus | null>(null);
  readonly assignees = signal<TicketAssignee[]>([]);
  readonly assigneesError = signal('');
  readonly formatDate = formatDate;
  readonly requesterName = requesterName;
  readonly shortTicketId = shortTicketId;
  readonly pageSize = 20;
  search = '';
  priority: TicketPriority | '' = '';
  assignee = '';

  constructor() {
    this.state.onChange = () => {
      if (this.destroyRef.destroyed) return;
      this.columns.set(this.state.columns);
      this.pendingId.set(this.state.pendingId);
      this.stale.set(this.state.stale);
      this.error.set(this.state.error);
      this.announcement.set(this.state.announcement);
    };
  }

  ngOnInit(): void {
    this.reload();
    this.assigneeRequest = this.service.listarResponsaveis().subscribe({
      next: (users) => this.assignees.set(users),
      error: () =>
        this.assigneesError.set(
          'Não foi possível carregar os responsáveis. Os demais filtros continuam disponíveis.',
        ),
    });
  }

  busy(): boolean {
    return this.loading() || !!this.pendingId() || this.dragging();
  }

  canMove(): boolean {
    return !this.loading() && !this.pendingId() && !this.stale();
  }

  applyFilters(): void {
    if (this.busy()) return;
    this.appliedFilters = {
      search: this.search.trim() || undefined,
      prioridade: this.priority || undefined,
      responsavel_id: this.assignee || undefined,
    };
    this.reload(true);
  }

  clearFilters(): void {
    if (this.busy()) return;
    this.search = '';
    this.priority = '';
    this.assignee = '';
    this.applyFilters();
  }

  private fetchColumn(column: KanbanColumn, pages: number) {
    // Reconsultar o prefixo evita pular cartões quando uma mudança desloca as páginas.
    return forkJoin(
      Array.from({ length: pages }, (_, page) =>
        this.service.listar({
          ...this.appliedFilters,
          status: column.status,
          sort: 'updated',
          page: page + 1,
          pageSize: this.pageSize,
        }),
      ),
    ).pipe(
      map((responses): KanbanColumn => ({
        ...column,
        tickets: [
          ...new Map(
            responses.flatMap((r) => r.data).map((ticket) => [ticket.id, ticket]),
          ).values(),
        ],
        total: responses[0].total,
        pages,
      })),
    );
  }

  reload(resetPages = false, focusTicket?: string): void {
    if (this.pendingId() || this.dragging()) return;
    this.request?.unsubscribe();
    this.loading.set(true);
    this.error.set('');
    this.request = forkJoin(
      this.columns().map((column) => this.fetchColumn(column, resetPages ? 1 : column.pages)),
    ).subscribe({
      next: (columns) => {
        this.state.error = '';
        this.state.replaceColumns(columns);
        this.loading.set(false);
        if (focusTicket) this.restoreFocus(focusTicket);
      },
      error: (error: Error) => {
        this.loading.set(false);
        this.state.stale = true;
        this.state.error = 'Não foi possível atualizar o quadro. ' + error.message;
        this.state.onChange();
        if (focusTicket) this.restoreFocus(focusTicket);
      },
    });
  }

  loadMore(column: KanbanColumn): void {
    if (this.busy() || this.stale() || column.tickets.length >= column.total) return;
    this.loading.set(true);
    this.error.set('');
    this.request = this.fetchColumn(column, column.pages + 1).subscribe({
      next: (next) => {
        this.state.replaceColumns(
          this.columns().map((item) => (item.status === next.status ? next : item)),
        );
        this.loading.set(false);
      },
      error: (error: Error) => {
        this.loading.set(false);
        this.error.set('Não foi possível carregar mais cartões. ' + error.message);
      },
    });
  }

  onDrop(event: CdkDragDrop<KanbanColumn, KanbanColumn, Ticket>): void {
    this.dragging.set(false);
    this.dropTarget.set(null);
    if (!event.isPointerOverContainer || event.previousContainer === event.container) return;
    void this.move(event.item.data.id, event.container.data.status);
  }

  onKeyboardMove(target: TicketStatus, ticket: Ticket): void {
    void this.move(ticket.id, target);
  }

  private async move(id: string, target: TicketStatus): Promise<void> {
    if (!this.canMove()) return;
    const saved = await this.state.move(id, target, (ticketId, payload) =>
      firstValueFrom(this.service.atualizarTicket(ticketId, payload)),
    );
    if (this.destroyRef.destroyed) return;
    if (saved) {
      this.statusChanged.emit();
      this.reload(false, id);
    } else {
      this.restoreFocus(id);
    }
  }

  private restoreFocus(id: string): void {
    requestAnimationFrame(() => {
      if (this.destroyRef.destroyed) return;
      const control = Array.from(
        this.host.nativeElement.querySelectorAll<HTMLSelectElement>('[data-move-ticket]'),
      ).find((element) => element.dataset['moveTicket'] === id);
      const focusTarget =
        control && !control.disabled
          ? control
          : this.host.nativeElement.querySelector<HTMLButtonElement>('[data-kanban-refresh]');
      focusTarget?.focus({ preventScroll: true });
    });
  }

  ngOnDestroy(): void {
    this.request?.unsubscribe();
    this.assigneeRequest?.unsubscribe();
  }
}
