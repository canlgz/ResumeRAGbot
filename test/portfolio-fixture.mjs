import { createGas, unitVector } from './harness.mjs';

export const png = (width=1000,height=667) => {
  const bytes=Array(40).fill(0);bytes.splice(0,8,137,80,78,71,13,10,26,10);
  for(const [i,n] of [[16,width],[20,height]])for(let j=0;j<4;j++)bytes[i+j]=(n>>((3-j)*8))&255;
  return bytes;
};
export function picture(label) {
  const ref={bytes:[...png(640,420),...Buffer.from(label)],reads:0,getType:()=> 'INLINE_IMAGE',asInlineImage(){return this;},getBlob(){
    ref.reads++;
    const blob=name=>({getBytes:()=>ref.bytes,getContentType:()=> 'image/png',getName:()=>name,
      copyBlob:()=>blob(name),setName(value){name=value;return this;}});
    return blob(label+'.png');
  }};return ref;
}
export const paragraph=(value,heading='NORMAL_TEXT')=>({getType:()=> 'PARAGRAPH',asParagraph(){return this;},getHeading:()=>heading,
  getText:()=>typeof value==='string'?value:'',getNumChildren:()=>1,getChild:()=>typeof value==='string'?{getType:()=> 'TEXT',getText:()=>value}:value});
export const candidate=value=>({body:{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]}});
export const isOcr=call=>call.body?.contents?.[0]?.parts?.some(part=>part.inlineData);

export function portfolioFixture(options={}) {
  const website=picture('website'),poster=picture('poster'),privatePicture=picture('private');
  const nodes=[paragraph('[[PUBLIC]]'),paragraph('作品 A｜閱讀網站介面','HEADING_1'),paragraph(website),paragraph('本人負責網站介面規劃。'),
    paragraph('作品 B｜攝影展海報','HEADING_1'),paragraph(poster),paragraph('此海報使用城市攝影素材作為測試作品。'),
    paragraph('職涯背景','HEADING_1'),paragraph('以 Google Apps Script 開發互動應用。'),paragraph('[[/PUBLIC]]'),paragraph(privatePicture)];
  const tabs=[{getId:()=> 't.0',getChildTabs:()=>[],asDocumentTab:()=>({getBody:()=>({getType:()=> 'BODY_SECTION',getNumChildren:()=>nodes.length,getChild:i=>nodes[i]})})}];
  const f=createGas({tabs,properties:{WEB_APP_URL:'https://script.google.com/macros/s/student-public/exec'},...options});
  f.state.response=call=>{
    if(call.url.startsWith('https://script.google.com/'))return {text:f.gas.doGet().text};
    if(call.url.startsWith('https://drive.google.com/thumbnail'))return {mime:'image/png',bytes:png()};
    if(isOcr(call)){
      const decoded=Buffer.from(call.body.contents[0].parts[1].inlineData.data,'base64');
      const site=decoded.equals(Buffer.from(website.bytes));
      return candidate({status:'readable',text:site?'拾光閱讀':'城市散步攝影展',visualDescription:site?'畫面可見青綠色導覽列與三張書籍卡片。':'畫面可見橘色圓形與深藍色建築。'});
    }
    if(call.url.endsWith(':batchEmbedContents'))return {body:{embeddings:call.body.requests.map(()=>({values:unitVector()}))}};
    if(call.url.endsWith(':embedContent'))return {body:{embedding:{values:unitVector()}}};
    if(call.url.endsWith(':generateContent')){
      const payload=JSON.parse(call.body.contents[0].parts[0].text);
      const selected=payload.conversation?.selectedWorkTitle||payload.question;
      const target=/閱讀|網站/.test(selected)?payload.evidence.find(item=>item.text.includes('青綠色')):payload.evidence.find(item=>item.text.includes('橘色'));
      const hit=target||payload.evidence[0];
      const quote=hit.text.includes('青綠色')?'畫面可見青綠色導覽列與三張書籍卡片。':hit.text.includes('橘色')?'畫面可見橘色圓形與深藍色建築。':hit.text.slice(0,35);
      return candidate({grounded:true,answer:quote,evidence:[{id:hit.id,quote}],sticker:'celebrate'});
    }
    return {body:{}};
  };
  f.gas.syncKnowledgeBase();
  const owner=f.gas.openImageReview();
  return {...f,website,poster,privatePicture,nodes,token:owner.url.split('#')[1],originalNodes:nodes.map(node=>node.getText()).join('\n')};
}
