## Context

v3.0.0 的 `handleHrReview_`（ResumeRAGbot/gas/HrReview.gs）以快取草稿（30 分鐘）、`pending_` 旗標、`lastEvent` 冪等處理三題問卷；`hr:submit` 時釋放鎖後呼叫 Gemini，再重新持鎖寫回結果。v3 design 曾否決「JD 由 AI 拆解」，理由是需求列必須可預期、可核對。

## Goals / Non-Goals

**Goals:**

- 人資可貼整份 JD，但每個拆出的需求都能追溯到 JD 原文，且一定經過人資確認才對照。
- 人資可在確認卡逐項移除或改寫需求。
- 提供較完整的「逐項對照」，並清楚標示代價（等待較久、API 用量較多）。
- 人資可把待確認條件帶入既有邀約流程，沿用訪客確認後才保存的規則。

**Non-Goals:**

- 不保存 JD 原文或分析結果供日後查詢；不新增指令碼屬性、權限或 .gs 檔。
- 不讓 AI 直接決定對照列：AI 拆出的項目只是建議，仍經程式核對與人資確認。
- 不匯出結果檔案。

## Decisions

### JD 拆解沿用「原文核對」原則

`extractHrRequirements_` 以 JSON schema 要求 `items[{label, kind, quote}]`。`validateHrExtraction_` 去除空白後確認 `quote` 為 JD 的連續子字串；失敗計入「未在原文找到」。label 以正規式擋下年齡、性別、婚育、宗教、健康、國籍等非工作條件，計入「已略過非工作條件」。label 內的分隔符號改為「／」，避免 `hrRequirements_` 再拆開。結果寫回 `fields.required`／`fields.bonus`（以換行串接），直接進入確認卡；之後的拆解、上限 5 項與熱圖流程完全不變。

JD 原文只在本次請求的記憶體中傳給 Gemini，不放入草稿或結果快取。拆不出任何項目時，自動切回逐項輸入。

### 長時間呼叫不持鎖

JD 拆解與對照共用同一個模式：持鎖時決定 job（`extract` 或 `review`），釋放鎖呼叫 Gemini，再持鎖確認草稿 ID 與步驟未變才寫回。期間若取消或重填，不覆蓋新草稿。

### 確認卡刪改

body 放「移除：<需求>」（`hr:drop:<id>:<n>`，n 為目前顯示的第 n 項）與「修改需求」（`hr:edit:<id>`）。移除會把該 label 從 required 與 bonus 兩欄都拿掉，避免重複項目再次出現；被截斷的第 6 項會遞補。修改回到第 2 題並設 `editing`，第 2、3 題顯示目前內容與「沿用目前」（`hr:keep:<id>`）。footer 為「開始對照／逐項對照／重新填寫／取消」。

### 逐項對照：一次批次嵌入

`embedQueries_` 以一次 `batchEmbedContents`（RETRIEVAL_QUERY）取得每項需求的向量；每項 `rankChunks_` 取前 4 段，以輪流方式合併去重，最多 12 段，每段標註 `rows`（由哪些需求列檢索到）。生成仍只呼叫一次。只有 1 項需求時等同一般對照。

### 帶入邀約

分析完成時，草稿改為 `step: 4`、清空 `fields`，另存 `carry: {role, pending}`，與原草稿同時到期。`hr:invite:<id>` 驗證草稿後呼叫 Contact.gs 的 `startCarriedInvitation_`：建立帶 `carry` 文字（最多 600 字）的邀約草稿，並清除人資草稿。邀約第 2 題顯示帶入內容，按「使用帶入內容」（`invite:carry:<id>`）採用，或傳送補充文字（接在帶入內容後，總長仍受 800 字限制）。重新填寫邀約會保留 carry。`handleContact_` 遇到 `hr:invite:` 不清除邀約草稿，避免 LINE 重送事件時把剛建立的邀約清掉。

## Risks / Trade-offs

- [JD 拆解多一次 AI 呼叫] → 只在人資主動選擇時發生；失敗時保留在 JD 輸入步驟，可改為逐項輸入。
- [逐項對照的嵌入用量為 N 倍] → 以批次請求維持一次 HTTP 往返，並在確認卡說明代價。
- [carry 讓職位與待確認條件多保留到草稿到期] → 不寫入任何持久儲存，隱私說明同步更新。
