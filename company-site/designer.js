const money = value => new Intl.NumberFormat('ru-RU').format(Math.round(Number(value) || 0));
const escapeHtml = value => String(value ?? '').replace(/[&<>"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]));

const drawingPaths = {
  single: '<path d="M110 55v230"/><path class="wall" d="M76 55h34M76 285h34"/>',
  panel: '<path d="M110 55v230"/><path class="wall" d="M76 55h34M76 285h34"/>',
  'screen-door': '<path d="M85 55v230M85 170h135"/><path class="door" d="M220 170a135 135 0 0 1-135 115"/>',
  niche: '<path class="wall" d="M45 58v245M315 58v245"/><path d="M45 170h270"/><path class="door" d="M315 170a270 270 0 0 1-270 133"/>',
  'niche-plus': '<path class="wall" d="M45 58v245M315 58v245"/><path d="M45 170h270M160 155v30"/><path class="door" d="M315 170a155 155 0 0 1-155 133"/>',
  corner: '<path d="M85 65v220h215"/><path class="door" d="M300 285a110 110 0 0 0-110-110"/>',
  'corner-plus': '<path d="M85 65v220h215M190 270v30"/><path class="door" d="M300 285a110 110 0 0 0-110-110"/>',
  'double-corner': '<path d="M85 65v220h215M190 270v30M70 175h30"/><path class="door" d="M300 285a110 110 0 0 0-110-110M85 175a110 110 0 0 1 110-110"/>',
  slider: '<path class="wall" d="M45 58v245M315 58v245"/><path d="M45 155h270M45 185h270"/><path class="slide" d="M105 138l-28 17 28 17M255 202l28-17-28-17"/>',
  'slider-corner': '<path d="M85 65v205h215M100 65v205h200"/><path class="slide" d="M245 287l35-17-35-17"/>',
  'slider-double': '<path d="M85 65v205h215M100 65v205h200"/><path class="slide" d="M130 48L95 65l35 17M245 287l35-17-35-17"/>',
  trapezoid: '<path d="M75 75v190l72 55h100l73-55V75"/><path class="door" d="M247 320a100 100 0 0 0-100-100"/>'
};

function download(filename, type, content){
  const url=URL.createObjectURL(new Blob([content],{type}));
  const link=document.createElement('a');link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

export function setupDesigner({onClose}={}){
  const dialog=document.querySelector('[data-designer-dialog]');
  const title=dialog.querySelector('[data-designer-title]');
  const modelLabel=dialog.querySelector('[data-designer-model]');
  const drawing=dialog.querySelector('[data-designer-drawing]');
  const form=dialog.querySelector('[data-designer-form]');
  const fields=dialog.querySelector('[data-designer-fields]');
  const estimate=dialog.querySelector('[data-designer-estimate]');
  const estimateText=dialog.querySelector('[data-estimate-value]');
  const status=dialog.querySelector('[data-designer-status]');
  const success=dialog.querySelector('[data-designer-success]');
  const quoteNumber=dialog.querySelector('[data-quote-number]');
  const contact=dialog.querySelector('[data-designer-contact]');
  let configPromise,model,construction,calculation,result;

  const config=()=>configPromise||(configPromise=fetch('/api/public-calculator/config/',{headers:{Accept:'application/json'}}).then(async response=>{
    if(!response.ok)throw new Error((await response.json().catch(()=>({}))).detail||'Не удалось загрузить параметры расчёта.');return response.json();
  }));
  function setStep(step){
    form.hidden=step!==1;estimate.hidden=step!==2;success.hidden=step!==3;
    dialog.dataset.step=String(step);
  }
  function renderDrawing(){
    const path=drawingPaths[model?.kind]||drawingPaths.panel;
    drawing.innerHTML=`<svg viewBox="0 0 360 360" role="img" aria-label="Проверочный вид сверху модели ${escapeHtml(model?.name)}"><g class="sketch-walls">${path}</g><text x="180" y="342" text-anchor="middle">ПРОВЕРОЧНЫЙ ЭСКИЗ · НЕ ДЛЯ ПРОИЗВОДСТВА</text></svg>`;
  }
  function fillOptions(select,items,preferred){
    select.innerHTML=items.map(item=>`<option value="${escapeHtml(item.id)}" ${item.id===preferred?'selected':''}>${escapeHtml(item.label)}</option>`).join('');
  }
  function renderFields(){
    fields.innerHTML=construction.fields.map(field=>`<label><span>${escapeHtml(field.label)}, мм</span><input type="number" name="dimension_${escapeHtml(field.key)}" min="100" max="4000" step="1" value="${Number(field.defaultValue)||''}" required /></label>`).join('');
  }
  async function open(nextModel){
    model=nextModel;construction=null;calculation=null;result=null;form.reset();status.textContent='';
    title.textContent=model.name;modelLabel.textContent=model.title;renderDrawing();setStep(1);
    dialog.showModal();
    try{
      const data=await config();construction=data.shower.constructions.find(item=>String(item.id)===String(model.id));
      if(!construction)throw new Error('Эта модель пока не связана с калькулятором.');
      renderFields();
      fillOptions(form.elements.glassId,data.shower.glass,'clear');
      const finishMap={bronze:'bronze',chrome:'chrome',black:'black'};
      fillOptions(form.elements.hardwareId,data.shower.hardware,finishMap[model.finish]||'chrome');
      fillOptions(form.elements.hardwareClassId,data.shower.hardwareClass,'standard');
      form.querySelector('[data-calculate]').disabled=false;
    }catch(error){status.textContent=error.message;form.querySelector('[data-calculate]').disabled=true;}
  }
  function configuration(){
    const dimensions={};
    construction.fields.forEach(field=>{dimensions[field.key]=Number(form.elements[`dimension_${field.key}`].value);});
    return {
      constructionId:String(construction.id),dimensions,
      glassId:form.elements.glassId.value,hardwareId:form.elements.hardwareId.value,hardwareClassId:form.elements.hardwareClassId.value,
      installation:form.elements.installation.checked,productionRequested:true,
      tray:{ledgeWidthMm:Number(form.elements.ledgeWidthMm.value),axis:form.elements.trayAxis.value},
      openingDirection:form.elements.openingDirection.value,
      obstacles:form.elements.obstacles.value.trim()
    };
  }
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(!form.reportValidity()||!construction)return;
    const button=form.querySelector('[data-calculate]');button.disabled=true;status.textContent='Считаем по актуальным ценам…';
    try{
      calculation=configuration();
      const response=await fetch('/api/public-calculator/calculate/',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({product:'shower',configuration:calculation,delivery:{enabled:false,zone:'inside',km:0}})});
      const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.detail||'Не удалось выполнить расчёт.');
      result=data;estimateText.textContent=`${money(data.amount)} ₽`;contact.reset();contact.elements.phone.value='+7';status.textContent='';setStep(2);
    }catch(error){status.textContent=error.message;}finally{button.disabled=false;}
  });
  contact.elements.phone.addEventListener('input',()=>{
    let digits=contact.elements.phone.value.replace(/\D/g,'');if(digits.startsWith('8'))digits='7'+digits.slice(1);if(!digits.startsWith('7'))digits='7'+digits;digits=digits.slice(0,11);
    let value='+7';if(digits.length>1)value+=` (${digits.slice(1,4)}`;if(digits.length>=4)value+=')';if(digits.length>4)value+=` ${digits.slice(4,7)}`;if(digits.length>7)value+=`-${digits.slice(7,9)}`;if(digits.length>9)value+=`-${digits.slice(9,11)}`;contact.elements.phone.value=value;
  });
  contact.addEventListener('submit',async event=>{
    event.preventDefault();if(!contact.reportValidity()||!result)return;
    const button=contact.querySelector('[type=submit]');button.disabled=true;status.textContent='Создаём смету и проект в CRM…';
    const params=new URLSearchParams(location.search);const utm={};for(const [key,value] of params)if(key.startsWith('utm_'))utm[key]=value;
    try{
      const response=await fetch('/api/public-calculator/lead/',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({calculation_id:result.calculation_id,name:contact.elements.name.value.trim(),phone:contact.elements.phone.value,email:contact.elements.email.value.trim(),company:contact.elements.company.value,source:{url:location.href,referrer:document.referrer,utm}})});
      const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.detail||'Не удалось сохранить проект.');
      quoteNumber.textContent=data.quote_number?`КП №${data.quote_number}`:'Проект принят';
      success.dataset.quote=data.quote_number||'';status.textContent='';setStep(3);
    }catch(error){status.textContent=error.message;}finally{button.disabled=false;}
  });
  dialog.querySelector('[data-estimate-back]').addEventListener('click',()=>setStep(1));
  dialog.querySelector('[data-designer-close]').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close();});
  dialog.addEventListener('close',()=>onClose?.());
  dialog.querySelector('[data-download-sketch]').addEventListener('click',()=>{
    const svg=drawing.querySelector('svg').outerHTML.replace('<svg','<svg xmlns="http://www.w3.org/2000/svg"');download(`AMALGAMA_${model.id}_проверочный_эскиз.svg`,'image/svg+xml;charset=utf-8',svg);
  });
  dialog.querySelector('[data-download-estimate]').addEventListener('click',()=>{
    const rows=construction.fields.map(field=>`<tr><td>${escapeHtml(field.label)}</td><td>${escapeHtml(calculation.dimensions[field.key])} мм</td></tr>`).join('');
    const html=`<!doctype html><meta charset="utf-8"><title>Смета AMALGAMA</title><style>body{font:16px Arial;max-width:760px;margin:60px auto;color:#142033}h1{font-size:38px}table{width:100%;border-collapse:collapse}td{padding:12px;border-bottom:1px solid #ddd}strong{font-size:28px}.note{margin-top:40px;color:#667}</style><p>AMALGAMA</p><h1>${escapeHtml(quoteNumber.textContent)} · ${escapeHtml(model.title)}</h1><table>${rows}</table><p>Предварительная стоимость: <strong>${money(result.amount)} ₽</strong></p><p class="note">Стоимость сформирована по параметрам клиента. Финальные производственные размеры и комплект чертежей выпускаются после проверки фактического замера технологом.</p>`;
    download(`AMALGAMA_${success.dataset.quote||model.id}_предварительная_смета.html`,'text/html;charset=utf-8',html);
  });
  return {open};
}
