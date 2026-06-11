# Inspector DTF

Herramienta web 100 % local para evaluar si un archivo PNG/JPG/JPEG/WEBP/PDF es adecuado para impresión DTF (Direct To Film).

No usa servidor. No usa APIs externas. No sube tu archivo a internet.
Todo el análisis se ejecuta en el navegador usando Canvas 2D y JavaScript puro.

Para archivos PDF se usa **PDF.js** (Mozilla), también ejecutado íntegramente en el navegador.

---

## Cómo usarla

1. Abre `index.html` con doble clic, o sírvela con un servidor local cualquiera.
2. Arrastra tu archivo sobre el panel izquierdo (o haz clic para seleccionarlo).
3. Si subes un PDF con varias páginas, elige la página a analizar (verás miniaturas).
4. Presiona **Analizar imagen**.
5. Revisa las tarjetas de diagnóstico y el banner de resumen.

> Si abres el HTML directamente con `file://` y notas problemas, sírvelo con un servidor local sencillo:
>
> ```powershell
> # Con Python 3
> python -m http.server 8080
> # Luego abre http://localhost:8080
> ```

### Soporte PDF — requiere internet la primera vez

El soporte para PDF carga **PDF.js** (Mozilla) desde un CDN (~1 MB). La primera vez necesitas internet; después de eso, el navegador lo cachea y funciona offline.

Si quieres tener el proyecto **100 % autónomo desde el primer momento**, descarga los dos archivos a una carpeta `lib/` junto a `index.html`:

```
lib/
├── pdf.min.js
└── pdf.worker.min.js
```

Puedes obtenerlos de:
- `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js`
- `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js`

Y luego cambia en `index.html` las dos referencias por `lib/pdf.min.js` y `lib/pdf.worker.min.js`.

---

## Qué evalúa

El inspector aplica criterios técnicos reales de DTF, no análisis decorativos.

### 1. Resolución real
Lee `ancho_px` y `alto_px` y calcula el tamaño físico máximo a 300 DPI:

```
ancho_cm = (ancho_px / 300) * 2.54
alto_cm  = (alto_px  / 300) * 2.54
```

- **OK** si la dimensión menor ≥ 1200 px
- **WARN** entre 600 px y 1200 px (útil para piezas pequeñas)
- **BAD** por debajo de 600 px

### 2. Formato del archivo
- **PDF** → OK (formato apto para DTF; se rasteriza a 300 DPI para el análisis)
- **PNG** → OK (preferido para DTF, soporta transparencia)
- **JPG/JPEG** → WARN (no preserva transparencia y usa compresión)
- **WEBP** → WARN leve

### 3. Transparencia
Lee el canal alpha:
- Si hay transparencia limpia → **OK**
- Si la imagen es 100 % opaca → **WARN** (fondo pegado)

### 4. Semitransparencias
Cuenta píxeles con `0 < alpha < 255` y reporta su porcentaje respecto al área visible.
- **OK** < 1 %
- **WARN** 1 % – 8 %
- **BAD** > 8 %

Las semitransparencias pueden provocar halos o bordes blandos en DTF.

### 5. Elementos menores a 4 px
Genera la máscara binaria `visible = alpha > 0`, aplica **connected components** (8-conectividad con Union-Find) y mide cada componente.
Cuenta los componentes cuyo `width < 4`, `height < 4` o diagonal `< 4`.
- **OK** 0 elementos
- **WARN** ≤ 15 elementos
- **BAD** > 15 elementos

> Para imágenes muy grandes el análisis se hace sobre una versión reducida y el umbral se ajusta proporcionalmente para mantener equivalencia perceptual.

### 6. Calidad visual
Tres detectores independientes sobre la luminancia (compuesta sobre blanco si hay alpha), con score 0–100:

- **6.1 Pixelación** — combina uniformidad de bloques 2×2 (sólo en zonas con contenido) y proporción de bordes "duros" sobre bordes totales.
- **6.2 Nitidez** — varianza del Laplaciano normalizada en escala logarítmica.
- **6.3 Compresión JPG** — compara las discontinuidades en las fronteras de bloques 8×8 vs el interior.
- **6.4 Calidad visual general** — promedio ponderado (nitidez 40 %, pixelación 35 %, compresión 25 %).

Cuando una detección tiene baja confianza, la tarjeta muestra explícitamente:

> *No se pudo determinar con certeza.*

### 7. Calificación general DTF
Promedio ponderado de todas las métricas con pesos calibrados:

| Métrica | Peso |
| --- | --- |
| Resolución | 22 % |
| Formato | 8 % |
| Transparencia | 12 % |
| Semitransparencias | 10 % |
| Elementos pequeños | 18 % |
| Calidad visual | 30 % |

El resultado es un score de 0 a 100 con cuatro veredictos:

- **Excelente** ≥ 85
- **Bueno** 70 – 84
- **Aceptable** 50 – 69
- **Problemático** < 50

---

## Estructura del proyecto

```
Analizador IA/
├── index.html        Estructura de la página
├── styles.css        Estilos (panel izquierdo tipo Canva + tarjetas)
├── analyzers.js      Algoritmos de análisis (sin dependencias)
├── app.js            Controlador de UI y render de resultados
└── README.md         Este archivo
```

---

## Filosofía

- **No inventa diagnósticos.** Si no hay certeza, lo dice.
- **Métricas objetivas y verificables**, basadas en problemas reales de DTF.
- **Velocidad y privacidad**: todo corre en el navegador del usuario.

---

## Limitaciones conocidas

- Para imágenes muy grandes (>2500 px en el lado mayor), el análisis de componentes conectados y la calidad visual se ejecutan sobre una versión escalada para no consumir memoria excesiva. La resolución original se reporta tal cual.
- La detección de compresión JPG mide artefactos de bloques 8×8; puede dar señal sobre PNG que provienen de un JPG re-guardado, pero no es 100 % específica del formato actual.
- La detección de pixelación se basa en heurísticas; en zonas con fondos planos extensos puede dar falsos positivos. Por eso se descartan zonas planas del cálculo.
