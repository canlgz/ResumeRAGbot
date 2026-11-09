# hr-review-mode Specification

## Purpose

HR review mode lets a recruiter answer three job-requirement questions in LINE and receive a skill-by-requirement evidence heatmap built only from verifiable quotes in the public resume. It exists so recruiters can quickly see which requirements the resume supports and which ones still need confirmation, without the bot producing a hiring score.

## Requirements

### Requirement: HR mode entry points

The system SHALL start HR review mode when a visitor sends the postback `hr:start` or the text `人資` or `人資模式`. Every Quick Reply built from the resume topic menu (`quickReply_()`) SHALL include a fixed `人資模式` action with postback data `hr:start` after the resume topic items; step prompts and confirmation cards of the HR and invitation drafts keep their own draft-specific Quick Reply (or none) and are excluded. In addition, the third home card SHALL include a `人資模式` button with the same postback. The `人資模式` action SHALL NOT appear in the resume topic list used for RAG topics.

#### Scenario: Start from Quick Reply

- **WHEN** a visitor taps the `人資模式` Quick Reply item
- **THEN** the bot replies with the step 1 of 3 prompt asking for the job title, including notices that the result is not a hiring score, that inputs are sent to AI for analysis, that the draft lasts 30 minutes, and that `取消` leaves the mode

#### Scenario: Quick Reply keeps topics first

- **WHEN** the resume has only the base topics `我是誰` and `快速一覽`
- **THEN** the Quick Reply labels are `我是誰`, `快速一覽`, `人資模式` in that order and the resume topic list contains only `我是誰` and `快速一覽`

---
### Requirement: Three-step job requirement questionnaire

The system SHALL collect three fields in order: `role` (job title, at most 50 characters, required), `required` (required skills or conditions, at most 300 characters, required), and `bonus` (bonus conditions or work context, at most 300 characters, skippable through `hr:skip:<draftId>`). An over-length answer SHALL keep the visitor on the same step with a length notice. After step 3 the system SHALL show a confirmation card listing the role and the parsed requirements, with footer actions `開始對照` (`hr:submit:<draftId>`), `逐項對照` (`hr:deep:<draftId>`), `重新填寫` (`hr:restart:<draftId>`), and `取消` (`hr:cancel`), plus the remove and edit actions defined in "Editable confirmation card". At step 2 the visitor MAY instead paste a job description as defined in "Job description extraction".

#### Scenario: Complete the questionnaire

- **WHEN** a visitor answers `AI 應用工程師`, then `Python、RAG、LINE Bot`, then taps `略過`
- **THEN** the bot shows a confirmation card listing role `AI 應用工程師` and requirements `Python`, `RAG`, `LINE Bot`

#### Scenario: Over-length answer

- **WHEN** a visitor sends a 51-character job title at step 1
- **THEN** the bot replies that the field is limited to 50 characters and the draft remains at step 1

#### Scenario: Required field with no items

- **WHEN** a visitor sends `、、，` at step 2
- **THEN** the bot asks for at least one requirement and the draft remains at step 2

---
### Requirement: Deterministic requirement parsing

The system SHALL split `required` and `bonus` on line breaks and the separators `、`, `，`, `,`, `；`, `;`, trim whitespace, drop empty and duplicate items, place required items before bonus items, and keep at most 5 items. When more than 5 items are given, the confirmation card SHALL state that only the first 5 are compared.

#### Scenario: Parse and cap requirements

- **WHEN** requirements are parsed from the given fields
- **THEN** the result matches the expected list

##### Example: parsing cases

| required | bonus | Expected rows (kind) |
| --- | --- | --- |
| Python、RAG | (empty) | Python (required), RAG (required) |
| Python (line break) Python; SQL | 簡報 | Python (required), SQL (required), 簡報 (bonus) |
| A,B,C,D | E、F | A, B, C, D (required), E (bonus); notice "只對照前 5 項" |

