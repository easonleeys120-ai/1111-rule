# 後台建置：Google Sheets + Apps Script

這個資料夾是 `index.html` 的後端。部署完後，簡報裡三個「寫入後台」按鈕會真的寫進 Google 試算表，重新整理也會從試算表讀回來。

## 一、建立試算表

後台資料建議放在這個 Google Drive 資料夾（可直接在此資料夾建立）：
👉 https://drive.google.com/drive/folders/1ksexf0n1VsIbtYOzI5XELP8wEbwbsaXB?usp=drive_link

一鍵建立（直接在該資料夾開新試算表）：
👉 https://docs.google.com/spreadsheets/create?folder=1ksexf0n1VsIbtYOzI5XELP8wEbwbsaXB

1. 點上面連結 → 命名為 `1111-rule 後台`（會自動落在該資料夾）
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
| 更新 | `POST /exec`，`action:"update"` + `id` | 依 log_id 找列並覆寫（會議記錄編輯用） |

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

## 八、每日 08:00 LINE 推播（鋰電市場 + 每日提醒）

把鋰電市場情報與當日填報摘要每天 08:00 推到 LINE。

### 1. 建立 LINE Messaging API 頻道
1. 到 https://developers.line.biz/console/ → **Create a new provider**（若沒有）
2. **Create a new channel → Messaging API**
3. 頻道設定頁 → **Messaging API** 分頁 → **Issue** 一個 **Channel access token (long-lived)**，複製起來
4. 把你的 LINE 帳號加為好友（用 QR code），並取得你的 **User ID**（或群組的 Group ID）

### 2. 把 token / 收件人寫進 Apps Script
Apps Script → **專案設定 → 指令碼屬性 → 新增指令碼屬性**：
- `LINE_CHANNEL_TOKEN` = 上面的 long-lived token
- `LINE_RECIPIENT_IDS` = 收件人 ID，多人用逗號分隔（例：`U1234...,U5678...`）

### 3. 啟用排程
回到試算表 → 選單 **⚙️ 1111-rule 後台 → 2. 設定每日 08:00 LINE 推播** → 會建立 time-driven trigger。

之後每天 08:00（Asia/Taipei）會自動把：
- 當日填報摘要（成員 + 任務）
- 最新 3 筆鋰電市場情報
- **產業新聞**：透過 Google News 自動聚合 CNN / BBC / UDN / Digitimes 等來源的鋰電池、儲能、BESS 相關頭條（不需手動貼連結）

推送到 LINE。

### 4. 手動測試
Apps Script 編輯器 → 函式下拉選 `dailyPush` → **執行**，看 Logger 與 LINE 是否收到。

### 常見問題
- **收不到**：確認 Channel access token 有效、收件人已加 Bot 為好友、`LINE_RECIPIENT_IDS` 沒有多餘空格
- **要改時間**：刪除舊 trigger（Apps Script → 觸發條件）後重跑 `setupDailyPush`，或直接改 `atHour(8)`
- **推播內容要客製**：改 `dailyPush()` 裡的 `text` 組字邏輯

## 九、會議記錄更新上傳

會議紀錄支援「更新」：前端或任何客戶端送
```json
{
  "action": "update",
  "sheet": "meeting",
  "id": "MTG-20261113-001",
  "payload": { "title": "新主題", "decision": "新決策", "owner": "Kevin" }
}
```
Apps Script 會依 `log_id` 找到該列並覆寫。前端如需編輯 UI，可呼叫此端點。

| 症狀 | 原因 / 解法 |
|---|---|
| 狀態燈「後台連線失敗」 | 網址不是 `/exec` 結尾、部署時沒選「任何人」、或部署後沒重新部署新版本 |
| `TOKEN_INVALID` | `BACKEND.token` 與指令碼屬性 `TOKEN` 不一致 |
| `找不到試算表` | 指令碼不是在該 Sheet 內建立，需補 `SPREADSHEET_ID` 指令碼屬性 |
| 寫入後表格沒更新 | 按右上「🔄 重新同步」 |
| 中文變亂碼 | 確認 `Code.gs` 以 UTF-8 儲存；Apps Script 編輯器貼上即可 |
