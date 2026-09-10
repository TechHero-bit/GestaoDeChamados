import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-settings-layout',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './settings-layout.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsLayoutComponent {}
