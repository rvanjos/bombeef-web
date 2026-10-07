'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const factory=require('../routes/dre');
function fixture(falhar=false){
 const db={faturas:[],itens:[],sql:[]};
 const pool={query:async(sql,p=[])=>({rows:sql.includes('COUNT(*) FROM fornecedores_lookup')?[{count:999}]:sql.includes('SELECT COUNT(*)')?[{n:1}]:[],rowCount:0}),connect:async()=>{
  let antes;return{release(){},async query(sql,p=[]){db.sql.push(sql);const max=Math.max(0,...[...sql.matchAll(/\$(\d+)/g)].map(m=>Number(m[1])));assert.equal(max,p.length,'SQL e parâmetros devem ser compatíveis');
   if(sql==='BEGIN')antes=structuredClone({faturas:db.faturas,itens:db.itens});
   if(sql==='ROLLBACK')Object.assign(db,antes);
   if(sql.includes('INSERT INTO cartao_faturas')){db.faturas.push(p);return{rows:[{id:1}]};}
   if(sql.includes('INSERT INTO cartao_fatura_itens')){if(falhar&&db.itens.length===1)throw new Error('Falha simulada de persistência');db.itens.push(p);}
   if(sql.includes('SELECT COUNT(*)'))return {rows:[{n:2}]};
   return {rows:[],rowCount:0};
  }};
 }};
 const router=factory(pool);const handler=router.stack.find(x=>x.route?.path==='/cartao-faturas'&&x.route.methods.post).route.stack.at(-1).handle;
 async function importar(body={}){const r={status:200};await handler({user:{id:7,lojaId:1},body:{cartao:'Caixa',competencia:'10/2026',valor_total:200,qtd_itens:2,fatura_id_ref:'CC_10_2026_Caixa',hash_fatura:'hash',itens:[{data:'2026-09-01',descricao:'Loja 1',valor:-100,parcela:'1/2',transacao:{id:'a',mes:'09/2026',parcela:'1/2'}},{data:'2026-09-02',descricao:'Loja 2',valor:-100}],...body}},{status(s){r.status=s;return this;},json(b){r.body=b;return this;}});return r;}
 return {db,importar};
}
test('nova fatura e itens são persistidos juntos com origem e loja',async()=>{const {db,importar}=fixture();const r=await importar();assert.equal(r.status,200);assert.equal(db.faturas.length,1);assert.equal(db.itens.length,2);assert.equal(db.itens[0][7],1);assert.equal(JSON.parse(db.itens[0][9]).parcela,'1/2');assert.ok(db.itens[0][6].endsWith('|1/2'));assert.ok(db.sql.includes('COMMIT'));});
test('falha em um item desfaz toda a nova importação',async()=>{const {db,importar}=fixture(true);const r=await importar();assert.equal(r.status,500);assert.equal(db.faturas.length,0);assert.equal(db.itens.length,0);assert.ok(db.sql.includes('ROLLBACK'));assert.ok(!db.sql.includes('COMMIT'));});
test('mês inválido ou importação vazia é rejeitada antes da transação',async()=>{const{db,importar}=fixture();assert.equal((await importar({competencia:'13/2026'})).status,400);assert.equal((await importar({itens:[]})).status,400);assert.equal(db.sql.length,0);});
