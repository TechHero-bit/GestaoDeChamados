import { Component, OnDestroy, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TicketListFilters, TicketStatus } from '../../../../core/models/ticket.model';

@Component({
  selector: 'app-ticket-filters',
  imports: [FormsModule],
  templateUrl: './ticket-filters.component.html',
})
export class TicketFiltersComponent implements OnDestroy {
  readonly filtersChanged = output<TicketListFilters>();

  search = '';
  status: TicketStatus | '' = '';
  date = '';
  private searchTimer?: ReturnType<typeof setTimeout>;

  onSearchChange(): void {
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.emitFilters(), 350);
  }

  emitFilters(): void {
    this.filtersChanged.emit({
      search: this.search.trim() || undefined,
      status: this.status || undefined,
      date: this.date || undefined,
    });
  }

  reset(): void {
    this.search = '';
    this.status = '';
    this.date = '';
    clearTimeout(this.searchTimer);
    this.emitFilters();
  }

  ngOnDestroy(): void {
    clearTimeout(this.searchTimer);
  }
}
