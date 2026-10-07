import './style.css';

const status = document.querySelector<HTMLParagraphElement>('#api-status');

async function checkApi(): Promise<void> {
  if (!status) return;

  try {
    const response = await fetch('/api/health');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data: unknown = await response.json();
    if (typeof data !== 'object' || data === null || !('status' in data) || data.status !== 'ok') {
      throw new Error('Respuesta inesperada de la API');
    }
    status.textContent = 'API conectada';
  } catch {
    status.textContent = 'No se pudo conectar con la API. Comprueba que esté ejecutándose.';
  }
}

void checkApi();
