## Why

v3.0.0 的人資模式已完成「三題 → 證據熱圖」。`ResumeRAGbot/docs/安裝後延伸思考.md` 列出三個後續方向：貼整份職缺說明、逐項檢索、把結果帶入邀約。本變更把三項一起實作為 v3.1.0，讓人資更快輸入條件、取得較完整的依據，並能直接請本人說明待確認條件。

## What Changes

- **貼職缺說明（JD）**：第 2 題可改按「貼職缺說明」，貼上 2000 字以內的職缺說明。Gemini 拆出必要／加分條件，每項必須附職缺原文；程式逐項比對原文，找不到的項目與非工作條件（年齡、性別、婚育、宗教、健康、國籍等）一律略過。拆解結果進入確認卡，職缺說明原文不保存。
- **確認卡可刪改**：確認卡新增「移除：<需求>」按鈕與「修改需求」。修改時回到第 2 題並顯示目前內容，可「沿用目前」。全部移除時回到第 2 題。
- **逐項對照**：確認卡新增「逐項對照」。每項需求各自檢索（一次批次嵌入請求、每項取前 4 段、合併去重後最多 12 段），再呼叫一次生成。摘要標示「逐項檢索」。
- **帶入邀約**：分析完成後，待確認訊息的 Quick Reply 多一個「帶入邀約」。按下後開始 LINE 邀約，第 2 題（職缺或合作內容）預先帶入「應徵職位＋待確認條件」，可直接採用或補充。仍須訪客確認才保存與通知。
- 發佈 v3.1.0：版本號、單檔安裝包、升級指南、README、CHANGELOG、說明與隱私文字。

## Capabilities

### Modified Capabilities

- `hr-review-mode`：新增 JD 拆解、確認卡刪改、逐項對照、帶入邀約；分析完成後保留「職位＋待確認條件」於同一份快取草稿至到期。

## Impact

- 修改程式：ResumeRAGbot/gas/HrReview.gs、ResumeRAGbot/gas/Contact.gs（邀約草稿 carry 欄位、`startCarriedInvitation_`、`hr:invite:` 不清除邀約）、ResumeRAGbot/gas/Gemini.gs（`embedQueries_`）、ResumeRAGbot/gas/Line.gs（說明與隱私文字）、ResumeRAGbot/gas/Config.gs（3.1.0）。
- 不新增 .gs 檔、指令碼屬性或 OAuth 權限；仍為 19 個 .gs。
- 外部服務：JD 拆解每次 1 次 generateContent；逐項對照每次 1 次 batchEmbedContents（N 筆）＋1 次 generateContent。
- 測試：ResumeRAGbot/test/hr-review.test.mjs 擴充。
