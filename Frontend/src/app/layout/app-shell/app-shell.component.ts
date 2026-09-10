import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { IdleService } from '../../core/services/idle.service';
import { HeaderComponent } from '../header/header.component';
import { SidebarComponent } from '../sidebar/sidebar.component';

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [HeaderComponent, RouterOutlet, SidebarComponent],
  templateUrl: './app-shell.component.html',
})
export class AppShellComponent implements OnInit, OnDestroy {
  private readonly idleService = inject(IdleService);
  readonly sidebarOpen = signal(false);
  readonly sidebarCollapsed = signal(this.readSidebarPreference());

  ngOnInit(): void {
    this.idleService.startMonitoring();
  }

  ngOnDestroy(): void {
    this.idleService.stopMonitoring();
  }

  toggleSidebar(): void {
    this.sidebarCollapsed.update((collapsed) => {
      const next = !collapsed;
      try {
        localStorage.setItem('helpdesk:sidebar_collapsed', String(next));
      } catch {
        // A preferência é opcional quando o storage não está disponível.
      }
      return next;
    });
  }

  private readSidebarPreference(): boolean {
    try {
      return localStorage.getItem('helpdesk:sidebar_collapsed') === 'true';
    } catch {
      return false;
    }
  }
}
