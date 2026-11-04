## 1. 需求拆解與草稿流程

- [x] 1.1 實作 Deterministic requirement parsing（設計「需求列由程式拆解而非 AI 拆解」）：在 ResumeRAGbot/gas/HrReview.gs 新增 `hrRequirements_(fields)`，依換行與「、，,；;」拆解、去空白與重複、必要條件在前、最多 5 項並回傳是否截斷。驗證：ResumeRAGbot/test/hr-review.test.mjs 以 spec 的 parsing cases 表格三列逐一斷言，`npm test` 通過。
- [x] 1.2 [after: 1.1] 實作 Three-step job requirement questionnaire（設計「人資模式草稿沿用邀約草稿模式」「三題的固定欄位與輸入限制」）：新增 `handleHrReview_(event, text, cfg, prepared)`，提供 hr:start 題目 1/3（含非錄取分數、交 AI 分析、30 分鐘、可取消的說明）、字數上限 50/300/300、第 2 題無項目時停留、第 3 題 `hr:skip:<id>`、確認卡含「開始對照／重新填寫／取消」與「只對照前 5 項」提示；草稿以快取 1800 秒加 `pending_` 旗標保存。驗證：hr-review.test.mjs 的「Complete the questionnaire」「Over-length answer」「Required field with no items」測試通過。
- [x] 1.3 [after: 1.2] 實作 Draft lifecycle and command precedence（設計「人資指令與邀約草稿互斥」）：取消回覆固定文字；快取過期但旗標仍在時回覆過期提示且不呼叫 Gemini；首頁、選單、topic:、work:、nav:contact、invite:start、清除對話會清除人資草稿並交出處理權；過期或不符的草稿 ID 回覆已過期；同一 webhook 事件重送時回傳 `lastMessages`。同時修改 ResumeRAGbot/gas/Contact.gs 的 `handleContact_`，遇到 `hr:` postback 或「人資」「人資模式」時清除邀約草稿與旗標並回傳 null。驗證：hr-review.test.mjs 的「Leaving through the home command」「HR mode replaces an invitation draft」「Expired draft」測試通過，既有 ResumeRAGbot/test/contact.test.mjs 仍全數通過。
- [x] 1.4 [after: 1.3] 在 ResumeRAGbot/gas/Webhook.gs 的 `handleEvent_` 中，把 `handleHrReview_` 接在 `handleContact_` 之後、清除對話之前；人資回覆不加貼圖、不寫入短期對話記憶。驗證：hr-review.test.mjs 透過 `handleEvent_` 走完 hr:start → 三題 → 確認卡，`state.calls` 中沒有 Gemini 請求，且 `readConversation_` 為 null。

## 2. 證據對照與熱圖

- [x] 2.1 [after: 1.4] 實作 Evidence-verified heatmap analysis 的生成端（設計「一次檢索與一次生成」）：hr:submit 時先核對 fingerprint 與索引，以「職位＋需求」做一次 `embedQuery_`、以 `rankChunks_` 取前 8 段，再以 `generateHrReview_` 呼叫 Gemini 一次（JSON schema：skills、cells{row,col,level,id,quote}、pending、interviewQuestions）。依「人資輸入的保存與記錄」，prompt 須包含不可信資料、禁止非工作條件、不承諾錄取的規則。驗證：測試斷言一次分析恰好 1 次嵌入請求加 1 次 generateContent 請求，且 request payload 的 systemInstruction 含上述規則字句。
- [x] 2.2 [after: 2.1] 實作 `validateHrReview_`（設計「熱圖格子逐格核對引用」）：非 none 的格子以 `quoteSource_` 核對，失敗則降級為 none 並列入待確認；技能最多 5 個、每個 12 字；移除整欄 none 的技能；整列 none 的需求列入待確認；面談問題最多 3 題、每題 80 字；格式錯誤丟出 `HR_REVIEW_INVALID_FORMAT`。驗證：hr-review.test.mjs 的「Unverifiable quote is downgraded」「column and row pruning」「Interview questions are capped」測試通過。
- [x] 2.3 [after: 2.2] 實作 Heatmap reply content（設計「熱圖以 Flex 色塊表格呈現」「回覆訊息組成」）：`hrHeatmapMessage_` 產生 giga bubble，包含標題、技能表頭、需求列（加分條件前綴＋）、四級色塊（#1F7A5A／#6FBF97／#CFE9DB／#EEEEEE）、圖例與免責句；回覆依序為摘要、熱圖、待確認與面談問題、資料來源，最多 4 則且都附 Quick Reply；沒有任何技能欄時不送熱圖，改以文字列出全部待確認項目。驗證：測試「Successful analysis reply」「No supported skills」通過，並斷言 5×5 熱圖的 `JSON.stringify` 長度小於 30000。
- [x] 2.4 [after: 2.3] 實作 Analysis failure handling 與 HR input privacy：Gemini 錯誤時回覆 `ragErrorMessage_`；格式錯誤時回覆重試提示並只記錄錯誤碼；兩種情況都把草稿留在確認卡。沒有索引回覆「履歷資料正在準備中」；生成前後 fingerprint 不符時回覆等待同步且不送熱圖。分析完成後清空草稿欄位，不寫 Doc、不動收件匣與索引。驗證：hr-review.test.mjs 的「Invalid AI format then retry」「Resume changed during generation」「Duplicate submit event」「Nothing persisted after analysis」測試通過（斷言 `documentWrites === 0`、`logs` 不含輸入字串、快取草稿欄位為空）。

