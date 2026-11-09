## ADDED Requirements

### Requirement: Version 3.2.0 release

The deployed app SHALL report version `3.2.0` through `appVersion_()` and `checkDeployment`. The single-file bundle SHALL include `HrReview.gs` and `HrInsights.gs`, and the upgrade guide SHALL describe upgrading from v2 and from v3.x by replacing code and redeploying, without re-running `syncKnowledgeBase` or adding permissions; split-file installs SHALL add `HrInsights.gs` for a total of 20 `.gs` files.

#### Scenario: Deployment check after upgrade

- **WHEN** the owner runs `checkDeployment` after deploying v3.2
- **THEN** `editorVersion` and `webAppVersion` are both `3.2.0`

---

### Requirement: HR insight entry points

The system SHALL treat the text `經歷時間軸` or `時間軸` and the postback `hr:timeline` as the experience timeline command, and the text `成果拆解` and the postbacks `hr:star` and `hr:star:<sectionId>` as the outcome breakdown commands. These commands SHALL be handled without creating, changing, or clearing an HR review draft, and SHALL clear any unfinished invitation draft. The HR step 1 prompt Quick Reply SHALL contain, in order, `經歷時間軸` (`hr:timeline`), `成果拆解` (`hr:star`), and `取消` (`hr:cancel`). The help text SHALL describe both commands.

#### Scenario: Step 1 offers insight shortcuts

- **WHEN** a visitor taps `人資模式`
- **THEN** the step 1 prompt Quick Reply data are `hr:timeline`, `hr:star`, `hr:cancel` in that order

#### Scenario: Insight command keeps the HR draft

- **WHEN** a visitor at HR step 2 sends `經歷時間軸`
- **THEN** the bot replies with the timeline and the HR draft is still at step 2 with its earlier answer

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

---
### Requirement: Outcome breakdown

The `hr:star` command SHALL list, as Quick Reply items with postback `hr:star:<first 16 hex of sha256(section)>`, at most 8 distinct sections of non-image chunks whose title matches `專案`, `作品`, `經歷`, `實習`, `競賽`, `project`, or `portfolio` (case-insensitive), in document order. Each label SHALL be the part after the first `：` (or the whole title when absent) with a trailing full-width parenthesized note removed, cut to 20 characters. When none match the bot SHALL reply `履歷中沒有找到專案或經歷段落。`. The `hr:star:<sectionId>` command SHALL check index and fingerprint as the timeline does, take at most 4 non-image chunks of that section, and request one Gemini generation of `{situation, task, action, result}`, each `{id, quote}`; no embedding request SHALL be made. A part SHALL show its quote (cut to 80 characters) only when the quote, normalized by `quoteKey_`, is a contiguous substring of one of those chunks; otherwise it SHALL show `履歷未提及` and add a fixed follow-up question for that part. A verified result without Arabic digits, a percent sign, or a Chinese numeral followed by a unit SHALL be marked `成果未量化` with a follow-up question asking for numbers. An unknown section ID SHALL reply `這個專案已不在目前的履歷中，請重新選擇「成果拆解」。`. The follow-up text Quick Reply SHALL begin with `換一個專案` (`hr:star`).

#### Scenario: Pick a project

- **WHEN** the resume has sections `專案一：LINE 內部知識助理（虛構測試資料）` and `專業技能`
- **THEN** the picker lists only `LINE 內部知識助理`

#### Scenario: Missing and unverified parts

- **WHEN** Gemini returns verified quotes for situation and action, an invented quote for task, and a verified result quote without numbers
- **THEN** the card shows `履歷未提及` for task, the follow-up text contains the task question and the `成果未量化` question, and one generation request and no embedding request are made

---
### Requirement: Forward summary for hiring managers

After a completed heatmap analysis, the system SHALL build a summary of at most 300 characters and store it as `forward` in the HR draft. The summary SHALL contain, in this order, `【履歷對照摘要】<role>`, `有依據：` with each supported requirement and its best level label, `待確認：` with the pending conditions, `建議面談：` with the first interview question when it fits, `來源：` with the source sections, and `※ 依公開履歷證據整理，不是錄取分數。`. Items that do not fit SHALL be replaced by `等 N 項`. The pending-confirmation message Quick Reply SHALL begin with `帶入邀約` (`hr:invite:<draftId>`) followed by `轉給主管` (`hr:forward:<draftId>`). `hr:forward:<draftId>` SHALL reply with `以下摘要可長按複製，轉傳給用人主管：` and the summary text as two messages, without calling Gemini and without clearing the draft. A stale or unknown draft ID SHALL reply `這份人資對照結果已過期。可以重新進行「人資模式」。`.

#### Scenario: Forward after analysis

- **WHEN** an analysis completes for role `AI 應用工程師` and the visitor taps `轉給主管`
- **THEN** the second message starts with `【履歷對照摘要】AI 應用工程師`, contains `有依據：` and the disclaimer, is at most 300 characters, no Gemini request is made, and `帶入邀約` still works afterwards

#### Scenario: Long lists are shortened

- **WHEN** the role is 50 characters and there are 5 supported requirements and 8 pending conditions of 60 characters each
- **THEN** the summary is at most 300 characters and contains `等` followed by a count

## MODIFIED Requirements

### Requirement: HR input privacy

HR answers SHALL be stored only in the script cache draft and SHALL NOT be written to the Google Doc, the invitation inbox, the Drive index, or execution logs. After a completed analysis, the draft fields SHALL be cleared; only the role, the pending conditions, and the forward summary SHALL remain in the same cache draft until it expires, for "Carry results into an invitation" and "Forward summary for hiring managers". A pasted job description SHALL be sent to Gemini for extraction only and SHALL NOT be stored. Timeline and outcome breakdown results SHALL NOT be stored. The privacy text SHALL state these rules. The Gemini instructions SHALL treat HR input and resume chunks as untrusted data, SHALL forbid evaluating or asking about age, gender, marital or family status, religion, health, or nationality, and SHALL forbid promising employment. The privacy text SHALL state that HR mode inputs are sent to AI for analysis while invitation inputs are not.

#### Scenario: Nothing persisted after analysis

- **WHEN** an analysis completes
- **THEN** no document write occurs, the invitation inbox is unchanged, logs contain no HR input text, and the cached draft has empty fields

#### Scenario: Privacy text explains the difference

- **WHEN** a visitor sends `隱私`
- **THEN** the reply states that HR mode inputs are sent to AI for analysis and invitation inputs are not, and mentions `轉給主管`

## REMOVED Requirements

### Requirement: Version 3.1.0 release

**Reason**: Superseded by the 3.2.0 release that adds HrInsights.gs.
**Migration**: Follow "Version 3.2.0 release"; upgrade by replacing code and redeploying.
