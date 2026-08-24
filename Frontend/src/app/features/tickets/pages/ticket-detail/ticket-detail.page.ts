import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Subscription, finalize } from 'rxjs';
import { TicketDetail, TicketMessage, TicketStatus } from '../../../../core/models/ticket.model';
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
    TicketAttachmentsComponent,
    TicketConversationComponent,
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
  private statusRequest?: Subscription;

  readonly ticket = signal<TicketDetail | null>(null);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly savingStatus = signal(false);
  readonly statusError = signal('');
  readonly shortTicketId = shortTicketId;
  readonly relativeDate = relativeDate;
  readonly requesterName = requesterName;

  ngOnInit(): void {
    this.subscriptions.add(
      this.route.paramMap.subscribe((params) => this.loadTicket(params.get('id') || '')),
    );
  }

  loadTicket(id: string): void {
    this.loadRequest?.unsubscribe();
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
    if (!current || current.status === status || this.savingStatus()) return;

    this.statusRequest?.unsubscribe();
    this.savingStatus.set(true);
    this.statusError.set('');
    this.statusRequest = this.ticketService
      .atualizarStatus(current.id, status)
      .pipe(finalize(() => this.savingStatus.set(false)))
      .subscribe({
        next: (updated) =>
          this.ticket.update((ticket) => (ticket ? { ...ticket, ...updated } : ticket)),
        error: (error: Error) => this.statusError.set(error.message),
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
    this.statusRequest?.unsubscribe();
  }
}