---
### Requirement: Evidence-verified heatmap analysis

On `hr:submit:<draftId>` the system SHALL verify that the public source fingerprint matches the index, retrieve resume chunks with one embedding request, and request one structured Gemini analysis. Each heatmap cell SHALL have one of the levels `strong` (明確證據), `related` (相關經驗), `indirect` (間接), or `none` (未提及). Every non-`none` cell SHALL carry a quote that `quoteSource_` verifies against the retrieved chunks; a cell whose quote fails verification SHALL be downgraded to `none`. Skills SHALL be capped at 5, and a skill column whose cells are all `none` SHALL be removed. A requirement row whose cells are all `none` SHALL be listed under pending confirmation.

#### Scenario: Unverifiable quote is downgraded

- **WHEN** Gemini returns a `strong` cell for requirement `RAG` whose quote does not appear in any retrieved chunk
- **THEN** that cell is rendered as 未提及 and `RAG` appears in the pending confirmation list

#### Scenario: No supported skills

- **WHEN** every cell returned by Gemini is `none` or fails verification
- **THEN** the bot sends no heatmap message and replies with text that lists all requirements as pending confirmation

##### Example: column and row pruning

- **GIVEN** requirements `Python`, `SQL` and skills `Python 開發`, `資料分析`, where only (`Python`, `Python 開發`) is `strong` with a verified quote
- **WHEN** the review is validated
- **THEN** skills are `Python 開發` only, row `SQL` is pending, and the grid is `[[strong], [none]]`

---
### Requirement: Heatmap reply content

The analysis reply SHALL contain at most 4 messages: a text summary naming the role and the number of compared requirements; a Flex heatmap with requirement rows (bonus rows prefixed with `＋`), skill columns, a four-level legend, and the sentence `只表示公開履歷中的證據強度，不是錄取分數；未提及不代表不具備。`; a text listing pending confirmations and at most 3 interview questions; and a text `資料來源：` listing the section titles of verified quotes. The heatmap message JSON SHALL be under 30,000 characters.

#### Scenario: Successful analysis reply

- **WHEN** the analysis verifies at least one cell
- **THEN** the reply contains the summary, the heatmap with the disclaimer sentence, the pending and interview-question text, and the source text, each with a Quick Reply

#### Scenario: Interview questions are capped

- **WHEN** Gemini returns 5 interview questions
- **THEN** the reply includes only the first 3

---
### Requirement: Draft lifecycle and command precedence

The HR draft SHALL expire 30 minutes after it starts. `取消` or `hr:cancel` SHALL clear the draft and reply `已離開人資模式，剛才的內容沒有送出分析。`. When the draft has expired from cache but its pending flag remains, the next message SHALL receive an expiry notice and SHALL NOT be sent to AI. Home, menu, topic, work, contact (`nav:contact`, `invite:start`), and reset commands SHALL clear the HR draft and run normally. HR commands SHALL clear any unfinished invitation draft, and a visitor SHALL have at most one active draft. A postback with a stale or unknown draft ID SHALL reply that the HR comparison has expired. A repeated webhook event SHALL return the previously sent messages without calling Gemini again.

#### Scenario: Leaving through the home command

- **WHEN** a visitor at step 2 sends `首頁`
- **THEN** the HR draft is cleared and the home card is shown

#### Scenario: HR mode replaces an invitation draft

- **WHEN** a visitor with an invitation draft at step 1 taps `人資模式`
- **THEN** the invitation draft is cleared and the HR step 1 prompt is shown

#### Scenario: Expired draft

- **WHEN** the HR draft cache entry has expired and the visitor sends any text
- **THEN** the bot replies with the expiry notice and makes no Gemini request

#### Scenario: Duplicate submit event

- **WHEN** the same `hr:submit` webhook event is delivered twice
- **THEN** Gemini is called once and both deliveries return the same messages

---
### Requirement: HR input privacy

