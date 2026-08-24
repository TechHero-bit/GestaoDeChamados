import { Component, inject, input, output } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './sidebar.component.html',
})
export class SidebarComponent {
  private readonly authService = inject(AuthService);

  readonly open = input(false);
  readonly closeSidebar = output<void>();

  readonly currentUser = this.authService.currentUser;

  onLogout(): void {
    this.closeSidebar.emit();
    this.authService.logout().subscribe();
  }
}
