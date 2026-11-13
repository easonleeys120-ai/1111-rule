# 後台建置：Google Sheets + Apps Script

這個資料夾是 `index.html` 的後端。部署完後，簡報裡三個「寫入後台」按鈕會真的寫進 Google 試算表，重新整理也會從試算表讀回來。

## 一、建立試算表

1. 開啟 https://sheets.new ，建立一份新試算表（例：`1111-rule 後台`）。
2. 選單 **擴充功能 → Apps Script**。
3. 刪掉預設的 `myFunction`，把 `Code.gs` 全部內容貼上。
4. 按 💾 儲存（專案名稱可改為 `1111-rule-backend`）。

## 二、初始化工作表

1. 上方函式下拉選 `setup` → 按 **執行**。
2. 第一次會要求授權：**檢閱權限 → 選帳號 → 進階 → 前往（不安全）→ 允許**。
   （出現「不安全」是因為這是你自己建、未經 Google 驗證的指令碼，正常現象。）
3. 回到試算表，會看到三張工作表：`每日提醒`、`會議紀錄`、`市場情報`，各有表頭。

## 三、部署為 Web App

1. Apps Script 右上 **部署 → 新增部署作業**。
2. 類型選齒輪 → **網頁應用程式**。
3. 設定：
   - **說明**：`v1`
   - **執行身分**：`我`
   - **具有存取權的使用者**：`任何人`
4. **部署** → 複製 `.../exec` 結尾的網址。

> 一定要選「任何人」，否則靜態網頁（沒有 Google 登入）無法呼叫。
> 若之後改了 `Code.gs`，要 **部署 → 管理部署作業 → 編輯（鉛筆）→ 版本：新版本 → 部署**，網址才會更新。

## 四、填回前端

打開 `index.html`，找到 `<script>` 最上方的設定區：

```js
const BACKEND = {
  url: '',      // ← 貼上 /exec 網址
  token: '',    // ← 選用，見下方
  limit: 20
};
```

貼成：

```js
const BACKEND = {
  url: 'https://script.google.com/macros/s/AKfycb....../exec',
  token: '',
  limit: 20
};
```

存檔、重新整理即可。右上角狀態燈會變成 **後台已連線（N 筆）**。

## 五、（選用）加上寫入密碼

Web App 公開後，任何知道網址的人都能寫入。加一組共享 token 可以擋掉亂寫：

1. Apps Script：**專案設定 → 指令碼屬性 → 新增指令碼屬性**
   - 屬性：`TOKEN`
   - 值：自訂字串，例如 `mkt2026-secret`
2. 前端 `BACKEND.token` 填入同一個字串。

> 這是「降低誤用」不是真正的權限控管 — 前端原始碼看得到 token。要正式權限請改用 Google 登入驗證或 Supabase。

## 六、API 規格（除錯用）

同一個 `/exec` 網址：

| 動作 | 請求 | 說明 |
|---|---|---|
| 健康檢查 | `GET /exec?action=ping` | 回 `{"ok":true,...}` |
| 讀取 | `GET /exec?action=list&sheet=daily&limit=20` | `sheet` = `daily` / `meeting` / `report` |
| 寫入 | `POST /exec`，body 見下 | 回應會帶入庫後的 `record` |

```json
{
  "action": "submit",
  "sheet": "daily",
  "payload": { "user": "Elena (海外/儲能)", "task": "完成東南亞換電櫃型錄校對" }
}
```

各模組的 `payload` 欄位：

- `daily`：`user`、`task`
- `meeting`：`title`、`decision`、`owner`
- `report`：`title`、`category`、`summary`

回應範例：

```json
{
  "ok": true,
  "sheet": "daily",
  "record": {
    "time": "09:15:22",
    "log_id": "REM-20261113-001",
    "user": "Elena (海外/儲能)",
    "task": "完成東南亞換電櫃型錄校對",
    "status": "Submitted_On_Time"
  }
}
```

## 七、常見問題

| 症狀 | 原因 / 解法 |
|---|---|
| 狀態燈「後台連線失敗」 | 網址不是 `/exec` 結尾、部署時沒選「任何人」、或部署後沒重新部署新版本 |
| `TOKEN_INVALID` | `BACKEND.token` 與指令碼屬性 `TOKEN` 不一致 |
| `找不到試算表` | 指令碼不是在該 Sheet 內建立，需補 `SPREADSHEET_ID` 指令碼屬性 |
| 寫入後表格沒更新 | 按右上「🔄 重新同步」 |
| 中文變亂碼 | 確認 `Code.gs` 以 UTF-8 儲存；Apps Script 編輯器貼上即可 |
