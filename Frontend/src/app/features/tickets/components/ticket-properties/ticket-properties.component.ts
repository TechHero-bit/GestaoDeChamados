import {
  ChangeDetectionStrategy,
  Component,
  input,
  OnChanges,
  output,
  SimpleChanges,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  Ticket,
  TicketAssignee,
  TicketPriority,
  TicketStatus,
} from '../../../../core/models/ticket.model';
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
  readonly assignees = input<TicketAssignee[]>([]);
  readonly loadingAssignees = input(false);
  readonly assigneesError = input('');
  readonly assigneeChanged = output<string | null>();
  readonly reloadAssignees = output<void>();
  readonly statusChanged = output<TicketStatus>();
  readonly priorityChanged = output<TicketPriority>();
  readonly formatDate = formatDate;
  selectedStatus: TicketStatus = 'Aberto';
  selectedPriority: TicketPriority = 'Normal';
  selectedAssignee: string | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['ticket'] || changes['error']) {
      const ticket = this.ticket();
      this.selectedStatus = ticket.status;
      this.selectedPriority = ticket.prioridade ?? 'Normal';
      this.selectedAssignee = ticket.responsavel_id ?? null;
    }
  }

  hasCurrentAssignee(): boolean {
    return this.assignees().some((user) => user.id === this.ticket().responsavel_id);
  }

  onAssigneeChange(id: string | null): void {
    this.selectedAssignee = id;
    this.assigneeChanged.emit(id);
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
