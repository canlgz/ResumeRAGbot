## Purpose

HR review mode lets a recruiter answer three job-requirement questions in LINE and receive a skill-by-requirement evidence heatmap built only from verifiable quotes in the public resume. It exists so recruiters can quickly see which requirements the resume supports and which ones still need confirmation, without the bot producing a hiring score.

## ADDED Requirements

### Requirement: HR mode entry points

The system SHALL start HR review mode when a visitor sends the postback `hr:start` or the text `人資` or `人資模式`. Every Quick Reply built from the resume topic menu (`quickReply_()`) SHALL include a fixed `人資模式` action with postback data `hr:start` after the resume topic items; step prompts and confirmation cards of the HR and invitation drafts keep their own draft-specific Quick Reply (or none) and are excluded. In addition, the third home card SHALL include a `人資模式` button with the same postback. The `人資模式` action SHALL NOT appear in the resume topic list used for RAG topics.

#### Scenario: Start from Quick Reply

- **WHEN** a visitor taps the `人資模式` Quick Reply item
- **THEN** the bot replies with the step 1 of 3 prompt asking for the job title, including notices that the result is not a hiring score, that inputs are sent to AI for analysis, that the draft lasts 30 minutes, and that `取消` leaves the mode

#### Scenario: Quick Reply keeps topics first

- **WHEN** the resume has only the base topics `我是誰` and `快速一覽`
- **THEN** the Quick Reply labels are `我是誰`, `快速一覽`, `人資模式` in that order and the resume topic list contains only `我是誰` and `快速一覽`

### Requirement: Three-step job requirement questionnaire

The system SHALL collect three fields in order: `role` (job title, at most 50 characters, required), `required` (required skills or conditions, at most 300 characters, required), and `bonus` (bonus conditions or work context, at most 300 characters, skippable through `hr:skip:<draftId>`). An over-length answer SHALL keep the visitor on the same step with a length notice. After step 3 the system SHALL show a confirmation card listing the role and the parsed requirements, with actions `開始對照` (`hr:submit:<draftId>`), `重新填寫` (`hr:restart:<draftId>`), and `取消` (`hr:cancel`).

#### Scenario: Complete the questionnaire

- **WHEN** a visitor answers `AI 應用工程師`, then `Python、RAG、LINE Bot`, then taps `略過`
- **THEN** the bot shows a confirmation card listing role `AI 應用工程師` and requirements `Python`, `RAG`, `LINE Bot`

#### Scenario: Over-length answer

- **WHEN** a visitor sends a 51-character job title at step 1
- **THEN** the bot replies that the field is limited to 50 characters and the draft remains at step 1

#### Scenario: Required field with no items

- **WHEN** a visitor sends `、、，` at step 2
- **THEN** the bot asks for at least one requirement and the draft remains at step 2

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

### Requirement: Heatmap reply content

The analysis reply SHALL contain at most 4 messages: a text summary naming the role and the number of compared requirements; a Flex heatmap with requirement rows (bonus rows prefixed with `＋`), skill columns, a four-level legend, and the sentence `只表示公開履歷中的證據強度，不是錄取分數；未提及不代表不具備。`; a text listing pending confirmations and at most 3 interview questions; and a text `資料來源：` listing the section titles of verified quotes. The heatmap message JSON SHALL be under 30,000 characters.

#### Scenario: Successful analysis reply

- **WHEN** the analysis verifies at least one cell
- **THEN** the reply contains the summary, the heatmap with the disclaimer sentence, the pending and interview-question text, and the source text, each with a Quick Reply

#### Scenario: Interview questions are capped

- **WHEN** Gemini returns 5 interview questions
- **THEN** the reply includes only the first 3

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

### Requirement: HR input privacy

HR answers SHALL be stored only in the script cache draft and SHALL NOT be written to the Google Doc, the invitation inbox, the Drive index, or execution logs. After a completed analysis, the draft fields SHALL be cleared. The Gemini instructions SHALL treat HR input and resume chunks as untrusted data, SHALL forbid evaluating or asking about age, gender, marital or family status, religion, health, or nationality, and SHALL forbid promising employment. The privacy text SHALL state that HR mode inputs are sent to AI for analysis while invitation inputs are not.

#### Scenario: Nothing persisted after analysis

- **WHEN** an analysis completes
- **THEN** no document write occurs, the invitation inbox is unchanged, logs contain no HR input text, and the cached draft has empty fields

#### Scenario: Privacy text explains the difference

- **WHEN** a visitor sends `隱私`
- **THEN** the reply states that HR mode inputs are sent to AI for analysis and invitation inputs are not

### Requirement: Analysis failure handling

When Gemini fails, times out, or returns an invalid structure, the system SHALL reply with an error message, log only an error code, and keep the draft at the confirmation step so `開始對照` can be retried. When the index is missing the system SHALL reply `履歷資料正在準備中`; when the source fingerprint differs from the index before or after generation the system SHALL reply that the resume is waiting for sync and SHALL NOT send heatmap results.

#### Scenario: Invalid AI format then retry

- **WHEN** the first Gemini response lacks the `cells` field and the visitor taps `開始對照` again with a valid response
- **THEN** the first reply asks to retry and logs `HR_REVIEW_INVALID_FORMAT`, and the second reply contains the heatmap

#### Scenario: Resume changed during generation

- **WHEN** the source fingerprint changes between retrieval and reply
- **THEN** the bot replies that the resume is waiting for sync and sends no heatmap

### Requirement: Version 3.0.0 release

The deployed app SHALL report version `3.0.0` through `appVersion_()` and `checkDeployment`. The single-file bundle SHALL include `HrReview.gs`, and the upgrade guide SHALL describe upgrading from v2 by replacing code and redeploying, without re-running `syncKnowledgeBase` or adding permissions.

#### Scenario: Deployment check after upgrade

- **WHEN** the owner runs `checkDeployment` after deploying v3
- **THEN** `editorVersion` and `webAppVersion` are both `3.0.0`
