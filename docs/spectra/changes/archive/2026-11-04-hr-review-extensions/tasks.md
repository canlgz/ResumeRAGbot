## 1. 貼職缺說明（JD）

- [x] 1.1 實作 Job description extraction：在 ResumeRAGbot/gas/HrReview.gs 新增 `extractHrRequirements_`（一次 generateContent，schema `items[{label, kind, quote}]`）、`validateHrExtraction_`（去空白後原文子字串核對、`HR_PROTECTED_` 擋非工作條件、分隔符號改「／」、最多 10 項）、`runHrExtraction_`；第 2 題 Quick Reply 加「貼職缺說明」（`hr:jd:<id>`），JD 模式提供「改為逐項輸入」（`hr:manual:<id>`）。拆解不持鎖，結果寫回前核對草稿 ID、步驟與模式。驗證：ResumeRAGbot/test/hr-extensions.test.mjs 的「Extract verified requirements」「validateHrExtraction_」「Nothing extractable」「over-length JD」測試通過，且斷言 JD 原文不在快取與記錄中。

## 2. 確認卡刪改

- [x] 2.1 實作 Editable confirmation card：`hrDropRequirement_` 與 `hr:drop:<id>:<n>`、`hr:edit:<id>`、`hr:keep:<id>`；全部移除時回到第 2 題。footer 改為「開始對照／逐項對照／重新填寫／取消」，移除與修改按鈕放在 body。驗證：「Remove one requirement」「a removed item lets the sixth requirement move」「Edit requirements」「confirmation card with long labels」測試通過；更新 hr-review.test.mjs 的 footer 斷言。

## 3. 逐項對照

- [x] 3.1 在 ResumeRAGbot/gas/Gemini.gs 新增 `embedQueries_`（一次 batchEmbedContents，RETRIEVAL_QUERY）；HrReview.gs 新增 `mergeHrHits_`（輪流合併、去重、標註 rows，最多 12 段）；`runHrReview_` 依 `hr:deep:<id>` 使用逐項檢索，摘要標示「逐項檢索」；evidence 帶 rows 並在 prompt 說明。驗證：「Deep comparison」「deep comparison with a single requirement」「mergeHrHits_」測試通過。

## 4. 帶入邀約

- [x] 4.1 分析完成時草稿保留 `carry: {role, pending}`；待確認訊息 Quick Reply 最前面加「帶入邀約」（`hr:invite:<id>`）。ResumeRAGbot/gas/Contact.gs 新增 `startCarriedInvitation_`，邀約第 2 題顯示帶入內容與「使用帶入內容」（`invite:carry:<id>`），補充文字接在後面；重新填寫保留 carry；`handleContact_` 遇到 `hr:invite:` 不清除邀約。驗證：「Carry pending conditions」「carried text plus a supplement」「Redelivered 帶入邀約 event」測試通過，既有 contact.test.mjs 全數通過。

## 5. 版本 3.1.0 發佈

- [x] 5.1 `appVersion_()`、package.json、package-lock.json 改為 3.1.0；更新 `helpText_`、`privacyText_`；`npm run bundle` 重新產生 dist/Code.gs 與 START_HERE.html。驗證：`npm test`（188 項）、`npm run check`、`npm run check:bundle`、`npm run check:docs` 全數通過。
- [x] 5.2 更新 README.md、CHANGELOG.md、docs/版本更新.md（新增 v3.0.0 → v3.1.0 段落）、docs/安裝後延伸思考.md、scripts/installer-template.html 的延伸思考段落，以及其他文件中的目前版本號。
- [ ] 5.3 （2026-11-04 歸檔時尚未執行，移交使用者於 LINE 實機驗收）手動驗收：部署到 GAS，在 LINE 依序測試貼 JD（核對每項需求都在原文中）、移除／修改、逐項對照（記錄等待秒數並與一般對照比較）、帶入邀約（確認收件匣與 Email／LINE 通知內容）。
