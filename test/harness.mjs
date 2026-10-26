import fs from 'node:fs';
import vm from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';

export function createGas(options = {}) {
  const properties = new Map(Object.entries({
    RESUME_DOC_ID: 'test-resume-document',
    GEMINI_API_KEY: 'test-gemini', LINE_CHANNEL_ACCESS_TOKEN: 'test-line',
    WEBHOOK_TOKEN: 'a'.repeat(64), ...options.properties
  }));
  const cache = new Map(), files = new Map(), calls = [], logs = [];
  const state = { text: options.text ?? '', tabs: options.tabs, properties, cache, files, calls, logs,
    response: options.response, documentWrites: 0, saves: 0, createdDocuments: [] };
  const props = {
    getProperty: key => properties.get(key) ?? null,
    setProperty: (key, value) => { properties.set(key, value); return props; },
    deleteProperty: key => { properties.delete(key); return props; },
    getProperties: () => Object.fromEntries(properties),
    setProperties: values => { Object.entries(values).forEach(([k, v]) => properties.set(k, v)); return props; }
  };
  function tab(id, text, children = [], onChange = () => {}) {
    const nodes = [];
    const changing = () => { if (state.documentWriteError) throw new Error('private-document-error'); state.documentWrites++; };
    const changed = () => onChange(body.getText());
    const paragraph = text => ({
      text, heading: 'NORMAL_TEXT', getType: () => 'PARAGRAPH', asParagraph() { return this; },
      getText() { return this.text; }, getHeading() { return this.heading; },
      setHeading(value) { changing(); this.heading = value; changed(); return this; }
    });
    function cell(text) {
      return { text, getText() { return this.text; },
        setText(value) { changing(); this.text = value; changed(); return this; } };
    }
    function row(values) {
      const cells = values.map(cell);
      return { getNumCells: () => cells.length, getCell: i => cells[i], getText: () => cells.map(c => c.getText()).join('\n'),
        appendTableCell(text) { changing(); const c = cell(text); cells.push(c); changed(); return c; } };
    }
    function table(values) {
      const rows = values.map(row);
      return { getType: () => 'TABLE', asTable() { return this; }, getNumRows: () => rows.length,
        getRow: i => rows[i], getCell: (r, c) => rows[r].getCell(c), getText: () => rows.map(r => r.getText()).join('\n'),
        appendTableRow() { changing(); const r = row([]); rows.push(r); changed(); return r; } };
    }
    const body = { getNumChildren: () => nodes.length, getChild: i => nodes[i],
      getText: () => nodes.map(n => n.getText()).join('\n'),
      setText(text) { changing(); nodes.splice(0, nodes.length, ...text.split('\n').map(paragraph)); changed(); return this; },
      appendParagraph(text) { changing(); const p = paragraph(text); nodes.push(p); changed(); return p; },
      insertTable(i, values) { changing(); const t = table(values); nodes.splice(i, 0, t); changed(); return t; }
    };
    nodes.push(...text.split('\n').map(paragraph));
    return { getId: () => id, getChildTabs: () => children,
      asDocumentTab: () => ({ getBody: () => body }) };
  }
  let mainTab, mainText;
  function documentTabs() {
    if (state.tabs) return state.tabs;
    if (!mainTab || mainText !== state.text) {
      mainText = state.text;
      mainTab = tab(state.primaryTabId ?? 't.0', state.text, [], text => { state.text = mainText = text; });
    }
    return [mainTab];
  }
  function findTab(tabs, id) {
    for (const t of tabs) {
      if (t.getId() === id) return t;
      const nested = findTab(t.getChildTabs(), id);
      if (nested) return nested;
    }
    return null;
  }
  const context = vm.createContext({
    Session: { getActiveUser: () => ({ getEmail: () => state.activeEmail ?? 'owner@example.test' }),
      getEffectiveUser: () => ({ getEmail: () => 'owner@example.test' }) },
    console: { log: value => logs.push(value) },
    PropertiesService: { getScriptProperties: () => props },
    CacheService: { getScriptCache: () => ({ get: k => cache.get(k) ?? null, put: (k, v) => cache.set(k, v) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => !state.lockBusy, releaseLock() {} }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_, text) => [...createHash('sha256').update(typeof text === 'string' ? text : Buffer.from(text)).digest()],
      getUuid: () => randomUUID(),
      base64Encode: bytes => Buffer.from(bytes).toString('base64'), sleep() {},
      formatDate: date => date.toISOString().replace('T', ' ').slice(0, 19)
    },
    DocumentApp: { ElementType: { PARAGRAPH: 'PARAGRAPH', TABLE: 'TABLE' },
      ParagraphHeading: { NORMAL: 'NORMAL_TEXT', HEADING1: 'HEADING_1' },
      openById: id => ({ getTabs: documentTabs, getTab: id => findTab(documentTabs(), id),
        getUrl: () => 'https://docs.google.com/document/d/' + id + '/edit',
        saveAndClose() { if (state.saveError) throw new Error('private-save-error'); state.saves++; } }),
      create(title) {
        if (state.createError) throw new Error('private-create-error');
        const id = 'created-document-' + randomUUID();
        state.primaryTabId = 'created-tab-1';
        state.text = ''; mainTab = null; state.tabs = null;
        const doc = { title, trashed: false, getId: () => id, getTabs: documentTabs,
          saveAndClose() { if (state.saveError) throw new Error('private-save-error'); state.saves++; },
          setTrashed(value) { doc.trashed = value; }, isTrashed: () => doc.trashed };
        state.createdDocuments.push(doc); files.set(id, doc);
        return doc;
      } },
    DriveApp: {
      createFile: (name, content) => {
        const id = 'file-' + (files.size + 1);
        const file = { name, content, trashed: false, getId: () => id,
          getBlob: () => ({ getDataAsString: () => file.content }),
          setTrashed: value => { file.trashed = value; }, isTrashed: () => file.trashed };
        files.set(id, file); return file;
      },
      getFileById: id => { if (!files.has(id)) throw new Error('File unavailable'); return files.get(id); }
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ text, setMimeType() { return this; } }) },
    HtmlService: { createHtmlOutput: text => ({ text }) },
    UrlFetchApp: { fetch: (url, config) => {
      const call = { url, ...config, body: config.payload ? JSON.parse(config.payload) : null };
      calls.push(call);
      const response = state.response ? state.response(call) : { status: 200, body: {} };
      return { getResponseCode: () => response.status ?? 200,
        getContentText: () => typeof response.text === 'string' ? response.text : JSON.stringify(response.body) };
    } },
    ScriptApp: { getScriptId: () => options.scriptId ?? 'test-script',
      getService: () => ({ getUrl: () => options.serviceUrl ?? null }),
      getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyHours: () => ({ create() {} }) }) }) }
  });
  const dir = new URL('../gas/', import.meta.url);
  const sources = options.sourceMode === 'bundle' ? [new URL('../dist/Code.gs', import.meta.url)]
    : fs.readdirSync(dir).filter(n => n.endsWith('.gs')).map(name => new URL(name, dir));
  for (const source of sources) vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source.pathname });
  return { gas: context, state, tab };
}

export function unitVector(index = 0) { return Array.from({ length: 768 }, (_, i) => i === index ? 1 : 0); }

export function event(text = '選單', id = 'event-1') {
  return { webhookEventId: id, type: 'message', mode: 'active', replyToken: 'reply-' + id,
    source: { type: 'user', userId: 'user-1' }, message: { type: 'text', id: 'msg-' + id, text } };
}
