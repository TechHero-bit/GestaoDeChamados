import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { map, of } from 'rxjs';
import { AuthService } from '../services/auth.service';

export const guestGuard: CanActivateFn = () => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (authService.authState() === 'checking') {
    return authService.checkSession().pipe(
      map((user) => {
        if (user) return router.createUrlTree(['/tickets']);
        return true;
      }),
    );
  }

  if (authService.isAuthenticated()) {
    return of(router.createUrlTree(['/tickets']));
  }

  return of(true);
};
