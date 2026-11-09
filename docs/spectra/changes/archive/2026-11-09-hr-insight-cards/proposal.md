## Why

v3 的人資模式只回答「履歷有沒有符合這些需求」，但人資篩履歷時還會檢查經歷時間是否連續、專案成果是否具體，看完後也要整理給用人主管。這三件事目前都得自己讀履歷、自己打字，是 W10 課前作業提出的「讓人資快速掌握求職者」最直接的缺口。

## What Changes

- 新增「經歷時間軸」：輸入「經歷時間軸」「時間軸」或按 `hr:timeline`，AI 從履歷中有年份的段落整理工作、學歷與專案期間；每一筆的原文與年月都由程式核對，核對不過就略過。空窗超過 6 個月、工作期間重疊、任職不滿 12 個月由程式計算（不交給 AI 判斷），並轉成中性的待確認面談問題，不詢問個人或家庭原因。
- 新增「成果拆解」：輸入「成果拆解」或按 `hr:star`，從履歷標題列出最多 8 個專案或經歷讓人資選擇；選定後以該段原文做情境、任務、行動、結果（STAR）四格，每格必須附可核對的履歷原文，否則顯示「履歷未提及」並產生追問；結果沒有數字時另提示「成果未量化」。
- 新增「轉給主管」：熱圖對照完成後，待確認訊息的 Quick Reply 多一個「轉給主管」(`hr:forward:<draftId>`)，回覆一段 300 字內、可長按複製轉傳的摘要（職位、有依據的需求與證據等級、待確認、建議面談問題、資料來源、非錄取分數聲明）。
- 人資模式第 1 題的 Quick Reply 加入「經歷時間軸」「成果拆解」；使用說明與隱私說明同步更新。
- 新增 `gas/HrInsights.gs`（分檔共 20 個 `.gs`），版本升為 3.2.0；不需新權限、指令碼屬性或重新同步。

## Capabilities

### New Capabilities

（無）

### Modified Capabilities

- `hr-review-mode`: 新增經歷時間軸、成果拆解、轉給主管摘要三項需求；修改入口（第 1 題 Quick Reply）、隱私保存範圍（多保留轉給主管摘要至草稿到期）與版本需求（3.2.0、20 個 `.gs`）。

## Impact

- 程式：新增 gas/HrInsights.gs；修改 gas/HrReview.gs（入口分派、第 1 題 Quick Reply、對照完成時產生摘要、`hr:forward`）、gas/Contact.gs（新文字指令也會結束未完成的邀約草稿）、gas/Line.gs（使用說明、隱私說明）、gas/Config.gs（版本）。
- 打包：scripts/bundle.mjs 加入 HrInsights；重新產生 dist/Code.gs 與 START_HERE.html；package.json 版本 3.2.0。
- 文件：CHANGELOG.md、docs/版本更新.md、docs/部署指南.md（檔案數 20）。
- 測試：新增 test/hr-insights.test.mjs；調整 test/hr-extensions.test.mjs 中第 1 題 Quick Reply 的斷言與版本相關斷言。
- API 用量：時間軸與成果拆解各為 1 次 Gemini 生成、0 次向量查詢；轉給主管不呼叫 AI。