## 3. 入口與說明文字

- [x] 3.1 [after: 1.4] 實作 HR mode entry points（設計「人資模式入口」）：在 ResumeRAGbot/gas/Line.gs 的 `quickReply_()` 中，於主題項目之後附加固定的「人資模式」（hr:start），首頁第三卡加入同名按鈕，文字「人資」「人資模式」可開啟；`menuTopics_` 與 `MESSAGE_TOPICS_` 不含此項。同步更新既有斷言：ResumeRAGbot/test/homepage.test.mjs 目前斷言首頁第三卡的主題按鈕與 Quick Reply 動作完全相同，ResumeRAGbot/test/quick-topics.test.mjs 斷言 Quick Reply 標籤只有「我是誰」「快速一覽」。這兩項要改為「主題部分相同，Quick Reply 結尾多一個 hr:start」。驗證：「Quick Reply keeps topics first」「Start from Quick Reply」測試通過，`npm test` 全數通過。
- [x] 3.2 [after: 3.1] 在 `helpText_` 加入人資模式用法；`privacyText_` 說明人資模式的輸入會交給 AI 分析、邀約內容不會，且人資輸入只暫存 30 分鐘。驗證：測試「Privacy text explains the difference」通過。

## 4. 版本 3.0.0 發佈

- [x] 4.1 [after: 2.4, 3.2] 完成 Version 3.0.0 release（設計「版本 3.0.0 發佈」）：`appVersion_()` 與 ResumeRAGbot/package.json 改為 3.0.0；在 ResumeRAGbot/scripts/bundle.mjs 的順序中，於 Contact 之後加入 HrReview；執行 `npm run bundle` 重新產生 dist/Code.gs 與安裝頁。驗證：在 hr-review.test.mjs 新增「Deployment check after upgrade」測試，明確斷言 `appVersion_() === '3.0.0'`，且 `checkDeployment` 回傳的 editorVersion 與 webAppVersion 都是 3.0.0（既有 ResumeRAGbot/test/deployment.test.mjs 只拿 `appVersion_()` 自身比對，沒有固定版本號）；`npm run check:bundle` 通過。
- [x] 4.2 [after: 4.1] 更新文件：ResumeRAGbot/docs/版本更新.md 改為 v2→v3 升級（19 個 `.gs`、新增 HrReview.gs、不需重跑同步與新增權限）；ResumeRAGbot/README.md 加入人資模式功能列；ResumeRAGbot/CHANGELOG.md 新增 v3.0.0；ResumeRAGbot/docs/安裝後延伸思考.md 改述已實作的範圍與未實作的延伸方向。驗證：`npm run check:docs` 與 `npm run check` 通過，並人工檢查文件中不再出現「尚未實作，也沒有第三版安裝包」。
- [ ] 4.3 [after: 4.2] （2026-11-04 歸檔時尚未執行，移交使用者於 LINE 實機驗收）手動驗收：以模擬履歷部署到 GAS，在 LINE 走完三題並按「開始對照」，確認熱圖每個有色格子的原文都能在 Doc 中找到，並記錄實際等待秒數，用來核對設計中「5–15 秒」的估計。驗證：在 tasks 完成註記中寫下測試職缺、格子核對結果與量測秒數。