HR answers SHALL be stored only in the script cache draft and SHALL NOT be written to the Google Doc, the invitation inbox, the Drive index, or execution logs. After a completed analysis, the draft fields SHALL be cleared; only the role, the pending conditions, and the forward summary SHALL remain in the same cache draft until it expires, for "Carry results into an invitation" and "Forward summary for hiring managers". A pasted job description SHALL be sent to Gemini for extraction only and SHALL NOT be stored. Timeline and outcome breakdown results SHALL NOT be stored. The privacy text SHALL state these rules. The Gemini instructions SHALL treat HR input and resume chunks as untrusted data, SHALL forbid evaluating or asking about age, gender, marital or family status, religion, health, or nationality, and SHALL forbid promising employment. The privacy text SHALL state that HR mode inputs are sent to AI for analysis while invitation inputs are not.

#### Scenario: Nothing persisted after analysis

- **WHEN** an analysis completes
- **THEN** no document write occurs, the invitation inbox is unchanged, logs contain no HR input text, and the cached draft has empty fields

#### Scenario: Privacy text explains the difference

- **WHEN** a visitor sends `隱私`
- **THEN** the reply states that HR mode inputs are sent to AI for analysis and invitation inputs are not, and mentions `轉給主管`


<!-- @trace
source: hr-insight-cards
updated: 2026-11-09
code:
  - gas/HrInsights.gs
  - package.json
  - START_HERE.html
  - docs/安裝後延伸思考.md
  - docs/部署指南.md
  - gas/Line.gs
  - README.md
  - gas/HrReview.gs
  - 老師需求.txt
  - docs/版本更新.md
  - docs/開始使用.md
  - gas/Config.gs
  - gas/Contact.gs
  - scripts/bundle.mjs
  - CHANGELOG.md
  - docs/學生安裝檢查.md
  - docs/聯繫與邀約通知.md
  - dist/Code.gs
  - test/hr-extensions.test.mjs
  - test/hr-review.test.mjs
  - test/hr-insights.test.mjs
-->

---
### Requirement: Analysis failure handling

When Gemini fails, times out, or returns an invalid structure, the system SHALL reply with an error message, log only an error code, and keep the draft at the confirmation step so `開始對照` can be retried. When the index is missing the system SHALL reply `履歷資料正在準備中`; when the source fingerprint differs from the index before or after generation the system SHALL reply that the resume is waiting for sync and SHALL NOT send heatmap results.

#### Scenario: Invalid AI format then retry

- **WHEN** the first Gemini response lacks the `cells` field and the visitor taps `開始對照` again with a valid response
- **THEN** the first reply asks to retry and logs `HR_REVIEW_INVALID_FORMAT`, and the second reply contains the heatmap

#### Scenario: Resume changed during generation

- **WHEN** the source fingerprint changes between retrieval and reply
- **THEN** the bot replies that the resume is waiting for sync and sends no heatmap

---
### Requirement: Job description extraction

At step 2 of HR review mode the system SHALL offer a `貼職缺說明` action (`hr:jd:<draftId>`). In this mode the visitor SHALL paste a job description of at most 2000 characters, and the system SHALL request one structured Gemini extraction of `items[{label, kind, quote}]`. An item SHALL be kept only when its whitespace-stripped quote is a contiguous substring of the whitespace-stripped job description and its label does not name a non-job attribute (age, gender, marital or family status, religion, health, nationality). Kept items SHALL replace the required and bonus fields and the draft SHALL move to the confirmation card, which states how many items were dropped. The job description text SHALL NOT be stored in the draft, the outcome cache, logs or any persistent store. `改為逐項輸入` (`hr:manual:<draftId>`) SHALL return to manual input.

#### Scenario: Extract verified requirements

- **WHEN** a visitor pastes a job description and Gemini returns one item with a quote from the text, one with an invented quote and one labelled `性別`
- **THEN** the confirmation card lists only the first item and reports one unverified and one excluded item

#### Scenario: Nothing extractable

