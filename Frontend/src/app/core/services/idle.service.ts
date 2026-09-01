import { inject, Injectable, NgZone } from '@angular/core';
import { fromEvent, merge, Subscription } from 'rxjs';
import { filter, throttleTime } from 'rxjs/operators';
import { AuthService } from './auth.service';

const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos
const SYNC_INTERVAL_MS = 2 * 60 * 1000; // 2 minutos para sincronização de atividade

@Injectable({ providedIn: 'root' })
export class IdleService {
  private readonly authService = inject(AuthService);
  private readonly ngZone = inject(NgZone);

  private lastActiveTimestamp = Date.now();
  private lastSyncedTimestamp = Date.now();
  private isUserActiveRecently = false;

  private eventsSubscription: Subscription | null = null;
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Inicia o monitoramento de inatividade do usuário quando autenticado.
   */
  startMonitoring(): void {
    this.stopMonitoring();
    this.lastActiveTimestamp = Date.now();
    this.lastSyncedTimestamp = Date.now();
    this.isUserActiveRecently = true;

    // Executar fora da zona do Angular para não disparar change detection a cada movimento do mouse
    this.ngZone.runOutsideAngular(() => {
      const mouseMove$ = fromEvent(window, 'mousemove');
      const mouseDown$ = fromEvent(window, 'mousedown');
      const keyDown$ = fromEvent(window, 'keydown');
      const touchStart$ = fromEvent(window, 'touchstart');
      const scroll$ = fromEvent(window, 'scroll');
      const click$ = fromEvent(window, 'click');

      this.eventsSubscription = merge(
        mouseMove$,
        mouseDown$,
        keyDown$,
        touchStart$,
        scroll$,
        click$,
      )
        .pipe(
          throttleTime(1000), // Limita leitura de eventos a 1 vez por segundo
          filter(
            () =>
              this.authService.isAuthenticated() &&
              !this.authService.externalAuthInProgress(),
          ),
        )
        .subscribe(() => {
          this.lastActiveTimestamp = Date.now();
          this.isUserActiveRecently = true;

          // Sincronizar periodicamente com o backend se houve atividade real
          const now = Date.now();
          if (now - this.lastSyncedTimestamp >= SYNC_INTERVAL_MS) {
            this.lastSyncedTimestamp = now;
            this.authService.recordActivity().subscribe();
          }
        });

      // Timer a cada 15 segundos para verificar o tempo decorrido
      this.checkTimer = setInterval(() => {
        if (
          !this.authService.isAuthenticated() ||
          this.authService.externalAuthInProgress()
        )
          return;

        const now = Date.now();
        const elapsed = now - this.lastActiveTimestamp;

        if (elapsed >= IDLE_TIMEOUT_MS) {
          this.ngZone.run(() => {
            this.authService.logout('/login').subscribe();
          });
        }
      }, 15 * 1000);
    });
  }

  /**
   * Para o monitoramento de inatividade.
   */
  stopMonitoring(): void {
    if (this.eventsSubscription) {
      this.eventsSubscription.unsubscribe();
      this.eventsSubscription = null;
    }
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }
}
