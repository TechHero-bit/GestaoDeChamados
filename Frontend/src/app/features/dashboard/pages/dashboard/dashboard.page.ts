import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { forkJoin, Subscription, finalize } from 'rxjs';
import { Ticket } from '../../../../core/models/ticket.model';
import { TicketService } from '../../../../core/services/ticket.service';
import { PriorityBadgeComponent } from '../../../../shared/components/priority-badge/priority-badge.component';
import { StatusBadgeComponent } from '../../../../shared/components/status-badge/status-badge.component';
import {
  formatDate,
  requesterName,
  shortTicketId,
} from '../../../../shared/utils/ticket-formatters';

@Component({
  selector: 'app-dashboard-page',
  imports: [RouterLink, PriorityBadgeComponent, StatusBadgeComponent],
  templateUrl: './dashboard.page.html',
})
export class DashboardPage implements OnInit, OnDestroy {
  private readonly ticketService = inject(TicketService);
  private request?: Subscription;

  readonly recentTickets = signal<Ticket[]>([]);
  readonly total = signal(0);
  readonly open = signal(0);
  readonly inProgress = signal(0);
  readonly resolved = signal(0);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly pending = computed(() => this.open() + this.inProgress());
  readonly resolutionRate = computed(() =>
    this.total() === 0 ? 0 : Math.round((this.resolved() / this.total()) * 100),
  );
  readonly statusItems = computed(() => [
    { label: 'Abertos', value: this.open(), tone: 'bg-accent' },
    { label: 'Em andamento', value: this.inProgress(), tone: 'bg-warning' },
    { label: 'Resolvidos', value: this.resolved(), tone: 'bg-success' },
  ]);

  readonly formatDate = formatDate;
  readonly requesterName = requesterName;
  readonly shortTicketId = shortTicketId;

  ngOnInit(): void {
    this.loadDashboard();
  }

  loadDashboard(): void {
    this.request?.unsubscribe();
    this.loading.set(true);
    this.error.set('');

    this.request = forkJoin({
      recent: this.ticketService.listar({ page: 1, pageSize: 5 }),
      open: this.ticketService.listar({ status: 'Aberto', page: 1, pageSize: 1 }),
      inProgress: this.ticketService.listar({
        status: 'Em Andamento',
        page: 1,
        pageSize: 1,
      }),
      resolved: this.ticketService.listar({ status: 'Resolvido', page: 1, pageSize: 1 }),
    })
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: ({ recent, open, inProgress, resolved }) => {
          this.recentTickets.set(recent.data);
          this.total.set(recent.total);
          this.open.set(open.total);
          this.inProgress.set(inProgress.total);
          this.resolved.set(resolved.total);
        },
        error: (error: Error) => {
          this.recentTickets.set([]);
          this.total.set(0);
          this.open.set(0);
          this.inProgress.set(0);
          this.resolved.set(0);
          this.error.set(error.message);
        },
      });
  }

  statusPercentage(value: number): number {
    return this.total() === 0 ? 0 : Math.round((value / this.total()) * 100);
  }

  ngOnDestroy(): void {
    this.request?.unsubscribe();
  }
}