- **WHEN** no extracted item passes verification
- **THEN** the bot explains that no verifiable requirement was found and shows the manual step 2 prompt

---
### Requirement: Editable confirmation card

The confirmation card SHALL provide `移除：<label>` actions (`hr:drop:<draftId>:<n>`) when more than one requirement is listed, and a `修改需求` action (`hr:edit:<draftId>`). Removing an item SHALL delete that label from both required and bonus fields and redisplay the card; removing the last item SHALL return to step 2. Editing SHALL return to step 2, show the current value, and offer `沿用目前` (`hr:keep:<draftId>`) at steps 2 and 3.

#### Scenario: Remove one requirement

- **WHEN** the card lists `Python`, `RAG`, `LINE Bot` and the visitor taps `移除：RAG`
- **THEN** the card lists `Python` and `LINE Bot`

---
### Requirement: Per-requirement retrieval

The confirmation card SHALL offer `逐項對照` (`hr:deep:<draftId>`). With more than one requirement, the system SHALL embed one query per requirement in a single `batchEmbedContents` request, take the top 4 chunks per requirement, merge them round-robin without duplicates up to 12 chunks, and request one Gemini generation. The summary SHALL state `逐項檢索`.

#### Scenario: Deep comparison

- **WHEN** a visitor with three requirements taps `逐項對照`
- **THEN** exactly one batch embedding request with three queries and one generation request are made, and the summary mentions `逐項檢索`

---
### Requirement: Carry results into an invitation

After a completed analysis, the pending-confirmation message SHALL include a `帶入邀約` Quick Reply (`hr:invite:<draftId>`). It SHALL start an invitation draft whose step 2 shows the role and pending conditions (at most 600 characters), with `使用帶入內容` (`invite:carry:<invitationId>`) or free text appended after the carried text. The HR draft SHALL be cleared. The invitation SHALL still be saved and notified only after the visitor confirms it.

#### Scenario: Carry pending conditions

- **WHEN** a visitor taps `帶入邀約`, answers step 1, and taps `使用帶入內容`
- **THEN** the invitation message field contains the role and each pending condition, and nothing is stored in the inbox until `確認送出`

---
### Requirement: Version 3.2.0 release

The deployed app SHALL report version `3.2.0` through `appVersion_()` and `checkDeployment`. The single-file bundle SHALL include `HrReview.gs` and `HrInsights.gs`, and the upgrade guide SHALL describe upgrading from v2 and from v3.x by replacing code and redeploying, without re-running `syncKnowledgeBase` or adding permissions; split-file installs SHALL add `HrInsights.gs` for a total of 20 `.gs` files.

#### Scenario: Deployment check after upgrade

- **WHEN** the owner runs `checkDeployment` after deploying v3.2
- **THEN** `editorVersion` and `webAppVersion` are both `3.2.0`


<!-- @trace
source: hr-insight-cards
updated: 2026-11-09
code:
  - gas/HrInsights.gs
  - package.json
  - START_HERE.html
  - docs/安裝後延伸思考.md
  - docs/部署指南.md
  - gas/Line.gs
  - README.md
  - gas/HrReview.gs
  - 老師需求.txt
  - docs/版本更新.md
  - docs/開始使用.md
  - gas/Config.gs
  - gas/Contact.gs
  - scripts/bundle.mjs
  - CHANGELOG.md
  - docs/學生安裝檢查.md
  - docs/聯繫與邀約通知.md
  - dist/Code.gs
  - test/hr-extensions.test.mjs
  - test/hr-review.test.mjs
  - test/hr-insights.test.mjs
-->

---
### Requirement: HR insight entry points

The system SHALL treat the text `經歷時間軸` or `時間軸` and the postback `hr:timeline` as the experience timeline command, and the text `成果拆解` and the postbacks `hr:star` and `hr:star:<sectionId>` as the outcome breakdown commands. These commands SHALL be handled without creating, changing, or clearing an HR review draft, and SHALL clear any unfinished invitation draft. The HR step 1 prompt Quick Reply SHALL contain, in order, `經歷時間軸` (`hr:timeline`), `成果拆解` (`hr:star`), and `取消` (`hr:cancel`). The help text SHALL describe both commands.

