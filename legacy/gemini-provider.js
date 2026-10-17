const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
const models=()=>({text:process.env.GEMINI_TEXT_MODEL||process.env.GEMINI_MODEL||'gemini-3.6-flash',vision:process.env.GEMINI_VISION_MODEL||process.env.GEMINI_MODEL||'gemini-3.6-flash',image:process.env.GEMINI_IMAGE_MODEL||''});
// Gemini 3.6 rejects maxItems in responseJsonSchema with HTTP 400. Collection
// limits are still enforced by the domain validators after parsing the result.
const providerSchema=value=>{
 if(Array.isArray(value))return value.map(providerSchema);
 if(!value||typeof value!=='object')return value;
 return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='maxItems').map(([key,item])=>[key,providerSchema(item)]));
};
export function aiCapabilities(){
 const configured=!!process.env.GEMINI_API_KEY,m=models();
 return {provider:'gemini',configured,menuAssistant:configured&&!!m.text,menuExtraction:configured&&!!m.vision,floorExtraction:configured&&!!m.vision,imageGeneration:configured&&!!m.image,models:{text:!!m.text,vision:!!m.vision,image:!!m.image},limits:{sources:6,sourceBytes:3_000_000,totalBytes:9_000_000}};
}
export function validateSources(input){
 const sources=Array.isArray(input?.sources)?input.sources:input?.mime?[input]:[];if(!sources.length||sources.length>6)fail('Provide between one and six source files.');
 let total=0;const normalized=sources.map((source,index)=>{const mime=String(source.mime||'');if(!['application/pdf','image/png','image/jpeg','image/webp','text/plain'].includes(mime))fail('Use PDF, PNG, JPEG, WebP or plain text.');
   if(mime==='text/plain'){const value=String(source.text||'').slice(0,100000);if(!value.trim())fail('Text sources cannot be empty.');total+=Buffer.byteLength(value);return {name:String(source.name||`Source ${index+1}`).slice(0,120),mime,text:value};}
   const data=String(source.data||'');if(!/^[A-Za-z0-9+/]+={0,2}$/.test(data))fail('A source file is not valid base64.');const bytes=Math.floor(data.length*3/4);if(bytes>3_000_000)fail('Each source must be smaller than 3 MB.');total+=bytes;return {name:String(source.name||`Source ${index+1}`).slice(0,120),mime,data};});if(total>9_000_000)fail('Combined sources must be smaller than 9 MB.');return normalized;
}
export async function geminiJson({capability='text',instruction,payload,parts=[],schema,timeout=25000,fetcher=fetch}){
 const caps=aiCapabilities(),model=models()[capability];if(!caps.configured||!model)fail(`Gemini ${capability} capability is not configured.`,503);
 const response=await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':process.env.GEMINI_API_KEY},signal:AbortSignal.timeout(timeout),body:JSON.stringify({systemInstruction:{parts:[{text:instruction}]},contents:[{parts:[{text:JSON.stringify(payload)},...parts]}],generationConfig:{responseMimeType:'application/json',responseJsonSchema:providerSchema(schema)}})});
 if(!response.ok)fail('Gemini is temporarily unavailable. No restaurant data was changed.',502);
 try{const data=await response.json(),text=data.candidates?.[0]?.content?.parts?.find(p=>typeof p.text==='string')?.text;return JSON.parse(text);}catch{fail('Gemini returned an invalid structured draft. No restaurant data was changed.',422);}
}
export async function geminiImage({prompt,fetcher=fetch}){
 const model=models().image;if(!process.env.GEMINI_API_KEY||!model)fail('Gemini image generation is not configured.',503);
 const response=await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,{method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':process.env.GEMINI_API_KEY},signal:AbortSignal.timeout(45000),body:JSON.stringify({contents:[{parts:[{text:String(prompt||'').slice(0,1200)}]}],generationConfig:{responseModalities:['IMAGE']}})});
 if(!response.ok)fail('Gemini image generation is unavailable. No image was saved.',502);const data=await response.json(),image=data.candidates?.[0]?.content?.parts?.find(p=>p.inlineData)?.inlineData;
 if(!image||!['image/png','image/jpeg','image/webp'].includes(image.mimeType)||typeof image.data!=='string')fail('Gemini did not return a usable image.',422);return {mime:image.mimeType,data:image.data};
}
