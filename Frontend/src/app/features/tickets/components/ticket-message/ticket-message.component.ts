import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { IncomingAttachment, TicketDetail, TicketMessage } from '../../../../core/models/ticket.model';
import { TicketService } from '../../../../core/services/ticket.service';
import { FileAttachmentComponent } from '../../../../shared/components/file-attachment/file-attachment.component';
import {
  formatLongDate,
  initials,
  requesterName,
} from '../../../../shared/utils/ticket-formatters';

@Component({
  selector: 'app-ticket-message',
  imports: [FileAttachmentComponent],
  templateUrl: './ticket-message.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TicketMessageComponent {
  private readonly tickets = inject(TicketService);

  readonly message = input.required<TicketMessage>();
  readonly ticket = input.required<TicketDetail>();
  readonly formatLongDate = formatLongDate;
  readonly initials = initials;
  readonly requesterName = requesterName;

  readonly attachments = computed<IncomingAttachment[]>(() => {
    return this.message().attachments || [];
  });

  regularAttachments(): IncomingAttachment[] {
    return this.attachments();
  }

  readonly formattedBody = computed<string>(() => {
    const raw = this.message().corpo_mensagem || '';
    return raw.replace(/\n{3,}/g, '\n\n').trim();
  });

  attachmentState(attachment: IncomingAttachment): 'pending' | 'error' | 'available' {
    if (attachment.processing_status === 'Pendente') return 'pending';
    if (attachment.processing_status === 'Falhou') return 'error';
    return 'available';
  }

  isAvailable(attachment: IncomingAttachment): boolean {
    return attachment.processing_status === 'Disponivel';
  }

  openAttachment(attachment: IncomingAttachment, download = false): void {
    if (!this.isAvailable(attachment) || typeof window === 'undefined') return;
    window.open(
      this.tickets.attachmentAccessUrl(this.ticket().id, attachment.id, download),
      '_blank',
      'noopener',
    );
  }
}
