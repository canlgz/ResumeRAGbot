## Context

ResumeRAGbot v2.0.0 是部署在 Google Apps Script 的 LINE 履歷機器人：訪客問題經 `handleEvent_`（ResumeRAGbot/gas/Webhook.gs）依序分流——聯繫與邀約（`handleContact_`）、清除對話、首頁、說明、隱私、社交對話，最後才進入 RAG 問答（`answerLineConversation_` → `answerResult_`）。

現況要點（已讀原始碼確認）：

- 邀約流程以 `CacheService` 草稿（30 分鐘）、`pending_` 指令碼屬性旗標、`lastEvent` 冪等、確認卡與 `invite:submit|restart|skip|cancel` postback 實作多步驟填寫；草稿未完成時，任何文字訊息都被當成欄位內容，非文字的 postback 會重送目前題目。
- Quick Reply（`quickReply_`）與首頁第三卡的導覽按鈕都由 `visibleMenuTopics_()` 產生，每項都是 `topic:<id>` postback，會進入 RAG；既有測試斷言基本項目為「我是誰」「快速一覽」。
- 回答的引用核對由 `quoteSource_(quote, hits, preferredId)` 判定原文是否確實出現在檢索片段；`validateAnswer_` 在任何引用失敗時整題丟出錯誤。
- 公開來源上限為 100 段、60,000 字（`checkSourceSize_`）；檢索 `rankChunks_` 預設 `topK: 5`。
- 單檔安裝包由 ResumeRAGbot/scripts/bundle.mjs 依固定檔名順序串接成 ResumeRAGbot/dist/Code.gs；版本號來自 `appVersion_()`。

需求來源：老師 W10 示範（「人資」按鈕 → 三個問題 → 技能 × 需求熱圖），以及 ResumeRAGbot/docs/安裝後延伸思考.md 的 v3 流程。

## Goals / Non-Goals

**Goals:**

- 人資在 LINE 內 3 步填完職缺條件，約一次等待後取得可閱讀的熱圖、待確認清單與面談問題。
- 每個有顏色的熱圖格子都能追溯到公開履歷原文；無法核對的內容不會被顯示成證據。
- 不新增指令碼屬性、OAuth 權限或外部服務；學生由 v2 升級時只需替換程式並重新部署。

**Non-Goals:**

- 不產生錄取分數、總分、排名或「是否適任」結論。
- 不支援貼整份職缺說明（JD）由 AI 自動拆解需求（討論中的選項 B 已否決）；需求列只來自人資在第 2、3 題輸入的文字。
- 不保存分析結果供日後查詢，不寫入 Doc、私人收件匣或 Drive 索引。
- 不產生圖片檔或外部網頁版熱圖。
- 不改動既有 RAG 問答、主題分類、作品卡片與邀約通知的行為（除了邀約草稿遇到人資指令時讓出處理權）。

## Decisions

### 人資模式草稿沿用邀約草稿模式

新增 ResumeRAGbot/gas/HrReview.gs，提供 `handleHrReview_(event, text, cfg, prepared)`：回傳訊息陣列表示已處理，回傳 `null` 表示交給後續流程。草稿存在 `CacheService`，鍵為 `hr:` + sha256(scriptId + docId + userId)，有效 1800 秒；另以不含內容的 `pending_` 屬性旗標偵測快取提早過期，行為同邀約。

替代方案：把三題做成一般 RAG 多輪對話——無法保證題序、取消與確認，否決。

### 人資指令與邀約草稿互斥

同一位訪客同時只能有一份進行中的草稿。`handleContact_` 遇到人資指令（`hr:` 開頭的 postback，或文字「人資」「人資模式」）時，清除邀約草稿與旗標並回傳 `null`；人資流程遇到 `invite:start`、`nav:contact`、首頁、主題、作品、清除對話等指令時，清除人資草稿並交出處理權。在 `handleEvent_` 中，人資流程排在 `handleContact_` 之後、清除對話之前。

替代方案：兩份草稿並存——下一則文字無法判定屬於哪一份，否決。

### 三題的固定欄位與輸入限制

| 步驟 | 欄位鍵 | 題目 | 字數上限 | 可略過 |
| --- | --- | --- | --- | --- |
| 1 / 3 | `role` | 應徵職位 | 50 | 否 |
| 2 / 3 | `required` | 必要技能或條件（可換行或以「、，,；;」分隔多項） | 300 | 否 |
| 3 / 3 | `bonus` | 加分條件或工作情境 | 300 | 是（`hr:skip:<id>`） |

超過上限時回覆提示並停留在同一題。第 2 題拆解後沒有任何非空項目時，提示重新輸入。

### 需求列由程式拆解而非 AI 拆解

`hrRequirements_(fields)` 以分隔字元拆解 `required` 與 `bonus`，去除空白與重複，必要條件在前、加分條件在後，標記 `kind: 'required' | 'bonus'`，最多保留 5 項；超過時在確認卡註明「只對照前 5 項」。每項需求保存時最多 60 字（確認卡與送給 Gemini 都用這個長度）；只有熱圖的需求列顯示時截到 16 字並加「…」。相同輸入必然得到相同列，方便測試。

