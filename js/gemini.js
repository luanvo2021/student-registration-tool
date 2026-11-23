/**
 * gemini.js – Google Gemini OCR module for student registration
 *
 * Exposes window.GeminiOCR with helpers to:
 *   • Extract student names from a training-schedule image
 *   • Extract fields from Vietnamese CCCD (Citizen ID) card images
 */

(function () {
    'use strict';

    const GEMINI_ENDPOINT =
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

    const MAX_RETRIES = 2;
    const RETRY_DELAY_MS = 1800;
    const IMAGE_LIMITS = {
        schedule: { maxSide: 2200, quality: 0.88 },
        cccd: { maxSide: 2000, quality: 0.92 },
    };

    /* ------------------------------------------------------------------ */
    /*  Utility helpers                                                    */
    /* ------------------------------------------------------------------ */

    /**
     * Strip markdown code-fence wrappers that Gemini sometimes adds around
     * JSON responses (```json … ``` or ``` … ```).
     */
    function stripCodeFence(text) {
        if (!text) return text;
        let trimmed = text.trim();
        // Remove opening fence (with optional language tag)
        if (trimmed.startsWith('```')) {
            const firstNewline = trimmed.indexOf('\n');
            if (firstNewline !== -1) {
                trimmed = trimmed.substring(firstNewline + 1);
            }
        }
        // Remove closing fence
        if (trimmed.endsWith('```')) {
            trimmed = trimmed.substring(0, trimmed.length - 3);
        }
        return trimmed.trim();
    }

    /**
     * Safely parse a JSON string that may be wrapped in markdown fences.
     */
    function safeParseJSON(text) {
        const cleaned = stripCodeFence(text);
        return JSON.parse(cleaned);
    }

    /**
     * Wait for the given number of milliseconds.
     */
    function delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function normalizeDate(value) {
        const text = String(value || '').trim();
        const match = text.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
        if (!match) return text;
        const day = Number(match[1]);
        const month = Number(match[2]);
        const year = Number(match[3]);
        if (day < 1 || day > 31 || month < 1 || month > 12 || year < 1900 || year > 2100) return '';
        return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
    }

    /* ------------------------------------------------------------------ */
    /*  GeminiOCR public interface                                         */
    /* ------------------------------------------------------------------ */

    window.GeminiOCR = {
        /** The Gemini API key – must be set before any extraction call. */
        apiKey: null,

        /**
         * Store the API key for subsequent requests.
         * @param {string} key
         */
        setApiKey(key) {
            this.apiKey = key;
        },

        /* -------------------------------------------------------------- */
        /*  fileToBase64                                                    */
        /* -------------------------------------------------------------- */

        /**
         * Convert a File / Blob to a base64-encoded string (no data-URI prefix).
         * @param {File} file
         * @returns {Promise<string>}
         */
        async fileToBase64(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    // result is "data:<mime>;base64,<data>" – we only need <data>
                    const base64 = reader.result.split(',')[1];
                    resolve(base64);
                };
                reader.onerror = () => reject(new Error('Không thể đọc file ảnh.'));
                reader.readAsDataURL(file);
            });
        },

        /**
         * Resize large camera images before uploading. This reduces request size
         * dramatically while keeping enough detail for Vietnamese text and the
         * 12-digit CCCD number. Small images are left untouched.
         */
        async prepareImage(file, kind) {
            const limits = IMAGE_LIMITS[kind] || IMAGE_LIMITS.cccd;
            if (!file || !String(file.type || '').startsWith('image/')) {
                return { base64Data: await this.fileToBase64(file), mimeType: file?.type || 'image/jpeg' };
            }

            const bitmap = await createImageBitmap(file);
            const longest = Math.max(bitmap.width, bitmap.height);
            if (longest <= limits.maxSide && file.size <= 1.5 * 1024 * 1024) {
                bitmap.close();
                return { base64Data: await this.fileToBase64(file), mimeType: file.type || 'image/jpeg' };
            }

            const scale = Math.min(1, limits.maxSide / longest);
            const width = Math.max(1, Math.round(bitmap.width * scale));
            const height = Math.max(1, Math.round(bitmap.height * scale));
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d', { alpha: false });
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, width, height);
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(bitmap, 0, 0, width, height);
            bitmap.close();

            const blob = await new Promise((resolve, reject) => {
                canvas.toBlob((result) => result ? resolve(result) : reject(new Error('Không thể tối ưu ảnh.')), 'image/jpeg', limits.quality);
            });
            return { base64Data: await this.fileToBase64(blob), mimeType: 'image/jpeg' };
        },

        /* -------------------------------------------------------------- */
        /*  callGemini (low-level)                                          */
        /* -------------------------------------------------------------- */

        /**
         * Send a prompt + inline image to the Gemini generateContent endpoint.
         *
         * @param {string} base64Data  Base64-encoded image bytes
         * @param {string} mimeType    e.g. "image/jpeg", "image/png"
         * @param {string} prompt      Text prompt
         * @returns {Promise<string>}  The model's text response
         */
        _availableModels: null,

        /**
         * Dynamically discover which Gemini models are enabled for this API key.
         */
        async getAvailableModels() {
            if (this._availableModels && this._availableModels.length > 0) {
                return this._availableModels;
            }

            const discovered = [];
            try {
                const res = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(this.apiKey)}`
                );
                if (res.ok) {
                    const data = await res.json();
                    if (data.models && Array.isArray(data.models)) {
                        data.models.forEach((m) => {
                            if (
                                m.supportedGenerationMethods &&
                                m.supportedGenerationMethods.includes('generateContent')
                            ) {
                                const cleanName = m.name.replace(/^models\//, '');
                                if (
                                    /^gemini-/i.test(cleanName) &&
                                    !/(image|tts|audio|robotics|embedding|aqa)/i.test(cleanName)
                                ) {
                                    discovered.push(cleanName);
                                }
                            }
                        });
                    }
                } else {
                    console.warn('ListModels HTTP error:', res.status);
                }
            } catch (e) {
                console.warn('ListModels network error:', e);
            }

            if (discovered.length > 0) {
                // Prioritize flash models, then pro
                discovered.sort((a, b) => {
                    const score = (name) => {
                        if (/2\.5-flash(?!.*lite)/i.test(name) && !/preview|exp/i.test(name)) return 100;
                        if (/2\.0-flash/i.test(name) && !/preview|exp/i.test(name)) return 90;
                        if (/flash/i.test(name) && !/preview|exp/i.test(name)) return 70;
                        if (/pro/i.test(name) && !/preview|exp/i.test(name)) return 40;
                        return 10;
                    };
                    const aScore = score(a);
                    const bScore = score(b);
                    return bScore - aScore;
                });
                console.log('Các model khả dụng cho API Key này:', discovered);
                this._availableModels = discovered;
                return discovered;
            }

            // Default fallback candidate models
            return [
                'gemini-2.5-flash',
                'gemini-2.0-flash',
                'gemini-2.0-flash-exp',
                'gemini-1.5-flash-latest',
                'gemini-1.5-flash',
                'gemini-1.5-pro-latest',
                'gemini-1.5-pro',
                'gemini-pro',
            ];
        },

        /**
         * Send a prompt + inline image to the Gemini generateContent endpoint.
         *
         * @param {string} base64Data  Base64-encoded image bytes
         * @param {string} mimeType    e.g. "image/jpeg", "image/png"
         * @param {string} prompt      Text prompt
         * @returns {Promise<string>}  The model's text response
         */
        async callGemini(base64Data, mimeType, prompt, responseSchema) {
            if (!this.apiKey) {
                throw new Error('API key chưa được thiết lập. Vui lòng nhập API key trước.');
            }

            let cleanMime = mimeType || 'image/jpeg';
            if (cleanMime.indexOf(';') !== -1) {
                cleanMime = cleanMime.split(';')[0].trim();
            }

            const body = {
                contents: [
                    {
                        parts: [
                            { text: prompt },
                            {
                                inlineData: {
                                    mimeType: cleanMime,
                                    data: base64Data,
                                },
                            },
                        ],
                    },
                ],
                generationConfig: {
                    responseMimeType: 'application/json',
                    temperature: 0,
                    ...(responseSchema ? { responseSchema } : {}),
                },
            };

            const models = await this.getAvailableModels();
            let lastError = null;

            for (const model of models) {
                const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

                // 20-second timeout per attempt to avoid hanging
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 20000);

                try {
                    const response = await fetch(endpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                        signal: controller.signal,
                    });
                    clearTimeout(timeoutId);

                    if (!response.ok) {
                        const errorBody = await response.text().catch(() => '');
                        console.warn(`Thử model ${model} thất bại (HTTP ${response.status}):`, errorBody);

                        let parsedMsg = '';
                        try {
                            const errObj = JSON.parse(errorBody);
                            if (errObj.error && errObj.error.message) {
                                parsedMsg = errObj.error.message;
                            }
                        } catch (e) {
                            parsedMsg = errorBody;
                        }

                        if (response.status === 401 || response.status === 403) {
                            throw new Error(`API Key không hợp lệ hoặc bị chặn: ${parsedMsg}`);
                        }
                        if (response.status === 404) {
                            lastError = new Error(`Model ${model} không hỗ trợ (${parsedMsg})`);
                            continue; // Try next available model
                        }
                        if (response.status === 429) {
                            throw new Error('Đã đạt giới hạn tốc độ (Rate limit). Vui lòng thử lại sau vài giây.');
                        }
                        throw new Error(`Lỗi Google API (HTTP ${response.status}): ${parsedMsg || 'Yêu cầu không hợp lệ'}`);
                    }

                    const data = await response.json();
                    const candidates = data?.candidates;
                    if (!candidates || candidates.length === 0) {
                        throw new Error('Google Gemini không trả về dữ liệu cho ảnh này.');
                    }

                    const text = candidates[0]?.content?.parts?.[0]?.text;
                    if (!text) {
                        throw new Error('Nội dung phản hồi từ Gemini rỗng.');
                    }

                    // Success! Lock this working model
                    this._availableModels = [model, ...models.filter((m) => m !== model)];
                    return text;
                } catch (err) {
                    clearTimeout(timeoutId);
                    lastError = err;
                    if (err.name === 'AbortError') {
                        lastError = new Error(`Hết thời gian chờ kết nối (Timeout 20s) khi gọi model ${model}.`);
                    }
                    if (
                        err.message.includes('API Key không hợp lệ') ||
                        err.message.includes('Rate limit')
                    ) {
                        throw err;
                    }
                }
            }

            throw lastError || new Error('Không thể kết nối với mô hình Gemini nào khả dụng.');
        },

        /* -------------------------------------------------------------- */
        /*  _callWithRetry (internal)                                       */
        /* -------------------------------------------------------------- */

        /**
         * Wrapper around callGemini that retries once on transient failures.
         * @private
         */
        async _callWithRetry(base64Data, mimeType, prompt, responseSchema) {
            let lastError;
            for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                try {
                    return await this.callGemini(base64Data, mimeType, prompt, responseSchema);
                } catch (err) {
                    lastError = err;
                    // Don't retry on auth errors – they won't self-resolve
                    if (
                        err.message.includes('API key không hợp lệ') ||
                        err.message.includes('API key chưa được thiết lập')
                    ) {
                        throw err;
                    }
                    if (attempt < MAX_RETRIES) {
                        await delay(RETRY_DELAY_MS * Math.pow(2, attempt));
                    }
                }
            }
            throw lastError;
        },

        /* -------------------------------------------------------------- */
        /*  extractSchedule                                                 */
        /* -------------------------------------------------------------- */

        /**
         * Extract a list of student names (and optional company) from an image
         * of a training schedule or class list.
         *
         * @param {File} imageFile
         * @returns {Promise<{students: Array<{name: string, company: string}>, rawText: string}>}
         */
        async extractSchedule(imageFile) {
            const { base64Data, mimeType } = await this.prepareImage(imageFile, 'schedule');

            const prompt = `Bạn là trợ lý OCR chuyên nghiệp xử lý văn bản tiếng Việt. Hãy phân tích ảnh lịch đào tạo / danh sách lớp học này và trích xuất tất cả học viên kèm theo tên Công ty / Đơn vị tương ứng của từng người.

Yêu cầu cụ thể:
1. Trích xuất TẤT CẢ học viên có trong danh sách / bảng.
2. Với mỗi học viên, đọc chính xác thông tin Công ty / Đơn vị tương ứng trong bảng.
3. Đọc theo từng dòng từ trên xuống dưới và giữ nguyên thứ tự xuất hiện.
4. Không lấy tiêu đề, giảng viên, trợ giảng, chữ ký hoặc người phê duyệt làm học viên.
5. Soát lại số dòng trong bảng trước khi trả kết quả; không tự thêm tên không nhìn thấy rõ.

LƯU Ý CỰC KỲ QUAN TRỌNG VỀ CÔNG TY (COMPANY):
- Nếu cột Công ty có ô gộp dòng (merged cell) hoặc chỉ có 1 tên công ty duy nhất áp dụng chung cho cả khối danh sách (ví dụ ô lớn ghi 'PTSC MC' hoặc 'PTSC M&C'), thì TẤT CẢ các học viên trong danh sách đó ĐỀU THUỘC CÔNG TY ĐÓ!
- Hãy gán đúng tên công ty đó (ví dụ 'PTSC M&C') cho toàn bộ các học viên. TUYỆT ĐỐI KHÔNG TỰ BỊA RA TÊN CÔNG TY KHÁC nếu trên ảnh không có.
- Nếu không có thông tin công ty nào trong ảnh, hãy để trường "company" là "".
- Trả về kết quả dưới dạng JSON THUẦN TÚY (không có markdown, không có giải thích thêm).

Định dạng JSON trả về:
{
  "students": [
    {"name": "VO SI QUI", "company": "PTSC M&C"},
    {"name": "HOANG LE KHOA", "company": "PTSC M&C"}
  ]
}

Lưu ý:
- Giữ nguyên tên in hoa hoặc chữ hoa chuẩn.
- Chỉ trả về JSON, không thêm bất kỳ văn bản nào khác.`;

            const schema = {
                type: 'OBJECT',
                properties: {
                    students: {
                        type: 'ARRAY',
                        items: {
                            type: 'OBJECT',
                            properties: {
                                name: { type: 'STRING' },
                                company: { type: 'STRING' }
                            },
                            required: ['name', 'company']
                        }
                    }
                },
                required: ['students']
            };

            const rawText = await this._callWithRetry(base64Data, mimeType, prompt, schema);

            try {
                const parsed = safeParseJSON(rawText);
                return {
                    students: Array.isArray(parsed.students)
                        ? parsed.students
                            .map(s => ({
                                name: String(s.name || '').replace(/\s+/g, ' ').trim(),
                                company: String(s.company || '').replace(/\s+/g, ' ').trim()
                            }))
                            .filter(s => s.name.length >= 3)
                        : [],
                    rawText,
                };
            } catch (parseErr) {
                console.warn('GeminiOCR.extractSchedule – không parse được JSON:', parseErr);
                return { students: [], rawText };
            }
        },

        /* -------------------------------------------------------------- */
        /*  extractCCCD                                                     */
        /* -------------------------------------------------------------- */

        /**
         * Extract information from one or multiple Vietnamese CCCD cards
         * contained within a single image file (e.g. multiple cards laid on a table,
         * or multiple phone screens displaying CCCD).
         *
         * @param {File} imageFile
         * @returns {Promise<{cards: Array<{name: string, dob: string, idNumber: string}>, rawText: string}>}
         */
        async extractCCCD(imageFile) {
            const { base64Data, mimeType } = await this.prepareImage(imageFile, 'cccd');

            const prompt = `Bạn là trợ lý OCR chuyên nghiệp xử lý Căn cước công dân (CCCD) Việt Nam. Hãy phân tích ảnh này và trích xuất TẤT CẢ các thẻ Căn cước công dân (CCCD) / Căn cước / Thông tin thẻ CCCD hiển thị trên màn hình điện thoại có trong ảnh.

LƯU Ý CỰC KỲ QUAN TRỌNG:
- Trong một bức ảnh CÓ THỂ CHỨA NHIỀU THẺ CCCD (ví dụ: xếp nhiều thẻ trên bàn, hoặc chụp nhiều màn hình điện thoại cùng lúc).
- Bạn PHẢI quét và trích xuất TẤT CẢ TỪNG THẺ CCCD tìm thấy trong ảnh, KHÔNG ĐƯỢC BỎ SÓT THẺ NÀO.
- Với MỖI thẻ CCCD tìm thấy, hãy đọc chính xác:
  1. idNumber: Số định danh cá nhân / Số CCCD (đủ 12 chữ số)
  2. name: Họ và tên / Họ, chữ đệm và tên (giữ nguyên tiếng Việt có dấu, in hoa)
  3. dob: Ngày, tháng, năm sinh (định dạng chuẩn DD/MM/YYYY)
- Phóng to và đọc lại riêng vùng 12 chữ số. idNumber bắt buộc phải có đúng 12 chữ số; không suy đoán chữ số bị che hoặc bị mờ.
- Đối chiếu nhãn tiếng Việt và tiếng Anh trên thẻ để không nhầm ngày sinh với ngày hết hạn.
- Không lấy số nằm trong mã QR, dòng MRZ hoặc số điện thoại làm số CCCD.

Định dạng JSON trả về (BẮT BUỘC theo cấu trúc mảng cards):
{
  "cards": [
    {
      "idNumber": "077097001140",
      "name": "LÊ HOÀNG NGUYÊN LÂM",
      "dob": "16/10/1997"
    },
    {
      "idNumber": "034087003103",
      "name": "PHẠM XUÂN HÒA",
      "dob": "02/12/1987"
    }
  ]
}

Nếu chỉ có 1 thẻ CCCD trong ảnh, mảng "cards" sẽ có 1 phần tử.
Chỉ trả về JSON thuần túy, không có markdown hoặc giải thích thêm.`;

            const schema = {
                type: 'OBJECT',
                properties: {
                    cards: {
                        type: 'ARRAY',
                        items: {
                            type: 'OBJECT',
                            properties: {
                                idNumber: { type: 'STRING' },
                                name: { type: 'STRING' },
                                dob: { type: 'STRING' }
                            },
                            required: ['idNumber', 'name', 'dob']
                        }
                    }
                },
                required: ['cards']
            };

            const rawText = await this._callWithRetry(base64Data, mimeType, prompt, schema);

            try {
                const parsed = safeParseJSON(rawText);
                let cards = [];

                if (Array.isArray(parsed.cards)) {
                    cards = parsed.cards;
                } else if (Array.isArray(parsed)) {
                    cards = parsed;
                } else if (parsed.idNumber || parsed.name) {
                    cards = [parsed];
                }

                // Clean and normalize each card
                const cleanCards = cards.map(c => {
                    const digits = String(c.idNumber || '').replace(/\D/g, '');
                    return {
                        name: String(c.name || '').toUpperCase().replace(/\s+/g, ' ').trim(),
                        dob: normalizeDate(c.dob),
                        idNumber: digits.length === 12 ? digits : ''
                    };
                }).filter(c => c.name || c.idNumber);

                return {
                    cards: cleanCards,
                    rawText,
                };
            } catch (parseErr) {
                console.warn('GeminiOCR.extractCCCD – không parse được JSON:', parseErr);
                return { cards: [], rawText };
            }
        },

        /* -------------------------------------------------------------- */
        /*  extractMultipleCCCDs                                            */
        /* -------------------------------------------------------------- */

        /**
         * Process an array of CCCD image files sequentially, with progress
         * reporting and per-image error isolation.
         *
         * @param {File[]}   imageFiles
         * @param {Function} [onProgress]  Called as onProgress(currentIndex, totalCount)
         * @returns {Promise<Array<{name: string, dob: string, idNumber: string, rawText: string, fileName: string}>>}
         */
        async extractMultipleCCCDs(imageFiles, onProgress) {
            const results = [];
            const total = imageFiles.length;

            for (let i = 0; i < total; i++) {
                const file = imageFiles[i];

                if (typeof onProgress === 'function') {
                    onProgress(i, total);
                }

                try {
                    const info = await this.extractCCCD(file);
                    const cards = info.cards || [];
                    cards.forEach((card) => {
                        results.push({
                            ...card,
                            fileName: file.name,
                            rawText: info.rawText,
                        });
                    });
                } catch (err) {
                    console.error(`GeminiOCR – lỗi xử lý file "${file.name}":`, err);
                    results.push({
                        name: '',
                        dob: '',
                        idNumber: '',
                        rawText: '',
                        fileName: file.name,
                        error: err.message,
                    });
                }

                // Small courtesy delay between consecutive API calls to avoid
                // hammering the endpoint when processing many images.
                if (i < total - 1) {
                    await delay(500);
                }
            }

            // Final progress tick to signal completion
            if (typeof onProgress === 'function') {
                onProgress(total, total);
            }

            return results;
        },
    };
})();
