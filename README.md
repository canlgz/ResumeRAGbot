# ResumeRAGbot

用 **Google Apps Script（GAS）＋Google 文件＋Gemini API** 建立 LINE 互動履歷，供學生安裝、修改與測試。每位學生使用自己的帳號與 API 設定，不需要 Cloudflare 或外部向量資料庫。

第一次執行 `initializeProject`，會在學生自己的 Google Drive **自動建立含填寫指引及完整模擬履歷的文件**，並設定文件 ID 與分頁 ID。學生不必面對空白文件，也不用手動找 ID。

目前版本：**v1.6.2**。已安裝舊版請先看 [保留資料的升級步驟](docs/版本更新.md)。

## 學生從這裡開始

- **[下載最新安裝包](https://github.com/canlgz/ResumeRAGbot/releases/latest)**：全部解壓縮後，用瀏覽器開啟資料夾裡和 README.md 放在一起的 **START_HERE.html**，按鈕可複製程式與 manifest，逐階段確認結果。
- **[詳細安裝說明](docs/部署指南.md)**：瀏覽器操作，不必安裝 Node.js、Git 或 clasp。
- **[履歷填寫指南](docs/履歷填寫指南.md)**：怎麼把範例改成自己的內容、學生專題範例與 AI 整理提示詞。
- **[圖片知識庫](docs/圖片知識庫.md)**：插入作品介面、設計海報或照片，同步辨識圖片文字、構圖、配色與可見元件。
- **[作品卡片與圖片校對](docs/作品卡片與圖片校對.md)**：主人校正辨識結果、選擇公開作品預覽、接續追問，以及自動代表主題選單。
- **[聯繫與邀約通知](docs/聯繫與邀約通知.md)**：Doc Email、Google 寄信授權、LINE Your user ID 設定、實際收件與排錯。
- [安裝勾選清單](docs/開始使用.md)：逐步核對。
- [課堂實作與驗收](docs/課堂實作.md)：已知問題、未知問題、資料更新及維護練習。
- [開發與 clasp 指南](docs/開發指南.md)：修改程式及本機測試。
- [學生安裝檢查紀錄](docs/學生安裝檢查.md)：實際下載、瀏覽器測試、重現問題與修正範圍。

## 安裝流程

開始前：建議使用年滿 18 歲的個人 Gmail。Gemini API 條款要求年滿 18 歲，學校帳號也可能無法使用 AI Studio 或開放 Web App 給所有人，詳見 [準備帳號](docs/部署指南.md#0-準備帳號)。

1. 建立自己的 GAS 專案，貼入 [單檔程式 dist/Code.gs](dist/Code.gs) 與 [manifest](gas/appsscript.json)。
2. 儲存 manifest 後，從左側檔案欄點回「程式碼.gs／Code.gs」，在上方函式下拉選單選 `initializeProject` 並執行；授權時勾「選取全部」，再從記錄的「履歷文件：」網址打開自動建立的履歷。
3. 建立 LINE Messaging API 頻道及 Gemini API Key。在「專案設定 → 指令碼屬性」按「編輯指令碼屬性」，新增兩個金鑰、修改既有的 `DISPLAY_NAME`，再按「儲存指令碼屬性」。
4. 依序執行 `testLineConnection`、`checkSetup`、`syncKnowledgeBase`、`checkSetup` 與 `testResumeAnswer`。
5. 「部署 → 新增部署作業」，點「選取類型」旁的齒輪選網頁應用程式，以「我」執行、「所有人」可存取，將正式 `/exec` 網址填入 `WEB_APP_URL`。執行 `checkDeployment`，確認編輯器及正式網址版本相同、`status=ready`。
6. 執行 `showWebhookUrl`，把完整結果貼到 LINE Webhook URL，開啟 Use webhook、關閉自動回應，再掃 QR Code 加入好友測試。

7. 在 Doc 填入實際 Email，執行 `enableInvitationEmailNotifications` 完成寄信授權並收到測試信；設定 `OWNER_LINE_USER_ID` 為本頻道 Basic settings 的 Your user ID。加入自己的 bot 為好友，用「留下邀約 → 確認送出」驗收 Email 與 LINE 通知。

GitHub 存放原始碼；機器人執行在學生自己的 GAS 專案。程式不內建任何人的文件、部署網址或正式金鑰。

## 功能

| 功能 | 行為 |
| --- | --- |
| 自動建立履歷 | 首次初始化建立指引及虛構範例，重複執行不覆蓋既有內容 |
| 首頁與代表主題 | 三張小型首頁卡；固定「我是誰」「快速一覽」＋最多四個適性特色，特色來源互斥分組；同步後沿用同一份選單 |
| 肖像 | 沿用 Doc 公開介紹的肖像並準備獨立預覽；無肖像則用幾何人物，不改 Doc |
| 聯繫與邀約通知 | 第一張卡提供聯繫入口；Email 從 Doc 讀取，邀約確認後存入私人收件匣，寄 Email 並推播已設定的主人 LINE |
| RAG 問答 | 公開文字分段、768 維向量、混合排序、前五段檢索與來源引用檢查 |
| 圖片內容搜尋 | 同步時辨識公開區圖片的文字與畫面內容；作品配色、構圖及可見元件也能檢索，回覆標示圖片來源 |
| 作品圖文卡片 | 展示主人逐張開放的作品副本，可選圖追問或查看原圖；輸入「作品圖庫」開啟 |
| 圖片辨識校對 | 執行 openImageReview 開啟 20 分鐘有效的管理頁，對照原圖修正辨識並同步，不改原 Doc |
| 短期對話記憶 | 約 10 分鐘內接續詢問、選作品或指明第幾件；「清除對話」重設，快取可能提早失效 |
| 等待提示 | 請求 LINE 顯示處理中動畫 |
| 待補充問題 | 資料不足時寫回原文件，同題合併次數，保留主人註記 |
| 更新同步 | 手動或每小時同步；來源改動後停止引用舊索引 |
| 錯誤說明 | 區分 API 配額、權限、服務錯誤及 AI 回答檢查失敗 |
| 安裝診斷 | checkSetup 比對編輯器、正式部署與索引狀態；checkDeployment 可獨立核對版本，確認不同時同步會保留現有索引並停止重建 |
| 問答次數 | 不設程式自訂的每日／每小時額度，供應商限制仍適用 |

```mermaid
flowchart LR
    Student[學生初始化] --> GAS[Google Apps Script]
    GAS -->|建立範例與填寫指引| Doc[自己的 Google 文件]
    Doc -->|PUBLIC 公開文字與圖片| GAS
    GAS <-->|私有向量索引| Drive[Google Drive]
    LINE[LINE 訪客] -->|Webhook| GAS
    GAS <-->|圖片辨識、向量與回答| Gemini[Gemini API]
    GAS -->|Reply API| LINE
    GAS -->|確認邀約後 Email 與 LINE Push| Owner[履歷主人]
    GAS -->|未回答的問題| Pending[原文件待補充區]
```

## 履歷格式

內容不必遵守固定欄位；使用自然段落、標題或條列都可以。需保留獨立成行的 `[[PUBLIC]]` 與 `[[/PUBLIC]]`，只有中間的文字與嵌入圖片會供 RAG 使用。圖片在同步時先轉成可搜尋文字，詳見 [圖片知識庫](docs/圖片知識庫.md)；外部連結內容不會自動追讀。

沒有工作經驗也能用課程專題、社團或志工經驗。請看 [履歷填寫指南](docs/履歷填寫指南.md)。內建的 [完整範例](docs/模擬履歷_陳沐言_AI自動化工程師.txt) 全是虛構，正式使用時應替換為自己的真實資料。

「待補充問題」是維護清單，不是履歷事實。主人確認後，將可公開的答案補進公開區，再執行 `syncKnowledgeBase`。

## 使用範圍

本專案適合教學與小量一對一文字問答。GAS Web App 事件不提供 LINE 簽章標頭，這版以秘密 Webhook 網址保護入口，**無法驗證 X-Line-Signature**，不等同 LINE 官方建議的簽章驗證。需要嚴格驗證的服務須另設可讀取標頭的入口。[GAS 事件介面](https://developers.google.com/apps-script/guides/web) · [LINE 簽章驗證](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)

AI 呼叫同步完成，服務延遲可能超過 LINE 回覆期限；沒有自動 Push 補答；邀約通知另使用 Push API。短期記憶只幫助確認問題指向，答案仍須有履歷證據。引用檢查及自動分類不能保證所有自然語意均正確，仍需由履歷主人核對。

公開區塊與提問會交給 Gemini，未回答的問題會保存到履歷主人的文件。來源文件與索引不必公開。作品卡片公開主人選定圖片的獨立副本，公開介紹中辨識為肖像的圖片會在同步時準備首頁預覽副本；已傳送或快取的圖片無法收回。請先用虛構資料練習，費用及平台限制見 [安裝說明](docs/部署指南.md)。

## 本機開發

需要 Node.js 22 以上；瀏覽器安裝不需要這些指令。

```sh
npm ci
npm run check
npm test
npm run bundle
npm run check:bundle
npm run check:docs
```

本機測試模擬 Google、Gemini 與 LINE，不使用真實金鑰、不消耗配額、不發送訊息。測試成功不代表帳號授權與 LINE 部署已正確，仍須完成實機驗收。

`gas/` 是 18 個分檔原始碼，`dist/Code.gs` 是可直接複製的單檔版本；`START_HERE.html` 是內含該單檔及 manifest 的安裝頁。修改分檔或 `web/image-review.html` 後執行 `npm run bundle`，會先產生 ReviewUi.gs，再更新單檔與安裝頁。安裝時擇一，不要重複貼入。

## 授權

[MIT License](LICENSE)。可用於教學、修改與分享，散布時保留授權文字。模擬人物、公司與成果不代表作者或使用者的真實經歷。
