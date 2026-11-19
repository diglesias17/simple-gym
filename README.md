# SimpleGym

PWA muy simple para seguir la rutina del gimnasio desde el teléfono. Es un solo `index.html` sin dependencias ni build, y guarda los datos en el `localStorage` del navegador.

**App:** https://diglesias17.github.io/simple-gym/

## Qué hace

- Rutina de 4 días más la entrada en calor diaria (2 vueltas).
- Registro de kg y reps por serie, con los valores de la sesión anterior como referencia.
- Temporizador de descanso (90 s, ±15 s) con vibración y sonido.
- Historial de sesiones y copia de seguridad (exportar e importar en JSON).
- Funciona sin conexión y se puede instalar con "Agregar a pantalla de inicio".

## Uso local

```sh
npx serve        # o: python -m http.server
```

Con el archivo abierto directamente (`file://`) la app funciona, pero sin modo offline ni instalación.

## Editar la rutina

Los ejercicios están en el objeto `ROUTINE`, al principio del `<script>` de `index.html`. El descanso se cambia en `REST_SECONDS`.

Después de cambiar cualquier archivo, subí la versión de `CACHE` en `sw.js` (`simplegym-v1` → `v2`…) para que los teléfonos descarguen la nueva versión.

> Los datos viven solo en el navegador de cada dispositivo. Exportá una copia de vez en cuando desde **Historial**.