#### Scenario: Step 1 offers insight shortcuts

- **WHEN** a visitor taps `人資模式`
- **THEN** the step 1 prompt Quick Reply data are `hr:timeline`, `hr:star`, `hr:cancel` in that order

#### Scenario: Insight command keeps the HR draft

- **WHEN** a visitor at HR step 2 sends `經歷時間軸`
- **THEN** the bot replies with the timeline and the HR draft is still at step 2 with its earlier answer


<!-- @trace
source: hr-insight-cards
updated: 2026-11-09
code:
  - gas/HrInsights.gs
  - package.json
  - START_HERE.html
  - docs/安裝後延伸思考.md
  - docs/部署指南.md
  - gas/Line.gs
  - README.md
  - gas/HrReview.gs
  - 老師需求.txt
  - docs/版本更新.md
  - docs/開始使用.md
  - gas/Config.gs
  - gas/Contact.gs
  - scripts/bundle.mjs
  - CHANGELOG.md
  - docs/學生安裝檢查.md
  - docs/聯繫與邀約通知.md
  - dist/Code.gs
  - test/hr-extensions.test.mjs
  - test/hr-review.test.mjs
  - test/hr-insights.test.mjs
-->

---
### Requirement: Experience timeline

The timeline command SHALL verify that the index exists and that the public source fingerprint matches it, select the non-image chunks whose section or text contains a four-digit year (in document order, at most 12), and request one structured Gemini generation of `entries[{kind, title, start, end, id, quote}]` with `kind` in `work`, `education`, `project`, `other`, `start` in `YYYY` or `YYYY-MM`, and `end` in `YYYY`, `YYYY-MM`, or `present`. No embedding request SHALL be made. An entry SHALL be kept only when its quote, normalized by `quoteKey_`, is a contiguous substring of one selected chunk (stricter than `quoteSource_`, which tolerates partial mismatches), every year of `start` and `end` appears in the whitespace-stripped quote, every month appears after its year within 4 characters, the title is replaced by the section label when it is not found in that chunk, `start` is not after `end`, and an `end` of `present` is backed by one of `至今`, `迄今`, `目前`, `現在`, `在職`, `present`, `now` in the quote. At most 12 kept entries SHALL be shown, sorted by start. When no chunk contains a year the bot SHALL reply `履歷中沒有找到可整理成時間軸的日期。` without calling Gemini; when no entry is kept it SHALL reply `沒能從履歷整理出可核對的經歷期間。`. The fingerprint SHALL be checked again after generation. The reply SHALL be a Flex timeline with the sentence `空窗、重疊或短期任職可能有正當原因，只是面談時可確認的提示，不是評價。` followed by a text listing flags, at most 3 suggested interview questions, and the source sections. Nothing from the timeline SHALL be stored.

#### Scenario: Timeline from verified dates

- **WHEN** Gemini returns one entry whose quote and dates appear in the resume and one entry whose quote is invented
- **THEN** the Flex timeline lists only the first entry, one generation request and no embedding request are made

#### Scenario: Month not present in quote

- **WHEN** Gemini returns an entry with start `2024-08` whose quote reads `2024 年 7 月至 2026 年 9 月`
- **THEN** the entry is dropped

#### Scenario: No dated chunks

- **WHEN** the public resume contains no four-digit year
- **THEN** the bot replies `履歷中沒有找到可整理成時間軸的日期。` and makes no Gemini request


