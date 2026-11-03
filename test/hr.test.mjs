import test from 'node:test';
import assert from 'node:assert/strict';
import { createGas, event, unitVector } from './harness.mjs';

function createHrFixture() {
  const resumeText = [
    '[[PUBLIC]]',
    '## 個人介紹',
    '姓名：陳沐言。職涯定位：AI 應用與流程自動化工程師。求職方向：AI 應用工程師、自動化工程師。',
    '## 專業技能',
    'Python：使用 pandas 整理 CSV 與 Excel 資料，撰寫欄位檢查與排程腳本。',
    'SQL：使用 PostgreSQL 撰寫 JOIN、CTE 與視窗函式。',
    '## 工作經歷一：AI 應用工程師',
    '公司：禾序數位工作室。主要職責：開發報表自動化與內部知識查詢工具。',
    '## 專案二：每週營運報表自動化',
    '使用技術：Python、pandas、Google Sheets、Google Apps Script。測試成果：單次平均處理時間由九十分鐘降為十五分鐘。',
    '## 工作方式與職務適配',
    '經驗邊界：已有的作品以小型工具與內部原型為主；未提供大型模型訓練、Kubernetes 維運、百萬使用者系統或帶領大型團隊的經驗。',
    '[[/PUBLIC]]'
  ].join('\n');

  const { gas, state } = createGas({
    text: resumeText,
    response: call => {
      if (call.url.endsWith(':batchEmbedContents')) {
        const requests = call.body.requests || [];
        return { body: { embeddings: requests.map((_, i) => ({ values: unitVector(i % 4) })) } };
      }
      if (call.url.endsWith(':embedContent')) {
        return { body: { embedding: { values: unitVector(0) } } };
      }
      if (call.url.endsWith(':generateContent')) {
        const schema = call.body?.generationConfig?.responseSchema;
        if (schema?.properties?.heatmapRows) {
          return {
            body: {
              candidates: [{
                finishReason: 'STOP',
                content: {
                  parts: [{
                    text: JSON.stringify({
                      overallQualityGrade: '待加強（僅具基礎或原型強度）',
                      documentQualityAudit: '文件雖列有 Python、SQL 與報表自動化，但專案皆註明為小型工具與內部原型，缺乏正式生產環境架構與容器化維運實績。',
                      step3QualityLevel: '基礎偏弱（待加強）',
                      step3Feedback: '文件記載每週營運報表自動化，但經驗邊界明言僅限於小型內部原型，未具大規模正式營運驗證。',
                      overallSummary: '求職者文件在基礎 Python/SQL 腳本上有明確對應，但針對容器化部署與大型生產環境則屬於不及格（缺實質佐證）。',
                      heatmapRows: [
                        { label: 'AI應用工程師', category: '職稱', skillClaim: 'high', workExp: 'partial', project: 'partial', outcome: 'partial', note: '具相關職稱記載，惟作品以小型內部原型為主' },
                        { label: 'Python/SQL', category: '技能', skillClaim: 'high', workExp: 'high', project: 'partial', outcome: 'partial', note: '有腳本與查詢記載，成果屬內部測試數據' },
                        { label: 'Docker/K8s', category: '技能', skillClaim: 'low', workExp: 'low', project: 'low', outcome: 'low', note: '不及格：經驗邊界明言未提供 K8s 維運經驗' },
                        { label: '流程自動化經驗', category: '經驗', skillClaim: 'high', workExp: 'partial', project: 'partial', outcome: 'partial', note: '具週報自動化原型，無大規模系統落地實績' }
                      ],
                      matched: ['Python 與 SQL 具備資料清理、欄位檢查與排程腳本實作記載'],
                      gaps: ['Docker/K8s 容器化維運於文件中完全無實作佐證（不及格）', '專案成果均停留在小型內部原型階段，缺乏正式環境驗證'],
                      interviewQuestions: ['請具體說明週報自動化腳本如何處理異常中斷與告警？', '是否有實際在正式環境部署容器化服務的經驗？'],
                      sourceIds: ['S1', 'S2']
                    })
                  }]
                }
              }]
            }
          };
        }
        if (schema?.properties?.qualityLevel) {
          return {
            body: {
              candidates: [{
                finishReason: 'STOP',
                content: {
                  parts: [{
                    text: JSON.stringify({
                      qualityLevel: '基礎偏弱（待加強）',
                      summary: '文件雖記載 AI 應用工程師與 Python/SQL，但內容強度以小型工具與內部原型為主，缺乏生產環境規模佐證。',
                      sourceIds: ['S1']
                    })
                  }]
                }
              }]
            }
          };
        }
      }
      return { status: 200, body: {} };
    }
  });
  gas.syncKnowledgeBase();
  return { gas, state };
}

