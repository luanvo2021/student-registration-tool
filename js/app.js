/**
 * app.js - Main Application Controller
 * Handles application state, UI interactions, OCR flow, image lists, student matching, and export.
 */

(function () {
    'use strict';

    // =========================================================================
    // State Management
    // =========================================================================
    const state = {
        currentStep: 1,
        apiKey: sessionStorage.getItem('gemini_api_key') || localStorage.getItem('gemini_api_key') || '',
        
        // Step 1: Course Info
        courseInfo: {
            title: '',
            type: 'OPITO',
            dates: '',
            instructors: '',
            assistants: ''
        },

        // Step 2: Schedule Images List & Extracted Students
        scheduleFiles: [
            // { id, file, url, name, size, status: 'ready'|'processing'|'done'|'error', studentCount: 0 }
        ],
        students: [
            // { id, no, name, company, dob, idNumber, matched: false, cccdFile: null }
        ],

        // Step 3: CCCD Images List & Extracted Info
        cccdFiles: [
            // { id, file, url, name, size, status: 'ready'|'processing'|'done'|'error', extracted: null }
        ],
        extractedCCCDs: [
            // { name, dob, idNumber, rawText, fileName, fileId }
        ],

        // Warnings
        missingStudents: [], // Students in schedule who don't have CCCD
        unmatchedCCCDs: []   // CCCDs that didn't match any student in schedule
    };

    // =========================================================================
    // Utility Helpers
    // =========================================================================

    function formatFileSize(bytes) {
        if (!bytes && bytes !== 0) return '---';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function encodeInlineValue(value) {
        return encodeURIComponent(String(value == null ? '' : value)).replace(/'/g, '%27');
    }

    /**
     * Remove Vietnamese accents/diacritics and normalize spaces/case
     */
    function removeVietnameseTones(str) {
        if (!str) return '';
        str = str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        str = str.replace(/[đĐ]/g, 'd');
        return str
            .toUpperCase()
            .replace(/[^A-Z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Compute token-based similarity between two names
     * Returns a score from 0.0 to 1.0
     */
    function calculateNameSimilarity(name1, name2) {
        const norm1 = removeVietnameseTones(name1);
        const norm2 = removeVietnameseTones(name2);

        if (!norm1 || !norm2) return 0;
        if (norm1 === norm2) return 1.0;

        const tokens1 = norm1.split(' ').filter(Boolean);
        const tokens2 = norm2.split(' ').filter(Boolean);

        const set1 = new Set(tokens1);
        const set2 = new Set(tokens2);

        let commonCount = 0;
        for (const t of set1) {
            if (set2.has(t)) commonCount++;
        }

        const totalTokens = Math.max(tokens1.length, tokens2.length);
        const tokenScore = commonCount / totalTokens;

        const firstName1 = tokens1[tokens1.length - 1];
        const firstName2 = tokens2[tokens2.length - 1];
        const lastName1 = tokens1[0];
        const lastName2 = tokens2[0];

        if (firstName1 === firstName2 && lastName1 === lastName2) {
            return Math.max(tokenScore, 0.85);
        }

        return tokenScore;
    }

    /**
     * Find best matching student in the schedule list for a given CCCD name
     */
    function matchStudent(cccdName, studentList) {
        if (!cccdName) return null;
        let bestMatch = null;
        let highestScore = 0;

        for (const student of studentList) {
            const score = calculateNameSimilarity(cccdName, student.name);
            if (score > highestScore) {
                highestScore = score;
                bestMatch = student;
            }
        }

        if (highestScore >= 0.7) {
            return { student: bestMatch, score: highestScore };
        }
        return null;
    }

    // =========================================================================
    // UI Helpers & Notifications
    // =========================================================================

    function showToast(message, type = 'info', duration = 4000) {
        const container = document.getElementById('toastContainer');
        if (!container) return;

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;

        let iconName = 'info';
        if (type === 'success') iconName = 'check_circle';
        if (type === 'warning') iconName = 'warning';
        if (type === 'error') iconName = 'error';

        const icon = document.createElement('span');
        icon.className = 'material-icons-outlined toast-icon';
        icon.textContent = iconName;
        const messageElement = document.createElement('div');
        messageElement.className = 'toast-message';
        messageElement.textContent = String(message || '');
        const closeButton = document.createElement('button');
        closeButton.className = 'toast-close material-icons-outlined';
        closeButton.type = 'button';
        closeButton.textContent = 'close';
        closeButton.addEventListener('click', () => toast.remove());
        toast.append(icon, messageElement, closeButton);

        container.appendChild(toast);

        setTimeout(() => {
            if (toast.parentElement) {
                toast.style.animation = 'toastOut 0.3s forwards';
                setTimeout(() => toast.remove(), 300);
            }
        }, duration);
    }

    // =========================================================================
    // App Controller (window.App)
    // =========================================================================

    window.App = {
        init() {
            this.bindEvents();
            this.setupClipboardPaste();
            this.loadApiKey();
            this.updateNav();

            // Set up drag and drop
            this.setupDragAndDrop('scheduleUploadZone', 'scheduleFileInput', (files) => this.addScheduleImages(files));
            this.setupDragAndDrop('cccdUploadZone', 'cccdFileInput', (files) => this.addCCCDImages(files));
        },

        bindEvents() {
            // Step 1 inputs auto-save to state
            const bindInput = (id, prop) => {
                const el = document.getElementById(id);
                if (el) {
                    el.addEventListener('input', (e) => {
                        state.courseInfo[prop] = e.target.value.trim();
                    });
                }
            };
            bindInput('courseTitle', 'title');
            bindInput('courseDates', 'dates');
            bindInput('instructors', 'instructors');
            bindInput('assistants', 'assistants');

            document.querySelectorAll('input[name="courseType"]').forEach(radio => {
                radio.addEventListener('change', (e) => {
                    if (e.target.checked) state.courseInfo.type = e.target.value;
                });
            });

            // Enter key on API modal
            const apiInput = document.getElementById('apiKeyInput');
            if (apiInput) {
                apiInput.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') this.saveApiKey();
                });
            }
        },

        // ---------------------------------------------------------------------
        // Clipboard Paste Support (Ctrl + V)
        // ---------------------------------------------------------------------
        setupClipboardPaste() {
            window.addEventListener('paste', async (e) => {
                const activeTag = document.activeElement ? document.activeElement.tagName : '';
                const isInputField = activeTag === 'INPUT' || activeTag === 'TEXTAREA';

                const items = e.clipboardData ? e.clipboardData.items : [];
                const imageFiles = [];

                if (items) {
                    for (let i = 0; i < items.length; i++) {
                        if (items[i].type && items[i].type.startsWith('image/')) {
                            const blob = items[i].getAsFile();
                            if (blob) {
                                const ext = blob.type.split('/')[1] || 'png';
                                const file = new File([blob], `Ảnh dán ${Date.now()}.${ext}`, { type: blob.type });
                                imageFiles.push(file);
                            }
                        }
                    }
                }

                if (imageFiles.length === 0 && e.clipboardData && e.clipboardData.files) {
                    for (let i = 0; i < e.clipboardData.files.length; i++) {
                        const f = e.clipboardData.files[i];
                        if (f.type && f.type.startsWith('image/')) {
                            imageFiles.push(f);
                        }
                    }
                }

                if (imageFiles.length > 0) {
                    e.preventDefault();

                    if (state.currentStep === 2) {
                        showToast(`Đã nhận ${imageFiles.length} ảnh lịch học từ Clipboard!`, 'info');
                        this.addScheduleImages(imageFiles);
                    } else if (state.currentStep === 3) {
                        showToast(`Đã nhận ${imageFiles.length} ảnh CCCD từ Clipboard!`, 'info');
                        this.addCCCDImages(imageFiles);
                    } else {
                        showToast(`Vui lòng chuyển đến Bước 2 (Lịch học) hoặc Bước 3 (CCCD) để dán ảnh.`, 'warning');
                    }
                }
            });
        },

        // ---------------------------------------------------------------------
        // Lightbox Image Viewer
        // ---------------------------------------------------------------------
        openLightbox(url, caption) {
            const modal = document.getElementById('imageLightboxModal');
            const img = document.getElementById('lightboxImage');
            const cap = document.getElementById('lightboxCaption');
            if (modal && img) {
                img.src = url;
                if (cap) cap.innerText = caption || '';
                modal.classList.add('active');
            }
        },

        // ---------------------------------------------------------------------
        // API Key Modal
        // ---------------------------------------------------------------------
        loadApiKey() {
            const rememberedKey = localStorage.getItem('gemini_api_key');
            const rememberInput = document.getElementById('rememberApiKey');
            if (rememberInput) rememberInput.checked = Boolean(rememberedKey);

            if (state.apiKey) {
                window.GeminiOCR.setApiKey(state.apiKey);
                const input = document.getElementById('apiKeyInput');
                if (input) {
    input.value = '';
    input.placeholder = 'API Key đã được lưu — nhập key mới để thay thế';
}
            }
        },

        showApiKeyModal() {
            const modal = document.getElementById('apiKeyModal');
            const input = document.getElementById('apiKeyInput');
            const rememberInput = document.getElementById('rememberApiKey');
            if (modal) modal.classList.add('active');
            if (rememberInput) rememberInput.checked = Boolean(localStorage.getItem('gemini_api_key'));
            if (input) {
                input.value = '';
input.placeholder = state.apiKey
    ? 'API Key đã được lưu — nhập key mới để thay thế'
    : 'AIzaSy...';
                input.focus();
            }
        },

        saveApiKey() {
            const input = document.getElementById('apiKeyInput');
            if (!input) return;
            const key = input.value.trim();
            if (!key) {
                showToast('Vui lòng nhập API Key!', 'warning');
                return;
            }
            state.apiKey = key;
            const rememberKey = Boolean(document.getElementById('rememberApiKey')?.checked);
            if (rememberKey) {
                localStorage.setItem('gemini_api_key', key);
                sessionStorage.removeItem('gemini_api_key');
            } else {
                sessionStorage.setItem('gemini_api_key', key);
                localStorage.removeItem('gemini_api_key');
            }
            window.GeminiOCR.setApiKey(key);
            document.getElementById('apiKeyModal').classList.remove('active');
            showToast(rememberKey ? 'Đã ghi nhớ Gemini API Key trên thiết bị này!' : 'Đã lưu Gemini API Key cho phiên hiện tại!', 'success');
        },
        clearApiKey() {
            state.apiKey = '';
            sessionStorage.removeItem('gemini_api_key');
            localStorage.removeItem('gemini_api_key');

            if (window.GeminiOCR) {
                window.GeminiOCR.setApiKey('');
            }

            const input = document.getElementById('apiKeyInput');
            if (input) {
                input.value = '';
                input.placeholder = 'AIzaSy...';
            }
            const rememberInput = document.getElementById('rememberApiKey');
            if (rememberInput) rememberInput.checked = false;

            const modal = document.getElementById('apiKeyModal');
            if (modal) modal.classList.remove('active');

            showToast('Đã xóa API Key khỏi trình duyệt.', 'success');
        },
        ensureApiKey() {
            if (!state.apiKey) {
                this.showApiKeyModal();
                showToast('Vui lòng nhập Gemini API Key để tiếp tục quét ảnh!', 'warning');
                return false;
            }
            return true;
        },

        // ---------------------------------------------------------------------
        // Step Navigation
        // ---------------------------------------------------------------------
        goToStep(stepNumber) {
            if (stepNumber < 1 || stepNumber > 4) return;

            if (state.currentStep === 1 && stepNumber > 1) {
                this.syncCourseInfoFromUI();
                if (!state.courseInfo.title) {
                    showToast('Vui lòng nhập Course Title!', 'warning');
                    document.getElementById('courseTitle')?.focus();
                    return;
                }
                if (!state.courseInfo.dates) {
                    showToast('Vui lòng nhập Ngày khóa học (Date)!', 'warning');
                    document.getElementById('courseDates')?.focus();
                    return;
                }
                if (!state.courseInfo.instructors) {
                    showToast('Vui lòng nhập Giảng viên (Instructor)!', 'warning');
                    document.getElementById('instructors')?.focus();
                    return;
                }
            }

            if (stepNumber === 4) {
                this.renderPreview();
            }

            document.querySelectorAll('.step-panel').forEach(p => p.classList.remove('active'));
            const targetPanel = document.getElementById(`step${stepNumber}`);
            if (targetPanel) targetPanel.classList.add('active');

            state.currentStep = stepNumber;
            this.updateNav();
            window.scrollTo({ top: 0, behavior: 'smooth' });
        },

        updateNav() {
            document.querySelectorAll('.nav-item').forEach(item => {
                const s = parseInt(item.getAttribute('data-step'), 10);
                item.classList.remove('active', 'completed');
                if (s === state.currentStep) {
                    item.classList.add('active');
                } else if (s < state.currentStep) {
                    item.classList.add('completed');
                }
            });
        },

        syncCourseInfoFromUI() {
            state.courseInfo.title = document.getElementById('courseTitle')?.value.trim() || '';
            state.courseInfo.dates = document.getElementById('courseDates')?.value.trim() || '';
            state.courseInfo.instructors = document.getElementById('instructors')?.value.trim() || '';
            state.courseInfo.assistants = document.getElementById('assistants')?.value.trim() || '';

            const checkedType = document.querySelector('input[name="courseType"]:checked');
            if (checkedType) state.courseInfo.type = checkedType.value;
        },

        // ---------------------------------------------------------------------
        // Drag and drop helper
        // ---------------------------------------------------------------------
        setupDragAndDrop(zoneId, inputId, onFiles) {
            const zone = document.getElementById(zoneId);
            const input = document.getElementById(inputId);
            if (!zone || !input) return;

            zone.addEventListener('dragover', (e) => {
                e.preventDefault();
                zone.classList.add('dragover');
            });
            zone.addEventListener('dragleave', () => {
                zone.classList.remove('dragover');
            });
            zone.addEventListener('drop', (e) => {
                e.preventDefault();
                zone.classList.remove('dragover');
                if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                    onFiles(Array.from(e.dataTransfer.files));
                }
            });

            input.addEventListener('change', (e) => {
                if (e.target.files && e.target.files.length > 0) {
                    onFiles(Array.from(e.target.files));
                    input.value = ''; // Reset so user can re-upload same file
                }
            });
        },

        // =====================================================================
        // Step 2: Schedule Images List & OCR
        // =====================================================================

        addScheduleImages(files) {
            const imageFiles = files.filter(f => f.type.startsWith('image/'));
            if (imageFiles.length === 0) {
                showToast('Vui lòng chọn hoặc dán file hình ảnh hợp lệ (JPG, PNG)!', 'warning');
                return;
            }

            imageFiles.forEach((file, i) => {
                const item = {
                    id: 'sch_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
                    file: file,
                    url: URL.createObjectURL(file),
                    name: file.name || `Ảnh lịch #${state.scheduleFiles.length + 1}`,
                    size: file.size,
                    status: 'ready', // 'ready' | 'processing' | 'done' | 'error'
                    studentCount: 0
                };
                state.scheduleFiles.push(item);
            });

            this.renderScheduleFilesTable();
            showToast(`Đã thêm ${imageFiles.length} ảnh vào danh sách ảnh lịch học. Đang tự động quét...`, 'info');

            // Auto-trigger scanning of newly added schedule images
            this.scanScheduleImages();
        },

        renderScheduleFilesTable() {
            const container = document.getElementById('scheduleFilesContainer');
            const tbody = document.getElementById('scheduleFilesTableBody');
            const countEl = document.getElementById('scheduleFilesCount');

            if (!container || !tbody) return;

            if (state.scheduleFiles.length === 0) {
                container.style.display = 'none';
                return;
            }

            container.style.display = 'block';
            if (countEl) countEl.innerText = state.scheduleFiles.length;
            tbody.innerHTML = '';

            state.scheduleFiles.forEach((item, index) => {
                const tr = document.createElement('tr');

                let statusBadge = '';
                if (item.status === 'ready') {
                    statusBadge = '<span class="status-badge" style="background:#f3f4f6; color:#4b5563;">Chờ quét</span>';
                } else if (item.status === 'processing') {
                    statusBadge = '<span class="status-badge" style="background:#dbeafe; color:#1e40af;">Đang quét...</span>';
                } else if (item.status === 'done') {
                    statusBadge = `<span class="status-badge matched">Đã nhận diện (${Number(item.studentCount) || 0} người)</span>`;
                } else if (item.status === 'error') {
                    statusBadge = `<span class="status-badge missing" title="${escapeHtml(item.errorMessage || 'Lỗi quét')}">Lỗi quét</span>`;
                }

                const safeUrl = encodeInlineValue(item.url);
                const safeName = encodeInlineValue(item.name);

                tr.innerHTML = `
                    <td style="text-align: center; color: var(--gray-500); font-weight: 500;">${index + 1}</td>
                    <td>
                        <div class="file-thumb-wrapper" onclick="App.openLightbox(decodeURIComponent('${safeUrl}'), decodeURIComponent('${safeName}'))" title="Nhấn để xem ảnh phóng to">
                            <img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.name)}">
                        </div>
                    </td>
                    <td>
                        <div class="file-name-cell">
                            <span>${escapeHtml(item.name)}</span>
                            <span class="file-badge">${escapeHtml(item.file.type || 'image/png')}</span>
                        </div>
                    </td>
                    <td style="color: var(--gray-600);">${formatFileSize(item.size)}</td>
                    <td>${statusBadge}</td>
                    <td style="text-align: center;">
                        <button class="btn btn-ghost btn-sm" onclick="App.openLightbox(decodeURIComponent('${safeUrl}'), decodeURIComponent('${safeName}'))" title="Xem ảnh">
                            <span class="material-icons-outlined">visibility</span>
                        </button>
                        <button class="btn btn-danger btn-sm" onclick="App.removeScheduleFile('${item.id}')" title="Xóa ảnh này">
                            <span class="material-icons-outlined">delete</span>
                        </button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        },

        removeScheduleFile(fileId) {
            const removed = state.scheduleFiles.find(f => f.id === fileId);
            if (removed?.url) URL.revokeObjectURL(removed.url);
            state.scheduleFiles = state.scheduleFiles.filter(f => f.id !== fileId);
            this.renderScheduleFilesTable();
            showToast('Đã xóa ảnh lịch học.', 'info');
        },

        clearScheduleFiles() {
            if (confirm('Bạn có chắc muốn xóa tất cả ảnh lịch học đã nạp?')) {
                state.scheduleFiles.forEach(item => {
                    if (item.url) URL.revokeObjectURL(item.url);
                });
                state.scheduleFiles = [];
                state.students = [];
                this.renderScheduleFilesTable();
                const resultsSection = document.getElementById('scheduleResults');
                if (resultsSection) resultsSection.style.display = 'none';
                document.getElementById('toStep3Btn').disabled = true;
            }
        },

        async scanScheduleImages() {
            if (!this.ensureApiKey()) return;
            if (state.scheduleFiles.length === 0) {
                showToast('Chưa có ảnh lịch học nào để quét!', 'warning');
                return;
            }

            const processing = document.getElementById('scheduleProcessing');
            const resultsSection = document.getElementById('scheduleResults');
            const btnScan = document.getElementById('btnScanSchedule');

            if (processing) processing.style.display = 'block';
            if (resultsSection) resultsSection.style.display = 'none';
            if (btnScan) btnScan.disabled = true;

            const allExtractedStudents = [];

            try {
                for (let i = 0; i < state.scheduleFiles.length; i++) {
                    const item = state.scheduleFiles[i];
                    item.status = 'processing';
                    this.renderScheduleFilesTable();

                    try {
                        const res = await window.GeminiOCR.extractSchedule(item.file);
                        item.status = 'done';
                        item.studentCount = (res.students && res.students.length) || 0;

                        if (res.students && res.students.length > 0) {
                            res.students.forEach(s => {
                                allExtractedStudents.push({
                                    name: (s.name || '').toUpperCase().trim(),
                                    company: (s.company || '').toUpperCase().trim()
                                });
                            });
                        }
                    } catch (err) {
                        console.error('Lỗi quét ảnh lịch:', err);
                        item.status = 'error';
                        item.errorMessage = err.message;
                        showToast(`Lỗi quét "${item.name}": ${err.message}`, 'error', 7000);
                    }
                    this.renderScheduleFilesTable();
                }

                if (processing) processing.style.display = 'none';
                if (btnScan) btnScan.disabled = false;

                if (allExtractedStudents.length > 0) {
                    state.students = allExtractedStudents.map((s, idx) => ({
                        id: 'std_' + Date.now() + '_' + idx,
                        no: idx + 1,
                        name: s.name,
                        company: s.company,
                        dob: '',
                        idNumber: '',
                        matched: false,
                        cccdFile: null
                    }));

                    this.renderExtractedSchedule();
                    document.getElementById('toStep3Btn').disabled = false;
                    showToast(`Đã nhận diện thành công ${state.students.length} học viên từ ${state.scheduleFiles.length} ảnh!`, 'success');
                } else {
                    showToast('Không tìm thấy danh sách học viên trong ảnh. Bạn có thể thêm thủ công.', 'warning');
                    if (resultsSection) resultsSection.style.display = 'block';
                    this.renderExtractedSchedule();
                }
            } catch (err) {
                console.error(err);
                showToast('Lỗi khi quét ảnh lịch: ' + err.message, 'error', 6000);
            } finally {
                if (processing) processing.style.display = 'none';
                if (btnScan) btnScan.disabled = false;
            }
        },

        cancelScheduleScan() {
            const processing = document.getElementById('scheduleProcessing');
            const btnScan = document.getElementById('btnScanSchedule');
            if (processing) processing.style.display = 'none';
            if (btnScan) btnScan.disabled = false;
            state.scheduleFiles.forEach((f) => {
                if (f.status === 'processing') f.status = 'ready';
            });
            this.renderScheduleFilesTable();
            showToast('Đã dừng tiến trình quét lịch học.', 'info');
        },

        renderExtractedSchedule() {
            const container = document.getElementById('extractedNamesList');
            const resultsSection = document.getElementById('scheduleResults');
            if (!container || !resultsSection) return;

            resultsSection.style.display = 'block';
            container.innerHTML = '';

            if (state.students.length === 0) {
                container.innerHTML = '<p class="hint" style="text-align: center; padding: 12px;">Chưa có học viên nào. Hãy thêm ảnh lịch học hoặc nhấn "Thêm thủ công".</p>';
                return;
            }

            state.students.forEach((student, idx) => {
                student.no = idx + 1;
                const el = document.createElement('div');
                el.className = 'extracted-item';
                el.innerHTML = `
                    <div class="item-number">${student.no}</div>
                    <div class="item-name" id="name_display_${student.id}">
                        <strong>${escapeHtml(student.name)}</strong>
                    </div>
                    <div class="item-company" id="company_display_${student.id}" style="color: var(--primary); font-weight: 500;">
                        ${student.company ? escapeHtml(student.company) : '<span style="color: var(--gray-400);">(Chưa có cty)</span>'}
                    </div>
                    <div class="item-actions">
                        <button class="btn btn-ghost btn-sm" title="Sửa tên / công ty" onclick="App.editStudent('${student.id}')">
                            <span class="material-icons-outlined">edit</span>
                        </button>
                        <button class="btn btn-danger btn-sm" title="Xóa" onclick="App.removeStudent('${student.id}')">
                            <span class="material-icons-outlined">delete</span>
                        </button>
                    </div>
                `;
                container.appendChild(el);
            });
        },

        editStudent(studentId) {
            const student = state.students.find(s => s.id === studentId);
            if (!student) return;

            const newName = prompt('Sửa Họ và tên học viên:', student.name);
            if (newName !== null) {
                student.name = newName.toUpperCase().trim();
            }

            const newCompany = prompt('Sửa Công ty / Đơn vị:', student.company);
            if (newCompany !== null) {
                student.company = newCompany.toUpperCase().trim();
            }

            this.renderExtractedSchedule();
        },

        removeStudent(studentId) {
            state.students = state.students.filter(s => s.id !== studentId);
            this.renderExtractedSchedule();
            if (state.students.length === 0) {
                document.getElementById('toStep3Btn').disabled = true;
            }
        },

        addManualStudent() {
            const name = prompt('Nhập họ và tên học viên:');
            if (!name || !name.trim()) return;

            const company = prompt('Nhập tên công ty / đơn vị (nếu có):', '') || '';

            state.students.push({
                id: 'std_' + Date.now(),
                no: state.students.length + 1,
                name: name.toUpperCase().trim(),
                company: company.toUpperCase().trim(),
                dob: '',
                idNumber: '',
                matched: false,
                cccdFile: null
            });

            this.renderExtractedSchedule();
            document.getElementById('toStep3Btn').disabled = false;
            showToast(`Đã thêm học viên "${name.toUpperCase().trim()}"`, 'success');
        },

        clearSchedule() {
            if (confirm('Bạn có chắc muốn xóa toàn bộ danh sách học viên và quét lại?')) {
                state.students = [];
                this.renderExtractedSchedule();
                document.getElementById('toStep3Btn').disabled = true;
            }
        },

        // =====================================================================
        // Step 3: CCCD Images List & OCR
        // =====================================================================

        addCCCDImages(files) {
            const imageFiles = files.filter(f => f.type.startsWith('image/'));
            if (imageFiles.length === 0) {
                showToast('Vui lòng chọn hoặc dán file hình ảnh CCCD hợp lệ!', 'warning');
                return;
            }

            const newItems = [];
            imageFiles.forEach((file) => {
                const item = {
                    id: 'cccd_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
                    file: file,
                    url: URL.createObjectURL(file),
                    name: file.name || `Ảnh CCCD #${state.cccdFiles.length + 1}`,
                    size: file.size,
                    status: 'ready',
                    extracted: null
                };
                state.cccdFiles.push(item);
                newItems.push(item);
            });

            this.renderCCCDFilesTable();
            showToast(`Đã thêm ${imageFiles.length} ảnh vào bảng danh sách CCCD. Đang tự động quét...`, 'info');

            // Auto scan newly added CCCDs
            this.scanCCCDItems(newItems);
        },

        renderCCCDFilesTable() {
            const container = document.getElementById('cccdFilesContainer');
            const tbody = document.getElementById('cccdFilesTableBody');
            const countEl = document.getElementById('cccdFilesCount');

            if (!container || !tbody) return;

            if (state.cccdFiles.length === 0) {
                container.style.display = 'none';
                return;
            }

            container.style.display = 'block';
            if (countEl) countEl.innerText = state.cccdFiles.length;
            tbody.innerHTML = '';

            state.cccdFiles.forEach((item, index) => {
                const tr = document.createElement('tr');

                let statusBadge = '';
                if (item.status === 'ready') {
                    statusBadge = '<span class="status-badge" style="background:#f3f4f6; color:#4b5563;">Chờ quét</span>';
                } else if (item.status === 'processing') {
                    statusBadge = '<span class="status-badge" style="background:#dbeafe; color:#1e40af;">Đang quét...</span>';
                } else if (item.status === 'done') {
                    const count = item.cardCount !== undefined ? item.cardCount : 1;
                    statusBadge = `<span class="status-badge matched">Đã đọc (${count} thẻ CCCD)</span>`;
                } else if (item.status === 'error') {
                    statusBadge = `<span class="status-badge missing" title="${escapeHtml(item.errorMessage || '')}">Lỗi đọc</span>`;
                }

                const safeUrl = encodeInlineValue(item.url);
                const safeName = encodeInlineValue(item.name);

                tr.innerHTML = `
                    <td style="text-align: center; color: var(--gray-500); font-weight: 500;">${index + 1}</td>
                    <td>
                        <div class="file-thumb-wrapper" onclick="App.openLightbox(decodeURIComponent('${safeUrl}'), decodeURIComponent('${safeName}'))" title="Nhấn để xem ảnh phóng to">
                            <img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.name)}">
                        </div>
                    </td>
                    <td>
                        <div class="file-name-cell">
                            <span>${escapeHtml(item.name)}</span>
                            <span class="file-badge">${escapeHtml(item.file.type || 'image/png')}</span>
                        </div>
                    </td>
                    <td style="color: var(--gray-600);">${formatFileSize(item.size)}</td>
                    <td>${statusBadge}</td>
                    <td style="text-align: center;">
                        <button class="btn btn-ghost btn-sm" onclick="App.openLightbox(decodeURIComponent('${safeUrl}'), decodeURIComponent('${safeName}'))" title="Xem ảnh">
                            <span class="material-icons-outlined">visibility</span>
                        </button>
                        <button class="btn btn-secondary btn-sm" onclick="App.retryCCCDFile('${item.id}')" title="Quét lại ảnh này" ${item.status === 'processing' ? 'disabled' : ''}>
                            <span class="material-icons-outlined">refresh</span>
                        </button>
                        <button class="btn btn-danger btn-sm" onclick="App.removeCCCDFile('${item.id}')" title="Xóa ảnh này">
                            <span class="material-icons-outlined">delete</span>
                        </button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        },

        removeCCCDFile(fileId) {
            const removed = state.cccdFiles.find(f => f.id === fileId);
            if (removed?.url) URL.revokeObjectURL(removed.url);
            state.cccdFiles = state.cccdFiles.filter(f => f.id !== fileId);
            state.extractedCCCDs = state.extractedCCCDs.filter(e => e.fileId !== fileId);
            this.renderCCCDFilesTable();
            this.performMatching();
            this.renderMatchingResults();
            showToast('Đã xóa ảnh CCCD.', 'info');
        },

        clearCCCDFiles() {
            if (confirm('Bạn có chắc muốn xóa tất cả ảnh CCCD đã nạp?')) {
                state.cccdFiles.forEach(item => {
                    if (item.url) URL.revokeObjectURL(item.url);
                });
                state.cccdFiles = [];
                state.extractedCCCDs = [];
                this.renderCCCDFilesTable();
                this.performMatching();
                this.renderMatchingResults();
            }
        },

        async scanCCCDImages() {
            // Re-scan all ready or all files
            await this.scanCCCDItems(state.cccdFiles);
        },

        async retryCCCDFile(fileId) {
            const item = state.cccdFiles.find(file => file.id === fileId);
            if (!item) {
                showToast('Không tìm thấy ảnh CCCD cần quét lại.', 'warning');
                return;
            }
            if (item.status === 'processing') {
                showToast('Ảnh này đang được quét. Vui lòng chờ hoàn tất.', 'info');
                return;
            }

            item.errorMessage = '';
            showToast(`Đang quét lại ảnh "${item.name}"...`, 'info');
            await this.scanCCCDItems([item]);
            if (item.status === 'done') {
                showToast(
                    `Đã cập nhật kết quả từ "${item.name}" (${item.cardCount || 0} thẻ CCCD).`,
                    item.cardCount > 0 ? 'success' : 'warning',
                    5000
                );
            }
        },

        async scanCCCDItems(itemsToScan) {
            if (!this.ensureApiKey()) return;
            if (!itemsToScan || itemsToScan.length === 0) return;

            const processing = document.getElementById('cccdProcessing');
            const progressBar = document.getElementById('cccdProgressBar');
            const progressText = document.getElementById('cccdProgressText');
            const btnScan = document.getElementById('btnScanCCCD');

            if (processing) processing.style.display = 'block';
            if (btnScan) btnScan.disabled = true;

            const total = itemsToScan.length;

            for (let i = 0; i < total; i++) {
                const item = itemsToScan[i];
                item.status = 'processing';
                this.renderCCCDFilesTable();

                const pct = Math.round(((i + 1) / total) * 100);
                if (progressBar) progressBar.style.width = pct + '%';
                if (progressText) progressText.innerText = `Đang quét CCCD ${i + 1}/${total} (${item.name})...`;

                try {
                    const res = await window.GeminiOCR.extractCCCD(item.file);
                    item.status = 'done';
                    item.extracted = res;
                    const cards = res.cards || [];
                    item.cardCount = cards.length;

                    // Remove any old extraction for this fileId if re-scanning
                    state.extractedCCCDs = state.extractedCCCDs.filter(e => e.fileId !== item.id);
                    cards.forEach(card => {
                        state.extractedCCCDs.push({
                            ...card,
                            fileName: item.name,
                            fileId: item.id
                        });
                    });
                } catch (err) {
                    console.error('Lỗi khi quét CCCD:', err);
                    item.status = 'error';
                    item.errorMessage = err.message;
                    showToast(`Lỗi quét CCCD "${item.name}": ${err.message}`, 'error', 7000);
                }

                this.renderCCCDFilesTable();
            }

            if (processing) processing.style.display = 'none';
            if (btnScan) btnScan.disabled = false;

            // Re-match against schedule
            this.performMatching();
            this.renderMatchingResults();
            if (state.currentStep === 4) this.renderPreview();
        },

        performMatching() {
            // Reset match flags on students
            state.students.forEach(s => {
                s.matched = false;
                s.dob = '';
                s.idNumber = '';
                s.cccdFile = null;
            });

            state.missingStudents = [];
            state.unmatchedCCCDs = [];

            const matchedStudentIds = new Set();

            // Match each extracted CCCD against schedule
            for (const cccd of state.extractedCCCDs) {
                if (!cccd.name && !cccd.idNumber) {
                    state.unmatchedCCCDs.push(cccd);
                    continue;
                }

                const result = matchStudent(cccd.name, state.students);
                if (result && !matchedStudentIds.has(result.student.id)) {
                    const student = result.student;
                    student.matched = true;
                    student.dob = cccd.dob || '';
                    student.idNumber = cccd.idNumber || '';
                    student.cccdFile = cccd.fileName;
                    matchedStudentIds.add(student.id);
                } else {
                    state.unmatchedCCCDs.push(cccd);
                }
            }

            // Identify missing students (in schedule but no CCCD matched)
            state.missingStudents = state.students.filter(s => !s.matched);
        },

        renderMatchingResults() {
            const resultsSection = document.getElementById('cccdResults');
            const matchedContainer = document.getElementById('matchedList');
            const warningsContainer = document.getElementById('warningsList');

            if (!resultsSection || !matchedContainer || !warningsContainer) return;
            resultsSection.style.display = 'block';

            matchedContainer.innerHTML = '';
            warningsContainer.innerHTML = '';

            // Render matched list
            state.students.forEach(student => {
                const item = document.createElement('div');
                item.className = `match-item ${student.matched ? 'matched' : 'missing'}`;

                const icon = student.matched ? 'check_circle' : 'warning';
                const statusText = student.matched 
                    ? `Đã khớp CCCD • Ngày sinh: <strong>${escapeHtml(student.dob || 'Chưa rõ')}</strong> • Số: <strong>${escapeHtml(student.idNumber || 'Chưa rõ')}</strong>`
                    : `<span style="color: var(--danger); font-weight: 500;">Chưa có CCCD (sẽ để trống trong form)</span>`;

                item.innerHTML = `
                    <div class="match-icon material-icons-outlined">${icon}</div>
                    <div class="match-info">
                        <div class="match-name">${Number(student.no) || 0}. ${escapeHtml(student.name)} <span style="font-weight: normal; color: var(--gray-500);">(${escapeHtml(student.company || 'Chưa có cty')})</span></div>
                        <div class="match-details">${statusText}</div>
                    </div>
                `;
                matchedContainer.appendChild(item);
            });

            // Warnings section for missing students
            if (state.missingStudents.length > 0 || state.unmatchedCCCDs.length > 0) {
                warningsContainer.style.display = 'block';
                let html = `<h4><span class="material-icons-outlined">notification_important</span> Cảnh báo thiếu thông tin:</h4><ul>`;

                if (state.missingStudents.length > 0) {
                    state.missingStudents.forEach(s => {
                        html += `<li><strong>${escapeHtml(s.name)}</strong> (${escapeHtml(s.company || '---')}) có tên trong danh sách nhưng không tìm thấy ảnh CCCD tương ứng. Thông tin ngày sinh và số CCCD sẽ để trống.</li>`;
                    });
                }

                if (state.unmatchedCCCDs.length > 0) {
                    state.unmatchedCCCDs.forEach(c => {
                        html += `<li>Ảnh CCCD tên "<strong>${escapeHtml(c.name || 'Không rõ tên')}</strong>" (Số: ${escapeHtml(c.idNumber || '---')}) không khớp với học viên nào trong lịch học.</li>`;
                    });
                }

                html += `</ul>`;
                warningsContainer.innerHTML = html;
            } else {
                warningsContainer.style.display = 'none';
            }

            const matchedCount = state.students.filter(s => s.matched).length;
            showToast(`Khớp thành công ${matchedCount}/${state.students.length} học viên!`, matchedCount === state.students.length ? 'success' : 'warning');
        },

        // =====================================================================
        // Step 4: Preview & Export
        // =====================================================================

        renderPreview() {
            this.syncCourseInfoFromUI();

            const elTitle = document.getElementById('prevCourseTitle');
            const elDates = document.getElementById('prevDates');
            const elInstructors = document.getElementById('prevInstructors');
            const elAssistants = document.getElementById('prevAssistants');

            if (elTitle) elTitle.innerText = state.courseInfo.title || '---';
            if (elDates) elDates.innerText = state.courseInfo.dates || '---';
            if (elInstructors) elInstructors.innerText = state.courseInfo.instructors || '---';
            if (elAssistants) elAssistants.innerText = state.courseInfo.assistants || '---';

            const tbody = document.getElementById('previewTableBody');
            if (!tbody) return;
            tbody.innerHTML = '';

            state.students.forEach((student, idx) => {
                student.no = idx + 1;
                const tr = document.createElement('tr');
                const isMatched = !!(student.dob && student.idNumber);

                tr.innerHTML = `
                    <td class="col-no">${student.no}</td>
                    <td class="col-name">
                        <input type="text" value="${escapeHtml(student.name)}" onchange="App.updateStudentField(${idx}, 'name', this.value)">
                    </td>
                    <td class="col-company">
                        <input type="text" value="${escapeHtml(student.company || '')}" placeholder="Nhập công ty..." onchange="App.updateStudentField(${idx}, 'company', this.value)">
                    </td>
                    <td class="col-dob">
                        <input type="text" value="${escapeHtml(student.dob)}" placeholder="DD/MM/YYYY" onchange="App.updateStudentField(${idx}, 'dob', this.value)">
                    </td>
                    <td class="col-id">
                        <input type="text" value="${escapeHtml(student.idNumber)}" placeholder="012345678901" onchange="App.updateStudentField(${idx}, 'idNumber', this.value)">
                    </td>
                    <td class="col-status">
                        <span class="status-badge ${isMatched ? 'matched' : 'missing'}">
                            ${isMatched ? 'Đủ CCCD' : 'Thiếu CCCD'}
                        </span>
                    </td>
                `;
                tbody.appendChild(tr);
            });

            const previewWarnings = document.getElementById('previewWarnings');
            const missing = state.students.filter(s => !s.dob || !s.idNumber);
            if (previewWarnings) {
                if (missing.length > 0) {
                    previewWarnings.style.display = 'block';
                    previewWarnings.innerHTML = `
                        <div class="warning-title">
                            <span class="material-icons-outlined">warning</span>
                            Có ${missing.length} học viên chưa có thông tin CCCD (sẽ để trống trong file Word hoặc bạn có thể nhập trực tiếp ở bảng trên):
                        </div>
                        <div>${missing.map(m => `<strong>${escapeHtml(m.name)}</strong>`).join(', ')}</div>
                    `;
                } else {
                    previewWarnings.style.display = 'none';
                }
            }
        },

        updateStudentField(index, field, value) {
            if (state.students[index]) {
                state.students[index][field] = value.trim();
                if (field === 'name' || field === 'company') {
                    state.students[index][field] = value.toUpperCase().trim();
                }
            }
        },

        async exportDocx() {
            this.syncCourseInfoFromUI();

            if (!state.courseInfo.title) {
                showToast('Thiếu Course Title!', 'warning');
                return;
            }
            if (!state.courseInfo.dates) {
                showToast('Thiếu Date!', 'warning');
                return;
            }

            try {
                showToast('Đang tạo file DOCX...', 'info');

                const dateCols = window.DocxExport.parseDateColumns(state.courseInfo.dates);

                const result = await window.DocxExport.generateDocx(
                    state.courseInfo,
                    state.students,
                    dateCols,
                    state.cccdFiles.filter(item => item.file && item.status !== 'error')
                );

                showToast(`Đã xuất file thành công: ${result.filename}`, 'success', 6000);
            } catch (err) {
                console.error(err);
                showToast('Lỗi khi xuất file DOCX: ' + err.message, 'error', 6000);
            }
        },

        batchSetCompany(companyName) {
            const name = (companyName !== undefined ? companyName : prompt('Nhập tên công ty áp dụng cho tất cả học viên:', 'PTSC M&C') || '').toUpperCase().trim();
            if (!name) return;
            state.students.forEach(s => s.company = name);
            if (state.currentStep === 2) this.renderExtractedSchedule();
            if (state.currentStep === 4) this.renderPreview();
            showToast(`Đã gán công ty "${name}" cho toàn bộ học viên!`, 'success');
        }
    };

    // Initialize on DOM ready
    document.addEventListener('DOMContentLoaded', () => {
        window.App.init();
    });
})();
