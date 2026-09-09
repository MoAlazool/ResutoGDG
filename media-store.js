import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import path from 'node:path';
const safeKey=key=>{if(!/^[a-z0-9][a-z0-9._-]{2,160}$/i.test(key))throw Object.assign(new Error('Invalid media identifier.'),{status:400});return key;};
export function localMediaStore(directory){
 return {async put(key,data,metadata={}){key=safeKey(key);await mkdir(directory,{recursive:true});await writeFile(path.join(directory,key),data);await writeFile(path.join(directory,key+'.json'),JSON.stringify(metadata));return {key,url:'/media/'+key};},async get(key){key=safeKey(key);try{return {data:await readFile(path.join(directory,key)),metadata:JSON.parse(await readFile(path.join(directory,key+'.json'),'utf8'))};}catch{return null;}},async delete(key){key=safeKey(key);await Promise.allSettled([unlink(path.join(directory,key)),unlink(path.join(directory,key+'.json'))]);}};
}
export function memoryMediaStore(){const values=new Map();return {async put(key,data,metadata={}){key=safeKey(key);values.set(key,{data:Buffer.from(data),metadata});return {key,url:'/media/'+key};},async get(key){return values.get(safeKey(key))||null;},async delete(key){values.delete(safeKey(key));},values};}
export function decodeMedia(input){
 const mime=String(input?.mime||'');if(!['image/png','image/jpeg','image/webp'].includes(mime)||typeof input?.data!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(input.data))throw Object.assign(new Error('Use an optimized PNG, JPEG or WebP image.'),{status:400});
 const data=Buffer.from(input.data,'base64');if(!data.length||data.length>800_000)throw Object.assign(new Error('Optimize the image below 800 KB before saving.'),{status:413});return {mime,data};
}
