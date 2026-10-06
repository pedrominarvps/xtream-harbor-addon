const form = document.querySelector('#install-form');
const status = document.querySelector('#status');
const submit = document.querySelector('#submit');
const result = document.querySelector('#result');
const manifest = document.querySelector('#manifest-url');

form.addEventListener('submit', async event => {
  event.preventDefault();
  submit.disabled = true;
  result.hidden = true;
  manifest.value = '';
  status.textContent = 'Preparando tu enlace…';
  try {
    const response = await fetch('/api/install', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessKey: document.querySelector('#access-key').value.trim() }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'No se pudo crear el enlace.');
    manifest.value = data.manifestUrl;
    document.querySelector('#stremio-link').href = data.installUrl;
    document.querySelector('#access-key').value = '';
    result.hidden = false;
    status.textContent = 'Enlace listo. Cópialo e instálalo en Harbor.';
  } catch (error) {
    status.textContent = error instanceof TypeError ? 'No hay conexión con el addon. Inténtalo de nuevo.' : error.message;
  } finally { submit.disabled = false; }
});

document.querySelector('#copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(manifest.value);
    status.textContent = 'Enlace copiado.';
  } catch {
    manifest.focus();
    manifest.select();
    status.textContent = 'Seleccioné el enlace. Usa Ctrl+C o la opción Copiar de tu dispositivo.';
  }
});
