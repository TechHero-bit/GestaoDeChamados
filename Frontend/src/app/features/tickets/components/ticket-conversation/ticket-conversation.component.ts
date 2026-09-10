import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TicketDetail } from '../../../../core/models/ticket.model';
import { TicketMessageComponent } from '../ticket-message/ticket-message.component';

@Component({
  selector: 'app-ticket-conversation',
  imports: [TicketMessageComponent],
  templateUrl: './ticket-conversation.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TicketConversationComponent {
  readonly ticket = input.required<TicketDetail>();
}
