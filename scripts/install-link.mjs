import { writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.mjs';

try {
  const config = loadConfig();
  const url = `${config.origin}/${config.accessKey}/manifest.json`;
  await writeFile('.install-local.md', `# Instalacion privada local\n\nEste archivo esta excluido de Git. No lo publiques ni compartas: contiene el enlace privado de tu cuenta.\n\nCon el addon ejecutandose, copia la siguiente URL y pegala en Harbor, en Addons → anadir por URL:\n\n${url}\n\nPuedes generar nuevamente este archivo con npm run install-link si cambias la clave o el dominio.\n`, { mode: 0o600 });
  console.log('Enlace privado guardado en .install-local.md; no se imprime en consola.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
