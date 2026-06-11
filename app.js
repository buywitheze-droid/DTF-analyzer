/* ==========================================================================
   Inspector DTF — app.js
   Controlador de UI: carga de archivo, render del análisis y tarjetas.
   ==========================================================================
*/

(function () {
    "use strict";

    /* ------------------------------------------------------------------ *
     * Referencias al DOM                                                  *
     * ------------------------------------------------------------------ */
    const dropzone        = document.getElementById("dropzone");
    const fileInput       = document.getElementById("fileInput");
    const fileInfoSection = document.getElementById("fileInfoSection");
    const fileInfoList    = document.getElementById("fileInfoList");
    const analyzeBtn      = document.getElementById("analyzeBtn");
    const resetBtn        = document.getElementById("resetBtn");

    const emptyState     = document.getElementById("emptyState");
    const analysisView   = document.getElementById("analysisView");
    const previewImage   = document.getElementById("previewImage");
    const previewLabel   = document.getElementById("previewLabel");
    const previewContainer = document.getElementById("previewContainer");

    const summaryBanner   = document.getElementById("summaryBanner");
    const summaryIcon     = document.getElementById("summaryIcon");
    const summaryHeadline = document.getElementById("summaryHeadline");
    const summaryMessage  = document.getElementById("summaryMessage");
    const summaryList     = document.getElementById("summaryList");

    const analysisLoader = document.getElementById("analysisLoader");
    const loaderProgress = document.getElementById("loaderProgress");
    const loaderText     = document.getElementById("loaderText");

    const resultsGrid    = document.getElementById("resultsGrid");
    const toggleButtons  = document.querySelectorAll(".toggle-btn");

    const detailsToggleWrap = document.getElementById("detailsToggleWrap");
    const toggleDetailsBtn  = document.getElementById("toggleDetailsBtn");
    const toggleLabel       = toggleDetailsBtn.querySelector(".toggle-label");

    const pageSelectorModal = document.getElementById("pageSelectorModal");
    const pageSelectorList  = document.getElementById("pageSelectorList");
    const pageSelectorSub   = document.getElementById("pageSelectorSub");

    const processingOverlay = document.getElementById("processingOverlay");
    const processingOverlayText = document.getElementById("processingOverlayText");

    /* ------------------------------------------------------------------ *
     * Estado                                                              *
     * ------------------------------------------------------------------ */
    let currentFile = null;
    let currentImage = null;
    let currentObjectUrl = null;
    let currentPdfMeta = null; // { totalPages, currentPage, widthCm, heightCm, dpi }

    const PDF_TARGET_DPI = 300;

    /* ------------------------------------------------------------------ *
     * Drag & drop + selección                                             *
     * ------------------------------------------------------------------ */
    dropzone.addEventListener("click", () => fileInput.click());

    dropzone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropzone.classList.add("dragging");
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragging"));
    dropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropzone.classList.remove("dragging");
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            handleFile(e.dataTransfer.files[0]);
        }
    });

    fileInput.addEventListener("change", (e) => {
        if (e.target.files && e.target.files[0]) {
            handleFile(e.target.files[0]);
        }
    });

    analyzeBtn.addEventListener("click", startAnalysis);
    resetBtn.addEventListener("click", resetAll);

    toggleButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
            toggleButtons.forEach((b) => b.classList.remove("active"));
            btn.classList.add("active");
            const bg = btn.dataset.bg;
            previewContainer.classList.remove("preview-checker", "preview-white", "preview-black");
            previewContainer.classList.add("preview-" + bg);
        });
    });

    // Cerrar modal
    pageSelectorModal.addEventListener("click", (e) => {
        if (e.target.dataset.close !== undefined) {
            pageSelectorModal.hidden = true;
        }
    });

    // Toggle del análisis técnico
    toggleDetailsBtn.addEventListener("click", () => {
        const isHidden = resultsGrid.hidden;
        resultsGrid.hidden = !isHidden;
        toggleDetailsBtn.classList.toggle("is-open", isHidden);
        toggleLabel.textContent = isHidden
            ? "Ocultar análisis técnico detallado"
            : "Ver análisis técnico detallado";
    });

    /* ------------------------------------------------------------------ *
     * Carga de archivo                                                    *
     * ------------------------------------------------------------------ */
    function handleFile(file) {
        if (!isValidFile(file)) {
            alert("Formato no soportado. Sube un archivo PNG, JPG, JPEG, WEBP o PDF.");
            return;
        }

        if (isPdfFile(file)) {
            handlePdfFile(file);
        } else {
            handleImageFile(file);
        }
    }

    function isValidFile(file) {
        const name = (file.name || "").toLowerCase();
        const type = (file.type || "").toLowerCase();
        return (
            type.includes("png") || type.includes("jpeg") ||
            type.includes("jpg") || type.includes("webp") ||
            type.includes("pdf") ||
            name.endsWith(".png") || name.endsWith(".jpg") ||
            name.endsWith(".jpeg") || name.endsWith(".webp") ||
            name.endsWith(".pdf")
        );
    }

    function isPdfFile(file) {
        const name = (file.name || "").toLowerCase();
        const type = (file.type || "").toLowerCase();
        return type.includes("pdf") || name.endsWith(".pdf");
    }

    function handleImageFile(file) {
        if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
        currentFile = file;
        currentPdfMeta = null;
        currentObjectUrl = URL.createObjectURL(file);

        const img = new Image();
        img.onload = () => {
            currentImage = img;
            previewImage.src = currentObjectUrl;
            previewLabel.textContent = file.name;

            renderFileInfo(file, img);

            emptyState.hidden = true;
            analysisView.hidden = false;
            summaryBanner.hidden = true;
            detailsToggleWrap.hidden = true;
            resultsGrid.hidden = true;
            resultsGrid.innerHTML = "";
            analyzeBtn.disabled = false;
            resetBtn.hidden = false;
        };
        img.onerror = () => {
            alert("No se pudo cargar la imagen. Verifica que el archivo no esté dañado.");
        };
        img.src = currentObjectUrl;
    }

    /* ------------------------------------------------------------------ *
     * Soporte PDF                                                         *
     * ------------------------------------------------------------------ */

    async function handlePdfFile(file) {
        if (typeof window.pdfjsLib === "undefined") {
            alert(
                "PDF.js no está disponible. Necesitas conexión a internet la primera vez " +
                "para cargar la librería (~1 MB) o descargarla a la carpeta del proyecto."
            );
            return;
        }

        showOverlay("Cargando PDF…");
        try {
            const arrayBuffer = await file.arrayBuffer();
            const pdfDoc = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
            hideOverlay();

            if (pdfDoc.numPages === 1) {
                await renderAndLoadPdfPage(file, pdfDoc, 1);
            } else {
                await showPageSelector(file, pdfDoc);
            }
        } catch (err) {
            hideOverlay();
            console.error(err);
            alert("Error al cargar el PDF: " + err.message);
        }
    }

    async function showPageSelector(file, pdfDoc) {
        pageSelectorSub.textContent =
            `Este PDF tiene ${pdfDoc.numPages} páginas. Elige cuál quieres analizar (se rasterizará a 300 DPI).`;
        pageSelectorList.innerHTML = "";
        pageSelectorModal.hidden = false;

        showOverlay("Generando vistas previas…");
        try {
            for (let i = 1; i <= pdfDoc.numPages; i++) {
                const page = await pdfDoc.getPage(i);
                const viewport = page.getViewport({ scale: 0.35 });
                const tCanvas = document.createElement("canvas");
                tCanvas.width = Math.round(viewport.width);
                tCanvas.height = Math.round(viewport.height);
                const tCtx = tCanvas.getContext("2d");
                tCtx.fillStyle = "#ffffff";
                tCtx.fillRect(0, 0, tCanvas.width, tCanvas.height);
                await page.render({ canvasContext: tCtx, viewport }).promise;

                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = "page-item";
                btn.appendChild(tCanvas);
                const label = document.createElement("span");
                label.className = "page-label";
                label.textContent = "Página " + i;
                btn.appendChild(label);
                btn.addEventListener("click", () => {
                    pageSelectorModal.hidden = true;
                    renderAndLoadPdfPage(file, pdfDoc, i);
                });
                pageSelectorList.appendChild(btn);
            }
        } finally {
            hideOverlay();
        }
    }

    async function renderAndLoadPdfPage(file, pdfDoc, pageNum) {
        showOverlay(`Rasterizando página ${pageNum} a ${PDF_TARGET_DPI} DPI…`);
        try {
            const page = await pdfDoc.getPage(pageNum);
            const scale = PDF_TARGET_DPI / 72; // PDF base = 72 DPI
            const viewport = page.getViewport({ scale });

            const canvas = document.createElement("canvas");
            canvas.width = Math.round(viewport.width);
            canvas.height = Math.round(viewport.height);
            const ctx = canvas.getContext("2d");
            // No rellenamos el fondo: queremos preservar la transparencia del PDF si existe.
            await page.render({
                canvasContext: ctx,
                viewport,
                background: "rgba(0,0,0,0)"
            }).promise;

            // Dimensiones físicas reales del PDF (en cm)
            const widthPts = viewport.width / scale;   // puntos PDF
            const heightPts = viewport.height / scale;
            const widthCm = (widthPts / 72) * 2.54;
            const heightCm = (heightPts / 72) * 2.54;

            currentPdfMeta = {
                totalPages: pdfDoc.numPages,
                currentPage: pageNum,
                widthCm: Math.round(widthCm * 10) / 10,
                heightCm: Math.round(heightCm * 10) / 10,
                dpi: PDF_TARGET_DPI
            };

            // Convertir el canvas a un Blob/ObjectURL para el flujo normal
            const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
            if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
            currentObjectUrl = URL.createObjectURL(blob);
            currentFile = file; // conservamos el original (nombre, tipo PDF)

            const img = new Image();
            img.onload = () => {
                currentImage = img;
                previewImage.src = currentObjectUrl;
                previewLabel.textContent =
                    file.name +
                    (pdfDoc.numPages > 1 ? ` — Página ${pageNum}/${pdfDoc.numPages}` : "");

                renderFileInfo(file, img);
                renderFileInfoPdfRow();

                emptyState.hidden = true;
                analysisView.hidden = false;
                summaryBanner.hidden = true;
                resultsGrid.hidden = true;
                resultsGrid.innerHTML = "";
                analyzeBtn.disabled = false;
                resetBtn.hidden = false;
                hideOverlay();
            };
            img.onerror = () => {
                hideOverlay();
                alert("No se pudo cargar la imagen rasterizada del PDF.");
            };
            img.src = currentObjectUrl;
        } catch (err) {
            hideOverlay();
            console.error(err);
            alert("Error al rasterizar el PDF: " + err.message);
        }
    }

    function renderFileInfoPdfRow() {
        if (!currentPdfMeta) return;
        const html =
            `<li data-key="pdf-page"><span class="label">Página PDF</span>` +
            `<span class="value">${currentPdfMeta.currentPage} de ${currentPdfMeta.totalPages}</span></li>` +
            `<li data-key="pdf-size"><span class="label">Tamaño real del PDF</span>` +
            `<span class="value">${currentPdfMeta.widthCm} × ${currentPdfMeta.heightCm} cm</span></li>` +
            `<li data-key="pdf-dpi"><span class="label">Rasterizado a</span>` +
            `<span class="value">${currentPdfMeta.dpi} DPI</span></li>`;
        fileInfoList.insertAdjacentHTML("beforeend", html);
    }

    function showOverlay(text) {
        processingOverlayText.textContent = text || "Procesando…";
        processingOverlay.hidden = false;
    }
    function hideOverlay() {
        processingOverlay.hidden = true;
    }

    function renderFileInfo(file, img) {
        const items = [
            { label: "Nombre", value: file.name },
            { label: "Tamaño", value: DTFAnalyzers.fileSizeText(file.size) },
            { label: "Dimensiones", value: `${DTFAnalyzers.formatPx(img.naturalWidth)} × ${DTFAnalyzers.formatPx(img.naturalHeight)} px` },
            { label: "Megapíxeles", value: ((img.naturalWidth * img.naturalHeight) / 1e6).toFixed(2) + " MP" }
        ];
        fileInfoList.innerHTML = items
            .map((it) => `<li><span class="label">${escapeHtml(it.label)}</span><span class="value">${escapeHtml(it.value)}</span></li>`)
            .join("");
        fileInfoSection.hidden = false;
    }

    function updateFileInfoWithType(imageType) {
        if (!imageType) return;
        const label = imageType.type === "vector"
            ? "Ilustración / Vector"
            : "Fotografía / Raster";
        const li = `<li><span class="label">Tipo detectado</span><span class="value">${escapeHtml(label)}</span></li>`;
        // Reemplaza si ya existe, si no, agrega
        const existing = fileInfoList.querySelector('[data-key="image-type"]');
        const html = `<li data-key="image-type"><span class="label">Tipo detectado</span><span class="value">${escapeHtml(label)}</span></li>`;
        if (existing) {
            existing.outerHTML = html;
        } else {
            fileInfoList.insertAdjacentHTML("beforeend", html);
        }
    }

    function resetAll() {
        if (currentObjectUrl) {
            URL.revokeObjectURL(currentObjectUrl);
            currentObjectUrl = null;
        }
        currentFile = null;
        currentImage = null;
        currentPdfMeta = null;
        fileInput.value = "";
        analyzeBtn.disabled = true;
        resetBtn.hidden = true;
        fileInfoSection.hidden = true;
        analysisView.hidden = true;
        emptyState.hidden = false;
        summaryBanner.hidden = true;
        detailsToggleWrap.hidden = true;
        resultsGrid.innerHTML = "";
        resultsGrid.hidden = true;
        analysisLoader.hidden = true;
    }

    /* ------------------------------------------------------------------ *
     * Lanzar análisis                                                     *
     * ------------------------------------------------------------------ */
    async function startAnalysis() {
        if (!currentFile || !currentImage) return;
        analyzeBtn.disabled = true;
        summaryBanner.hidden = true;
        detailsToggleWrap.hidden = true;
        resultsGrid.hidden = true;
        analysisLoader.hidden = false;
        updateProgress(0, "Iniciando análisis…");

        try {
            const reports = await DTFAnalyzers.runFullAnalysis(
                currentFile,
                currentImage,
                { pdfMeta: currentPdfMeta },
                updateProgress
            );
            renderResults(reports);
        } catch (err) {
            console.error(err);
            alert("Ocurrió un error durante el análisis: " + err.message);
        } finally {
            analysisLoader.hidden = true;
            analyzeBtn.disabled = false;
        }
    }

    function updateProgress(p, msg) {
        loaderProgress.style.width = (p * 100).toFixed(0) + "%";
        loaderText.textContent = msg || "";
    }

    /* ------------------------------------------------------------------ *
     * Render de resultados                                                *
     * ------------------------------------------------------------------ */
    function renderResults(r) {
        renderSummaryBanner(r.summary);
        updateFileInfoWithType(r.imageType);

        // Por defecto el análisis técnico está oculto; mostramos el toggle.
        resultsGrid.hidden = true;
        detailsToggleWrap.hidden = false;
        toggleDetailsBtn.classList.remove("is-open");
        toggleLabel.textContent = "Ver análisis técnico detallado";

        const cards = [];

        // 1 Resolución
        let resolutionExtras;
        if (r.resolution.dpiSource === "PDF") {
            resolutionExtras = `<div class="card-meta">
                <b>${DTFAnalyzers.formatPx(r.resolution.widthPx)} × ${DTFAnalyzers.formatPx(r.resolution.heightPx)} px</b>
                · tamaño real del PDF: ${r.resolution.cmW} × ${r.resolution.cmH} cm
            </div>`;
        } else if (r.resolution.dpiSource) {
            const dpiText = (r.resolution.dpiX === r.resolution.dpiY)
                ? `${r.resolution.dpiX} DPI`
                : `${r.resolution.dpiX}×${r.resolution.dpiY} DPI`;
            resolutionExtras = `<div class="card-meta">
                <b>${DTFAnalyzers.formatPx(r.resolution.widthPx)} × ${DTFAnalyzers.formatPx(r.resolution.heightPx)} px</b>
                · ≈ ${r.resolution.cmW} × ${r.resolution.cmH} cm @ ${dpiText} <em>(DPI incrustado · ${escapeHtml(r.resolution.dpiSource)})</em>
            </div>`;
        } else {
            resolutionExtras = `<div class="card-meta">
                <b>${DTFAnalyzers.formatPx(r.resolution.widthPx)} × ${DTFAnalyzers.formatPx(r.resolution.heightPx)} px</b>
                · ≈ ${r.resolution.cmW} × ${r.resolution.cmH} cm a 300 DPI <em>(asumido, el archivo no declara DPI)</em>
            </div>`;
        }
        cards.push(makeCard({
            title: "Resolución real",
            status: r.resolution.status,
            headline: r.resolution.headline,
            body: r.resolution.message,
            extras: resolutionExtras
        }));

        // 2 Formato
        cards.push(makeCard({
            title: "Formato del archivo",
            status: r.format.status,
            headline: r.format.headline,
            body: r.format.message,
            extras: `<div class="card-meta">${escapeHtml(r.format.meta)}</div>`
        }));

        // 3 Transparencia
        cards.push(makeCard({
            title: "Transparencia",
            status: r.transparency.status,
            headline: r.transparency.headline,
            body: r.transparency.message,
            extras: `<div class="card-meta">${escapeHtml(r.transparency.meta)}</div>`
        }));

        // 4 Semitransparencias
        cards.push(makeCard({
            title: "Semitransparencias",
            status: r.semitransparency.status,
            headline: r.semitransparency.headline,
            body: r.semitransparency.message,
            extras: `<div class="card-meta">${escapeHtml(r.semitransparency.meta)}</div>`
        }));

        // 5 Elementos < 4 px (sin meta numérico, solo observación)
        cards.push(makeCard({
            title: "Elementos menores a 4 px",
            status: r.smallElements.status,
            headline: r.smallElements.headline,
            body: r.smallElements.message
        }));

        // 6.1 Pixelación · informativo
        cards.push(makeQualityCard({
            title: "Pixelación",
            score: r.pixelation.score,
            status: r.pixelation.status,
            message: r.pixelation.message,
            confidence: r.pixelation.confidence,
            skipped: r.pixelation.skipped,
            okLabel: "Sin pixelación",
            informative: true
        }));

        // 6.2 Nitidez · informativo
        cards.push(makeQualityCard({
            title: "Nitidez",
            score: r.sharpness.score,
            status: r.sharpness.status,
            message: r.sharpness.message,
            confidence: r.sharpness.confidence,
            skipped: r.sharpness.skipped,
            okLabel: "Nítida",
            informative: true
        }));

        // 6.3 Calidad visual general · informativo
        cards.push(makeQualityCard({
            title: "Calidad visual general",
            score: r.visualQuality.score,
            status: r.visualQuality.status,
            headline: r.visualQuality.headline,
            message: r.visualQuality.message,
            skipped: r.visualQuality.skipped,
            wide: true,
            okLabel: "Excelente",
            informative: true
        }));

        resultsGrid.innerHTML = cards.join("");
        resultsGrid.hidden = false;
    }

    /* ------------------------------------------------------------------ *
     * Summary banner — qué hay y qué hacer                                *
     * ------------------------------------------------------------------ */
    function renderSummaryBanner(summary) {
        summaryBanner.hidden = false;
        summaryBanner.classList.remove("is-ok", "is-warn", "is-bad", "is-obs");

        let cls = "is-ok", icon = "✓";
        if (summary.status === "BAD")      { cls = "is-bad";  icon = "✕"; }
        else if (summary.status === "WARN") { cls = "is-warn"; icon = "⚠"; }
        else if (summary.status === "OBS")  { cls = "is-obs";  icon = "ⓘ"; }

        summaryBanner.classList.add(cls);
        summaryIcon.textContent = icon;
        summaryHeadline.textContent = summary.headline;
        summaryMessage.textContent = summary.message;

        const items = [];
        (summary.criticalIssues || []).forEach((issue) => {
            items.push(renderIssueItem(issue, "bad", "Importante"));
        });
        (summary.reviewIssues || []).forEach((issue) => {
            items.push(renderIssueItem(issue, "warn", "Revisar"));
        });
        (summary.observations || []).forEach((issue) => {
            items.push(renderIssueItem(issue, "obs", "Nota"));
        });

        if (items.length > 0) {
            summaryList.innerHTML = items.join("");
            summaryList.hidden = false;
        } else {
            summaryList.innerHTML = "";
            summaryList.hidden = true;
        }
    }

    function renderIssueItem(issue, pillCls, pillLabel) {
        // Compatibilidad: aceptar tanto strings (legacy) como objetos { title, action }
        const title  = (issue && typeof issue === "object") ? issue.title  : issue;
        const action = (issue && typeof issue === "object") ? issue.action : "";
        return `
            <li>
                <span class="pill ${pillCls}">${escapeHtml(pillLabel)}</span>
                <div class="issue-content">
                    <p class="issue-title">${escapeHtml(title || "")}</p>
                    ${action ? `<p class="issue-action">${escapeHtml(action)}</p>` : ""}
                </div>
            </li>
        `;
    }


    /* ------------------------------------------------------------------ *
     * Constructores de tarjetas                                           *
     * ------------------------------------------------------------------ */
    function statusTag(status) {
        const map = {
            OK:   { cls: "ok",   icon: "✓", label: "OK" },
            WARN: { cls: "warn", icon: "⚠", label: "WARN" },
            BAD:  { cls: "bad",  icon: "✕", label: "BAD" },
            INFO: { cls: "info", icon: "ⓘ", label: "INFO" }
        };
        const m = map[status] || { cls: "unknown", icon: "?", label: "—" };
        return `<span class="status-tag ${m.cls}"><span>${m.icon}</span><span>${m.label}</span></span>`;
    }

    function makeCard(o) {
        const wideClass = o.wide ? " is-wide" : "";
        return `
            <div class="card${wideClass}">
                <div class="card-header">
                    <span class="card-title">${escapeHtml(o.title)}</span>
                    ${statusTag(o.status)}
                </div>
                <h3 class="card-headline">${escapeHtml(o.headline || "")}</h3>
                <p class="card-body">${escapeHtml(o.body || "")}</p>
                ${o.extras || ""}
            </div>
        `;
    }

    function makeQualityCard(o) {
        const wideClass = o.wide ? " is-wide" : "";
        const score = o.score;
        const confidence = o.confidence || "high";
        const hasScore = !o.skipped && score != null && confidence !== "low";
        const infoNote = o.informative
            ? `<p class="card-note">Métrica informativa: no afecta la calificación general.</p>`
            : "";

        // Si fue skipeada (p. ej. imagen vectorial), se marca simplemente como OK.
        if (o.skipped) {
            return `
                <div class="card${wideClass}">
                    <div class="card-header">
                        <span class="card-title">${escapeHtml(o.title)}</span>
                        ${statusTag("OK")}
                    </div>
                    <h3 class="card-headline">Todo en orden</h3>
                </div>
            `;
        }

        // Si la confianza es baja, mostramos el mensaje explícito
        if (!hasScore) {
            return `
                <div class="card${wideClass}">
                    <div class="card-header">
                        <span class="card-title">${escapeHtml(o.title)}</span>
                        ${statusTag("INFO")}
                    </div>
                    <h3 class="card-headline">No se pudo determinar con certeza</h3>
                    <p class="card-body">${escapeHtml(o.message || "Información insuficiente para este análisis.")}</p>
                    ${infoNote}
                </div>
            `;
        }

        let barClass = "bar-bad";
        if (score >= 75) barClass = "bar-ok";
        else if (score >= 50) barClass = "bar-warn";

        const headline = o.headline ||
                         (score >= 80 ? o.okLabel || "Excelente" :
                          score >= 60 ? "Aceptable" :
                          score >= 40 ? "Bajo" : "Muy bajo");

        return `
            <div class="card${wideClass}">
                <div class="card-header">
                    <span class="card-title">${escapeHtml(o.title)}</span>
                    ${statusTag(o.status)}
                </div>
                <h3 class="card-headline">${escapeHtml(headline)}</h3>
                <div class="score-row">
                    <span>Score</span>
                    <b>${score}/100</b>
                </div>
                <div class="score-bar"><div class="${barClass}" style="width:${score}%"></div></div>
                <p class="card-body">${escapeHtml(o.message || "")}</p>
                ${infoNote}
            </div>
        `;
    }

    /* ------------------------------------------------------------------ *
     * Helpers                                                             *
     * ------------------------------------------------------------------ */
    function escapeHtml(str) {
        if (str == null) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

}());
