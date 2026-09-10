import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TicketPriority } from '../../../core/models/ticket.model';

@Component({
  selector: 'app-priority-badge',
  templateUrl: './priority-badge.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PriorityBadgeComponent {
  readonly priority = input.required<TicketPriority>();
}
