import { Component, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Ticket, TicketStatus } from '../../../../core/models/ticket.model';

@Component({
  selector: 'app-ticket-properties',
  imports: [FormsModule],
  templateUrl: './ticket-properties.component.html',
})
export class TicketPropertiesComponent {
  readonly ticket = input.required<Ticket>();
  readonly saving = input(false);
  readonly error = input('');
  readonly statusChanged = output<TicketStatus>();
}
