import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../../../core/services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './login.page.html',
})
export class LoginPage {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  email = '';
  password = '';
  showPassword = signal(false);
  loading = signal(false);
  error = signal<string | null>(null);
  sessionExpired = signal(false);

  constructor() {
    this.route.queryParams.subscribe((params) => {
      if (params['sessionExpired'] === 'true') {
        this.sessionExpired.set(true);
      }
    });
  }

  togglePasswordVisibility(): void {
    this.showPassword.update((val) => !val);
  }

  onSubmit(): void {
    if (this.loading()) return;

    this.error.set(null);
    this.sessionExpired.set(false);

    const emailTrimmed = this.email.trim();
    if (!emailTrimmed) {
      this.error.set('Por favor, informe seu e-mail corporativo.');
      return;
    }

    if (!this.password) {
      this.error.set('Por favor, informe sua senha.');
      return;
    }

    this.loading.set(true);

    this.authService.login({ email: emailTrimmed, password: this.password }).subscribe({
      next: () => {
        const returnUrl = this.route.snapshot.queryParams['returnUrl'] || '/tickets';
        this.router.navigateByUrl(returnUrl);
      },
      error: (err: Error) => {
        this.loading.set(false);
        this.error.set(err.message || 'E-mail ou senha inválidos.');
      },
    });
  }
}
