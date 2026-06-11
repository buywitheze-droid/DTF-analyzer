/* ==========================================================================
   Inspector DTF — analyzers.js
   Implementación de los análisis técnicos sobre la imagen.
   Todo se ejecuta en navegador, sin dependencias externas.
   ==========================================================================
*/

(function (global) {
    "use strict";

    /* ------------------------------------------------------------------ *
     * Utilidades                                                          *
     * ------------------------------------------------------------------ */

    const DPI = 300;

    function nextTick() {
        return new Promise((resolve) => setTimeout(resolve, 0));
    }

    function clamp(v, min, max) {
        return Math.max(min, Math.min(max, v));
    }

    function round1(v) { return Math.round(v * 10) / 10; }
    function round2(v) { return Math.round(v * 100) / 100; }

    function formatPx(n) {
        return n.toLocaleString("es-MX");
    }

    function fileSizeText(bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
        return (bytes / (1024 * 1024)).toFixed(2) + " MB";
    }

    /* ------------------------------------------------------------------ *
     * Sección 1 · Resolución real                                         *
     * ------------------------------------------------------------------ */

    /**
     * Lee los DPI incrustados del archivo (PNG pHYs, JPEG JFIF/EXIF).
     * Devuelve { xDpi, yDpi, source } o null si no se pudo determinar.
     */
    async function extractEmbeddedDPI(file) {
        if (!file) return null;
        const fmt = detectFormat(file);
        if (fmt !== "PNG" && fmt !== "JPEG") return null;
        try {
            const buffer = await file.arrayBuffer();
            const view = new DataView(buffer);
            if (fmt === "PNG") return readPngDPI(view);
            if (fmt === "JPEG") return readJpegDPI(view);
        } catch (_) {
            return null;
        }
        return null;
    }

    // PNG pHYs chunk
    function readPngDPI(view) {
        // Firma PNG: 89 50 4E 47 0D 0A 1A 0A
        if (view.byteLength < 16) return null;
        if (view.getUint32(0) !== 0x89504E47) return null;
        if (view.getUint32(4) !== 0x0D0A1A0A) return null;

        let offset = 8;
        while (offset + 12 <= view.byteLength) {
            const length = view.getUint32(offset);
            const type = view.getUint32(offset + 4);
            // pHYs = "pHYs" = 0x70485973
            if (type === 0x70485973) {
                if (offset + 8 + 9 > view.byteLength) return null;
                const ppuX = view.getUint32(offset + 8);
                const ppuY = view.getUint32(offset + 12);
                const unit = view.getUint8(offset + 16);
                if (unit === 1) { // unidad = metro
                    return {
                        xDpi: Math.round(ppuX * 0.0254),
                        yDpi: Math.round(ppuY * 0.0254),
                        source: "PNG pHYs"
                    };
                }
                return null; // unidad 0 = sólo aspect ratio, no es DPI real
            }
            if (type === 0x49454E44) break; // IEND
            offset += 8 + length + 4; // length(4) + type(4) + data + crc(4)
        }
        return null;
    }

    // JPEG JFIF / EXIF
    function readJpegDPI(view) {
        if (view.byteLength < 4) return null;
        if (view.getUint16(0) !== 0xFFD8) return null; // SOI

        let offset = 2;
        let exifDpi = null;
        while (offset + 4 <= view.byteLength) {
            const marker = view.getUint16(offset);
            offset += 2;
            if ((marker & 0xFF00) !== 0xFF00) return exifDpi;
            if (marker === 0xFFD8 || marker === 0xFFD9) return exifDpi;
            if (marker === 0xFFDA) return exifDpi; // SOS: a partir de aquí no hay metadata

            const segLength = view.getUint16(offset);
            if (segLength < 2 || offset + segLength > view.byteLength) return exifDpi;

            // APP0 — JFIF
            if (marker === 0xFFE0 && segLength >= 16) {
                const isJfif =
                    view.getUint8(offset + 2) === 0x4A && // J
                    view.getUint8(offset + 3) === 0x46 && // F
                    view.getUint8(offset + 4) === 0x49 && // I
                    view.getUint8(offset + 5) === 0x46 && // F
                    view.getUint8(offset + 6) === 0x00;   // \0
                if (isJfif) {
                    const units = view.getUint8(offset + 9);   // 0=ratio, 1=DPI, 2=DPCM
                    const xDensity = view.getUint16(offset + 10);
                    const yDensity = view.getUint16(offset + 12);
                    if (units === 1 && xDensity > 0 && yDensity > 0) {
                        return { xDpi: xDensity, yDpi: yDensity, source: "JPEG JFIF" };
                    }
                    if (units === 2 && xDensity > 0 && yDensity > 0) {
                        return {
                            xDpi: Math.round(xDensity * 2.54),
                            yDpi: Math.round(yDensity * 2.54),
                            source: "JPEG JFIF (cm)"
                        };
                    }
                    // units===0 → es solo aspecto, seguimos buscando EXIF
                }
            }

            // APP1 — EXIF
            if (marker === 0xFFE1 && segLength >= 16) {
                const isExif =
                    view.getUint8(offset + 2) === 0x45 && // E
                    view.getUint8(offset + 3) === 0x78 && // x
                    view.getUint8(offset + 4) === 0x69 && // i
                    view.getUint8(offset + 5) === 0x66 && // f
                    view.getUint8(offset + 6) === 0x00 &&
                    view.getUint8(offset + 7) === 0x00;
                if (isExif) {
                    const tiffStart = offset + 8;
                    const tiffEnd = offset + segLength;
                    const tiffDpi = readTiffDPI(view, tiffStart, tiffEnd);
                    if (tiffDpi) exifDpi = tiffDpi;
                }
            }

            offset += segLength;
        }
        return exifDpi;
    }

    function readTiffDPI(view, tiffStart, tiffEnd) {
        if (tiffStart + 8 > tiffEnd) return null;
        const byteOrder = view.getUint16(tiffStart);
        const le = byteOrder === 0x4949; // II=little, MM=big
        if (byteOrder !== 0x4949 && byteOrder !== 0x4D4D) return null;
        if (view.getUint16(tiffStart + 2, le) !== 0x002A) return null;

        const ifd0 = view.getUint32(tiffStart + 4, le);
        const ifdStart = tiffStart + ifd0;
        if (ifdStart + 2 > tiffEnd) return null;
        const numEntries = view.getUint16(ifdStart, le);

        let xResNum = null, xResDen = null;
        let yResNum = null, yResDen = null;
        let resUnit = 2; // default EXIF: pulgadas

        for (let i = 0; i < numEntries; i++) {
            const e = ifdStart + 2 + i * 12;
            if (e + 12 > tiffEnd) break;
            const tag = view.getUint16(e, le);
            const type = view.getUint16(e + 2, le);

            if (tag === 0x011A && type === 5) {
                const vOff = tiffStart + view.getUint32(e + 8, le);
                if (vOff + 8 <= tiffEnd) {
                    xResNum = view.getUint32(vOff, le);
                    xResDen = view.getUint32(vOff + 4, le);
                }
            } else if (tag === 0x011B && type === 5) {
                const vOff = tiffStart + view.getUint32(e + 8, le);
                if (vOff + 8 <= tiffEnd) {
                    yResNum = view.getUint32(vOff, le);
                    yResDen = view.getUint32(vOff + 4, le);
                }
            } else if (tag === 0x0128 && type === 3) {
                resUnit = view.getUint16(e + 8, le);
            }
        }

        if (xResNum == null || yResNum == null) return null;
        if (!xResDen || !yResDen) return null;

        let xDpi = xResNum / xResDen;
        let yDpi = yResNum / yResDen;
        if (resUnit === 3) {       // cm
            xDpi *= 2.54;
            yDpi *= 2.54;
        } else if (resUnit !== 2) { // ni pulgadas ni cm → no fiable
            return null;
        }
        if (xDpi <= 0 || yDpi <= 0) return null;

        return {
            xDpi: Math.round(xDpi),
            yDpi: Math.round(yDpi),
            source: "JPEG EXIF"
        };
    }

    /**
     * analyzeResolution
     *
     * Acepta opcionalmente:
     *   - pdfMeta:     dimensiones físicas reales del PDF original (en cm)
     *   - embeddedDPI: DPI incrustado leído del archivo (PNG/JPEG)
     *
     * Prioridad para el tamaño físico:
     *   1) pdfMeta (dimensiones exactas del PDF)
     *   2) embeddedDPI (DPI declarado en el archivo)
     *   3) Asunción de 300 DPI (comportamiento por defecto)
     */
    function analyzeResolution(img, options) {
        options = options || {};
        const widthPx = img.naturalWidth;
        const heightPx = img.naturalHeight;

        let cmW, cmH, dpiX, dpiY, dpiSource;

        if (options.pdfMeta) {
            cmW = options.pdfMeta.widthCm;
            cmH = options.pdfMeta.heightCm;
            dpiX = options.pdfMeta.dpi || DPI;
            dpiY = options.pdfMeta.dpi || DPI;
            dpiSource = "PDF";
        } else if (options.embeddedDPI && options.embeddedDPI.xDpi > 0 && options.embeddedDPI.yDpi > 0) {
            dpiX = options.embeddedDPI.xDpi;
            dpiY = options.embeddedDPI.yDpi;
            dpiSource = options.embeddedDPI.source;
            cmW = (widthPx / dpiX) * 2.54;
            cmH = (heightPx / dpiY) * 2.54;
        } else {
            dpiX = DPI;
            dpiY = DPI;
            dpiSource = null; // se asume
            cmW = (widthPx / DPI) * 2.54;
            cmH = (heightPx / DPI) * 2.54;
        }

        const minDim = Math.min(widthPx, heightPx);
        let status, headline, message;

        if (minDim < 600) {
            status = "BAD";
            headline = "Resolución insuficiente";
            message = "La imagen es demasiado pequeña para imprimir en DTF con buena calidad. " +
                      "A 300 DPI no alcanza para una pieza utilizable.";
        } else if (minDim < 1200) {
            status = "WARN";
            headline = "Resolución limitada";
            message = "Funciona sólo para piezas pequeñas (logos, parches). Para diseños grandes la calidad puede ser pobre.";
        } else {
            status = "OK";
            headline = "Resolución adecuada";
            message = "La imagen tiene suficiente resolución para impresión DTF a buen tamaño.";
        }

        // Construir el meta legible
        const dpiText = (dpiX === dpiY) ? `${dpiX} DPI` : `${dpiX}×${dpiY} DPI`;
        let meta;
        if (dpiSource === "PDF") {
            meta = `${formatPx(widthPx)} × ${formatPx(heightPx)} px · tamaño real PDF ${round1(cmW)} × ${round1(cmH)} cm`;
        } else if (dpiSource) {
            meta = `${formatPx(widthPx)} × ${formatPx(heightPx)} px · ≈ ${round1(cmW)} × ${round1(cmH)} cm @ ${dpiText} (incrustado · ${dpiSource})`;
        } else {
            meta = `${formatPx(widthPx)} × ${formatPx(heightPx)} px · ≈ ${round1(cmW)} × ${round1(cmH)} cm @ 300 DPI (asumido — el archivo no declara DPI)`;
        }

        return {
            status,
            headline,
            message,
            widthPx,
            heightPx,
            cmW: round1(cmW),
            cmH: round1(cmH),
            dpiX,
            dpiY,
            dpiSource,
            meta
        };
    }

    /* ------------------------------------------------------------------ *
     * Sección 2 · Formato del archivo                                     *
     * ------------------------------------------------------------------ */

    function detectFormat(file) {
        const name = (file.name || "").toLowerCase();
        const type = (file.type || "").toLowerCase();

        if (type.includes("pdf") || name.endsWith(".pdf")) return "PDF";
        if (type.includes("png") || name.endsWith(".png")) return "PNG";
        if (type.includes("jpeg") || type.includes("jpg") ||
            name.endsWith(".jpg") || name.endsWith(".jpeg")) return "JPEG";
        if (type.includes("webp") || name.endsWith(".webp")) return "WEBP";
        return "DESCONOCIDO";
    }

    function analyzeFormat(file) {
        const format = detectFormat(file);
        let status, headline, message;

        switch (format) {
            case "PDF":
                status = "OK";
                headline = "Formato PDF";
                message = "PDF es un formato apto para DTF: preserva geometría vectorial y transparencia. " +
                          "Se analizó la página rasterizada a 300 DPI.";
                break;
            case "PNG":
                status = "OK";
                headline = "Formato PNG";
                message = "PNG es el formato recomendado para DTF: conserva transparencia y no introduce compresión visible.";
                break;
            case "JPEG":
                status = "WARN";
                headline = "Formato JPG";
                message = "El archivo está en JPG. Para DTF es preferible PNG transparente o PDF, " +
                          "porque JPG no conserva transparencia y utiliza compresión.";
                break;
            case "WEBP":
                status = "WARN";
                headline = "Formato WEBP";
                message = "WEBP soporta transparencia, pero no es el formato estándar para flujos DTF. " +
                          "Recomendamos convertirlo a PNG antes de imprimir.";
                break;
            default:
                status = "BAD";
                headline = "Formato no reconocido";
                message = "No fue posible identificar el formato del archivo.";
        }

        return {
            status,
            headline,
            message,
            format,
            meta: `${format} · ${fileSizeText(file.size || 0)}`
        };
    }

    /* ------------------------------------------------------------------ *
     * Sección 3 y 4 · Transparencia y semitransparencias                  *
     * ------------------------------------------------------------------ */

    function scanAlphaChannel(rgba) {
        const total = rgba.length / 4;
        let transparent = 0;
        let semi = 0;
        let opaque = 0;

        for (let i = 3; i < rgba.length; i += 4) {
            const a = rgba[i];
            if (a === 0) transparent++;
            else if (a === 255) opaque++;
            else semi++;
        }

        return {
            total,
            transparent,
            semi,
            opaque,
            visible: total - transparent
        };
    }

    function buildTransparencyReport(stats, format) {
        const { total, transparent, opaque } = stats;
        const transparentPct = (transparent / total) * 100;
        const hasTransparency = transparent > total * 0.005; // > 0.5% de píxeles transparentes
        const allOpaque = opaque === total;

        let status, headline, message;

        if (allOpaque || !hasTransparency) {
            // En JPG no hay transparencia por diseño; el mensaje cambia ligeramente
            status = "WARN";
            headline = "Sin transparencia";
            if (format === "JPEG") {
                message = "El archivo no contiene transparencia porque JPG no la soporta. " +
                          "Esto significa que la imagen lleva un fondo pegado que aparecerá en la impresión.";
            } else {
                message = "El archivo no contiene transparencia. Puede tener fondo pegado, " +
                          "lo que requerirá recortar el contorno antes de imprimir.";
            }
        } else {
            status = "OK";
            headline = "Transparencia detectada";
            message = `Se detectaron ${round1(transparentPct)}% de píxeles totalmente transparentes. ` +
                      "El archivo trae fondo limpio listo para recortar en DTF.";
        }

        return {
            status,
            headline,
            message,
            transparentPct: round1(transparentPct),
            meta: `Transparentes: ${round1(transparentPct)}% · Opacos: ${round1((opaque / total) * 100)}%`
        };
    }

    function buildSemitransparencyReport(stats) {
        const { semi, visible } = stats;
        // Porcentaje calculado sobre píxeles visibles (alpha > 0)
        const semiPctVisible = visible > 0 ? (semi / visible) * 100 : 0;

        let status, headline, message;

        if (semi === 0) {
            status = "OK";
            headline = "Sin semitransparencias";
            message = "No se detectaron píxeles semitransparentes. " +
                      "El archivo no tendrá halos ni bordes blandos en impresión.";
        } else if (semiPctVisible < 1) {
            status = "OK";
            headline = "Semitransparencias mínimas";
            message = `Sólo ${round2(semiPctVisible)}% de los píxeles visibles son semitransparentes. ` +
                      "Cantidad despreciable, no debería generar problemas.";
        } else if (semiPctVisible < 8) {
            status = "WARN";
            headline = "Semitransparencias presentes";
            message = `Aproximadamente ${round1(semiPctVisible)}% de los píxeles visibles son semitransparentes. ` +
                      "Para DTF pueden generar halos o bordes suaves no deseados.";
        } else {
            status = "BAD";
            headline = "Alta cantidad de semitransparencias";
            message = `Aproximadamente ${round1(semiPctVisible)}% de los píxeles visibles son semitransparentes. ` +
                      "Este nivel suele provocar halos visibles, bordes blandos y problemas durante la impresión DTF.";
        }

        return {
            status,
            headline,
            message,
            semiPct: round2(semiPctVisible),
            semiCount: semi,
            meta: `${formatPx(semi)} píxeles semitransparentes (${round2(semiPctVisible)}% del área visible)`
        };
    }

    /* ------------------------------------------------------------------ *
     * Sección 5 · Elementos menores a 4 px                                *
     * ------------------------------------------------------------------ */

    function buildAlphaMask(rgba, width, height) {
        const total = width * height;
        const mask = new Uint8Array(total);
        for (let i = 0; i < total; i++) {
            // visible si alpha > 16 (ignoramos píxeles casi invisibles)
            if (rgba[i * 4 + 3] > 16) mask[i] = 1;
        }
        return mask;
    }

    /**
     * Connected components (8-connectivity) usando Union-Find.
     * Recibe la máscara binaria.
     * Devuelve array de componentes con {width, height, count, bbox}.
     */
    function connectedComponents(mask, width, height) {
        const total = width * height;
        // Pre-check: si no hay píxeles visibles, devolver vacío
        let hasVisible = false;
        for (let i = 0; i < total; i++) if (mask[i]) { hasVisible = true; break; }
        if (!hasVisible) return [];

        const parent = new Int32Array(total);
        for (let i = 0; i < total; i++) parent[i] = -1; // -1 = no asignado

        function find(x) {
            let root = x;
            while (parent[root] !== root) root = parent[root];
            // path compression
            while (parent[x] !== root) {
                const next = parent[x];
                parent[x] = root;
                x = next;
            }
            return root;
        }

        function union(a, b) {
            const ra = find(a);
            const rb = find(b);
            if (ra !== rb) parent[ra] = rb;
        }

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                if (!mask[idx]) continue;
                if (parent[idx] === -1) parent[idx] = idx;

                // Vecinos ya procesados (8-conn): izq, arriba-izq, arriba, arriba-der
                if (x > 0 && mask[idx - 1]) {
                    if (parent[idx - 1] === -1) parent[idx - 1] = idx - 1;
                    union(idx, idx - 1);
                }
                if (y > 0) {
                    const up = idx - width;
                    if (mask[up]) {
                        if (parent[up] === -1) parent[up] = up;
                        union(idx, up);
                    }
                    if (x > 0 && mask[up - 1]) {
                        if (parent[up - 1] === -1) parent[up - 1] = up - 1;
                        union(idx, up - 1);
                    }
                    if (x < width - 1 && mask[up + 1]) {
                        if (parent[up + 1] === -1) parent[up + 1] = up + 1;
                        union(idx, up + 1);
                    }
                }
            }
        }

        const compMap = new Map();
        for (let i = 0; i < total; i++) {
            if (!mask[i]) continue;
            const root = find(i);
            const x = i % width;
            const y = (i - x) / width;
            let c = compMap.get(root);
            if (!c) {
                c = { minX: x, maxX: x, minY: y, maxY: y, count: 0 };
                compMap.set(root, c);
            }
            if (x < c.minX) c.minX = x;
            if (x > c.maxX) c.maxX = x;
            if (y < c.minY) c.minY = y;
            if (y > c.maxY) c.maxY = y;
            c.count++;
        }

        const components = [];
        compMap.forEach((c) => {
            components.push({
                width: c.maxX - c.minX + 1,
                height: c.maxY - c.minY + 1,
                count: c.count,
                bbox: [c.minX, c.minY, c.maxX, c.maxY]
            });
        });
        return components;
    }

    function analyzeSmallElements(rgba, width, height, opts) {
        opts = opts || {};
        const threshold = opts.threshold || 4;

        // Si la imagen es enorme, hacemos downscale del análisis de CC pero ajustamos umbral.
        const maxDim = Math.max(width, height);
        let scale = 1;
        let workW = width, workH = height;
        let workRgba = rgba;
        if (maxDim > 2500) {
            // Downscale proporcional
            scale = 2500 / maxDim;
            workW = Math.round(width * scale);
            workH = Math.round(height * scale);
            const c1 = document.createElement("canvas");
            c1.width = width; c1.height = height;
            c1.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
            const c2 = document.createElement("canvas");
            c2.width = workW; c2.height = workH;
            const ctx2 = c2.getContext("2d");
            ctx2.drawImage(c1, 0, 0, workW, workH);
            workRgba = ctx2.getImageData(0, 0, workW, workH).data;
        }

        const workThreshold = Math.max(2, Math.round(threshold * scale));

        const mask = buildAlphaMask(workRgba, workW, workH);
        const components = connectedComponents(mask, workW, workH);

        // Detección binaria: hay o no hay elementos diminutos. Sin conteo numérico.
        let hasSmall = false;
        for (const c of components) {
            const diag = Math.sqrt(c.width * c.width + c.height * c.height);
            if (c.width < workThreshold || c.height < workThreshold || diag < workThreshold) {
                hasSmall = true;
                break;
            }
        }

        const status = hasSmall ? "WARN" : "OK";
        const headline = hasSmall
            ? "Posibles elementos diminutos"
            : "Sin elementos diminutos";
        const message = hasSmall
            ? "Antes de continuar, asegúrate de que no haya elementos menores a 4 px. Pueden perderse durante la impresión o el estampado."
            : "No se detectaron elementos menores a 4 px.";

        return {
            status,
            headline,
            message,
            hasSmall
        };
    }

    /* ------------------------------------------------------------------ *
     * Sección 6 · Calidad visual                                          *
     * ------------------------------------------------------------------ */

    /**
     * Convierte RGBA a un buffer de grises Uint8ClampedArray.
     * Si hay alpha, compone sobre fondo blanco para obtener intensidad real visible.
     */
    function rgbaToGray(rgba, width, height) {
        const total = width * height;
        const gray = new Uint8ClampedArray(total);
        for (let i = 0; i < total; i++) {
            const j = i * 4;
            const a = rgba[j + 3] / 255;
            const r = rgba[j] * a + 255 * (1 - a);
            const g = rgba[j + 1] * a + 255 * (1 - a);
            const b = rgba[j + 2] * a + 255 * (1 - a);
            gray[i] = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
        }
        return gray;
    }

    /**
     * Detector de tipo de imagen: foto raster vs ilustración vectorial rasterizada.
     *
     * Estrategia:
     *   - Cuantizamos a 5 bits por canal (32 niveles) y contamos colores únicos
     *     sobre una muestra de píxeles para velocidad.
     *   - Medimos la fracción de bloques 8×8 totalmente uniformes (rellenos planos).
     *
     * Una ilustración vectorial rasterizada típicamente tiene:
     *     - Pocos colores únicos (rellenos planos)
     *     - Alto porcentaje de bloques 8×8 uniformes
     *
     * Devuelve { type: 'vector' | 'photo', confidence, uniqueColors, flatRatio }
     */
    function detectImageType(rgba, width, height) {
        const total = width * height;

        // --- 1. Contar colores únicos cuantizados ---
        // Muestreamos hasta ~50k píxeles para evitar tiempos largos en imágenes grandes.
        const sampleStep = Math.max(1, Math.floor(total / 50000));
        const colorSet = new Set();
        const COLOR_CAP = 5000; // si superamos esto, es una foto sin duda
        for (let i = 0; i < total; i += sampleStep) {
            const j = i * 4;
            if (rgba[j + 3] < 16) continue; // ignorar píxeles transparentes
            const r = rgba[j] >> 3;     // 32 niveles por canal
            const g = rgba[j + 1] >> 3;
            const b = rgba[j + 2] >> 3;
            colorSet.add((r << 10) | (g << 5) | b);
            if (colorSet.size > COLOR_CAP) break;
        }
        const uniqueColors = colorSet.size;

        // --- 2. Fracción de bloques 8×8 uniformes ---
        let flatBlocks = 0;
        let totalBlocks = 0;
        const TOL = 4; // tolerancia por canal (compensa antialiasing leve y dithering suave)
        for (let by = 0; by + 7 < height; by += 8) {
            for (let bx = 0; bx + 7 < width; bx += 8) {
                const baseIdx = (by * width + bx) * 4;
                const r0 = rgba[baseIdx], g0 = rgba[baseIdx + 1], b0 = rgba[baseIdx + 2];
                let uniform = true;
                for (let dy = 0; dy < 8 && uniform; dy++) {
                    for (let dx = 0; dx < 8; dx++) {
                        const idx = ((by + dy) * width + (bx + dx)) * 4;
                        if (rgba[idx + 3] < 16) continue;
                        if (Math.abs(rgba[idx]     - r0) > TOL ||
                            Math.abs(rgba[idx + 1] - g0) > TOL ||
                            Math.abs(rgba[idx + 2] - b0) > TOL) {
                            uniform = false;
                            break;
                        }
                    }
                }
                totalBlocks++;
                if (uniform) flatBlocks++;
            }
        }
        const flatRatio = totalBlocks > 0 ? flatBlocks / totalBlocks : 0;

        // --- 3. Decisión ---
        // Heurísticas conservadoras: en duda, asumimos foto (evita falsos positivos).
        let type = "photo";
        let confidence = "high";

        if (uniqueColors < 64) {
            // Muy pocos colores → es ilustración / logo casi seguro
            type = "vector";
            confidence = "high";
        } else if (uniqueColors < 200 && flatRatio > 0.25) {
            type = "vector";
            confidence = "high";
        } else if (uniqueColors < 400 && flatRatio > 0.4) {
            type = "vector";
            confidence = "medium";
        } else if (flatRatio > 0.55 && uniqueColors < 800) {
            // Imágenes con mucho fondo plano (ej. logo sobre transparencia con detalle moderado)
            type = "vector";
            confidence = "medium";
        }

        return {
            type,
            confidence,
            uniqueColors,
            flatRatio: round2(flatRatio)
        };
    }

    /**
     * 6.2 Detector de desenfoque · Variance of Laplacian.
     * Score 0-100. Valores altos = nítida.
     */
    function analyzeSharpness(gray, width, height) {
        if (width < 4 || height < 4) {
            return { score: null, variance: null, confidence: "low" };
        }
        let sum = 0;
        let sumSq = 0;
        let count = 0;

        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const i = y * width + x;
                // Laplacian: [[0,1,0],[1,-4,1],[0,1,0]]
                const v = gray[i - width] + gray[i - 1] + gray[i + 1] + gray[i + width] - 4 * gray[i];
                sum += v;
                sumSq += v * v;
                count++;
            }
        }
        const mean = sum / count;
        const variance = (sumSq / count) - (mean * mean);

        // Mapeo a 0-100 con escala logarítmica
        // Calibración empírica: var<20 borrosa, var>800 muy nítida.
        const logVar = Math.log10(Math.max(variance, 1));
        const score = Math.round(clamp(((logVar - 1) / 2.4) * 100, 0, 100));

        let status, message;
        if (score >= 70) {
            status = "OK";
            message = "La imagen tiene buena nitidez.";
        } else if (score >= 40) {
            status = "WARN";
            message = "La imagen parece ligeramente borrosa. Revisa si el archivo original es más nítido.";
        } else {
            status = "BAD";
            message = "La imagen está visiblemente borrosa. Imprimirla así dará un resultado de baja calidad.";
        }

        return {
            score,
            variance: Math.round(variance),
            status,
            message,
            confidence: "high"
        };
    }

    /**
     * 6.1 Detector de pixelación.
     * Combinación de:
     *  - uniformidad de bloques 2×2 (en zonas con contenido)
     *  - proporción de bordes "duros" sobre bordes totales
     */
    function analyzePixelation(gray, width, height) {
        if (width < 8 || height < 8) {
            return { score: null, confidence: "low", status: "INFO",
                     message: "La imagen es demasiado pequeña para analizar pixelación de forma confiable." };
        }

        // Métrica 1: uniformidad de bloques 2×2 sólo donde hay algo de variación local
        let uniformBlocks = 0;
        let totalBlocks = 0;
        for (let y = 0; y < height - 1; y += 2) {
            for (let x = 0; x < width - 1; x += 2) {
                const i = y * width + x;
                const p1 = gray[i];
                const p2 = gray[i + 1];
                const p3 = gray[i + width];
                const p4 = gray[i + width + 1];
                // Considerar el bloque sólo si está en una región con cambio (no zonas planas)
                // Aproximamos: mirar también un bloque vecino, si el rango global del bloque
                // y vecinos es > 8 ⇒ región con contenido
                if (x + 3 < width) {
                    const q = gray[i + 2];
                    const localMin = Math.min(p1, p2, p3, p4, q);
                    const localMax = Math.max(p1, p2, p3, p4, q);
                    if (localMax - localMin < 8) continue; // zona plana, no informativa
                }
                totalBlocks++;
                if (p1 === p2 && p2 === p3 && p3 === p4) uniformBlocks++;
            }
        }
        const uniformRatio = totalBlocks > 0 ? uniformBlocks / totalBlocks : 0;

        // Métrica 2: bordes duros vs bordes suaves
        let hardEdges = 0;
        let softEdges = 0;
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const i = y * width + x;
                const dx = gray[i + 1] - gray[i - 1];
                const dy = gray[i + width] - gray[i - width];
                const mag = Math.abs(dx) + Math.abs(dy); // aprox L1
                if (mag > 200) hardEdges++;
                else if (mag > 40) softEdges++;
            }
        }
        const edgeTotal = hardEdges + softEdges;
        const hardRatio = edgeTotal > 0 ? hardEdges / edgeTotal : 0;

        // Combinar
        const pixIndex = uniformRatio * 0.55 + hardRatio * 0.45;
        const score = Math.round(clamp((1 - pixIndex) * 100, 0, 100));

        let status, message;
        if (score >= 75) {
            status = "OK";
            message = "No se detecta pixelación significativa.";
        } else if (score >= 50) {
            status = "WARN";
            message = "Se detecta cierta pixelación o aliasing visible.";
        } else {
            status = "BAD";
            message = "Se detecta pixelación importante: bordes escalonados y bloques visibles.";
        }

        return {
            score,
            uniformRatio: round2(uniformRatio),
            hardRatio: round2(hardRatio),
            status,
            message,
            confidence: edgeTotal > 1000 ? "high" : "low"
        };
    }

    /**
     * 6.3 Calidad visual general (combina nitidez + pixelación).
     */
    function combineVisualQuality(sharpness, pixelation) {
        // Si ambos están skipeados (imagen vectorial), no calculamos calidad visual.
        if (sharpness && sharpness.skipped && pixelation && pixelation.skipped) {
            return {
                skipped: true,
                status: "INFO",
                headline: "No aplica",
                message: "Las métricas de calidad visual no se evalúan en ilustraciones vectoriales."
            };
        }

        const parts = [];
        if (sharpness && !sharpness.skipped && sharpness.score != null) parts.push({ score: sharpness.score, weight: 0.55 });
        if (pixelation && !pixelation.skipped && pixelation.score != null) parts.push({ score: pixelation.score, weight: 0.45 });

        if (parts.length === 0) {
            return { score: null, status: "INFO", headline: "Sin datos suficientes",
                     message: "No se pudo determinar la calidad visual con certeza." };
        }
        const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
        const score = Math.round(parts.reduce((s, p) => s + p.score * p.weight, 0) / totalWeight);

        let status, headline;
        if (score >= 80) { status = "OK";   headline = "Calidad visual excelente"; }
        else if (score >= 60) { status = "WARN"; headline = "Calidad visual aceptable"; }
        else                  { status = "BAD";  headline = "Calidad visual baja"; }

        return {
            score, status, headline,
            message: status === "OK"
                ? "La imagen tiene buena nitidez, sin pixelación ni artefactos relevantes."
                : status === "WARN"
                    ? "La imagen es usable, pero presenta limitaciones que conviene revisar antes de imprimir."
                    : "La imagen tiene problemas visuales claros (borrosa, pixelada o con compresión) que afectarán la impresión."
        };
    }

    /* ------------------------------------------------------------------ *
     * Sección 7 · Calificación general DTF                                *
     * ------------------------------------------------------------------ */

    /**
     * Construye el resumen ejecutivo para el banner principal.
     *
     * Reglas (jerárquicas, gana siempre la capa más severa):
     *
     *   1. Si alguna de las métricas críticas (resolución, formato, transparencia)
     *      sale WARN o BAD → "No apto para imprimirse".
     *
     *   2. Si las críticas están OK pero alguna de las medianamente críticas
     *      (semitransparencias, elementos pequeños) sale WARN o BAD →
     *      "Revisa tu archivo antes de continuar".
     *
     *   3. Si las críticas y medianas están OK, pero las informativas
     *      (pixelación, nitidez) salen WARN o BAD →
     *      "Sí se puede imprimir, pero con ligeras observaciones".
     *
     *   4. Si todo está OK → "Listo para imprimir".
     */
    function isBadOrWarn(s) { return s === "WARN" || s === "BAD"; }

    function buildSummary(reports) {
        // Cada issue es ahora { title, action } con lenguaje para el cliente final.
        const criticalIssues  = []; // capa 1 — impide imprimir
        const reviewIssues    = []; // capa 2 — revisar antes
        const observations    = []; // capa 3 — sólo notas leves

        const res = reports.resolution;

        // ---- Capa 1: críticos (resolución, formato, transparencia) ----
        // 1. Resolución
        if (res.status === "BAD") {
            criticalIssues.push({
                title: "Tu imagen es muy chica",
                action: `Mide ${res.widthPx} × ${res.heightPx} píxeles, que se vería muy borrosa al imprimirla a cualquier tamaño útil. ` +
                        "Pide a tu diseñador el archivo original en mayor tamaño (idealmente arriba de 3500 × 3500 píxeles). " +
                        "Si descargaste la imagen de internet, busca una versión de mejor calidad."
            });
        } else if (res.status === "WARN") {
            let resTitle, resAction;
            if (!res.dpiSource) {
                // El archivo no declara DPI; asumimos 300 DPI (estándar DTF).
                resTitle = "Verifica el DPI de tu archivo";
                resAction =
                    `No detectamos un DPI declarado en el archivo. Asumiendo el estándar de 300 DPI, el diseño se imprimiría ` +
                    `a ${res.cmW} × ${res.cmH} cm. Confirma con tu diseñador que el archivo esté efectivamente a 300 DPI; ` +
                    "si esperabas un tamaño de impresión mayor, lo más probable es que el archivo esté a un DPI inferior y " +
                    "convenga solicitarlo a 300 DPI.";
            } else if (res.dpiX < 300) {
                resTitle = `Tu archivo está a ${res.dpiX} DPI (menor al estándar)`;
                resAction =
                    `Tu archivo declara ${res.dpiX} DPI, por debajo del estándar de 300 DPI para impresión DTF. A ese DPI ` +
                    `se imprime a ${res.cmW} × ${res.cmH} cm. Solicita a tu diseñador la versión a 300 DPI para obtener ` +
                    "calidad de impresión adecuada.";
            } else {
                resTitle = "Tamaño de impresión limitado";
                resAction =
                    `A los ${res.dpiX} DPI declarados, tu archivo se imprime a ${res.cmW} × ${res.cmH} cm. ` +
                    "Si necesitas un tamaño mayor, perderá calidad.";
            }
            criticalIssues.push({ title: resTitle, action: resAction });
        }

        // 2. Formato
        if (reports.format.format === "JPEG") {
            criticalIssues.push({
                title: "Tu archivo está en JPG",
                action: "Los JPG no tienen fondo transparente, así que tu diseño llevará pegado el cuadrado de fondo cuando se imprima. " +
                        "Conviértelo a PNG con fondo transparente: puedes usar Remove.bg, Canva (botón \"Quitar fondo\") o pídele " +
                        "a quien hizo el diseño la versión original en PNG sin fondo."
            });
        } else if (reports.format.format === "WEBP") {
            criticalIssues.push({
                title: "Tu archivo está en WEBP",
                action: "WEBP no es el formato estándar para impresión. Conviértelo a PNG en sitios gratuitos como convertio.co " +
                        "o cloudconvert.com (busca \"WEBP a PNG\")."
            });
        } else if (reports.format.format === "DESCONOCIDO") {
            criticalIssues.push({
                title: "No reconocemos el formato del archivo",
                action: "Asegúrate de subir una imagen PNG, JPG, WEBP o un PDF. Si el archivo viene con otra extensión, " +
                        "ábrelo en cualquier editor y guárdalo como PNG."
            });
        }

        // 3. Transparencia (se omite si ya hay un bloqueo por JPG: es redundante)
        if (reports.transparency.status === "WARN" && reports.format.format !== "JPEG") {
            criticalIssues.push({
                title: "Tu diseño tiene fondo",
                action: "Tu archivo lleva un fondo (blanco u otro color) que se imprimirá junto con el diseño formando un recuadro. " +
                        "Para que solo se imprima la silueta del diseño, quita el fondo antes. Puedes usar Remove.bg (gratis y muy rápido), " +
                        "Canva con su botón \"Quitar fondo\", o Photoshop si lo tienes."
            });
        }

        // ---- Capa 2: medianamente críticos (semitransparencias, elementos pequeños) ----
        // 4. Semitransparencias
        if (reports.semitransparency.status === "BAD") {
            reviewIssues.push({
                title: "Hay muchas zonas semitransparentes",
                action: `Aproximadamente ${reports.semitransparency.semiPct}% de tu diseño tiene transparencia parcial (bordes suaves o sombras). ` +
                        "En DTF, cada píxel semitransparente genera un halo blanco visible alrededor del diseño porque la tinta blanca " +
                        "de base aparece donde el píxel no es 100 % sólido. Pídele a tu diseñador que aplane la transparencia y " +
                        "endurezca los bordes antes de mandar a imprimir."
            });
        } else if (reports.semitransparency.status === "WARN") {
            reviewIssues.push({
                title: "Algunos bordes son semitransparentes",
                action: "Aunque sean pocos, los píxeles semitransparentes generan halos blancos en la impresión DTF: la tinta blanca " +
                        "de base se nota en cualquier zona donde el píxel no sea 100 % opaco. Pídele a tu diseñador que limpie los " +
                        "bordes o aplane la transparencia antes de mandar a imprimir."
            });
        }

        // 5. Elementos < 4 px (mensaje genérico, sin conteo; sólo si hay)
        if (reports.smallElements.hasSmall) {
            reviewIssues.push({
                title: "Hay detalles muy pequeños",
                action: "Tu diseño tiene elementos diminutos (líneas finas, puntos, textos muy chicos) que probablemente " +
                        "no sobrevivan al proceso de impresión y depilado del transfer. Revisa si esos detalles son importantes " +
                        "para ti; si lo son, pídele a tu diseñador que los agrande o engruese antes de mandar a producción."
            });
        }

        // ---- Capa 3: informativos (pixelación, nitidez) ----
        // Se omiten cuando se detecta imagen vectorial (poco fiables ahí).
        // 6. Pixelación
        if (!reports.pixelation.skipped && isBadOrWarn(reports.pixelation.status)) {
            observations.push({
                title: reports.pixelation.status === "BAD"
                    ? "La imagen se ve pixelada"
                    : "Se nota cierta pixelación",
                action: "Esto suele pasar cuando una imagen pequeña se agranda artificialmente. " +
                        "Si tienes el archivo original (en su tamaño nativo o en vector), úsalo en lugar de esta versión."
            });
        }

        // 7. Nitidez
        if (!reports.sharpness.skipped && isBadOrWarn(reports.sharpness.status)) {
            observations.push({
                title: reports.sharpness.status === "BAD"
                    ? "La imagen se ve borrosa"
                    : "La imagen luce ligeramente borrosa",
                action: "Si tienes una versión más nítida del archivo (o el original sin compresión), úsala. " +
                        "La impresión no puede recuperar definición que no tenga la imagen de origen."
            });
        }

        // ---- Resolver estado global por capas ----
        let status, headline, message;

        if (criticalIssues.length > 0) {
            status = "BAD";
            headline = "Tu archivo todavía no está listo";
            message = criticalIssues.length === 1
                ? "Hay algo importante que arreglar antes de mandarlo a imprimir."
                : `Hay ${criticalIssues.length} cosas importantes que arreglar antes de mandarlo a imprimir.`;
        } else if (reviewIssues.length > 0) {
            status = "WARN";
            headline = "Revisa estos puntos antes de imprimir";
            message = reviewIssues.length === 1
                ? "Hay un detalle a revisar antes de mandarlo a producción."
                : `Hay ${reviewIssues.length} detalles a revisar antes de mandarlo a producción.`;
        } else if (observations.length > 0) {
            status = "OBS";
            headline = "Tu archivo se puede imprimir, con notas menores";
            message = "Cumple todo lo necesario para impresión. Solo hay observaciones que puedes considerar.";
        } else {
            status = "OK";
            headline = "Tu archivo está listo para imprimir";
            message = "Cumple con todo lo necesario para impresión DTF.";
        }

        return {
            status, headline, message,
            criticalIssues, reviewIssues, observations
        };
    }

    /* ------------------------------------------------------------------ *
     * Orquestador principal                                               *
     * ------------------------------------------------------------------ */

    function downscaleCanvas(srcCanvas, maxDim) {
        const w = srcCanvas.width, h = srcCanvas.height;
        const m = Math.max(w, h);
        if (m <= maxDim) return { canvas: srcCanvas, scale: 1 };
        const scale = maxDim / m;
        const newW = Math.max(1, Math.round(w * scale));
        const newH = Math.max(1, Math.round(h * scale));
        const dst = document.createElement("canvas");
        dst.width = newW;
        dst.height = newH;
        const ctx = dst.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(srcCanvas, 0, 0, newW, newH);
        return { canvas: dst, scale };
    }

    async function runFullAnalysis(file, img, optionsOrProgress, maybeProgress) {
        // Compatibilidad: si el 3er argumento es función, era el onProgress (firma antigua).
        let options, onProgress;
        if (typeof optionsOrProgress === "function") {
            options = {};
            onProgress = optionsOrProgress;
        } else {
            options = optionsOrProgress || {};
            onProgress = maybeProgress || (() => {});
        }
        const reports = {};

        onProgress(0.04, "Detectando formato del archivo…");
        reports.format = analyzeFormat(file);
        await nextTick();

        onProgress(0.08, "Leyendo metadatos…");
        let embeddedDPI = null;
        if (reports.format.format === "PNG" || reports.format.format === "JPEG") {
            embeddedDPI = await extractEmbeddedDPI(file);
        }
        await nextTick();

        onProgress(0.10, "Midiendo resolución…");
        reports.resolution = analyzeResolution(img, {
            pdfMeta: options.pdfMeta,
            embeddedDPI
        });
        await nextTick();

        onProgress(0.18, "Cargando datos de imagen…");
        const fullCanvas = document.createElement("canvas");
        fullCanvas.width = img.naturalWidth;
        fullCanvas.height = img.naturalHeight;
        const fullCtx = fullCanvas.getContext("2d", { willReadFrequently: true });
        fullCtx.drawImage(img, 0, 0);
        await nextTick();

        const fullData = fullCtx.getImageData(0, 0, fullCanvas.width, fullCanvas.height);
        const rgba = fullData.data;

        onProgress(0.32, "Analizando transparencia…");
        const alphaStats = scanAlphaChannel(rgba);
        reports.transparency = buildTransparencyReport(alphaStats, reports.format.format);
        reports.semitransparency = buildSemitransparencyReport(alphaStats);
        await nextTick();

        onProgress(0.48, "Detectando elementos diminutos (<4 px)…");
        reports.smallElements = analyzeSmallElements(rgba, fullCanvas.width, fullCanvas.height);
        await nextTick();

        onProgress(0.62, "Preparando análisis visual…");
        const { canvas: visualCanvas, scale: visualScale } = downscaleCanvas(fullCanvas, 1600);
        const visualCtx = visualCanvas.getContext("2d", { willReadFrequently: true });
        const visualData = visualScale === 1
            ? fullData
            : visualCtx.getImageData(0, 0, visualCanvas.width, visualCanvas.height);
        await nextTick();

        onProgress(0.70, "Detectando tipo de imagen…");
        reports.imageType = detectImageType(visualData.data, visualData.width, visualData.height);
        await nextTick();

        const isVector = reports.imageType.type === "vector";
        const gray = rgbaToGray(visualData.data, visualData.width, visualData.height);

        onProgress(0.80, isVector ? "Saltando análisis de nitidez (ilustración)…" : "Midiendo nitidez…");
        reports.sharpness = isVector
            ? { skipped: true, status: "INFO",
                message: "No aplica a ilustraciones vectoriales: los rellenos planos y el antialiasing distorsionan la métrica." }
            : analyzeSharpness(gray, visualData.width, visualData.height);
        await nextTick();

        onProgress(0.90, isVector ? "Saltando análisis de pixelación (ilustración)…" : "Detectando pixelación…");
        reports.pixelation = isVector
            ? { skipped: true, status: "INFO",
                message: "No aplica a ilustraciones vectoriales: los bordes nítidos generan falsos positivos." }
            : analyzePixelation(gray, visualData.width, visualData.height);
        await nextTick();

        onProgress(0.98, "Resumiendo resultados…");
        reports.visualQuality = combineVisualQuality(reports.sharpness, reports.pixelation);
        reports.summary = buildSummary(reports);

        onProgress(1.0, "Listo");
        return reports;
    }

    /* ------------------------------------------------------------------ *
     * Exponer API                                                         *
     * ------------------------------------------------------------------ */

    global.DTFAnalyzers = {
        runFullAnalysis,
        fileSizeText,
        formatPx,
        DPI
    };

}(window));
