// Isolated browser verification only. Never imported by the application or Netlify.
import {readFileSync} from 'node:fs';
import {createApp} from '../server.js';
const fixtures=JSON.parse(readFileSync(new URL('../tests/owner-fixtures.json',import.meta.url),'utf8'));
const enabled=process.env.OWNER_TEST_MOCK==='1';
if(enabled){process.env.GEMINI_API_KEY='mock-verification-only';process.env.GEMINI_IMAGE_MODEL='mock-image';}else{delete process.env.GEMINI_API_KEY;delete process.env.GEMINI_IMAGE_MODEL;}
const app=createApp({dbPath:process.env.DB_PATH,managerPassword:'owner-test',kitchenPassword:'kitchen-test',origin:'http://localhost:3108',aiFetch:async(_url,options)=>{await new Promise(r=>setTimeout(r,300));const body=JSON.parse(options.body);if(body.generationConfig.responseModalities)return {ok:true,json:async()=>({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:readFileSync(new URL('../public/assets/resuto-arabic-logo.png',import.meta.url)).toString('base64')}}]}}]})};const value=body.generationConfig.responseJsonSchema.properties.tables?fixtures.floor:fixtures.menu;return {ok:true,json:async()=>({candidates:[{content:{parts:[{text:JSON.stringify(value)}]}}]})};}});
app.server.listen(3108,'127.0.0.1',()=>console.log('Owner UI verification: '+(enabled?'MOCK GEMINI':'MISSING KEY')));
