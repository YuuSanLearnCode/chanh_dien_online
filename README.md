# Linh Quang Bảo Điện — Tương Tác TikTok LIVE

Điện thờ **Thần Ganesha** (*Om Gam Ganapataye Namaha*) tương tác trực tiếp trên **TikTok LIVE**. Người xem bình luận sẽ bước vào bảo điện ngồi chiêm bái, gõ các từ khóa cầu nguyện để hiển thị **Popup & nhạc cầu nguyện** theo từng chủ đề, và khi tặng quà sẽ được **xướng tên hồi hướng** bằng giọng đọc tiếng Việt kèm bảng vinh danh Công Đức.

## Cấu trúc dự án

| Đường dẫn | Mô tả |
|---|---|
| `start.bat` | File khởi động nhanh toàn bộ hệ thống chỉ với 1 cú nhấp đúp |
| `live/server.mjs` | Server Node.js kết nối phòng TikTok LIVE, lọc ngôn từ, tạo giọng đọc TTS và đồng bộ WebSocket |
| `live/overlay.html` | Màn hình hiển thị 9:16 (`1080×1920`) cho TikTok LIVE Studio / OBS |
| `live/control.html` | Bảng điều khiển trực tiếp: kết nối kênh, chỉnh âm lượng 4 kênh, giả lập sự kiện, quản lý bot |
| `assets/` | Hình ảnh bảo điện, nhân vật, hiệu ứng (`assets/Popup/`) và âm thanh cầu nguyện (`assets/music/`) |

## Hướng dẫn khởi chạy

Yêu cầu cài đặt **Node.js 20+**.

### Cách 1: Chạy nhanh bằng `start.bat` (Khuyên dùng)
Nhấp đúp vào file **`start.bat`** ở thư mục gốc. Script sẽ tự động:
1. Cài đặt thư viện (nếu chạy lần đầu).
2. Giải phóng cổng `3000` nếu có tiến trình cũ đang chạy.
3. Mở **Bảng điều khiển** (`http://localhost:3000/live/control.html`) và **Màn hình Overlay** (`http://localhost:3000/live/overlay.html`).
4. Khởi động server và tự động kết nối vào phòng TikTok LIVE đã cấu hình.

### Cách 2: Chạy bằng dòng lệnh
```bash
cd live
npm install
node server.mjs
```

### Đưa lên TikTok LIVE Studio / OBS
- Trong **TikTok LIVE Studio**: Chọn **Thêm nguồn (Add source) → Liên kết (Link)** → Nhập `http://localhost:3000/live/overlay.html` → Chọn độ phân giải tùy chỉnh **`1080 × 1920`**.
- Trong **OBS Studio**: Chọn **Browser Source** → URL `http://localhost:3000/live/overlay.html`, Width `1080`, Height `1920`.

## Tính năng tương tác trên LIVE

- **Bình luận vào bảo điện**: Người xem bình luận bất kỳ sẽ có nhân vật bước vào ngồi chiêm bái (hỗ trợ tối đa 100 chỗ ngồi tự động co giãn `24 → 36 → 64 → 100`).
- **6 chủ đề Popup & Nhạc cầu nguyện**: Khi người xem bình luận có chứa một trong 6 nhóm từ khóa sau, hệ thống sẽ bật Popup hình ảnh Thần Ganesha kèm nhạc cầu nguyện tương ứng:
  - **Cầu tài** (`cầu tài`, `tài lộc`, `phát tài`, `tiền tài`)
  - **Xóa nợ** (`xóa nợ`, `trả nợ`, `hết nợ`, `nợ nần`)
  - **Cầu duyên** (`cầu duyên`, `tình duyên`, `nhân duyên`, `lương duyên`, `xin duyên`)
  - **Cầu tự** (`cầu tự`, `cầu con`, `con cái`)
  - **Bình an** (`bình an`, `cầu an`)
  - **Giải hạn** (`giải hạn`, `tai ương`, `hết xui`, `xả xui`, `giải xui`)
- **Tặng quà & Xướng tên hồi hướng**:
  - Tự động gom chuỗi combo quà tặng để hiển thị và đọc đúng tổng số lượng.
  - Giọng đọc tiếng Việt xướng tên tín chủ dâng lễ vật lên Thần Ganesha kèm lời chúc theo chủ đề cầu nguyện và cộng điểm vào bảng **Công Đức**.
- **Điều khiển âm thanh độc lập**:
  - 4 thanh kéo âm lượng thời gian thực trên Bảng điều khiển: **Nhạc nền**, **Nhạc Popup**, **Giọng đọc / Kinh định kỳ**, **Chuông & Mõ**.
  - Tự động hạ nhỏ nhạc nền và ưu tiên giọng đọc cảm ơn người tặng quà hoặc Popup cầu nguyện khi đang phát kinh định kỳ.
- **Bộ lọc an toàn**: Tự động chặn các bình luận chứa từ ngữ nhạy cảm/vi phạm và chỉ đọc lời chúc chuẩn của bảo điện.
