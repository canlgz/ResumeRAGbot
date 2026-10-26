// Optional UI checks: PLAYWRIGHT_MODULE and CHROME_PATH can select a local browser runtime.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const html=await fs.readFile(path.join(root,'web/image-review.html'),'utf8');
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
const out=path.join(root,'local/review-browser');await fs.mkdir(out,{recursive:true});
try{
  for(const [name,viewport] of [['desktop',{width:1360,height:1000}],['mobile',{width:390,height:844}]]){
    const page=await browser.newPage({viewport});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const image='data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#ddded2"/><circle cx="400" cy="280" r="160" fill="#d87c47"/></svg>').toString('base64');
    await page.addInitScript(({image})=>{
      const token='a'.repeat(64),data={version:'1.3.0',fingerprint:'fixture',indexReady:true,reviewRevision:0,expiresAt:Date.now()+1200000,
        topics:['網站介面','攝影海報','職涯背景'].map((label,i)=>({label,id:String(i+1).repeat(16)})),images:['作品 A｜閱讀網站介面','作品 B｜攝影展海報'].map((title,i)=>({digest:String(i+1).repeat(64),title,transcription:i?'城市散步':'拾光閱讀',visualDescription:i?'橘色圓形與藍色建築。':'青綠色導覽列與書籍卡片。',originalTranscription:i?'城市散步':'拾光閱讀',originalVisualDescription:'畫面觀察',sharing:'private'}))};
      window.rpcCalls=[];window.failNext='';
      window.google={script:{url:{getLocation:cb=>cb({hash:token})},run:{withSuccessHandler(success){const api={withFailureHandler(failure){return new Proxy({}, {get:(_,method)=>(passed,...args)=>{window.rpcCalls.push({method,args});setTimeout(()=>{try{
        if(window.failNext){const code=window.failNext;window.failNext='';throw new Error(code);}
        if(passed!==token)throw new Error('REVIEW_SESSION_EXPIRED');
        let result;
        if(method==='getImageReviewData')result=structuredClone(data);
        else if(method==='getImageReviewImage')result={dataUrl:image};
        else if(method==='saveImageReview'){const item=data.images.find(x=>x.digest===args[0]);item.transcription=args[1].transcription;item.visualDescription=args[1].visualDescription;item.reviewed=true;data.reviewRevision++;result={saved:true,synced:true};}
        else if(method==='setPortfolioImageSharing'){data.images.find(x=>x.digest===args[0]).sharing=args[1]?'public':'private';result={status:args[1]?'public':'private'};}
        else if(method==='validatePortfolioCards')result={message:'LINE 已接受作品卡片格式；這項檢查沒有傳送訊息。'};
        else if(method==='testImageReviewTopic')result={status:'answered',label:data.topics.find(t=>t.id===args[0]).label,messages:['這是主題測試回答。','資料來源：指定主題'],previousWorkSeeded:true};
        else if(method==='syncImageReview')result={status:'unchanged'};
        else if(method==='closeImageReview')result={status:'closed'};
        else throw new Error('unknown method');
        success(result);
      }catch(error){failure(error);}},5);}});}};return api;}}}};
    },{image});
    await page.route('https://review.test/',route=>route.fulfill({contentType:'text/html',body:html}));
    await page.goto('https://review.test/');await page.locator('article').nth(1).waitFor();
    await page.waitForFunction(()=>!document.getElementById('reload').disabled);
    assert.equal(await page.locator('img').count(),2);
    assert(await page.locator('#summary').textContent().then(x=>x.includes('網站介面')));
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:path.join(out,name+'.png'),fullPage:true});
    await page.locator('#topicsTest').click();
    await page.waitForFunction(()=>!document.getElementById('reload').disabled);
    assert.match(await page.locator('#status').textContent(),/3 \/ 3 通過/);
    assert.equal(await page.locator('#topicResults section').count(),3);
    const first=page.locator('article').first(),second=page.locator('article').nth(1);
    await first.getByRole('button',{name:'開放作品預覽',exact:true}).click();
    await page.waitForFunction(()=>!document.getElementById('reload').disabled);
    assert.match(await page.locator('#status').textContent(),/先勾選/);
    assert.equal(await page.evaluate(()=>rpcCalls.filter(c=>c.method==='setPortfolioImageSharing').length),0);
    await first.locator('textarea').first().fill('<img src=x onerror="window.injected=true">');
    assert(await page.locator('#reload').isDisabled());assert(await second.locator('textarea').first().isDisabled());
    await first.getByRole('button',{name:'儲存校對並同步',exact:true}).click();
    await page.waitForFunction(()=>!document.getElementById('reload').disabled);
    assert.match(await page.locator('#status').textContent(),/保存並完成同步/);assert.equal(await page.evaluate(()=>window.injected),undefined);
    await first.locator('input[type=checkbox]').check();await first.getByRole('button',{name:'開放作品預覽',exact:true}).click();
    await page.waitForFunction(()=>!document.getElementById('reload').disabled);
    assert.match(await first.locator('.sharing h3').textContent(),/已開放/);
    await first.getByRole('button',{name:'撤回公開預覽',exact:true}).click();
    await page.waitForFunction(()=>!document.getElementById('reload').disabled);
    assert.match(await first.locator('.sharing h3').textContent(),/未開放/);
    await page.evaluate(()=>{window.failNext='REVIEW_SESSION_EXPIRED';});await page.locator('#reload').click();
    await page.waitForFunction(()=>document.querySelectorAll('article').length===0);
    assert(await page.locator('#reload').isDisabled());assert.match(await page.locator('#status').textContent(),/連結已失效/);
    assert.deepEqual(errors,[]);await page.close();
    console.log(name+': responsive layout, image loading, consent, correction, XSS text, sharing and session expiry passed.');
  }
}finally{await browser.close();}
