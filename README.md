# SimpleGym

PWA muy simple para seguir la rutina del gimnasio desde el teléfono. Es un solo `index.html` sin dependencias ni build, y guarda los datos en el `localStorage` del navegador.

**App:** https://diglesias17.github.io/simple-gym/

## Qué hace

- Rutinas que cargás vos desde la app: días, ejercicios, entrada en calor y elongación.
- Registro de kg y reps por serie, con los valores de la sesión anterior como referencia.
- Temporizador de descanso (90 s, ±15 s) con vibración y sonido.
- Historial de sesiones y copia de seguridad (exportar e importar en JSON).
- Funciona sin conexión y se puede instalar con "Agregar a pantalla de inicio".

## Uso local

```sh
npx serve        # o: python -m http.server
```

Con el archivo abierto directamente (`file://`) la app funciona, pero sin modo offline ni instalación.

## Rutinas

Las rutinas se cargan desde la app, en **Rutinas → + Nueva rutina**: días, ejercicios (series, reps y descanso opcional), entrada en calor y elongación. Se pueden guardar varias y elegir cuál está en uso; **Duplicar** sirve para armar la siguiente a partir de la actual.

El historial se vincula por nombre de ejercicio (sin importar mayúsculas ni tildes): si "Sentadilla copa" aparece en una rutina nueva, muestra lo que hiciste la última vez y precarga el peso. El descanso por defecto se cambia en `REST_SECONDS`.

`LEGACY_ROUTINE` en `index.html` solo se usa para migrar los datos de la primera versión de la app.

## Desarrollo

Después de cambiar cualquier archivo, subí la versión de `CACHE` en `sw.js` (`simplegym-v1` → `v2`…) para que los teléfonos descarguen la nueva versión.

> Los datos viven solo en el navegador de cada dispositivo. Exportá una copia de vez en cuando desde **Historial**.
