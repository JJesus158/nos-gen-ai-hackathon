import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  inject,
  signal,
} from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { faMoon, faSun } from '@fortawesome/free-solid-svg-icons';
import { LanguageService } from './language.service';
import { Theme, ThemeService } from './theme.service';
import { DOCUMENT_API_URL } from './document-processor';

@Component({
  selector: 'app-root',
  imports: [RouterLink, RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly themeIcons = { light: faSun, dark: faMoon };
  protected readonly theme = inject(ThemeService);
  protected readonly language = inject(LanguageService);
  protected readonly apiEnabled = Boolean(inject(DOCUMENT_API_URL));
  protected readonly languageMenuOpen = signal(false);

  protected toggleTheme(): void {
    this.theme.setPreference(this.theme.preference() === 'light' ? 'dark' : 'light');
  }

  protected setLanguage(value: string): void {
    if (value === 'en' || value === 'pt-PT') {
      this.language.setPreference(value);
      this.languageMenuOpen.set(false);
    }
  }

  protected toggleLanguageMenu(): void {
    this.languageMenuOpen.update((open) => !open);
  }

  @HostListener('document:click', ['$event'])
  protected closeLanguageMenu(event: MouseEvent): void {
    const target = event.target;
    if (target instanceof Element && !target.closest('.language-control')) {
      this.languageMenuOpen.set(false);
    }
  }
}
