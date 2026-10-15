(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.DREExcel=api;})(typeof window!=='undefined'?window:null,function(root){
'use strict';
const moeda='"R$" #,##0.00;[Red]-"R$" #,##0.00;"—"';
const paleta={title:['8B0000','FFFFFF',15],subtitle:['8B0000','FFFFFF',10],header:['5C1A1A','FFFFFF',10],section:['EFE4D8','5C1A1A',11],group:['F8F1E9','5C1A1A',10],subtotal:['E7DDD0','222222',10],subtotal_small:['F4EEE7','555555',10],resultado_verde:['DCFCE7','166534',11],resultado_azul:['1E3A5F','FFFFFF',11],resultado_amarelo:['FEF3C7','78350F',11],resultado_final:['252525','FFFFFF',12]};
function criar(abas,ExcelJS){
  const wb=new ExcelJS.Workbook();wb.creator='Sistema Bom Beef';wb.created=new Date();
  for(const aba of abas){
    const cols=aba.meses.length+2;
    const ws=wb.addWorksheet(aba.nome,{views:[{state:'frozen',xSplit:1,ySplit:4,showGridLines:false}],pageSetup:{orientation:'landscape',paperSize:8,fitToPage:true,fitToWidth:1,fitToHeight:0,printTitlesRow:'1:4',margins:{left:.25,right:.25,top:.4,bottom:.4,header:.2,footer:.2}}});
    ws.getColumn(1).width=52;for(let c=2;c<=cols;c++)ws.getColumn(c).width=18;
    for(const ln of aba.linhas){
      const tp=ln.tipo||'cat',vals=tp==='header'?['GRUPO / CATEGORIA',...aba.meses,'TOTAL']:[ln.label,...Array.from({length:aba.meses.length},(_,i)=>ln.values[i]??null),ln.total??null];
      const row=ws.addRow(vals);row.height=tp==='blank'?7:tp==='title'?30:tp==='subtitle'?23:tp==='cat'?22:26;
      let estilo=paleta[tp]||['FFFFFF','374151',10];
      if(tp==='cat'&&row.number%2===0)estilo=['FAF8F5','374151',10];
      row.eachCell({includeEmpty:true},(cell,c)=>{
        cell.font={name:'Calibri',size:estilo[2],bold:tp!=='cat'&&tp!=='blank',color:{argb:'FF'+estilo[1]}};
        cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF'+estilo[0]}};
        cell.alignment={horizontal:c===1?'left':'right',vertical:'middle',wrapText:c===1,indent:c===1&&tp==='cat'?1:0};
        if(tp!=='blank')cell.border={bottom:{style:tp.startsWith('resultado')?'medium':'hair',color:{argb:'FFD6C4A8'}}};
        if(typeof cell.value==='number')cell.numFmt=moeda;
      });
      if(['title','subtitle','section','group'].includes(tp)){ws.mergeCells(row.number,1,row.number,cols);row.getCell(1).alignment={horizontal:tp==='title'||tp==='subtitle'?'center':'left',vertical:'middle'};}
    }
    ws.pageSetup.printArea=`A1:${ws.getColumn(cols).letter}${ws.rowCount}`;
    ws.headerFooter.oddFooter='Sistema Bom Beef &R Página &P de &N';
  }
  return wb;
}
let carregamento=null;
function biblioteca(){
  if(root.ExcelJS)return Promise.resolve(root.ExcelJS);
  if(carregamento)return carregamento;
  carregamento=new Promise((resolve,reject)=>{const s=root.document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';s.onload=()=>root.ExcelJS?resolve(root.ExcelJS):reject(Error('Gerador Excel indisponível'));s.onerror=()=>{carregamento=null;s.remove();reject(Error('Falha ao carregar o gerador Excel'));};root.document.head.appendChild(s);});return carregamento;
}
async function exportar(abas){const lib=await biblioteca(),wb=criar(abas,lib),buffer=await wb.xlsx.writeBuffer();const url=root.URL.createObjectURL(new root.Blob([buffer],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));const a=root.document.createElement('a');a.href=url;a.download=`DRE_BomBeef_${new Date().getFullYear()}.xlsx`;root.document.body.appendChild(a);a.click();a.remove();root.setTimeout(()=>root.URL.revokeObjectURL(url),10000);}
return {criar,exportar};
});
