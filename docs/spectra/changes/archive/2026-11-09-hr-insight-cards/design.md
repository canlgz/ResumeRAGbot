## Context

v3.1 的人資模式（gas/HrReview.gs）以快取草稿收集職缺條件，產生「技能 × 需求」證據熱圖，所有 AI 輸出都要通過 `quoteSource_` 原文核對。索引（`loadIndex_`）中的每個片段有 `id`、`section`（Doc 標題）、`text`，圖片片段另有 `imageKey`。模擬履歷的標題形如「工作經歷一：AI 應用工程師（虛構測試資料）」「專案二：每週營運報表自動化（虛構測試資料）」，日期寫成「2024 年 7 月至 2026 年 9 月」。LINE 一次回覆最多 5 則訊息，Quick Reply 最多 13 項。

## Goals / Non-Goals

**Goals:**

- 人資不必填三題，就能直接看到「經歷時間軸」與「成果拆解」，結果都只來自可核對的履歷原文。
- 熱圖對照完成後一鍵產生可轉傳的主管摘要。
- 空窗、重疊、短期任職的判斷是可重現的程式計算。

**Non-Goals:**

- 不做多位求職者比較、面試評分表或時段預約。
- 不推測空窗原因，不詢問個人、家庭、健康等原因，不把疑點當成扣分。
- 不保存時間軸或成果拆解的結果；不新增權限、指令碼屬性或索引格式，不需重新同步。
- 轉給主管不呼叫 LINE 分享 API（LIFF），只產生可長按複製的文字。

## Decisions

### Insight commands are stateless and live in HrInsights.gs

時間軸與成果拆解不建立草稿，由 `handleHrInsight_` 在 `handleHrReview_` 的草稿邏輯之前處理，不改變進行中的人資草稿；重送事件由既有的 `claimEvent_` 排除。放在新檔 gas/HrInsights.gs，避免 HrReview.gs 超過 800 行。替代方案「全部寫進 HrReview.gs」可維持 19 個檔，但單檔過長；單檔安裝的學生不受檔案數影響，分檔安裝只需多建一個檔。

### Timeline flags are computed in code from verified dates

Gemini 只負責把段落整理成 `entries[{kind, title, start, end, id, quote}]`；程式核對 quote（統一標點後必須是片段的連續原文，比 `quoteSource_` 的 80% 覆蓋率嚴格，避免日期或數字被改一個字仍通過）、核對 quote 中確實出現該年份與月份、`present` 必須有「至今／迄今／目前／現在／在職／present／now」字樣。空窗、重疊、短期任職全由程式以月份序號計算。替代方案「請 AI 直接列出疑點」無法保證可重現，也可能帶入對個人原因的推測，因此不採用。

### Year-only dates use conservative bounds

只有年份的期間，在空窗計算中視為 1 月到 12 月（讓空窗變短），並且不參與重疊與短期任職判斷，避免精度不足造成誤報。

### Timeline and STAR read chunks directly without embedding

時間軸取「含 4 位數年份的非圖片片段」依文件順序最多 12 段；成果拆解取所選標題的全部非圖片片段（最多 4 段）。兩者都不需向量查詢，各只有 1 次 Gemini 生成。替代方案「以向量檢索」可能漏掉沒有語意相似度的日期段落。

### STAR cells show verified quotes, not AI paraphrase

每格只顯示通過核對的原文（截至 80 字），不顯示 AI 摘要，避免改寫失真。結果格沒有阿拉伯數字、百分比或中文數量詞時另標「成果未量化」。

### Forward summary is built deterministically at analysis time

摘要在熱圖完成時由程式依優先順序（有依據 → 待確認 → 第一題面談問題 → 來源）逐項填入，總長不超過 300 字，放不下的以「等 N 項」標示；存在同一份人資快取草稿的 `forward` 欄位，到期即失效。按「轉給主管」不呼叫 AI。

## Implementation Contract

**行為**

