import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import { DOCUMENT_API_URL } from './document-processor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    // The FastAPI backend; ng serve forwards /api through proxy.conf.json.
    { provide: DOCUMENT_API_URL, useValue: '/api/documents' },
  ],
};
