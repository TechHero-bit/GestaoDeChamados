import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { map, of } from 'rxjs';
import { AuthService } from '../services/auth.service';

export const authGuard: CanActivateFn = (_route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  if (authService.authState() === 'checking') {
    return authService.checkSession().pipe(
      map((user) => {
        if (user) return true;
        return router.createUrlTree(['/login'], {
          queryParams: { returnUrl: state.url },
        });
      }),
    );
  }

  if (authService.isAuthenticated()) {
    return of(true);
  }

  return of(
    router.createUrlTree(['/login'], {
      queryParams: { returnUrl: state.url },
    }),
  );
};
