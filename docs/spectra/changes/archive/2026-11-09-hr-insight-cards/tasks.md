## 1. 入口與分派

- [x] 1.1 實作 HR insight entry points：新增 gas/HrInsights.gs 的 `handleHrInsight_`，辨識「經歷時間軸」「時間軸」`hr:timeline`、「成果拆解」`hr:star`、`hr:star:<sectionId>`，在 `handleHrReview_` 草稿邏輯之前分派（Insight commands are stateless and live in HrInsights.gs），不建立、修改或清除人資草稿；gas/Contact.gs 的邀約處理把新文字指令視同人資指令並結束未完成的邀約草稿；人資第 1 題 Quick Reply 改為 `hr:timeline`、`hr:star`、`hr:cancel`。驗證：test/hr-insights.test.mjs 的「Step 1 offers insight shortcuts」「Insight command keeps the HR draft」，並把 test/hr-review.test.mjs 與 test/hr-extensions.test.mjs 中第 1 題只有 `hr:cancel` 的斷言改成新順序。

## 2. 經歷時間軸

- [x] 2.1 [after: 1.1] 實作 Experience timeline 的資料流程：核對索引與指紋、取含 4 位數年份的非圖片片段最多 12 段（Timeline and STAR read chunks directly without embedding）、呼叫 Gemini 一次、`validateHrTimeline_` 逐筆核對 quote 與年月（Timeline flags are computed in code from verified dates），生成後再核對指紋；無日期片段時不呼叫 AI。驗證：test/hr-insights.test.mjs 的「Timeline from verified dates」「Month not present in quote」「No dated chunks」，並斷言沒有任何 embedding 請求、快取中沒有時間軸內容。
- [x] 2.2 [after: 2.1] 實作 Timeline flag computation 的 `hrTimelineFlags_`：空窗、重疊、短期任職以月份序號計算，`present` 用目前月份，只有年份時採 Year-only dates use conservative bounds；以固定模板產生最多 3 題中性面談問題（空窗題註明不需說明個人原因）。驗證：test/hr-insights.test.mjs 以 spec 中 flag cases 表格五列逐列斷言。
- [x] 2.3 [after: 2.2] 組成時間軸回覆：Flex 時間軸（期間、類型、標題、疑點標籤、評價聲明句）與疑點／面談問題／資料來源文字，JSON 少於 30,000 字。驗證：test/hr-insights.test.mjs 斷言聲明句、無疑點時的「未發現超過 6 個月的空窗…」文字與 Flex 大小。

## 3. 成果拆解

- [x] 3.1 [after: 1.1] 實作 Outcome breakdown 的專案選單：從非圖片片段的標題篩選專案／作品／經歷／實習／競賽，最多 8 個，標籤去掉「：」前綴與全形括號註記，postback 為 `hr:star:<sha256 前 16 碼>`。驗證：test/hr-insights.test.mjs 的「Pick a project」與沒有符合標題時的提示。
- [x] 3.2 [after: 3.1] 實作 `hr:star:<sectionId>`：取該標題最多 4 段、呼叫 Gemini 一次、逐格核對，失敗顯示「履歷未提及」並加固定追問，結果無數字時標「成果未量化」（STAR cells show verified quotes, not AI paraphrase），追問文字 Quick Reply 以「換一個專案」開頭；未知 ID 回覆已不在履歷中。驗證：test/hr-insights.test.mjs 的「Missing and unverified parts」與未知 ID、Gemini 格式錯誤只記錄錯誤碼的測試。

## 4. 轉給主管

- [x] 4.1 實作 Forward summary for hiring managers：`hrForwardText_` 依優先順序填入並以「等 N 項」截斷至 300 字內（Forward summary is built deterministically at analysis time），對照完成時存入草稿 `forward`，待確認訊息 Quick Reply 為「帶入邀約」「轉給主管」，`hr:forward:<draftId>` 回覆兩則文字、不呼叫 AI、不清除草稿，過期 ID 回覆過期提示。驗證：test/hr-insights.test.mjs 的「Forward after analysis」「Long lists are shortened」與過期 ID 測試。

## 5. 隱私、說明、版本與發布

- [x] 5.1 [after: 4.1] 更新 HR input privacy 與使用說明：gas/Line.gs 的 `privacyText_` 說明保留職位、待確認條件與轉給主管摘要至到期、時間軸與成果拆解不保存；`helpText_` 說明兩個新指令。驗證：test/hr-insights.test.mjs 斷言「隱私」回覆包含「轉給主管」，以及對照完成後草稿欄位為空。
- [x] 5.2 [after: 2.3, 3.2, 5.1] 完成 Version 3.2.0 release：`appVersion_()` 與 package.json 改為 3.2.0，scripts/bundle.mjs 在 HrReview 之後加入 HrInsights，執行 npm run bundle 重新產生 dist/Code.gs 與 START_HERE.html；更新 CHANGELOG.md、docs/版本更新.md（v3.x 升級與分檔新增 HrInsights.gs、共 20 個 `.gs`）、docs/部署指南.md 檔案數。驗證：test/hr-review.test.mjs 的部署檢查改斷言 3.2.0，並通過 npm test、npm run check、npm run check:bundle、npm run check:docs。
