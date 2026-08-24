import { Component, input } from '@angular/core';
import { Ticket } from '../../../../core/models/ticket.model';
import { initials, requesterName } from '../../../../shared/utils/ticket-formatters';

@Component({
  selector: 'app-ticket-requester-card',
  templateUrl: './ticket-requester-card.component.html',
})
export class TicketRequesterCardComponent {
  readonly ticket = input.required<Ticket>();
  readonly initials = initials;
  readonly requesterName = requesterName;
}
