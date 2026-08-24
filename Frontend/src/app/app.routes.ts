import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./layout/app-shell/app-shell.component').then((module) => module.AppShellComponent),
    children: [
      { path: '', redirectTo: 'tickets', pathMatch: 'full' },
      {
        path: 'tickets',
        title: 'Fila de Atendimento | Helpdesk Central',
        loadComponent: () =>
          import('./features/tickets/pages/ticket-list/ticket-list.page').then(
            (module) => module.TicketListPage,
          ),
      },
      {
        path: 'tickets/:id',
        title: 'Atendimento do Chamado | Helpdesk Central',
        loadComponent: () =>
          import('./features/tickets/pages/ticket-detail/ticket-detail.page').then(
            (module) => module.TicketDetailPage,
          ),
      },
    ],
  },
  { path: '**', redirectTo: 'tickets' },
];
