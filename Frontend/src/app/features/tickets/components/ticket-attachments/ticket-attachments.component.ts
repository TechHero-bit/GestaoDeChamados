import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { IncomingAttachment, TicketDetail } from '../../../../core/models/ticket.model';
import { TicketService } from '../../../../core/services/ticket.service';
import { FileAttachmentComponent } from '../../../../shared/components/file-attachment/file-attachment.component';
import { formatLongDate } from '../../../../shared/utils/ticket-formatters';

@Component({
  selector: 'app-ticket-attachments',
  imports: [FileAttachmentComponent],
  templateUrl: './ticket-attachments.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TicketAttachmentsComponent {
  private readonly tickets = inject(TicketService);
  readonly ticket = input.required<TicketDetail>();
  readonly refreshing = input(false);
  readonly error = input('');
  readonly refreshRequested = output<void>();
  readonly formatLongDate = formatLongDate;
  readonly attachments = computed(() =>
    this.ticket().messages.flatMap((message) =>
      (message.attachments || []).map((attachment) => ({
        ...attachment,
        receivedAt: message.data_criacao,
      })),
    ),
  );

  attachmentState(attachment: IncomingAttachment): 'pending' | 'error' | 'available' {
    if (attachment.processing_status === 'Pendente') return 'pending';
    if (attachment.processing_status === 'Falhou') return 'error';
    return 'available';
  }

  openAttachment(attachment: IncomingAttachment, download = false): void {
    if (attachment.processing_status !== 'Disponivel' || typeof window === 'undefined') return;
    window.open(
      this.tickets.attachmentAccessUrl(this.ticket().id, attachment.id, download),
      '_blank',
      'noopener',
    );
  }
}
