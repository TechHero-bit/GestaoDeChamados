import {
  ChangeDetectionStrategy,
  Component,
  input,
  OnChanges,
  output,
  SimpleChanges,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Ticket, TicketPriority, TicketStatus } from '../../../../core/models/ticket.model';
import { formatDate } from '../../../../shared/utils/ticket-formatters';

@Component({
  selector: 'app-ticket-properties',
  imports: [FormsModule],
  templateUrl: './ticket-properties.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TicketPropertiesComponent implements OnChanges {
  readonly ticket = input.required<Ticket>();
  readonly saving = input(false);
  readonly error = input('');
  readonly statusChanged = output<TicketStatus>();
  readonly priorityChanged = output<TicketPriority>();
  readonly formatDate = formatDate;
  selectedStatus: TicketStatus = 'Aberto';
  selectedPriority: TicketPriority = 'Normal';

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['ticket'] || changes['error']) {
      const ticket = this.ticket();
      this.selectedStatus = ticket.status;
      this.selectedPriority = ticket.prioridade ?? 'Normal';
    }
  }

  onStatusChange(status: TicketStatus): void {
    this.selectedStatus = status;
    this.statusChanged.emit(status);
  }

  onPriorityChange(prioridade: TicketPriority): void {
    this.selectedPriority = prioridade;
    this.priorityChanged.emit(prioridade);
  }
}
