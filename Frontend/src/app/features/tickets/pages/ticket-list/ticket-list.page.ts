import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Subscription, finalize } from 'rxjs';
import { Ticket, TicketListFilters } from '../../../../core/models/ticket.model';
import { TicketService } from '../../../../core/services/ticket.service';
import { TicketFiltersComponent } from '../../components/ticket-filters/ticket-filters.component';
import { TicketTableComponent } from '../../components/ticket-table/ticket-table.component';

@Component({
  selector: 'app-ticket-list-page',
  imports: [TicketFiltersComponent, TicketTableComponent],
  templateUrl: './ticket-list.page.html',
})
export class TicketListPage implements OnInit, OnDestroy {
  private readonly ticketService = inject(TicketService);
  private readonly route = inject(ActivatedRoute);
  private request?: Subscription;

  readonly tickets = signal<Ticket[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly pageSize = 10;
  readonly initialSearch = this.route.snapshot.queryParamMap.get('search')?.trim() || '';
  readonly filters = signal<TicketListFilters>(
    this.initialSearch ? { search: this.initialSearch } : {},
  );
  readonly loading = signal(true);
  readonly error = signal('');
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize)));
  readonly startIndex = computed(() =>
    this.total() === 0 ? 0 : (this.page() - 1) * this.pageSize + 1,
  );
  readonly endIndex = computed(() => Math.min(this.page() * this.pageSize, this.total()));

  ngOnInit(): void {
    this.loadTickets();
  }

  onFiltersChanged(filters: TicketListFilters): void {
    this.filters.set(filters);
    this.page.set(1);
    this.loadTickets();
  }

  goToPage(page: number): void {
    if (page < 1 || page > this.totalPages() || page === this.page()) return;
    this.page.set(page);
    this.loadTickets();
  }

  loadTickets(): void {
    this.request?.unsubscribe();
    this.loading.set(true);
    this.error.set('');

    this.request = this.ticketService
      .listar({
        ...this.filters(),
        page: this.page(),
        pageSize: this.pageSize,
      })
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (response) => {
          this.tickets.set(response.data);
          this.total.set(response.total);
        },
        error: (error: Error) => {
          this.tickets.set([]);
          this.total.set(0);
          this.error.set(error.message);
        },
      });
  }

  ngOnDestroy(): void {
    this.request?.unsubscribe();
  }
}
