'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const factory=require('../routes/retiradas');
function fixture(){
 const rows=[{id:1,loja_id:1,baixa_pdv:false,valor_total:10,status:'pendente'},{id:2,loja_id:1,baixa_pdv:true,dt_baixa_pdv:'2026-10-01'},{id:3,loja_id:2,baixa_pdv:false}];
 const db={rows,sql:[]};const pool={query:async()=>({rows:[],rowCount:0}),connect:async()=>({release(){},async query(sql,p=[]){db.sql.push(sql);if(sql.includes('SELECT id FROM retiradas'))return {rows:rows.filter(r=>r.loja_id===p[0]&&p[1].includes(r.id))};if(sql.includes('UPDATE retiradas')){const updated=rows.filter(r=>r.loja_id===p[0]&&p[1].includes(r.id)&&!r.baixa_pdv);for(const r of updated){r.baixa_pdv=true;r.baixa_pdv_por=p[2];r.dt_baixa_pdv='hoje';}return {rows:updated,rowCount:updated.length};}return {rows:[]};}})};
 const router=factory(pool);const h=router.stack.find(x=>x.route?.path==='/baixa-pdv-lote').route.stack.at(-1).handle;
 async function marcar(ids){const r={status:200};await h({body:{ids},user:{id:7,lojaId:1}},{status(s){r.status=s;return this;},json(b){r.body=b;return this;}});return r;}
 return{db,marcar};
}
test('lote marca pendentes e preserva baixa antiga e os valores de dívida',async()=>{const{db,marcar}=fixture();const r=await marcar([1,2,1]);assert.equal(r.status,200);assert.equal(r.body.marcados,1);assert.equal(r.body.ja_marcados,1);assert.equal(db.rows[0].baixa_pdv_por,7);assert.equal(db.rows[0].valor_total,10);assert.equal(db.rows[0].status,'pendente');assert.equal(db.rows[1].dt_baixa_pdv,'2026-10-01');assert.ok(db.sql.includes('COMMIT'));});
test('ID de outra loja rejeita lote todo antes de alterar dados',async()=>{const {db,marcar}=fixture();assert.equal((await marcar([1,3])).status,409);assert.equal(db.rows[0].baixa_pdv,false);assert.ok(db.sql.includes('ROLLBACK'));assert.ok(!db.sql.some(s=>s.includes('UPDATE retiradas')));});
test('lista inválida, vazia ou acima do limite é rejeitada',async()=>{const{marcar}=fixture();for(const ids of [[],null,['x'],[0],[-1],Array.from({length:501},(_,i)=>i+1)])assert.equal((await marcar(ids)).status,400);});
