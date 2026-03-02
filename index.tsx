import '@fontsource/inter/latin-300.css';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-700.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AlertProvider } from './components/GlobalAlert';
import { ThemeProvider } from './contexts/ThemeContext';
import { initModelRegistry } from './services/modelRegistry';
import { APP_VERSION } from './constants/links';

console.log(
  `%c BigBanana AI Director v${APP_VERSION} %c`,
  'background: #818cf8; color: #fff; font-size: 14px; font-weight: bold; padding: 4px 12px; border-radius: 4px;',
  ''
);

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);

const bootstrap = async () => {
  try {
    await initModelRegistry();
    root.render(
      <React.StrictMode>
        <BrowserRouter>
          <ThemeProvider>
            <AlertProvider>
              <App />
            </AlertProvider>
          </ThemeProvider>
        </BrowserRouter>
      </React.StrictMode>
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    root.render(
      <div style={{ padding: '24px', fontFamily: 'sans-serif' }}>
        <h2>Cloud Config Unavailable</h2>
        <p>{message}</p>
        <p>Please ensure `config-api` is running, then refresh.</p>
      </div>
    );
  }
};

bootstrap();