- 「經歷時間軸」「時間軸」文字或 `hr:timeline` postback：回覆 Flex 時間軸（每筆：期間、類型、標題、疑點標籤；底部聲明「空窗、重疊或短期任職可能有正當原因，只是面談時可確認的提示，不是評價。」）與一則文字（疑點提示、最多 3 題建議面談問題、資料來源）。
- 「成果拆解」文字或 `hr:star` postback：文字訊息「請選擇要拆解的專案或經歷：」附最多 8 個 Quick Reply（`hr:star:<sha256(section) 前 16 碼>`），標籤取「：」之後、去掉「（…）」，最多 20 字。`hr:star:<id>`：回覆 Flex 四格卡（情境 S、任務 T、行動 A、結果 R）與追問文字，Quick Reply 最前面有「換一個專案」(`hr:star`)。
- 熱圖對照完成：待確認訊息 Quick Reply 依序為「帶入邀約」「轉給主管」再接一般 Quick Reply；`hr:forward:<draftId>` 回覆兩則文字：「以下摘要可長按複製，轉傳給用人主管：」與摘要本文。草稿不清除，之後仍可「帶入邀約」。
- 人資第 1 題 Quick Reply：「經歷時間軸」(`hr:timeline`)、「成果拆解」(`hr:star`)、「取消」。

**資料形狀**

- 時間軸 Gemini schema：`{ entries: [{ kind: 'work'|'education'|'project'|'other', title, start: 'YYYY' | 'YYYY-MM', end: 'YYYY' | 'YYYY-MM' | 'present', id, quote }] }`，最多保留 12 筆，依 start 排序。
- 疑點：`{ type: 'gap'|'overlap'|'short', from, to, months, titles }`，最多 6 筆。空窗只看 work 與 education，間隔月數大於 6；重疊與短期只看月份精確的 work；短期為已結束且含頭尾月數少於 12。
- STAR Gemini schema：`{ situation, task, action, result }`，每格 `{ id, quote }`。
- 草稿：完成對照後的人資草稿多一個 `forward` 字串欄位（≤300 字）。

**失敗模式**

- 索引不存在：「履歷資料正在準備中，請稍後再來，或直接與本人聯繫。」；來源與索引指紋不同（生成前後都檢查）：「履歷資料正在等待同步，請稍後再試。」
- 沒有含年份的片段：「履歷中沒有找到可整理成時間軸的日期。」，不呼叫 AI；所有 entries 都核對失敗：「沒能從履歷整理出可核對的經歷期間。」
- 沒有專案或經歷標題：「履歷中沒有找到專案或經歷段落。」；`hr:star:<id>` 找不到標題：「這個專案已不在目前的履歷中，請重新選擇「成果拆解」。」
- Gemini 錯誤或格式不符：只記錄錯誤碼（`HR_TIMELINE_INVALID_FORMAT`、`HR_STAR_INVALID_FORMAT` 或既有 API 錯誤碼），回覆可重試的訊息。
- `hr:forward` 草稿過期或 ID 不符：「這份人資對照結果已過期。可以重新進行「人資模式」。」

**驗收**

- `npm test` 新增 test/hr-insights.test.mjs，涵蓋 specs 中每個 scenario；`npm run check`、`npm run check:bundle`、`npm run check:docs` 通過。

**範圍**

- 範圍內：上述三項功能、入口、說明與隱私文字、版本 3.2.0、打包與文件。
- 範圍外：既有熱圖、JD 拆解、逐項對照與帶入邀約的行為不變；不改索引格式。

## Risks / Trade-offs

- [Gemini 把日期正規化錯誤] → 年份與月份都必須出現在已核對的原文中，否則整筆略過。
- [詢問空窗可能觸及個人隱私] → 問題模板固定註明「不需說明個人原因」，只請本人補充與工作相關的經歷。
- [含年份片段超過 12 段時漏掉較晚的經歷] → 依文件順序取前 12 段；一般履歷經歷段落少於 12 段（模擬履歷含年份的段落共 6 段：工作 2、專案 3、學歷 1）。
- [摘要含人資輸入的需求名稱] → 只存在快取草稿至到期，隱私說明同步揭露。
