import { Component, computed, inject, output } from '@angular/core';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-header',
  standalone: true,
  templateUrl: './header.component.html',
})
export class HeaderComponent {
  private readonly authService = inject(AuthService);

  readonly menuRequested = output<void>();
  readonly currentUser = this.authService.currentUser;

  readonly userInitials = computed(() => {
    const name = this.currentUser()?.nome?.trim();
    if (!name) return 'HD';
    const parts = name.split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  });

  onLogout(): void {
    this.authService.logout().subscribe();
  }
}
