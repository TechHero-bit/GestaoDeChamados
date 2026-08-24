import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, finalize, map, Observable, of, tap, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AuthResponse, AuthState, LoginCredentials, User } from '../models/auth.model';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly apiUrl = `${environment.apiUrl}/auth`;

  private readonly _currentUser = signal<User | null>(null);
  private readonly _authState = signal<AuthState>('checking');

  readonly currentUser = this._currentUser.asReadonly();
  readonly authState = this._authState.asReadonly();
  readonly isAuthenticated = computed(() => this._currentUser() !== null);
  readonly isAdmin = computed(() => this._currentUser()?.role === 'ADMIN');

  /**
   * Valida se existe uma sessão ativa restaurando o usuário no bootstrap da aplicação.
   */
  checkSession(): Observable<User | null> {
    this._authState.set('checking');
    return this.http.get<{ success: boolean; user: User }>(`${this.apiUrl}/me`).pipe(
      map((res) => res.user),
      tap((user) => {
        this._currentUser.set(user);
        this._authState.set('authenticated');
      }),
      catchError(() => {
        this._currentUser.set(null);
        this._authState.set('unauthenticated');
        return of(null);
      }),
    );
  }

  /**
   * Realiza login enviando as credenciais. O backend grava o cookie HttpOnly.
   */
  login(credentials: LoginCredentials): Observable<User> {
    return this.http.post<AuthResponse>(`${this.apiUrl}/login`, credentials).pipe(
      map((res) => res.user),
      tap((user) => {
        this._currentUser.set(user);
        this._authState.set('authenticated');
      }),
      catchError((error: HttpErrorResponse) => {
        const message =
          error.error?.message ||
          'E-mail ou senha inválidos. Verifique suas credenciais.';
        return throwError(() => new Error(message));
      }),
    );
  }

  /**
   * Realiza logout revogando a sessão no backend e limpando estado e storage do Help Desk.
   */
  logout(redirectUrl: string = '/login'): Observable<void> {
    return this.http
      .post<{ success: boolean }>(`${this.apiUrl}/logout`, {})
      .pipe(
        map(() => void 0),
        catchError(() => of(void 0)),
        finalize(() => {
          this.clearLocalState();
          this.router.navigate([redirectUrl]);
        }),
      );
  }

  /**
   * Notificação de atividade para manter a sessão ativa durante uso contínuo.
   */
  recordActivity(): Observable<void> {
    if (!this.isAuthenticated()) return of(void 0);
    return this.http.post<void>(`${this.apiUrl}/activity`, {}).pipe(
      catchError(() => of(void 0)),
    );
  }

  /**
   * Limpa todo o estado em memória e apenas as chaves namespace helpdesk:* dos storages locais.
   * Não afeta dados de outros sistemas no mesmo domínio.
   */
  clearLocalState(): void {
    this._currentUser.set(null);
    this._authState.set('unauthenticated');

    const clearNamespace = (storage: Storage) => {
      try {
        const keysToRemove: string[] = [];
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (key && key.startsWith('helpdesk:')) {
            keysToRemove.push(key);
          }
        }
        keysToRemove.forEach((key) => storage.removeItem(key));
      } catch {
        // Ignora erros caso o storage esteja desabilitado
      }
    };

    clearNamespace(localStorage);
    clearNamespace(sessionStorage);
  }
}
