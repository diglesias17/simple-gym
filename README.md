# SimpleGym

PWA muy simple para seguir la rutina del gimnasio desde el teléfono. Es un solo `index.html` sin dependencias ni build, y guarda los datos en el `localStorage` del navegador.

**App:** https://diglesias17.github.io/simple-gym/

## Qué hace

- Rutinas que cargás vos desde la app: días, ejercicios, entrada en calor y elongación.
- Registro de kg y reps por serie, con los valores de la sesión anterior como referencia.
- Temporizador de descanso (por defecto 1:30, ±15 s) con vibración y sonido.
- Historial de sesiones.
- Configuración: tamaño de letra, descanso por defecto y copia de seguridad (exportar e importar en JSON).
- Funciona sin conexión y se puede instalar con "Agregar a pantalla de inicio".

## Uso local

```sh
npx serve        # o: python -m http.server
```

Con el archivo abierto directamente (`file://`) la app funciona, pero sin modo offline ni instalación.

## Rutinas

Las rutinas se cargan desde la app, en **Rutinas → + Nueva rutina**: días, ejercicios (series, reps, peso sugerido y descanso, opcionales los dos últimos), entrada en calor y elongación (ejercicio, series y reps). Se pueden guardar varias y elegir cuál está en uso; **Duplicar** sirve para armar la siguiente a partir de la actual.

Para no escribir en el teléfono, el botón con la figurita (o **+ ejercicio**) abre un selector con el cuerpo de frente y de espalda: tocás un músculo y elegís el ejercicio de la lista (`MUSCLES` en `index.html`). También hay atajos para tus ejercicios, cardio y movilidad. Al escribir el nombre de un ejercicio, la app sugiere los que ya usaste y una lista de ejercicios comunes (`EXERCISES` y `PHASE_ITEMS` en `index.html`). El peso sugerido se precarga la primera vez que hacés el ejercicio con esa rutina; después se usa el último peso real.

El historial se vincula por nombre de ejercicio (sin importar mayúsculas ni tildes): si "Sentadilla copa" aparece en una rutina nueva, muestra lo que hiciste la última vez y precarga el peso. El descanso por defecto se elige en **Configuración**; si un ejercicio tiene descanso propio en la rutina, se usa ese.

`LEGACY_ROUTINE` en `index.html` solo se usa para migrar los datos de la primera versión de la app.

## Desarrollo

### Pruebas

```sh
node tests/e2e.mjs              # corre las pruebas (unos 20 s)
node tests/e2e.mjs --capturas   # además guarda capturas de pantalla
```

Levantan la app en un servidor local y la manejan con Chrome (o Edge) sin ventana, con pantalla de teléfono. No hace falta instalar nada: solo Node 22 o más nuevo. Si el navegador no está en la ruta habitual, indicala con la variable `CHROME`. Corrélas antes de cada commit.

### Publicar cambios

Después de cambiar cualquier archivo, subí la versión de `CACHE` en `sw.js` (`simplegym-v1` → `v2`…) para que los teléfonos descarguen la nueva versión.

> Los datos viven solo en el navegador de cada dispositivo. Exportá una copia de vez en cuando desde **Configuración**.
