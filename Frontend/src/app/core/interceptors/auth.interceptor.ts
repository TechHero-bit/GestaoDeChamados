import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  // Enviar cookies HttpOnly em todas as requisições
  const clonedReq = req.clone({
    withCredentials: true,
  });

  return next(clonedReq).pipe(
    catchError((error: HttpErrorResponse) => {
      if (error.status === 401) {
        const isLoginRequest = req.url.includes('/auth/login');
        const isCheckSessionRequest = req.url.includes('/auth/me');

        // Se for uma requisição autenticada comum e a sessão caiu por inatividade ou expiração
        if (!isLoginRequest && !isCheckSessionRequest) {
          authService.clearLocalState();
          router.navigate(['/login'], {
            queryParams: { sessionExpired: 'true' },
          });
        }
      }
      return throwError(() => error);
    }),
  );
};
