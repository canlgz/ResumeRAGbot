## Why

老師在 W10 課堂示範並要求 v3：在 LINE 履歷機器人加入「人資」入口，讓人資回答三個問題後，取得一張「技能 × 需求」證據熱圖，快速掌握求職者與職缺的對應程度。v2.0.0 的 `ResumeRAGbot/docs/安裝後延伸思考.md` 已提出「職缺需求 → 逐項對照履歷證據 → 待確認 → 面談問題」的方向，但尚未實作；本變更把兩者合併為正式的 v3.0.0。

## What Changes

- 新增「人資模式」入口：首頁第三張卡片按鈕、固定 Quick Reply 項目，以及文字「人資」「人資模式」都可開啟。
- 新增三題問答流程（逐步填寫、30 分鐘內有效、可取消、可重新填寫、最後有確認卡）：
  1. 應徵職位
  2. 必要技能或條件（可一次輸入多項）
  3. 加分條件或工作情境（可略過）
- 確認後，以 Gemini 對照公開履歷，回覆：
  - 技能 × 需求熱圖（LINE Flex 色塊表格）：列為人資需求（最多 5 項），欄為履歷技能（最多 5 項），每格分四級——明確證據、相關經驗、間接、未提及。
  - 每個非「未提及」格子都必須有可核對的履歷原文；核對失敗的格子降為「未提及」並列入「待確認」。
  - 待確認條件清單與 3 題以內的面談建議問題（文字訊息），並附資料來源段落。
- 熱圖只表示「公開履歷中的證據強度」，明確標示不是錄取分數，也不代表未提及的能力本人不具備。
- 人資填寫內容可送交 Gemini 分析，但只存在約 30 分鐘的快取草稿中，不寫入 Doc、不存入邀約收件匣、不寫入執行記錄。
- 發佈 v3.0.0：版本號、單檔安裝包、v2→v3 升級指南、README、CHANGELOG、使用說明與隱私說明更新。

## Non-Goals (optional)

（見 design.md 的 Goals / Non-Goals）

## Capabilities

### New Capabilities

- `hr-review-mode`: 人資模式入口、三題職缺問答流程、證據核對後的技能 × 需求熱圖、待確認條件與面談問題，以及人資輸入的暫存與隱私規則。

### Modified Capabilities

（無；目前專案尚無既有規格）

## Impact

- 新增程式：ResumeRAGbot/gas/HrReview.gs（草稿狀態、Gemini 對照、引用核對、熱圖 Flex 組裝）。
- 修改程式：
  - ResumeRAGbot/gas/Webhook.gs：`handleEvent_` 在聯繫流程之後、一般 RAG 之前呼叫人資流程。
  - ResumeRAGbot/gas/Line.gs：首頁第三卡加「人資模式」按鈕；`quickReply_` 在主題項目之後附加固定的「人資模式」動作（不加入履歷主題清單，避免觸發 RAG）；`helpText_`、`privacyText_` 補充人資模式說明。
  - ResumeRAGbot/gas/Contact.gs：`handleContact_` 遇到人資模式指令時結束未完成的邀約草稿並交出處理權，避免邀約草稿吞掉人資指令。
  - ResumeRAGbot/gas/Config.gs：`appVersion_` 改為 3.0.0。
- 建置：ResumeRAGbot/scripts/bundle.mjs 的檔案順序加入 HrReview；重新產生 ResumeRAGbot/dist/Code.gs 與安裝頁。
- 測試：新增 ResumeRAGbot/test/hr-review.test.mjs；必要時調整既有首頁、Quick Reply 測試。
- 文件：ResumeRAGbot/README.md、ResumeRAGbot/CHANGELOG.md、ResumeRAGbot/docs/版本更新.md、ResumeRAGbot/docs/安裝後延伸思考.md、ResumeRAGbot/package.json 版本。
- 外部服務：每次確認送出多一次 Gemini generateContent 呼叫（使用既有 GEMINI_API_KEY，不新增權限或指令碼屬性）。