### 一次檢索與一次生成

確認送出後：

1. 核對來源 `fingerprint` 與索引一致，否則回覆「履歷資料正在等待同步」，草稿保留在確認步驟。
2. 以「職位＋全部需求」組成一個查詢，`embedQuery_` 一次，`rankChunks_` 取前 8 段（`minSimilarity: -1`）作為證據。
3. 以 `generateHrReview_(fields, requirements, hits, cfg)` 呼叫 Gemini 一次（結構化 JSON 輸出，temperature 0.15）。

每次分析固定為 1 次嵌入加 1 次生成呼叫。前 8 段是估計值：若 W10 模擬履歷（ResumeRAGbot/docs/模擬履歷_陳沐言_AI自動化工程師.txt）的對照結果常漏掉明顯證據，再調整這個數字。

替代方案：每項需求各檢索一次——最多 5 次嵌入呼叫，等待時間更長，暫不採用。

### 熱圖格子逐格核對引用

Gemini 輸出結構：

```json
{
  "skills": ["string"],
  "cells": [{ "row": 0, "col": 0, "level": "strong|related|indirect|none", "id": "chunk-id", "quote": "逐字原文" }],
  "pending": ["string"],
  "interviewQuestions": ["string"]
}
```

`validateHrReview_(result, requirements, hits)` 規則：

- `skills` 最多保留 5 個，每個最多 12 字。
- 每個 `level` 不是 `none` 的格子都用 `quoteSource_` 核對；核對失敗時改為 `none`，並把該需求列入待確認。
- 沒有提供的格子視為 `none`。
- 欄位中所有格子都是 `none` 的技能會被移除；所有格子都是 `none` 的需求列會加入待確認。
- 面談問題最多保留 3 題，每題最多 80 字。
- 格式錯誤（缺少欄位、型別不符）時丟出 `HR_REVIEW_INVALID_FORMAT`。

與 `validateAnswer_` 不同：單一引用失敗不讓整次分析失敗，只降級該格，因為熱圖是多格的局部結果。

### 熱圖以 Flex 色塊表格呈現

一個 `bubble`（size `giga`）：

- 標題列：「職缺證據熱圖｜<職位>」。
- 表頭列：左上空白，其後是技能名稱。
- 每列需求：先顯示需求名稱（加分條件前綴「＋」），再顯示各格色塊。
- 色塊級距：明確證據 `#1F7A5A`（白字「●●●」）、相關經驗 `#6FBF97`（「●●」）、間接 `#CFE9DB`（「●」）、未提及 `#EEEEEE`（「－」）。
- 下方顯示圖例，並固定附一句：「只表示公開履歷中的證據強度，不是錄取分數；未提及不代表不具備。」

`altText` 以文字列出每項需求的最高級距。沒有任何技能欄時不送熱圖，只送文字結果。

### 回覆訊息組成

一次回覆最多 4 則訊息，全部附 Quick Reply：

1. 文字摘要：職位與對照項數。
2. 熱圖 Flex 訊息。
3. 文字：「待確認」清單與「建議面談問題」。
4. 文字：「資料來源：<段落標題>」，取自被核對通過的引用。

送出前再核對一次 `fingerprint`；若履歷已變動，改回「履歷資料正在等待同步」。

### 人資輸入的保存與記錄

- 草稿欄位只存在快取；分析完成後清空欄位，只保留草稿 ID、`lastEvent` 與 `lastMessages` 作為重送防護，同樣 1800 秒到期。
- `safeLog_` 只記錄錯誤碼。
- 送給 Gemini 的 prompt 必須說明：人資輸入與履歷片段都是不可信資料；不得依年齡、性別、婚育、宗教、健康、國籍等非工作條件評估或提問；不得承諾錄取。

### 人資模式入口

- `quickReply_()` 在主題項目之後附加固定的 `{ label: '人資模式', data: 'hr:start', displayText: '人資模式' }`。它不加入 `MESSAGE_TOPICS_` 或 `menuTopics_`，不會被當成履歷主題送進 RAG。
- 首頁第三卡在「回首頁」旁新增「人資模式」按鈕（postback `hr:start`）。
- 文字「人資」「人資模式」視同 `hr:start`。

### 版本 3.0.0 發佈

- `appVersion_()` 與 package.json 改為 `3.0.0`。
- bundle 順序在 `Contact` 之後加入 `HrReview`。
- 重新產生 dist 與安裝頁。
- 版本更新.md 改寫為「從第二版升級至第三版」：分檔安裝為 19 個 `.gs`，並新增 HrReview.gs；升級不需重跑同步、不需新權限。
- README、CHANGELOG、安裝後延伸思考.md 改為描述已實作的 v3。

## Implementation Contract

**Behavior（訪客可觀察）：**

