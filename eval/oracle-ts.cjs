// Unused-import oracle: the TypeScript compiler's own diagnostics (noUnusedLocals).
//   node eval/oracle-ts.cjs <repository> <output.json>      (TS_DIR = a directory whose node_modules holds typescript 5.x, see docs/evaluation.md)
// The project itself depends on TypeScript 7, which has no JavaScript API, so the 5.x copy is resolved explicitly.
const ts=require(require.resolve('typescript',{paths:[process.env.TS_DIR||process.cwd()]}));const fs=require('fs');const path=require('path');
const root=process.argv[2];
const files=require('child_process').execSync('git ls-files',{cwd:root,encoding:'utf8',maxBuffer:1e8}).split('\n').filter(f=>/\.(tsx?|mts|cts|jsx?|mjs|cjs)$/.test(f)&&!/\.d\.ts$/.test(f)).map(f=>path.join(root,f));
const program=ts.createProgram(files,{noUnusedLocals:true,noEmit:true,noResolve:true,skipLibCheck:true,jsx:ts.JsxEmit.Preserve,target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.ESNext,allowJs:true,checkJs:false,types:[]});
const out=[];
for(const sf of program.getSourceFiles()){ if(!files.includes(sf.fileName)) continue;
 for(const d of program.getSemanticDiagnostics(sf)){ if([6133,6192,6196,6198].includes(d.code)){ const m=ts.flattenDiagnosticMessageText(d.messageText,'\n'); const node=sf.text.slice(d.start,d.start+d.length); const line=sf.getLineAndCharacterOfPosition(d.start).line+1; out.push({file:path.relative(root,sf.fileName),line,code:d.code,text:node.slice(0,80),m:m.slice(0,80)}); } } }
fs.writeFileSync(process.argv[3],JSON.stringify(out));console.log(path.basename(root),files.length,'files, oracle diagnostics',out.length);
