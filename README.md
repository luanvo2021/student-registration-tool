# HSEQ - Công Cụ Quản Lý & Xuất Danh Sách Học Viên Tự Động Qua Ảnh CCCD & Schedule

Công cụ hỗ trợ trung tâm đào tạo tự động hóa quy trình lập biểu mẫu **"COURSE REGISTRATION & ATTENDANCE"** bằng cách nhận diện thông tin học viên qua ảnh chụp lịch học (Schedule) và ảnh Căn cước công dân (CCCD) sử dụng trí tuệ nhân tạo (Google Gemini Vision AI).

---

## 🌟 Tính Năng Nổi Bật

1. **Nhập thông tin khóa học linh hoạt**:
   - Course Title (Tên khóa học: TBOSIET, HUET, BOSIET...)
   - Loại chứng chỉ: OPITO hoặc PV College/Others
   - Ngày diễn ra (Date: VD `11-13/11/2026`)
   - Giảng viên (Instructor) và Trợ giảng (Assistant)
   - Tên công ty mặc định (VD `PTSC M&C`)

2. **Quét ảnh lịch học (Schedule)**:
   - Tải lên ảnh chụp bảng danh sách học viên trong lịch đào tạo.
   - AI tự động trích xuất danh sách họ và tên của toàn bộ học viên.
   - Hỗ trợ sửa tên, xóa, hoặc thêm học viên thủ công nếu cần.

3. **Quét ảnh Căn cước công dân (CCCD)**:
   - Cho phép nạp nhiều ảnh CCCD cùng lúc (chụp từ điện thoại, scan, ảnh thẻ cứng...).
   - AI nhận diện chính xác: **Họ và tên**, **Ngày sinh (DD/MM/YYYY)**, **Số CCCD (12 số)**.
   - Thuật toán chuẩn hóa tiếng Việt thông minh (xóa dấu, so khớp họ tên) tự động ghép nối thông tin CCCD vào đúng người trong danh sách lịch học (ngay cả khi tên trong danh sách không dấu và CCCD có dấu).

4. **Xử lý và cảnh báo thiếu thông tin**:
   - Nếu học viên có tên trong danh sách nhưng **chưa có ảnh CCCD**: Hệ thống tự động để trống thông tin Ngày sinh & Số CCCD theo đúng yêu cầu.
   - Hiển thị danh sách cảnh báo rõ ràng trên giao diện trực quan.
   - Cảnh báo nếu có ảnh CCCD không thuộc danh sách học viên.

5. **Xem trước và Xuất file Word (DOCX)**:
   - Bảng xem trước trực quan cho phép chỉnh sửa trực tiếp mọi ô thông tin.
   - Xuất file `.docx` định dạng chuẩn theo form gốc:
     - Header chuẩn HSEQ Center và mã form `HSEQ.FRM.1.5E`.
     - Thông tin khóa học và bảng điểm danh khổ ngang (Landscape).
     - Tự động tách các cột ngày điểm danh tương ứng theo khoảng ngày (VD: `11/11`, `12/11`, `13/11`).
     - Tự động sinh tối thiểu 20 dòng bảng chuẩn với ô chữ in hoa (UPPERCASE).
     - Khung chữ ký Instructor và Assistant xác nhận.

6. **Chế độ Dữ liệu mẫu (Demo)**:
   - Có nút **"Tải dữ liệu mẫu (Demo)"** giúp bạn thử nghiệm ngay lập tức toàn bộ quy trình mà không cần chuẩn bị file trước.

---

## 🚀 Hướng Dẫn Sử Dụng

### Cách 1: Chạy nhanh qua file `start.bat`
1. Nhấp đúp chuột vào file `start.bat`.
2. Trình duyệt sẽ tự động mở trang web tại địa chỉ: `http://localhost:8080`.

### Cách 2: Mở trực tiếp
Mở trực tiếp file `index.html` bằng Google Chrome, Microsoft Edge hoặc bất kỳ trình duyệt nào.

---

## 🔑 Cài Đặt Gemini API Key
Để tính năng quét ảnh hoạt động:
1. Nhấn nút **"Cài đặt API Key"** ở góc dưới thanh điều hướng bên trái.
2. Dán mã Google Gemini API Key của bạn vào (hoàn toàn miễn phí lấy tại [Google AI Studio](https://aistudio.google.com/)).
3. Nhấn **Lưu**. API Key được lưu an toàn trên trình duyệt của bạn (Local Storage) cho các lần sau.

---

## 📁 Cấu Trúc Thư Mục Dự Án
```
student-registration-tool/
├── index.html          # Giao diện chính người dùng
├── start.bat           # File khởi chạy nhanh máy chủ web
├── css/
│   └── style.css       # Giao diện hiện đại, trực quan
├── js/
│   ├── app.js          # Logic điều phối chính, ghép nối tên và kiểm tra thiếu
│   ├── gemini.js       # Module tích hợp Gemini Vision OCR nhận diện CCCD & Lịch
│   └── export.js       # Module xuất file DOCX chuẩn form HSEQ.FRM.1.5E
└── images/             # Ảnh mẫu trích xuất từ tài liệu mẫu của bạn
```