- 點「人資模式」或輸入「人資」後，收到「人資模式 1 / 3」題目，並看到「不是錄取分數、輸入會交給 AI 分析、30 分鐘內有效、可輸入取消」的說明。
- 依序回答 3 題（第 3 題可按「略過」）後，收到確認卡；確認卡列出職位與拆解後的需求清單，並有「開始對照」「重新填寫」「取消」三個按鈕。
- 按「開始對照」後收到最多 4 則訊息：摘要、熱圖、待確認與面談問題、資料來源。
- 輸入「取消」：回覆「已離開人資模式，剛才的內容沒有送出分析。」
- 草稿過期後的下一則訊息：回覆過期提示，內容不交給 AI。
- 草稿進行中點首頁、主題、作品、聯繫本人或清除對話：人資草稿被清除，並照常執行該指令。

**Interface / data shape：**

- `handleHrReview_(event, text, cfg, prepared) → Array<LineMessage> | null`
- Postback 指令：
  - `hr:start`
  - `hr:skip:<draftId>`
  - `hr:submit:<draftId>`
  - `hr:restart:<draftId>`
  - `hr:cancel`
- 草稿：`{ id, step: 0..3, fields: { role, required, bonus }, expiresAt, lastEvent, lastMessages }`。其中 `step === 3` 表示確認卡階段，`step === 4` 表示已完成。
- `hrRequirements_(fields) → { items: Array<{ label, kind }>, truncated: boolean }`（`items` 長度 0 到 5；第 2 題拆不出任何項目時不讓訪客前進，所以送出分析時至少 1 項；`truncated` 表示輸入超過 5 項）
- `validateHrReview_(result, requirements, hits) → { skills, grid: level[][], pending, interviewQuestions, sections }`（核對通過的引用只用來產生 `sections` 資料來源，不另外回傳逐格引用）
- `hrHeatmapMessage_(role, requirements, review) → FlexMessage | null`

**Failure modes：**

- Gemini 錯誤或逾時：回覆 `ragErrorMessage_` 的說明，草稿停在確認卡，可再按「開始對照」。
- `HR_REVIEW_INVALID_FORMAT`：回覆「這次 AI 未能整理出對照結果，請稍後再按『開始對照』」，並只記錄錯誤碼。
- `HR_REVIEW_INCOMPLETE`（Gemini 回應沒有正常結束，例如輸出被截斷）：回覆 `ragErrorMessage_` 的一般說明，只記錄錯誤碼，草稿停在確認卡，可再按「開始對照」。
- 沒有索引：回覆「履歷資料正在準備中」。
- 來源已變更：回覆「履歷資料正在等待同步」。
- 過期或不是目前草稿的 postback ID：回覆「這份人資對照已過期，請重新選擇『人資模式』」。

**Acceptance criteria：**

- `npm test` 全數通過，包含新增的 ResumeRAGbot/test/hr-review.test.mjs，至少涵蓋 specs 的每個 Scenario。
- `npm run check`、`npm run check:bundle`、`npm run check:docs` 通過。
- 手動驗收：以模擬履歷部署，在 LINE 走完三題，熱圖每個有色格子的原文都能在 Doc 中找到。

**Scope boundaries：**

- 範圍內：HrReview.gs；Webhook 分流；Contact 讓出處理權；Line 的入口、說明與隱私文字；版本號、bundle、dist、安裝頁與文件；測試。
- 範圍外：RAG 檢索演算法、主題分類、作品卡、邀約通知、管理頁面、圖片辨識。

## Risks / Trade-offs

- [單一查詢取前 8 段可能漏掉某項需求的證據] → 該需求會顯示為「未提及」並列入待確認，不會誤判成有證據；之後可以改成逐項檢索。
- [Gemini 回傳的技能名稱可能不一致] → 欄位只用來顯示，真正的依據是逐格核對的原文；沒有證據的欄位會被移除。
- [Flex 訊息大小與 LINE 版面寬度] → 最多 5×5 格，技能名稱截斷為 6 字顯示；測試斷言 JSON 長度小於 30,000 字元。
- [等待時間：一次嵌入加一次生成，估計 5–15 秒] → 先呼叫 `startLoading_` 顯示載入動畫。這是估計值，以手動驗收實際量測。
- [人資輸入交給 AI 與邀約「不交 AI」的規則不同] → 在題目說明與 `privacyText_` 明確說明差異。
- [v2 測試中斷言 Quick Reply 只有主題項目] → 同步更新相關測試，並新增「人資模式不在主題清單內」的斷言。

## Migration Plan

1. 學生下載 v3.0.0 安裝包。
2. 單檔安裝：以新版 Code.gs 取代全文。分檔安裝：新增 HrReview.gs，並更新其餘 `.gs` 與 manifest。
3. 「管理部署」編輯原部署，選擇「新版本」。
4. 執行 `checkDeployment`，確認兩個版本都是 3.0.0。
5. 不需重跑 `syncKnowledgeBase`，不需新權限或新指令碼屬性。
6. 回退：以 v2.0.0 的 Code.gs 覆蓋並部署新版本。索引與收件匣格式不受影響。
