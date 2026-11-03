'use strict';
const iso=v=>v instanceof Date?v.toISOString().slice(0,10):String(v||'').slice(0,10);
function validarEscala(body,hoje){
  const inicio=String(body.vigencia_inicio||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(inicio)||!Number.isFinite(Date.parse(inicio))||new Date(inicio).toISOString().slice(0,10)!==inicio||inicio<hoje)throw Error('Informe uma vigência válida, a partir de hoje. Períodos anteriores são preservados.');
  if(!Array.isArray(body.dias)||body.dias.length!==7||new Set(body.dias.map(d=>d.dia_semana)).size!==7)throw Error('Configure os sete dias da semana.');
  const min=v=>{if(!/^\d{2}:\d{2}$/.test(v))throw Error('Horário inválido');const [h,m]=v.split(':').map(Number);if(h>23||m>59)throw Error('Horário inválido');return h*60+m;};
  const dias=body.dias.map(d=>{
    if(!Number.isInteger(d.dia_semana)||d.dia_semana<0||d.dia_semana>6||typeof d.folga!=='boolean')throw Error('Dia inválido');
    if(d.folga)return {dia_semana:d.dia_semana,folga:true,horario_entrada:null,horario_saida:null,jornada_horas:0,intervalo_min:0};
    const a=min(d.horario_entrada),b=min(d.horario_saida),i=Number(d.intervalo_min);
    if(!Number.isInteger(i)||i<0||b<=a||i>=b-a)throw Error('Confira saída e intervalo da jornada.');
    return {dia_semana:d.dia_semana,folga:false,horario_entrada:d.horario_entrada,horario_saida:d.horario_saida,intervalo_min:i,jornada_horas:(b-a-i)/60};
  });
  const ciclo=Number(body.domingo_ciclo||0),base=String(body.domingo_base||'');
  if(![0,2,3].includes(ciclo))throw Error('Rodízio inválido');
  if(ciclo){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(base)||!Number.isFinite(Date.parse(base))||new Date(base+'T12:00:00Z').getUTCDay()!==0||new Date(base).toISOString().slice(0,10)!==base)throw Error('Selecione um domingo de referência: primeiro domingo trabalhado do ciclo.');
    if(dias.find(d=>d.dia_semana===0).folga)throw Error('Informe os horários do domingo trabalhado e desmarque Folga no domingo ao usar rodízio.');
  }
  return {vigencia_inicio:inicio,dias,domingo_ciclo:ciclo,domingo_base:ciclo?base:null};
}
function resolverEscala(versoes,funcionarioId,lojaId,data){
  const dia=iso(data),v=versoes.filter(v=>Number(v.funcionario_id)===Number(funcionarioId)&&Number(v.loja_id)===Number(lojaId)&&iso(v.vigencia_inicio)<=dia).sort((a,b)=>iso(b.vigencia_inicio).localeCompare(iso(a.vigencia_inicio))||Number(b.id)-Number(a.id))[0];
  if(!v)return null;
  const dow=new Date(dia+'T12:00:00Z').getUTCDay(),d=(v.dias||[]).find(d=>Number(d.dia_semana)===dow);
  if(!d)return null;
  const ciclo=Number(v.domingo_ciclo||0);
  const semanas=ciclo?Math.floor((Date.parse(dia)-Date.parse(iso(v.domingo_base)))/604800000):0;
  const folga=dow===0&&ciclo?((semanas%ciclo)+ciclo)%ciclo===ciclo-1:!!d.folga;
  return {...d,folga,jornada_horas:folga?0:Number(d.jornada_horas),escala_id:v.id,vigencia_inicio:iso(v.vigencia_inicio)};
}
async function initEscalas(pool){
  await pool.query(`CREATE TABLE IF NOT EXISTS ponto_escalas_versoes (
    id SERIAL PRIMARY KEY, funcionario_id INTEGER NOT NULL REFERENCES funcionarios(id),
    loja_id INTEGER NOT NULL REFERENCES lojas(id),vigencia_inicio DATE NOT NULL,dias JSONB NOT NULL,
    domingo_ciclo INTEGER NOT NULL DEFAULT 0 CHECK(domingo_ciclo IN(0,2,3)),domingo_base DATE,
    usuario_id INTEGER REFERENCES usuarios(id),criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ponto_escalas_vigencia ON ponto_escalas_versoes(loja_id,funcionario_id,vigencia_inicio DESC,id DESC)`);
  await pool.query('ALTER TABLE ponto_escalas_versoes ENABLE ROW LEVEL SECURITY');
  await pool.query('ALTER TABLE ponto_escalas_versoes FORCE ROW LEVEL SECURITY');
  await pool.query(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='ponto_escalas_versoes' AND policyname='ponto_escalas_loja') THEN
    CREATE POLICY ponto_escalas_loja ON ponto_escalas_versoes
    USING(current_setting('app.bb_system',true)='1' OR loja_id=NULLIF(current_setting('app.loja_id',true),'')::int)
    WITH CHECK(current_setting('app.bb_system',true)='1' OR loja_id=NULLIF(current_setting('app.loja_id',true),'')::int);
    END IF; END $$`);
}
async function carregarEscalas(pool,lojaId){return (await pool.query('SELECT * FROM ponto_escalas_versoes WHERE loja_id=$1 ORDER BY vigencia_inicio DESC,id DESC',[lojaId])).rows;}
async function salvarEscala(pool,funcionarioId,lojaId,usuarioId,config){
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const {rows:[f]}=await c.query('SELECT * FROM funcionarios WHERE id=$1 AND loja_id=$2 AND ativo=true FOR UPDATE',[funcionarioId,lojaId]);
    if(!f)throw Error('Funcionário não encontrado nesta loja');
    const {rows:vs}=await c.query('SELECT id FROM ponto_escalas_versoes WHERE funcionario_id=$1 AND loja_id=$2 LIMIT 1',[funcionarioId,lojaId]);
    if(!vs.length){
      const {rows:ds}=await c.query('SELECT * FROM ponto_jornada_dia WHERE funcionario_id=$1 AND loja_id=$2',[funcionarioId,lojaId]);
      const minutos=t=>{const [h,m]=String(t).split(':').map(Number);return h*60+m;};
      const horas=f.horario_entrada&&f.horario_saida?Math.max(0,(minutos(f.horario_saida)-minutos(f.horario_entrada)-Number(f.intervalo_min??60))/60):Number(f.jornada_horas??8);
      const dias=Array.from({length:7},(_,dia)=>{const d=ds.find(d=>Number(d.dia_semana)===dia);return d?{...d,jornada_horas:d.folga?0:Number(d.jornada_horas??f.jornada_horas??8),intervalo_min:d.intervalo_min??f.intervalo_min??60,horario_entrada:d.horario_entrada??f.horario_entrada,horario_saida:d.horario_saida??f.horario_saida}:{dia_semana:dia,folga:false,horario_entrada:f.horario_entrada,horario_saida:f.horario_saida,jornada_horas:horas,intervalo_min:f.intervalo_min??60};});
      await c.query(`INSERT INTO ponto_escalas_versoes(funcionario_id,loja_id,vigencia_inicio,dias,usuario_id) VALUES($1,$2,'1900-01-01',$3,$4)`,[funcionarioId,lojaId,JSON.stringify(dias),usuarioId]);
    }
    const {rows:[v]}=await c.query(`INSERT INTO ponto_escalas_versoes(funcionario_id,loja_id,vigencia_inicio,dias,domingo_ciclo,domingo_base,usuario_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[funcionarioId,lojaId,config.vigencia_inicio,JSON.stringify(config.dias),config.domingo_ciclo,config.domingo_base,usuarioId]);
    await c.query('COMMIT');return v;
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
module.exports={validarEscala,resolverEscala,initEscalas,carregarEscalas,salvarEscala,iso};
