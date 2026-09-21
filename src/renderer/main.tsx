import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/500.css';
import '@fontsource/instrument-sans/600.css';
import '@fontsource/instrument-sans/700.css';
import '@fontsource/instrument-serif/400.css';
import './styles.css';
import './i18n';
import { App } from './App';
import { applyTheme, initialTheme } from './theme';

applyTheme(initialTheme()); // before the first paint, so there is no flash of the wrong theme

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
