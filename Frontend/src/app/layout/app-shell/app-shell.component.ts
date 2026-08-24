import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { HeaderComponent } from '../header/header.component';
import { SidebarComponent } from '../sidebar/sidebar.component';

@Component({
  selector: 'app-shell',
  imports: [HeaderComponent, RouterOutlet, SidebarComponent],
  templateUrl: './app-shell.component.html',
})
export class AppShellComponent {
  readonly sidebarOpen = signal(false);
}
