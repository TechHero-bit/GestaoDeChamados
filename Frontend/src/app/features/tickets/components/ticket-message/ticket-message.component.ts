import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TicketDetail, TicketMessage } from '../../../../core/models/ticket.model';
import {
  formatLongDate,
  initials,
  requesterName,
} from '../../../../shared/utils/ticket-formatters';

@Component({
  selector: 'app-ticket-message',
  templateUrl: './ticket-message.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TicketMessageComponent {
  readonly message = input.required<TicketMessage>();
  readonly ticket = input.required<TicketDetail>();
  readonly formatLongDate = formatLongDate;
  readonly initials = initials;
  readonly requesterName = requesterName;
}