<!-- @trace
source: hr-insight-cards
updated: 2026-11-09
code:
  - gas/HrInsights.gs
  - package.json
  - START_HERE.html
  - docs/安裝後延伸思考.md
  - docs/部署指南.md
  - gas/Line.gs
  - README.md
  - gas/HrReview.gs
  - 老師需求.txt
  - docs/版本更新.md
  - docs/開始使用.md
  - gas/Config.gs
  - gas/Contact.gs
  - scripts/bundle.mjs
  - CHANGELOG.md
  - docs/學生安裝檢查.md
  - docs/聯繫與邀約通知.md
  - dist/Code.gs
  - test/hr-extensions.test.mjs
  - test/hr-review.test.mjs
  - test/hr-insights.test.mjs
-->

---
### Requirement: Timeline flag computation

Flags SHALL be computed in code from kept entries, never by Gemini. Months are indexed as `year × 12 + month − 1`; `present` uses the current month; a year-only start uses January and a year-only end uses December. A gap flag SHALL be raised when, over `work` and `education` entries sorted by start, the next start is more than 6 months after the latest end seen so far (gap months = next start − latest end − 1). An overlap flag SHALL be raised for two `work` entries whose dates both have month precision and that share at least one month. A short-tenure flag SHALL be raised for a `work` entry with month precision that has ended and lasts fewer than 12 months counting both ends. At most 6 flags SHALL be listed. Interview questions SHALL be generated from fixed templates; the gap template SHALL ask only for work or learning experience during the period and SHALL state that personal reasons are not needed. When there are no flags the text SHALL state `未發現超過 6 個月的空窗、時間重疊或不滿 12 個月的任職。`.

#### Scenario: Compute flags

- **WHEN** flags are computed from the given entries
- **THEN** the result matches the expected flags

##### Example: flag cases

| Entries (kind start–end) | Expected flags |
| --- | --- |
| education 2018-09–2022-06; work 2022-07–2024-06; work 2024-07–2026-09 | none |
| education 2018-09–2020-06; work 2021-03–2023-02 | gap 2020-07–2021-02 (8 months) |
| work 2020-01–2020-06; work 2020-06–2022-01 | overlap 2020-06; short 2020-01–2020-06 (6 months) |
| work 2019–2019; work 2021–2022 | gap 2020-01–2020-12 (12 months), no short or overlap |
| work 2025-03–present | none |


<!-- @trace
source: hr-insight-cards
updated: 2026-11-09
code:
  - gas/HrInsights.gs
  - package.json
  - START_HERE.html
  - docs/安裝後延伸思考.md
  - docs/部署指南.md
  - gas/Line.gs
  - README.md
  - gas/HrReview.gs
  - 老師需求.txt
  - docs/版本更新.md
  - docs/開始使用.md
  - gas/Config.gs
  - gas/Contact.gs
  - scripts/bundle.mjs
  - CHANGELOG.md
  - docs/學生安裝檢查.md
  - docs/聯繫與邀約通知.md
  - dist/Code.gs
  - test/hr-extensions.test.mjs
  - test/hr-review.test.mjs
  - test/hr-insights.test.mjs
-->

---
### Requirement: Outcome breakdown

The `hr:star` command SHALL list, as Quick Reply items with postback `hr:star:<first 16 hex of sha256(section)>`, at most 8 distinct sections of non-image chunks whose title matches `專案`, `作品`, `經歷`, `實習`, `競賽`, `project`, or `portfolio` (case-insensitive), in document order. Each label SHALL be the part after the first `：` (or the whole title when absent) with a trailing full-width parenthesized note removed, cut to 20 characters. When none match the bot SHALL reply `履歷中沒有找到專案或經歷段落。`. The `hr:star:<sectionId>` command SHALL check index and fingerprint as the timeline does, take at most 4 non-image chunks of that section, and request one Gemini generation of `{situation, task, action, result}`, each `{id, quote}`; no embedding request SHALL be made. A part SHALL show its quote (cut to 80 characters) only when the quote, normalized by `quoteKey_`, is a contiguous substring of one of those chunks; otherwise it SHALL show `履歷未提及` and add a fixed follow-up question for that part. A verified result without Arabic digits, a percent sign, or a Chinese numeral followed by a unit SHALL be marked `成果未量化` with a follow-up question asking for numbers. An unknown section ID SHALL reply `這個專案已不在目前的履歷中，請重新選擇「成果拆解」。`. The follow-up text Quick Reply SHALL begin with `換一個專案` (`hr:star`).

