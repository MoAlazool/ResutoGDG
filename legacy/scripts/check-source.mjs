import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
async function check(dir){for(const x of await readdir(dir,{withFileTypes:true})){if(['node_modules','.git','data','artifacts','resuto-sites'].includes(x.name))continue;const p=dir+'/'+x.name;if(x.isDirectory())await check(p);else if(/\.(mjs|js)$/.test(p)){const r=spawnSync(process.execPath,['--check',p],{stdio:'inherit'});if(r.status)process.exit(r.status);}}}
await check('.');console.log('All JavaScript sources passed syntax checks.');
