import { Component, inject, input, OnDestroy, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription, finalize } from 'rxjs';
import { TicketMessage } from '../../../../core/models/ticket.model';
import { TicketService } from '../../../../core/services/ticket.service';

@Component({
  selector: 'app-ticket-reply-editor',
  imports: [FormsModule],
  templateUrl: './ticket-reply-editor.component.html',
})
export class TicketReplyEditorComponent implements OnDestroy {
  private readonly ticketService = inject(TicketService);
  private request?: Subscription;

  readonly ticketId = input.required<string>();
  readonly requester = input('solicitante');
  readonly messageSent = output<TicketMessage>();
  readonly sending = signal(false);
  readonly error = signal('');
  readonly sentNotice = signal(false);

  message = '';

  send(): void {
    const message = this.message.trim();
    if (!message || this.sending()) return;

    this.error.set('');
    this.sentNotice.set(false);
    this.sending.set(true);
    this.request = this.ticketService
      .responder(this.ticketId(), message)
      .pipe(finalize(() => this.sending.set(false)))
      .subscribe({
        next: (createdMessage) => {
          this.message = '';
          this.sentNotice.set(true);
          this.messageSent.emit(createdMessage);
        },
        error: (error: Error) => this.error.set(error.message),
      });
  }

  ngOnDestroy(): void {
    this.request?.unsubscribe();
  }
}
