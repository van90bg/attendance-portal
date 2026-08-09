# Deterministic multi-file patch runner (known-good shape)

Session: 2026-08-08 simplify pass F1–F6. Context: batch-edit 5 CRLF GAS files
(Database.gs ×3 modules, Config.gs, ScanService.gs, tests, index.html) with
zero fuzzy patching. The first runner design had a plan-per-module overwrite bug;
this is the shape that works.

## Runner requirements (any project, not just RollCall)

1. **Collapse reps by FILE before touching disk.**
   ```
   const byFile = new Map(); // file → [reps...]
   for (module of argv) for (rep of module.reps) byFile.get(rep.file).push(rep)
   ```
   Apply all reps for a file to ONE in-memory copy read once from disk. NEVER
   read-per-module then write-per-module — the last writer wins and earlier
   modules evaporate (the F1/F2 drift bug).

2. **Atomic: verify ALL files in memory, write ALL only when 0 misses.**
   Phase 1: read → strip BOM (index.html has one) → CRLF→LF → apply exact
   `String.includes`/split-join replacements, counting misses. Any miss →
   `console.error` the needle + abort with exit 1 BEFORE any write. Phase 2:
   restore CRLF (LF→`\r\n`) + BOM, `fs.writeFileSync` last. Never persist a
   partial patch.

3. **Parse-verify before write.**
   - `.gs`/`.js`: `new vm.Script(t, {filename: file})`.
   - `index.html`: extract inline scripts by regex
     `/<\/?script\b([^>]*)>([\s\S]*?)<\/script>/gi` skipping `src=`, one
     `vm.Script` per inline script; require at least one found.

4. **A miss must abort, not degrade.** No "apply what matched, skip what didn't".
   One wrong `old:` (signature drift, `new:` vs `next:` key, stringly typo)
   silently matching nothing is the cost of `includes`; the guard is: `if (n===0)
   throw; if (n<reps.length) throw;`. In the run, a rep using key `new:` instead
   of `next:` was caught by the runner's `typeof r.next !== 'string'` guard —
   read the module file back before running when a MISS looks bizarre.

## Symptoms that already bit us (check for these)

- `grep -c "symbol" Database.gs` = N call sites but `grep -n "function symbol"` = 0
  → a linked module was dropped by the write-last-wins bug. Recover with an undo
  module (old = broken text, next = original) then re-run the collapsed batch.
- `npm run test` green ≠ patch complete: tests don't load Database.gs, so a
  missing server helper (ReferenceError) is invisible. Always the
  call-site ↔ definition grep reconciliation.

## Minimal runner skeleton (node, no deps)

```js
const fs=require('node:fs'), path=require('node:path'), vm=require('node:vm');
const ROOT=path.join(__dirname,'..','..');
function load(name){const m=require(path.join(__dirname,name));
  return Array.isArray(m)?m:[m];} // modules may export one or many {file,reps}
const byFile=new Map();
for(const name of process.argv.slice(2)){
  for(const mod of load(name)){
    if(!mod.file||!Array.isArray(mod.reps)) throw new Error('bad module '+name);
    if(!byFile.has(mod.file)) byFile.set(mod.file,[]);
    byFile.get(mod.file).push(...mod.reps.map(r=>({label:`[${name}] ${r.label}`,old:r.old,next:r.next})));
  }
}
const plans=[];
for(const [file,reps] of byFile){
  const p=path.join(ROOT,file);
  const raw=fs.readFileSync(p,'utf8');
  const hadBom=raw.charCodeAt(0)===0xFEFF;
  let t=raw.replace(/^\uFEFF/,'').replace(/\r\n/g,'\n');
  let n=0;
  for(const r of reps){
    if(typeof r.old!=='string'||typeof r.next!=='string') throw new Error('bad rep '+r.label);
    if(t.includes(r.old)){t=t.split(r.old).join(r.next);n++;}
    else {console.error('MISS '+r.label+' needle '+JSON.stringify(r.old.slice(0,90)));process.exitCode=1;}
  }
  if(!n){console.error('no rep matched for '+file);process.exitCode=1;continue;}
  if(process.exitCode) continue; // verify first, write never on miss
  if(/\.(gs|js)$/i.test(file)) new vm.Script(t,{filename:file});
  else {
    const re=/<script\b([^>]*)>([\s\S]*?)<\/script>/gi; let m,idx=0;
    while((m=re.exec(t))){ if(/\bsrc\s*=/.test(m[1]))continue; idx++; new vm.Script(m[2],{filename:file+'#'+idx}); }
    if(!idx) throw new Error('no inline scripts in '+file);
  }
  plans.push({p,out:(hadBom?'\uFEFF':'')+t.split('\n').join('\r\n')});
}
if(process.exitCode){console.error('NOTHING WRITTEN');process.exit(1);}
for(const s of plans){fs.writeFileSync(s.p,s.out,'utf8');console.log('WROTE '+s.p);}
```

## Module shape

```js
// each module file exports either:
module.exports={ file:'Database.gs', reps:[{label,old,next}, ...] };
// or (batch of independent files) an ARRAY of such objects.
// rep keys must be `next` (not `new`), label is what MISS prints.
```