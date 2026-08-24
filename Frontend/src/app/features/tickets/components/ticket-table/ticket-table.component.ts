import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Ticket } from '../../../../core/models/ticket.model';
import { StatusBadgeComponent } from '../../../../shared/components/status-badge/status-badge.component';
import {
  formatDate,
  initials,
  requesterName,
  shortTicketId,
} from '../../../../shared/utils/ticket-formatters';

@Component({
  selector: 'app-ticket-table',
  imports: [RouterLink, StatusBadgeComponent],
  templateUrl: './ticket-table.component.html',
})
export class TicketTableComponent {
  readonly tickets = input.required<Ticket[]>();
  readonly loading = input(false);
  readonly skeletonRows = [1, 2, 3, 4, 5];

  readonly formatDate = formatDate;
  readonly initials = initials;
  readonly requesterName = requesterName;
  readonly shortTicketId = shortTicketId;
}
