import {build} from 'esbuild';
await build({entryPoints:['client/firebase-client.js'],bundle:true,format:'esm',platform:'browser',target:['es2020'],outfile:'public/firebase-client.js',minify:true,sourcemap:false});
