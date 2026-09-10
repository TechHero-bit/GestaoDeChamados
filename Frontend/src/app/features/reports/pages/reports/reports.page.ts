import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription, finalize } from 'rxjs';
import { Ticket, TicketPriority, TicketStatus } from '../../../../core/models/ticket.model';
import { TicketService } from '../../../../core/services/ticket.service';

interface TrendDatum {
  date: string;
  label: string;
  fullLabel: string;
  total: number;
  resolved: number;
}

interface TrendPoint extends TrendDatum {
  x: number;
  yTotal: number;
  yResolved: number;
  showLabel: boolean;
}

interface ChartGridLine {
  y: number;
  value: number;
}

interface TrendChart {
  points: TrendPoint[];
  totalPath: string;
  resolvedPath: string;
  areaPath: string;
  gridLines: ChartGridLine[];
  baselineY: number;
}

interface DistributionItem {
  label: string;
  value: number;
  percentage: number;
  color: string;
  offset: number;
}

interface PriorityItem {
  label: TicketPriority;
  value: number;
  percentage: number;
  color: string;
  softColor: string;
}

@Component({
  selector: 'app-reports-page',
  imports: [FormsModule],
  templateUrl: './reports.page.html',
})
export class ReportsPage implements OnInit, OnDestroy {
  private readonly ticketService = inject(TicketService);
  private readonly shortDateFormatter = new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'short',
  });
  private readonly longDateFormatter = new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
  private request?: Subscription;

  readonly tickets = signal<Ticket[]>([]);
  readonly filteredTickets = signal<Ticket[]>([]);
  readonly totalAvailable = signal(0);
  readonly loading = signal(true);
  readonly error = signal('');

  readonly openCount = computed(
    () => this.filteredTickets().filter((ticket) => ticket.status === 'Aberto').length,
  );
  readonly inProgressCount = computed(
    () => this.filteredTickets().filter((ticket) => ticket.status === 'Em Andamento').length,
  );
  readonly resolvedCount = computed(
    () => this.filteredTickets().filter((ticket) => ticket.status === 'Resolvido').length,
  );
  readonly resolutionRate = computed(() =>
    this.filteredTickets().length === 0
      ? 0
      : Math.round((this.resolvedCount() / this.filteredTickets().length) * 100),
  );

  readonly trendData = computed<TrendDatum[]>(() => {
    const grouped = new Map<string, { total: number; resolved: number }>();

    for (const ticket of this.filteredTickets()) {
      const date = ticket.data_criacao.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

      const current = grouped.get(date) ?? { total: 0, resolved: 0 };
      current.total += 1;
      if (ticket.status === 'Resolvido') current.resolved += 1;
      grouped.set(date, current);
    }

    return [...grouped.entries()]
      .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
      .map(([date, values]) => {
        const localDate = new Date(`${date}T12:00:00`);
        return {
          date,
          label: this.shortDateFormatter.format(localDate).replace('.', ''),
          fullLabel: this.longDateFormatter.format(localDate),
          ...values,
        };
      });
  });

  readonly trendChart = computed<TrendChart>(() => {
    const data = this.trendData();
    const width = 760;
    const height = 300;
    const left = 48;
    const right = 18;
    const top = 22;
    const bottom = 42;
    const baselineY = height - bottom;
    const plotWidth = width - left - right;
    const plotHeight = baselineY - top;
    const maxValue = Math.max(1, ...data.map((item) => item.total));
    const labelStep = Math.max(1, Math.ceil(data.length / 6));

    const points = data.map((item, index) => {
      const x =
        data.length === 1
          ? left + plotWidth / 2
          : left + (index / Math.max(1, data.length - 1)) * plotWidth;
      return {
        ...item,
        x,
        yTotal: baselineY - (item.total / maxValue) * plotHeight,
        yResolved: baselineY - (item.resolved / maxValue) * plotHeight,
        showLabel: index % labelStep === 0 || index === data.length - 1,
      };
    });

    const totalPath = this.smoothPath(points, 'yTotal');
    const resolvedPath = this.smoothPath(points, 'yResolved');
    const areaPath =
      points.length > 1
        ? `${totalPath} L ${points.at(-1)?.x ?? left} ${baselineY} L ${points[0].x} ${baselineY} Z`
        : '';

    const gridLines = Array.from({ length: 5 }, (_, index) => ({
      y: top + (index / 4) * plotHeight,
      value: Math.round(maxValue * (1 - index / 4)),
    }));

    return { points, totalPath, resolvedPath, areaPath, gridLines, baselineY };
  });

  readonly statusDistribution = computed<DistributionItem[]>(() => {
    const total = this.filteredTickets().length;
    const values = [
      { label: 'Abertos', value: this.openCount(), color: 'var(--color-accent)' },
      {
        label: 'Em andamento',
        value: this.inProgressCount(),
        color: 'var(--color-warning)',
      },
      { label: 'Resolvidos', value: this.resolvedCount(), color: 'var(--color-success)' },
    ];
    let offset = 0;

    return values.map((item) => {
      const percentage = total === 0 ? 0 : (item.value / total) * 100;
      const result = { ...item, percentage, offset };
      offset += percentage;
      return result;
    });
  });

  readonly priorityDistribution = computed<PriorityItem[]>(() => {
    const total = this.filteredTickets().length;
    const priorities: Array<{
      label: TicketPriority;
      color: string;
      softColor: string;
    }> = [
      {
        label: 'Alta',
        color: 'var(--color-danger)',
        softColor: 'var(--color-danger-soft)',
      },
      {
        label: 'Normal',
        color: 'var(--color-accent)',
        softColor: 'var(--color-accent-soft)',
      },
      {
        label: 'Baixa',
        color: 'var(--color-success)',
        softColor: 'var(--color-success-soft)',
      },
    ];

    return priorities.map((priority) => {
      const value = this.filteredTickets().filter(
        (ticket) => ticket.prioridade === priority.label,
      ).length;
      return {
        ...priority,
        value,
        percentage: total === 0 ? 0 : Math.round((value / total) * 100),
      };
    });
  });

  startDate = '';
  endDate = '';
  status: TicketStatus | '' = '';
  priority: TicketPriority | '' = '';

  ngOnInit(): void {
    this.loadReport();
  }

  loadReport(): void {
    this.request?.unsubscribe();
    this.loading.set(true);
    this.error.set('');

    this.request = this.ticketService
      .listar({ page: 1, pageSize: 100 })
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (response) => {
          this.tickets.set(response.data);
          this.totalAvailable.set(response.total);
          this.applyFilters();
        },
        error: (error: Error) => {
          this.tickets.set([]);
          this.filteredTickets.set([]);
          this.totalAvailable.set(0);
          this.error.set(error.message);
        },
      });
  }

  applyFilters(): void {
    this.filteredTickets.set(
      this.tickets().filter((ticket) => {
        const ticketDate = ticket.data_criacao.slice(0, 10);
        return (
          (!this.startDate || ticketDate >= this.startDate) &&
          (!this.endDate || ticketDate <= this.endDate) &&
          (!this.status || ticket.status === this.status) &&
          (!this.priority || ticket.prioridade === this.priority)
        );
      }),
    );
  }

  resetFilters(): void {
    this.startDate = '';
    this.endDate = '';
    this.status = '';
    this.priority = '';
    this.applyFilters();
  }

  private smoothPath(points: TrendPoint[], yKey: 'yTotal' | 'yResolved'): string {
    if (points.length === 0) return '';
    if (points.length === 1) return `M ${points[0].x} ${points[0][yKey]}`;

    let path = `M ${points[0].x} ${points[0][yKey]}`;
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      const middleX = (previous.x + current.x) / 2;
      path += ` C ${middleX} ${previous[yKey]}, ${middleX} ${current[yKey]}, ${current.x} ${current[yKey]}`;
    }
    return path;
  }

  ngOnDestroy(): void {
    this.request?.unsubscribe();
  }
}
