// Local-only benchmark: real SQLite, deterministic search results, no provider calls.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { transformSync } = require('esbuild');
require.extensions['.ts'] = (mod, filename) => mod._compile(transformSync(fs.readFileSync(filename, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node24' }).code, filename);
const root = path.resolve(__dirname, '..');
process.chdir(root);
const { openAppDatabase } = require('../src/main/db/database.ts');
const { ConversationRepository } = require('../src/main/chat/conversation-repository.ts');
const { RetrievalService } = require('../src/main/retrieval/retrieval-service.ts');
const { assembleContext, estimateTokens } = require('../src/main/chat/context-builder.ts');
const { finalizeCitations } = require('../src/main/chat/citation-parser.ts');
const { persistParsedCitations } = require('../src/main/chat/citation-persist.ts');
function baseline(relative) {
  const filename = path.join(root, relative);
  const mod = new Module(filename, module);
  mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const source = execFileSync('git', ['show', 'HEAD:' + relative], { encoding: 'utf8' });
  mod._compile(transformSync(source, { loader: 'ts', format: 'cjs', target: 'node24' }).code, filename);
  return mod.exports;
}
const old = baseline('src/main/chat/context-builder.ts');
const OldRetrieval = baseline('src/main/retrieval/retrieval-service.ts').RetrievalService;
const oldCitations = baseline('src/main/chat/citation-persist.ts');
function stats(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  return { medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(3), p95Ms: +sorted[Math.ceil(sorted.length * .95) - 1].toFixed(3) };
}
async function measured(fn) {
  await fn();
  const times = [];
  let value;
  for (let i = 0; i < 20; i++) { const start = performance.now(); value = await fn(); times.push(performance.now() - start); }
  return { ...stats(times), value };
}
async function fixture(name, count, historyCount, text) {
  const app = openAppDatabase(':memory:', path.join(root, 'src/main/db/migrations'));
  const db = app.connection;
  const at = '2026-09-20T00:00:00.000Z';
  db.prepare('INSERT INTO projects(id,name) VALUES (?,?)').run('p', 'Benchmark');
  db.prepare('INSERT INTO sources(id,project_id,kind,display_name) VALUES (?,?,?,?)').run('s','p','pdf','Fixture');
  db.prepare('INSERT INTO source_revisions(id,source_id,original_path,stored_path,source_hash,locator_kind,chunking_version,state) VALUES (?,?,?,?,?,?,?,?)').run('r','s','a','a','hash','page','v1','ready');
  db.prepare('UPDATE sources SET current_revision_id=? WHERE id=?').run('r','s');
  db.prepare('INSERT INTO embedding_spaces(id,project_id,provider,model_id,model_revision,dimension,distance,pooling,preprocess_version,chunking_version,fingerprint,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('space','p','local','mock','v1',2,'cosine','mean','v1','v1','fingerprint','active',at,at);
  db.prepare('INSERT INTO project_embedding_spaces VALUES (?,?,?)').run('p','space',at);
  const insert = db.prepare('INSERT INTO source_chunks(id,revision_id,ordinal,text,locator_json,content_hash) VALUES (?,?,?,?,?,?)');
  const candidates = Array.from({ length: count }, (_, i) => ({ chunkId: 'c'+i, sourceId: 's', contentHash: 'h'+i, ordinal: i }));
  db.transaction(() => candidates.forEach((item, i) => insert.run(item.chunkId,'r',i,text(i),JSON.stringify({kind:'page',page:i+1}),item.contentHash)))();
  const repo = new ConversationRepository(db);
  repo.createConversation({id:'conv',projectId:'p',title:'Benchmark',createdAt:at});
  for(let i=0;i<historyCount;i++){
    repo.appendUserMessage({projectId:'p',conversationId:'conv',id:'u'+i,content:'Earlier question '+i,createdAt:at});
    repo.startAssistantMessage({projectId:'p',conversationId:'conv',id:'a'+i,replyToMessageId:'u'+i,provider:'mock',profileId:'profile',model:'mock',createdAt:at});
    repo.completeAssistantMessage({projectId:'p',conversationId:'conv',id:'a'+i,content:'Earlier answer '+i,usage:{inputTokens:1,outputTokens:1,totalTokens:2},updatedAt:at});
  }
  repo.appendUserMessage({projectId:'p',conversationId:'conv',id:'current',content:'Find facts',createdAt:at});
  repo.startAssistantMessage({projectId:'p',conversationId:'conv',id:'answer',replyToMessageId:'current',provider:'mock',profileId:'profile',model:'mock',createdAt:at});
  let embeddings = 0;
  const retrieval = new RetrievalService({ db, provider:{embedBatch:async()=>{embeddings++;return [[1,0]];}}, lance:{vectorSearch:async(_s,_q,n)=>candidates.slice(0,n),textSearch:async(_s,_q,n)=>candidates.slice(0,n)} });
  const sameCandidates = candidates.slice(0, Math.min(count,32));
  const sameSearchDeps = {db,provider:{embedBatch:async()=>[[1,0]]},lance:{vectorSearch:async()=>sameCandidates,textSearch:async()=>sameCandidates}};
  const oldSearchService = new OldRetrieval(sameSearchDeps);
  const newSearchService = new RetrievalService(sameSearchDeps);
  const oldSearch = await measured(()=>oldSearchService.search({projectId:'p',query:'facts',limit:sameCandidates.length}));
  const newSearch = await measured(()=>newSearchService.search({projectId:'p',query:'facts',limit:sameCandidates.length}));
  const history = await measured(()=>repo.listHistoryPairs({projectId:'p',conversationId:'conv',beforeSequence:historyCount*2,limit:32}));
  const oldHistory = await measured(()=>repo.listMessages('p','conv'));
  const search = await measured(()=>retrieval.searchForChat({projectId:'p',query:'facts',evidenceTokenBudget:100000,signal:new AbortController().signal}));
  assert.equal(search.value.ok,true);
  const chunks = search.value.value.map(row=>({...row,locatorSummary:row.locatorJson}));
  const input = {question:'Find facts',retrieved:chunks,historyPairs:history.value,contextTokens:131072,outputTokens:8192};
  const assembly = await measured(()=>assembleContext(input));
  const context = assembly.value;
  assert.equal(context.fixedOverflow,false);
  assert(context.citations.length>=Math.min(count,40));
  assert(context.messages.reduce((sum,m)=>sum+estimateTokens(m.content)+8,64)<=context.tokenBudget.inputTokenTarget);
  const map = Object.fromEntries(context.citations.map(c=>[c.label,{...c,text:c.sentText}]));
  const answer = context.citations.map(c=>'Fact ['+c.label+']').join(' ');
  const parsed = finalizeCitations(answer,map);
  const persist = await measured(()=>persistParsedCitations(db,{projectId:'p',messageId:'answer',parsed,retrievals:map}));
  assert.equal(persist.value.length,context.citations.length);
  const sameParsed = {...parsed,citations:parsed.citations.slice(0,32)};
  const samePersist = fn => {db.prepare('DELETE FROM message_citations WHERE message_id=?').run('answer');return fn(db,{projectId:'p',messageId:'answer',parsed:sameParsed,retrievals:map});};
  const oldSave = await measured(()=>samePersist(oldCitations.persistParsedCitations));
  const newSave = await measured(()=>samePersist(persistParsedCitations));
  // Compare assembly with exactly the same candidate bodies, history and output allowance.
  const shared = {question:'Find facts',retrieved:chunks.slice(0,32),contextTokens:32768,outputTokens:6554,priorTurns:[]};
  const oldAssembly = await measured(()=>old.assembleContext(shared));
  const newAssembly = await measured(()=>assembleContext(shared));
  const withoutValue = ({value,...timing})=>timing;
  const report={name,sourceChunks:count,historyPairs:historyCount,finalEvidence:context.citations.length,inputEstimate:context.messages.reduce((sum,m)=>sum+estimateTokens(m.content)+8,64),stopReason:search.value.diagnostics.stopReason,candidates:search.value.diagnostics.vectorCandidateLimit,history:withoutValue(history),oldFullHistory:withoutValue(oldHistory),retrieval:withoutValue(search),assembly:withoutValue(assembly),citationSave:withoutValue(persist),sameInputAssembly:{old:withoutValue(oldAssembly),current:withoutValue(newAssembly)},sameInputRetrieval:{old:withoutValue(oldSearch),current:withoutValue(newSearch)},sameCitationSave:{old:withoutValue(oldSave),current:withoutValue(newSave)},embeddingCalls:embeddings};
  if(name==='capacity-route'){const signal=new AbortController().signal;const before=embeddings;await retrieval.searchForChat({projectId:'p',query:'facts',evidenceTokenBudget:500,signal});await retrieval.searchForChat({projectId:'p',query:'facts',evidenceTokenBudget:50000,signal});assert.equal(embeddings-before,1);report.expansionEmbeddings=embeddings-before;}
  app.close();
  return report;
}
(async()=>{
  const cases=[['small',8,2,i=>'Fact '+i],['short-48',48,2,i=>'Fact '+i],['citations-128',128,2,i=>'Fact '+i],['history-500',48,500,i=>'Fact '+i],['tables-neighbors',160,2,i=>'Table '+Math.floor(i/8)+' | column | value '+i],['capacity-route',384,2,i=>'Fact '+i]];
  const reports=[];for(const args of cases)reports.push(await fixture(...args));
  const corpus=['中文资料与引用。'.repeat(50),'UnbrokenEnglishSequence'.repeat(50),'const item={value:42};'.repeat(50),'https://example.test/'+ 'abcdefgh12345/'.repeat(80),'a|b|c|1|2|3'.repeat(80),'a9Z!x7Q@w5E#r3T$'.repeat(80)];
  console.log(JSON.stringify({baseline:execFileSync('git',['rev-parse','--short','HEAD'],{encoding:'utf8'}).trim(),warmups:1,runs:20,network:false,search:'deterministic mock; real SQLite and production retrieval/assembly/citation functions',reports,tokenEstimates:corpus.map((text,i)=>({case:i,bytes:Buffer.byteLength(text),old:old.estimateTokens(text),current:estimateTokens(text),calibrated:false}))},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
