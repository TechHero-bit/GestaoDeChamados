import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { guestGuard } from './core/guards/guest.guard';

export const routes: Routes = [
  {
    path: 'login',
    title: 'Acessar o Sistema | Helpdesk Central',
    canActivate: [guestGuard],
    loadComponent: () =>
      import('./features/auth/pages/login/login.page').then((module) => module.LoginPage),
  },
  {
    path: '',
    canActivate: [authGuard],
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
      {
        path: 'settings/integrations',
        title: 'Integrações | Helpdesk Central',
        loadComponent: () =>
          import('./features/settings/pages/integrations/integrations.page').then(
            (module) => module.IntegrationsPage,
          ),
      },
    ],
  },
  { path: '**', redirectTo: 'tickets' },
];
