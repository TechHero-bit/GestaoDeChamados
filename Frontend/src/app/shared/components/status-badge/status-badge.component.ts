import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TicketStatus } from '../../../core/models/ticket.model';

@Component({
  selector: 'app-status-badge',
  templateUrl: './status-badge.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StatusBadgeComponent {
  readonly status = input.required<TicketStatus>();
}
