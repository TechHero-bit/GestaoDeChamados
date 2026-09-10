import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { guestGuard } from './core/guards/guest.guard';

export const routes: Routes = [
  {
    path: 'login',
    title: 'Entrar | SmartDesk',
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
      { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
      {
        path: 'dashboard',
        title: 'Dashboard | SmartDesk',
        loadComponent: () =>
          import('./features/dashboard/pages/dashboard/dashboard.page').then(
            (module) => module.DashboardPage,
          ),
      },
      {
        path: 'tickets',
        title: 'Fila de atendimento | SmartDesk',
        loadComponent: () =>
          import('./features/tickets/pages/ticket-list/ticket-list.page').then(
            (module) => module.TicketListPage,
          ),
      },
      {
        path: 'tickets/:id',
        title: 'Atendimento do chamado | SmartDesk',
        loadComponent: () =>
          import('./features/tickets/pages/ticket-detail/ticket-detail.page').then(
            (module) => module.TicketDetailPage,
          ),
      },
      {
        path: 'reports',
        title: 'Relatórios | SmartDesk',
        loadComponent: () =>
          import('./features/reports/pages/reports/reports.page').then(
            (module) => module.ReportsPage,
          ),
      },
      {
        path: 'settings',
        loadComponent: () =>
          import('./features/settings/layout/settings-layout/settings-layout.component').then(
            (module) => module.SettingsLayoutComponent,
          ),
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'profile' },
          {
            path: 'profile',
            title: 'Perfil | SmartDesk',
            loadComponent: () =>
              import('./features/settings/pages/profile/profile.page').then(
                (module) => module.ProfilePage,
              ),
          },
          {
            path: 'integrations',
            title: 'Integrações | SmartDesk',
            loadComponent: () =>
              import('./features/settings/pages/integrations/integrations.page').then(
                (module) => module.IntegrationsPage,
              ),
          },
          {
            path: 'signature',
            title: 'Assinatura | SmartDesk',
            loadComponent: () =>
              import('./features/settings/pages/signature/signature.page').then(
                (module) => module.SignaturePage,
              ),
          },
        ],
      },
    ],
  },
  { path: '**', redirectTo: 'tickets' },
];
