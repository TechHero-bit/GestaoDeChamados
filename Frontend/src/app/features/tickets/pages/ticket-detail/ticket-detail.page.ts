import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Subscription, finalize } from 'rxjs';
import {
  TicketDetail,
  TicketAssignee,
  TicketMessage,
  TicketPriority,
  TicketStatus,
  TicketUpdatePayload,
} from '../../../../core/models/ticket.model';
import { TicketService } from '../../../../core/services/ticket.service';
import { StatusBadgeComponent } from '../../../../shared/components/status-badge/status-badge.component';
import {
  relativeDate,
  requesterName,
  shortTicketId,
} from '../../../../shared/utils/ticket-formatters';
import { TicketAttachmentsComponent } from '../../components/ticket-attachments/ticket-attachments.component';
import { TicketConversationComponent } from '../../components/ticket-conversation/ticket-conversation.component';
import { TicketPropertiesComponent } from '../../components/ticket-properties/ticket-properties.component';
import { TicketReplyEditorComponent } from '../../components/ticket-reply-editor/ticket-reply-editor.component';
import { TicketRequesterCardComponent } from '../../components/ticket-requester-card/ticket-requester-card.component';

@Component({
  selector: 'app-ticket-detail-page',
  imports: [
    RouterLink,
    StatusBadgeComponent,
    TicketConversationComponent,
    TicketAttachmentsComponent,
    TicketPropertiesComponent,
    TicketReplyEditorComponent,
    TicketRequesterCardComponent,
  ],
  templateUrl: './ticket-detail.page.html',
})
export class TicketDetailPage implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly ticketService = inject(TicketService);
  private readonly subscriptions = new Subscription();
  private loadRequest?: Subscription;
  private ticketUpdateRequest?: Subscription;
  private attachmentsRequest?: Subscription;

  readonly ticket = signal<TicketDetail | null>(null);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly savingProperties = signal(false);
  readonly propertiesError = signal('');
  readonly assignees = signal<TicketAssignee[]>([]);
  readonly loadingAssignees = signal(false);
  readonly assigneesError = signal('');
  readonly refreshingAttachments = signal(false);
  readonly attachmentsError = signal('');
  readonly shortTicketId = shortTicketId;
  readonly relativeDate = relativeDate;
  readonly requesterName = requesterName;

  ngOnInit(): void {
    this.loadAssignees();
    this.subscriptions.add(
      this.route.paramMap.subscribe((params) => this.loadTicket(params.get('id') || '')),
    );
  }

  loadAssignees(): void {
    if (this.loadingAssignees()) return;
    this.loadingAssignees.set(true);
    this.assigneesError.set('');
    this.subscriptions.add(
      this.ticketService
        .listarResponsaveis()
        .pipe(finalize(() => this.loadingAssignees.set(false)))
        .subscribe({
          next: (users) => this.assignees.set(users),
          error: (error: Error) => this.assigneesError.set(error.message),
        }),
    );
  }

  refreshAttachments(): void {
    const current = this.ticket();
    if (!current || this.refreshingAttachments()) return;
    this.refreshingAttachments.set(true);
    this.attachmentsError.set('');
    this.attachmentsRequest = this.ticketService
      .buscarPorId(current.id)
      .pipe(finalize(() => this.refreshingAttachments.set(false)))
      .subscribe({
        next: (updated) =>
          this.ticket.update((ticket) => {
            if (!ticket || ticket.id !== updated.id) return ticket;
            const messages = new Map(ticket.messages.map((message) => [message.id, message]));
            for (const message of updated.messages) messages.set(message.id, message);
            return {
              ...ticket,
              messages: [...messages.values()].sort(
                (a, b) => Date.parse(a.data_criacao) - Date.parse(b.data_criacao),
              ),
            };
          }),
        error: (error: Error) => this.attachmentsError.set(error.message),
      });
  }

  updateAssignee(responsavel_id: string | null): void {
    const current = this.ticket();
    if (!current || (current.responsavel_id ?? null) === responsavel_id || this.savingProperties())
      return;
    this.updateTicket({ responsavel_id });
  }

  loadTicket(id: string): void {
    this.loadRequest?.unsubscribe();
    this.ticketUpdateRequest?.unsubscribe();
    this.attachmentsRequest?.unsubscribe();
    this.propertiesError.set('');
    this.attachmentsError.set('');
    this.loading.set(true);
    this.error.set('');
    this.ticket.set(null);
    this.loadRequest = this.ticketService
      .buscarPorId(id)
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (ticket) => this.ticket.set(ticket),
        error: (error: Error) => this.error.set(error.message),
      });
  }

  updateStatus(status: TicketStatus): void {
    const current = this.ticket();
    if (!current || current.status === status || this.savingProperties()) return;

    this.updateTicket({ status });
  }

  updatePriority(prioridade: TicketPriority): void {
    const current = this.ticket();
    const currentPriority = current?.prioridade ?? 'Normal';
    if (!current || currentPriority === prioridade || this.savingProperties()) return;

    this.updateTicket({ prioridade });
  }

  private updateTicket(payload: TicketUpdatePayload): void {
    const current = this.ticket();
    if (!current) return;

    this.ticketUpdateRequest?.unsubscribe();
    this.savingProperties.set(true);
    this.propertiesError.set('');
    this.ticketUpdateRequest = this.ticketService
      .atualizarTicket(current.id, payload)
      .pipe(finalize(() => this.savingProperties.set(false)))
      .subscribe({
        next: (updated) =>
          this.ticket.update((ticket) =>
            ticket && ticket.id === updated.id ? { ...ticket, ...updated } : ticket,
          ),
        error: (error: Error) => this.propertiesError.set(error.message),
      });
  }

  appendMessage(message: TicketMessage): void {
    this.ticket.update((ticket) =>
      ticket ? { ...ticket, messages: [...ticket.messages, message] } : ticket,
    );
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
    this.loadRequest?.unsubscribe();
    this.ticketUpdateRequest?.unsubscribe();
    this.attachmentsRequest?.unsubscribe();
  }
}