test('HR 3-step sequential flow performs per-step content quality checks and outputs 3-column analysis, source bubble, and 2D Heatmap Flex card', () => {
  const { gas, state } = createHrFixture();
  const cfg = gas.config_();

  // Start via postback hr:start
  gas.handleEvent_({ ...event('', 'hr-0'), type: 'postback', postback: { data: 'hr:start' } }, cfg);
  let reply = state.calls.filter(c => c.url.endsWith('/message/reply')).at(-1).body.messages;
  assert.equal(reply.length, 1);
  assert.match(reply[0].text, /第 1 \/ 3 題｜主要工作職稱/);

  // Answer Q1 (Role) -> immediate content quality check + Q2 prompt
  gas.handleEvent_(event('資深 AI 應用工程師', 'hr-1'), cfg);
  reply = state.calls.filter(c => c.url.endsWith('/message/reply')).at(-1).body.messages;
  assert.equal(reply.length, 2);
  assert.match(reply[0].text, /即時內容品質檢核｜職稱定位/);
  assert.match(reply[0].text, /文件強度判定：【基礎偏弱（待加強）】/);
  assert.match(reply[1].text, /第 2 \/ 3 題｜對應工作技能/);

  // Answer Q2 (Skills) -> immediate content quality check + Q3 prompt with skip button
  gas.handleEvent_(event('Python、SQL、Docker/K8s', 'hr-2'), cfg);
  reply = state.calls.filter(c => c.url.endsWith('/message/reply')).at(-1).body.messages;
  assert.equal(reply.length, 2);
  assert.match(reply[0].text, /即時內容品質檢核｜對應技能/);
  assert.match(reply[1].text, /第 3 \/ 3 題｜具體工作與專案經驗/);
  assert(reply[1].quickReply.items.some(i => i.action.data.startsWith('hr:skip:')));

  // Answer Q3 (Experience) -> Final 3-column analysis + Source bubble + 2D Heatmap Flex card
  const writesBefore = state.documentWrites;
  gas.handleEvent_(event('需有流程自動化與正式環境部署經驗', 'hr-3'), cfg);
  reply = state.calls.filter(c => c.url.endsWith('/message/reply')).at(-1).body.messages;
  assert.equal(reply.length, 3);
  assert.match(reply[0].text, /【履歷文件內容品質與強度總評】/);
  assert.match(reply[0].text, /【人資三欄式實質強度分析】/);
  assert.match(reply[1].text, /^資料來源：/);
  assert.equal(reply[2].type, 'flex');
  assert.match(reply[2].altText, /人資適配熱圖/);
  const flexStr = JSON.stringify(reply[2].contents);
  assert.match(flexStr, /● 達標/);
  assert.match(flexStr, /◐ 偏弱/);
  assert.match(flexStr, /✕ 不及格/);
  assert.equal(state.documentWrites, writesBefore, 'HR evaluation must never write JD data back into the resume document');
});

test('HR flow supports skipping Q3, cancelling mid-flow, and isolating visitor drafts', () => {
  const { gas, state } = createHrFixture();
  const cfg = gas.config_();

  // Visitor 1 starts HR flow
  gas.handleEvent_({ ...event('', 'c-0'), type: 'postback', postback: { data: 'hr:start' } }, cfg);
  // Visitor 2 sends normal message and is not trapped in Visitor 1's HR draft
  const v2Event = { ...event('選單', 'v2-home'), source: { type: 'user', userId: 'user-2' } };
  gas.handleEvent_(v2Event, cfg);
  const v2Reply = state.calls.filter(c => c.url.endsWith('/message/reply')).at(-1).body.messages[0];
  assert.equal(v2Reply.type, 'flex');

  // Visitor 1 cancels
  gas.handleEvent_({ ...event('', 'c-cancel'), type: 'postback', postback: { data: 'hr:cancel' } }, cfg);
  const cancelReply = state.calls.filter(c => c.url.endsWith('/message/reply')).at(-1).body.messages[0];
  assert.match(cancelReply.text, /已取消人資適配評量/);
});
