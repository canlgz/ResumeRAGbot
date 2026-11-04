## ADDED Requirements

### Requirement: Job description extraction

At step 2 of HR review mode the system SHALL offer a `貼職缺說明` action (`hr:jd:<draftId>`). In this mode the visitor SHALL paste a job description of at most 2000 characters, and the system SHALL request one structured Gemini extraction of `items[{label, kind, quote}]`. An item SHALL be kept only when its whitespace-stripped quote is a contiguous substring of the whitespace-stripped job description and its label does not name a non-job attribute (age, gender, marital or family status, religion, health, nationality). Kept items SHALL replace the required and bonus fields and the draft SHALL move to the confirmation card, which states how many items were dropped. The job description text SHALL NOT be stored in the draft, the outcome cache, logs or any persistent store. `改為逐項輸入` (`hr:manual:<draftId>`) SHALL return to manual input.

#### Scenario: Extract verified requirements

- **WHEN** a visitor pastes a job description and Gemini returns one item with a quote from the text, one with an invented quote and one labelled `性別`
- **THEN** the confirmation card lists only the first item and reports one unverified and one excluded item

#### Scenario: Nothing extractable

- **WHEN** no extracted item passes verification
- **THEN** the bot explains that no verifiable requirement was found and shows the manual step 2 prompt

### Requirement: Editable confirmation card

The confirmation card SHALL provide `移除：<label>` actions (`hr:drop:<draftId>:<n>`) when more than one requirement is listed, and a `修改需求` action (`hr:edit:<draftId>`). Removing an item SHALL delete that label from both required and bonus fields and redisplay the card; removing the last item SHALL return to step 2. Editing SHALL return to step 2, show the current value, and offer `沿用目前` (`hr:keep:<draftId>`) at steps 2 and 3.

#### Scenario: Remove one requirement

- **WHEN** the card lists `Python`, `RAG`, `LINE Bot` and the visitor taps `移除：RAG`
- **THEN** the card lists `Python` and `LINE Bot`

### Requirement: Per-requirement retrieval

The confirmation card SHALL offer `逐項對照` (`hr:deep:<draftId>`). With more than one requirement, the system SHALL embed one query per requirement in a single `batchEmbedContents` request, take the top 4 chunks per requirement, merge them round-robin without duplicates up to 12 chunks, and request one Gemini generation. The summary SHALL state `逐項檢索`.

#### Scenario: Deep comparison

- **WHEN** a visitor with three requirements taps `逐項對照`
- **THEN** exactly one batch embedding request with three queries and one generation request are made, and the summary mentions `逐項檢索`

### Requirement: Carry results into an invitation

After a completed analysis, the pending-confirmation message SHALL include a `帶入邀約` Quick Reply (`hr:invite:<draftId>`). It SHALL start an invitation draft whose step 2 shows the role and pending conditions (at most 600 characters), with `使用帶入內容` (`invite:carry:<invitationId>`) or free text appended after the carried text. The HR draft SHALL be cleared. The invitation SHALL still be saved and notified only after the visitor confirms it.

#### Scenario: Carry pending conditions

- **WHEN** a visitor taps `帶入邀約`, answers step 1, and taps `使用帶入內容`
- **THEN** the invitation message field contains the role and each pending condition, and nothing is stored in the inbox until `確認送出`