#### Scenario: Pick a project

- **WHEN** the resume has sections `專案一：LINE 內部知識助理（虛構測試資料）` and `專業技能`
- **THEN** the picker lists only `LINE 內部知識助理`

#### Scenario: Missing and unverified parts

- **WHEN** Gemini returns verified quotes for situation and action, an invented quote for task, and a verified result quote without numbers
- **THEN** the card shows `履歷未提及` for task, the follow-up text contains the task question and the `成果未量化` question, and one generation request and no embedding request are made


<!-- @trace
source: hr-insight-cards
updated: 2026-11-09
code:
  - gas/HrInsights.gs
  - package.json
  - START_HERE.html
  - docs/安裝後延伸思考.md
  - docs/部署指南.md
  - gas/Line.gs
  - README.md
  - gas/HrReview.gs
  - 老師需求.txt
  - docs/版本更新.md
  - docs/開始使用.md
  - gas/Config.gs
  - gas/Contact.gs
  - scripts/bundle.mjs
  - CHANGELOG.md
  - docs/學生安裝檢查.md
  - docs/聯繫與邀約通知.md
  - dist/Code.gs
  - test/hr-extensions.test.mjs
  - test/hr-review.test.mjs
  - test/hr-insights.test.mjs
-->

---
### Requirement: Forward summary for hiring managers

After a completed heatmap analysis, the system SHALL build a summary of at most 300 characters and store it as `forward` in the HR draft. The summary SHALL contain, in this order, `【履歷對照摘要】<role>`, `有依據：` with each supported requirement and its best level label, `待確認：` with the pending conditions, `建議面談：` with the first interview question when it fits, `來源：` with the source sections, and `※ 依公開履歷證據整理，不是錄取分數。`. Items that do not fit SHALL be replaced by `等 N 項`. The pending-confirmation message Quick Reply SHALL begin with `帶入邀約` (`hr:invite:<draftId>`) followed by `轉給主管` (`hr:forward:<draftId>`). `hr:forward:<draftId>` SHALL reply with `以下摘要可長按複製，轉傳給用人主管：` and the summary text as two messages, without calling Gemini and without clearing the draft. A stale or unknown draft ID SHALL reply `這份人資對照結果已過期。可以重新進行「人資模式」。`.

#### Scenario: Forward after analysis

- **WHEN** an analysis completes for role `AI 應用工程師` and the visitor taps `轉給主管`
- **THEN** the second message starts with `【履歷對照摘要】AI 應用工程師`, contains `有依據：` and the disclaimer, is at most 300 characters, no Gemini request is made, and `帶入邀約` still works afterwards

#### Scenario: Long lists are shortened

- **WHEN** the role is 50 characters and there are 5 supported requirements and 8 pending conditions of 60 characters each
- **THEN** the summary is at most 300 characters and contains `等` followed by a count

<!-- @trace
source: hr-insight-cards
updated: 2026-11-09
code:
  - gas/HrInsights.gs
  - package.json
  - START_HERE.html
  - docs/安裝後延伸思考.md
  - docs/部署指南.md
  - gas/Line.gs
  - README.md
  - gas/HrReview.gs
  - 老師需求.txt
  - docs/版本更新.md
  - docs/開始使用.md
  - gas/Config.gs
  - gas/Contact.gs
  - scripts/bundle.mjs
  - CHANGELOG.md
  - docs/學生安裝檢查.md
  - docs/聯繫與邀約通知.md
  - dist/Code.gs
  - test/hr-extensions.test.mjs
  - test/hr-review.test.mjs
  - test/hr-insights.test.mjs
-->