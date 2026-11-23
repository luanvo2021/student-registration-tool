/**
 * export.js – High-Fidelity DOCX Exporter
 * 
 * Directly fills data into the EXACT original template (template.docx) using JSZip.
 * Reuses the template formatting, margins, column widths, borders, and header logos.
 */

(function () {
    'use strict';

    const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
    const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    const PIC_NS = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
    const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
    const IMAGE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
    const FONT_NAME = 'Times New Roman';
    const HEADER_FORMAT = { size: 26, bold: true, italic: false };
    const STUDENT_FORMAT = { size: 24, bold: false, italic: false };
    const EMU_PER_INCH = 914400;

    /**
     * Parse date range string into individual column headers
     */
    function parseDateColumns(dateStr) {
        if (!dateStr || !dateStr.trim()) return [];

        const s = dateStr.trim();

        // Pattern: "DD-DD/MM/YYYY" (e.g. 11-13/11/2026)
        const sameMonth = s.match(/^(\d{1,2})\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (sameMonth) {
            const startDay = parseInt(sameMonth[1], 10);
            const endDay = parseInt(sameMonth[2], 10);
            const month = parseInt(sameMonth[3], 10);
            const cols = [];
            for (let d = startDay; d <= endDay; d++) {
                cols.push(`${String(d).padStart(2, '0')}/${String(month).padStart(2, '0')}`);
            }
            return cols;
        }

        // Pattern: "DD/MM-DD/MM/YYYY" (e.g. 28/10-01/11/2026)
        const crossMonth = s.match(/^(\d{1,2})\/(\d{1,2})\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (crossMonth) {
            const startDay = parseInt(crossMonth[1], 10);
            const startMonth = parseInt(crossMonth[2], 10);
            const endDay = parseInt(crossMonth[3], 10);
            const endMonth = parseInt(crossMonth[4], 10);
            const year = parseInt(crossMonth[5], 10);
            const cols = [];
            const start = new Date(year, startMonth - 1, startDay);
            const end = new Date(year, endMonth - 1, endDay);
            const cur = new Date(start);
            while (cur <= end) {
                const dd = String(cur.getDate()).padStart(2, '0');
                const mm = String(cur.getMonth() + 1).padStart(2, '0');
                cols.push(`${dd}/${mm}`);
                cur.setDate(cur.getDate() + 1);
            }
            return cols;
        }

        // Single date "DD/MM/YYYY"
        const single = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (single) {
            const dd = String(parseInt(single[1], 10)).padStart(2, '0');
            const mm = String(parseInt(single[2], 10)).padStart(2, '0');
            return [`${dd}/${mm}`];
        }

        return [];
    }

    function getOrCreateDirectChild(parent, localName, namespace = W_NS, qualifiedName = `w:${localName}`) {
        let child = getDirectChildren(parent, localName)[0];
        if (!child) {
            child = parent.ownerDocument.createElementNS(namespace, qualifiedName);
            parent.insertBefore(child, parent.firstChild);
        }
        return child;
    }

    function setRunFormatting(run, format) {
        if (!run || !format) return;

        const rPr = run.localName === 'rPr' ? run : getOrCreateDirectChild(run, 'rPr');
        const fonts = getOrCreateDirectChild(rPr, 'rFonts');
        ['ascii', 'hAnsi', 'cs', 'eastAsia'].forEach(name => {
            fonts.setAttributeNS(W_NS, `w:${name}`, FONT_NAME);
        });

        const size = getOrCreateDirectChild(rPr, 'sz');
        size.setAttributeNS(W_NS, 'w:val', String(format.size));
        const sizeCs = getOrCreateDirectChild(rPr, 'szCs');
        sizeCs.setAttributeNS(W_NS, 'w:val', String(format.size));

        ['b', 'bCs'].forEach(name => {
            const existing = getDirectChildren(rPr, name);
            if (format.bold) {
                getOrCreateDirectChild(rPr, name).setAttributeNS(W_NS, 'w:val', '1');
            } else {
                existing.forEach(node => node.remove());
            }
        });

        ['i', 'iCs'].forEach(name => {
            const existing = getDirectChildren(rPr, name);
            if (format.italic) {
                getOrCreateDirectChild(rPr, name).setAttributeNS(W_NS, 'w:val', '1');
            } else {
                existing.forEach(node => node.remove());
            }
        });
    }

    function setParagraphFormatting(cell, format) {
        const paragraph = getDirectChildren(cell, 'p')[0];
        if (!paragraph) return;
        const pPr = getOrCreateDirectChild(paragraph, 'pPr');
        const rPr = getOrCreateDirectChild(pPr, 'rPr');
        setRunFormatting(rPr, format);
    }

    function setCellText(cell, newText, firstValueIndex = 0, format = null) {
        const textNodes = Array.from(cell.getElementsByTagNameNS(W_NS, 't'));
        const valueNodes = textNodes.slice(firstValueIndex);
        if (valueNodes.length) {
            valueNodes[0].textContent = newText;
            if (format) setRunFormatting(valueNodes[0].parentNode, format);
            if (newText !== newText.trim()) {
                valueNodes[0].setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
            }
            valueNodes.slice(1).forEach(node => { node.textContent = ''; });
        } else if (newText) {
            const paragraph = getDirectChildren(cell, 'p')[0];
            const properties = getDirectChildren(paragraph, 'pPr')[0];
            const runProperties = properties && getDirectChildren(properties, 'rPr')[0];
            const xmlDoc = cell.ownerDocument;
            const run = xmlDoc.createElementNS(W_NS, 'w:r');
            if (runProperties) run.appendChild(runProperties.cloneNode(true));
            if (format) setRunFormatting(run, format);

            const text = xmlDoc.createElementNS(W_NS, 'w:t');
            text.textContent = newText;
            run.appendChild(text);
            paragraph.appendChild(run);
        }
    }

    function createElement(xmlDoc, namespace, qualifiedName, attributes = {}) {
        const element = xmlDoc.createElementNS(namespace, qualifiedName);
        Object.entries(attributes).forEach(([name, value]) => {
            if (name.startsWith('r:')) {
                element.setAttributeNS(R_NS, name, String(value));
            } else if (name.startsWith('w:')) {
                element.setAttributeNS(W_NS, name, String(value));
            } else {
                element.setAttribute(name, String(value));
            }
        });
        return element;
    }

    function appendElement(parent, namespace, qualifiedName, attributes = {}) {
        const child = createElement(parent.ownerDocument, namespace, qualifiedName, attributes);
        parent.appendChild(child);
        return child;
    }

    function createPageBreakParagraph(xmlDoc) {
        const paragraph = createElement(xmlDoc, W_NS, 'w:p');
        const run = appendElement(paragraph, W_NS, 'w:r');
        appendElement(run, W_NS, 'w:br', { 'w:type': 'page' });
        return paragraph;
    }

    function createSectionBreakParagraph(xmlDoc, sectionProperties) {
        const paragraph = createElement(xmlDoc, W_NS, 'w:p');
        const pPr = appendElement(paragraph, W_NS, 'w:pPr');
        const clonedSection = sectionProperties.cloneNode(true);
        const existingType = getDirectChildren(clonedSection, 'type')[0];
        if (existingType) existingType.remove();
        const sectionType = createElement(xmlDoc, W_NS, 'w:type', { 'w:val': 'nextPage' });
        clonedSection.insertBefore(sectionType, clonedSection.firstChild);
        pPr.appendChild(clonedSection);
        return paragraph;
    }

    function createImageParagraph(xmlDoc, relationshipId, imageNumber, widthEmu, heightEmu, spacingAfter) {
        const paragraph = createElement(xmlDoc, W_NS, 'w:p');
        const pPr = appendElement(paragraph, W_NS, 'w:pPr');
        appendElement(pPr, W_NS, 'w:jc', { 'w:val': 'center' });
        appendElement(pPr, W_NS, 'w:spacing', { 'w:after': spacingAfter });

        const run = appendElement(paragraph, W_NS, 'w:r');
        const drawing = appendElement(run, W_NS, 'w:drawing');
        const inline = appendElement(drawing, WP_NS, 'wp:inline', {
            distT: '0',
            distB: '0',
            distL: '0',
            distR: '0'
        });
        appendElement(inline, WP_NS, 'wp:extent', { cx: widthEmu, cy: heightEmu });
        appendElement(inline, WP_NS, 'wp:effectExtent', { l: '0', t: '0', r: '0', b: '0' });
        appendElement(inline, WP_NS, 'wp:docPr', {
            id: String(imageNumber),
            name: `CCCD ${imageNumber}`,
            descr: `Ảnh CCCD ${imageNumber}`
        });
        const frameProperties = appendElement(inline, WP_NS, 'wp:cNvGraphicFramePr');
        appendElement(frameProperties, A_NS, 'a:graphicFrameLocks', { noChangeAspect: '1' });

        const graphic = appendElement(inline, A_NS, 'a:graphic');
        const graphicData = appendElement(graphic, A_NS, 'a:graphicData', {
            uri: 'http://schemas.openxmlformats.org/drawingml/2006/picture'
        });
        const picture = appendElement(graphicData, PIC_NS, 'pic:pic');
        const nonVisual = appendElement(picture, PIC_NS, 'pic:nvPicPr');
        appendElement(nonVisual, PIC_NS, 'pic:cNvPr', {
            id: '0',
            name: `cccd_${imageNumber}.jpg`
        });
        appendElement(nonVisual, PIC_NS, 'pic:cNvPicPr');

        const blipFill = appendElement(picture, PIC_NS, 'pic:blipFill');
        appendElement(blipFill, A_NS, 'a:blip', { 'r:embed': relationshipId });
        const stretch = appendElement(blipFill, A_NS, 'a:stretch');
        appendElement(stretch, A_NS, 'a:fillRect');

        const shapeProperties = appendElement(picture, PIC_NS, 'pic:spPr');
        const transform = appendElement(shapeProperties, A_NS, 'a:xfrm');
        appendElement(transform, A_NS, 'a:off', { x: '0', y: '0' });
        appendElement(transform, A_NS, 'a:ext', { cx: widthEmu, cy: heightEmu });
        const geometry = appendElement(shapeProperties, A_NS, 'a:prstGeom', { prst: 'rect' });
        appendElement(geometry, A_NS, 'a:avLst');
        return paragraph;
    }

    async function normalizeImage(file) {
        const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
        try {
            const maxWidth = 2000;
            const maxHeight = 1400;
            const scale = Math.min(1, maxWidth / bitmap.width, maxHeight / bitmap.height);
            const width = Math.max(1, Math.round(bitmap.width * scale));
            const height = Math.max(1, Math.round(bitmap.height * scale));
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext('2d');
            context.fillStyle = '#FFFFFF';
            context.fillRect(0, 0, width, height);
            context.drawImage(bitmap, 0, 0, width, height);
            const blob = await new Promise((resolve, reject) => {
                canvas.toBlob(result => result ? resolve(result) : reject(new Error('Không thể chuyển đổi ảnh CCCD.')), 'image/jpeg', 0.92);
            });
            return {
                data: await blob.arrayBuffer(),
                width,
                height
            };
        } finally {
            bitmap.close();
        }
    }

    function removeLegacyContentAfterTable(xmlDoc, table) {
        const body = table.parentNode;
        const removedRelationshipIds = new Set();
        const finalSectionProperties = getDirectChildren(body, 'sectPr')[0] || null;
        let sibling = table.nextSibling;
        while (sibling) {
            const nextSibling = sibling.nextSibling;
            const isSectionProperties = sibling.nodeType === 1 && sibling.localName === 'sectPr';
            if (!isSectionProperties) {
                if (sibling.nodeType === 1) {
                    if (finalSectionProperties) {
                        ['footerReference', 'headerReference'].forEach(localName => {
                            const references = Array.from(sibling.getElementsByTagNameNS(W_NS, localName));
                            references.forEach(reference => {
                                const relationshipId = reference.getAttributeNS(R_NS, 'id');
                                const alreadyPresent = Array.from(
                                    finalSectionProperties.getElementsByTagNameNS(W_NS, localName)
                                ).some(existing => existing.getAttributeNS(R_NS, 'id') === relationshipId);
                                if (!alreadyPresent) {
                                    finalSectionProperties.insertBefore(
                                        reference.cloneNode(true),
                                        finalSectionProperties.firstChild
                                    );
                                }
                            });
                        });
                    }
                    Array.from(sibling.getElementsByTagNameNS(A_NS, 'blip')).forEach(blip => {
                        const relationshipId = blip.getAttributeNS(R_NS, 'embed');
                        if (relationshipId) removedRelationshipIds.add(relationshipId);
                    });
                }
                sibling.remove();
            }
            sibling = nextSibling;
        }
        return removedRelationshipIds;
    }

    async function appendCCCDImages(zip, xmlDoc, cccdFiles, removedRelationshipIds) {
        const files = (cccdFiles || [])
            .map(item => item && (item.file || item))
            .filter(file => file && file.type && file.type.startsWith('image/'));

        const relationshipsPath = 'word/_rels/document.xml.rels';
        const relationshipsXml = await zip.file(relationshipsPath).async('string');
        const relationshipsDoc = new DOMParser().parseFromString(relationshipsXml, 'application/xml');
        const relationshipRoot = relationshipsDoc.documentElement;
        Array.from(relationshipRoot.getElementsByTagNameNS(REL_NS, 'Relationship')).forEach(node => {
            if (removedRelationshipIds && removedRelationshipIds.has(node.getAttribute('Id'))) {
                const target = node.getAttribute('Target') || '';
                if (target.startsWith('media/')) zip.remove(`word/${target}`);
                node.remove();
            }
        });

        if (!files.length) {
            zip.file(relationshipsPath, new XMLSerializer().serializeToString(relationshipsDoc));
            return;
        }

        const existingRelationshipIds = Array.from(relationshipRoot.getElementsByTagNameNS(REL_NS, 'Relationship'))
            .map(node => node.getAttribute('Id') || '');
        let nextRelationshipNumber = existingRelationshipIds.reduce((max, id) => {
            const match = id.match(/^rId(\d+)$/);
            return match ? Math.max(max, Number(match[1])) : max;
        }, 0) + 1;

        const contentTypesPath = '[Content_Types].xml';
        const contentTypesXml = await zip.file(contentTypesPath).async('string');
        const contentTypesDoc = new DOMParser().parseFromString(contentTypesXml, 'application/xml');
        const contentTypesRoot = contentTypesDoc.documentElement;
        const hasJpegType = Array.from(contentTypesRoot.children).some(node => {
            const extension = (node.getAttribute('Extension') || '').toLowerCase();
            return extension === 'jpg' || extension === 'jpeg';
        });
        if (!hasJpegType) {
            const jpegDefault = contentTypesDoc.createElementNS(
                'http://schemas.openxmlformats.org/package/2006/content-types',
                'Default'
            );
            jpegDefault.setAttribute('Extension', 'jpg');
            jpegDefault.setAttribute('ContentType', 'image/jpeg');
            contentTypesRoot.appendChild(jpegDefault);
        }

        const body = xmlDoc.getElementsByTagNameNS(W_NS, 'body')[0];
        const sectionProperties = getDirectChildren(body, 'sectPr')[0] || null;
        body.insertBefore(
            createSectionBreakParagraph(xmlDoc, sectionProperties),
            sectionProperties
        );

        const maxWidthEmu = Math.round(8.8 * EMU_PER_INCH);
        const maxHeightEmu = Math.round(3.0 * EMU_PER_INCH);
        for (let index = 0; index < files.length; index++) {
            const normalized = await normalizeImage(files[index]);
            const relationshipId = `rId${nextRelationshipNumber++}`;
            const mediaName = `cccd_${index + 1}.jpg`;
            zip.file(`word/media/${mediaName}`, normalized.data);

            const relationship = relationshipsDoc.createElementNS(REL_NS, 'Relationship');
            relationship.setAttribute('Id', relationshipId);
            relationship.setAttribute('Type', IMAGE_REL_TYPE);
            relationship.setAttribute('Target', `media/${mediaName}`);
            relationshipRoot.appendChild(relationship);

            const scale = Math.min(
                maxWidthEmu / normalized.width,
                maxHeightEmu / normalized.height
            );
            const widthEmu = Math.round(normalized.width * scale);
            const heightEmu = Math.round(normalized.height * scale);
            const isTopImage = index % 2 === 0;
            body.insertBefore(
                createImageParagraph(
                    xmlDoc,
                    relationshipId,
                    index + 1,
                    widthEmu,
                    heightEmu,
                    isTopImage ? '240' : '0'
                ),
                sectionProperties
            );

            if (!isTopImage && index < files.length - 1) {
                body.insertBefore(createPageBreakParagraph(xmlDoc), sectionProperties);
            }
        }

        const serializer = new XMLSerializer();
        zip.file(relationshipsPath, serializer.serializeToString(relationshipsDoc));
        zip.file(contentTypesPath, serializer.serializeToString(contentTypesDoc));
    }

    /**
     * Get direct child elements with specific tag name
     */
    function getDirectChildren(parent, localName) {
        const result = [];
        for (let i = 0; i < parent.childNodes.length; i++) {
            const child = parent.childNodes[i];
            if (child.nodeType === 1) { // ELEMENT_NODE
                if (child.localName === localName || child.nodeName === `w:${localName}`) {
                    result.push(child);
                }
            }
        }
        return result;
    }

    /**
     * Fill the original template.docx with the user's data and trigger download
     */
    async function generateDocx(courseInfo, students, dateColumns, cccdFiles = []) {
        if (!window.JSZip) {
            throw new Error('Thư viện JSZip chưa được nạp. Vui lòng kiểm tra lại file js/lib/jszip.min.js');
        }

        if (!window.TEMPLATE_DOCX_BASE64) {
            throw new Error('File mẫu template.docx chưa được nạp trong bộ nhớ.');
        }

        const dateCols = dateColumns && dateColumns.length > 0 
            ? dateColumns 
            : parseDateColumns(courseInfo.dates);

        // Load the template zip in memory
        const zip = await window.JSZip.loadAsync(window.TEMPLATE_DOCX_BASE64, { base64: true });

        // Read word/document.xml
        const xmlStr = await zip.file('word/document.xml').async('string');

        // Parse XML with standard DOMParser
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlStr, 'application/xml');

        // Find main table
        const tables = xmlDoc.getElementsByTagNameNS(W_NS, 'tbl');
        const tbl = tables[0] || xmlDoc.getElementsByTagName('w:tbl')[0];
        if (!tbl) {
            throw new Error('Không tìm thấy bảng trong file mẫu Word.');
        }
        const removedRelationshipIds = removeLegacyContentAfterTable(xmlDoc, tbl);

        const rows = getDirectChildren(tbl, 'tr');
        const studentRowStart = 5;
        const guideRow = rows[21];
        if (rows.length !== 22) {
            throw new Error('Cấu trúc bảng Word không khớp với mẫu HSEQ.FRM.1.5E.');
        }

        const courseCells = getDirectChildren(rows[1], 'tc');
        setCellText(courseCells[0], courseInfo.title || '', 2, HEADER_FORMAT);
        setCellText(courseCells[3], courseInfo.dates || '', 2, HEADER_FORMAT);

        const isOpito = (courseInfo.type || '').toUpperCase() === 'OPITO';
        // Keep the checkbox in its own 20-point text run.
        setCellText(courseCells[1], isOpito ? '☑' : '□', 2, { size: 40, bold: true, italic: false });
        setCellText(courseCells[2], isOpito ? '□' : '☑', 4, { size: 40, bold: true, italic: false });

        const instructorCells = getDirectChildren(rows[2], 'tc');
        setCellText(instructorCells[0], courseInfo.instructors || '', 1, HEADER_FORMAT);
        setCellText(instructorCells[1], courseInfo.assistants || '', 1, HEADER_FORMAT);

        const dateCells = getDirectChildren(rows[4], 'tc');
        for (let i = 0; i < 3; i++) {
            setCellText(dateCells[5 + i], dateCols[i] || '', 0, HEADER_FORMAT);
        }

        const learners = students || [];
        const templateRows = rows.slice(studentRowStart, 21);
        const blankRow = templateRows[templateRows.length - 1].cloneNode(true);
        for (let i = 0; i < Math.max(templateRows.length, learners.length); i++) {
            const row = templateRows[i] || tbl.insertBefore(blankRow.cloneNode(true), guideRow);
            const cells = getDirectChildren(row, 'tc');
            const learner = learners[i] || {};
            cells.forEach(cell => setParagraphFormatting(cell, STUDENT_FORMAT));
            // Word's native list numbering supplies the No column.
            setCellText(cells[1], (learner.name || '').trim().toUpperCase(), 0, STUDENT_FORMAT);
            setCellText(cells[2], (learner.company || '').trim().toUpperCase(), 0, STUDENT_FORMAT);
            setCellText(cells[3], learner.dob || '', 0, STUDENT_FORMAT);
            setCellText(cells[4], learner.idNumber || '', 0, STUDENT_FORMAT);
            // Medical screening, certification and signatures are completed on the form.
            for (const cell of cells.slice(5)) {
                setCellText(cell, '');
            }
        }

        await appendCCCDImages(zip, xmlDoc, cccdFiles, removedRelationshipIds);

        // =====================================================================
        // Serialize XML back & pack into ZIP
        // =====================================================================
        const serializer = new XMLSerializer();
        const updatedXml = serializer.serializeToString(xmlDoc);

        zip.file('word/document.xml', updatedXml);

        // Generate the new DOCX file blob
        const blob = await zip.generateAsync({
            type: 'blob',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            compression: 'DEFLATE',
        });

        // Generate filename
        const safeTitle = (courseInfo.title || 'Course').replace(/[^a-zA-Z0-9_\-]/g, '_');
        const safeDates = (courseInfo.dates || '').replace(/[\/\\:*?"<>|]/g, '-');
        const filename = `HSEQ.FRM.1.5E._Registration_and_Attendance.${safeTitle}_${safeDates}.docx`;

        // Trigger download
        if (typeof window.saveAs === 'function') {
            window.saveAs(blob, filename);
        } else {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                a.remove();
                URL.revokeObjectURL(url);
            }, 200);
        }

        return { blob, filename };
    }

    // Expose globally
    window.DocxExport = {
        generateDocx: generateDocx,
        parseDateColumns: parseDateColumns,
    };
})();
