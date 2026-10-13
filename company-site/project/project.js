(() => {
  const form = document.querySelector('[data-project-form]');
  const input = form.elements.files;
  const dropzone = document.querySelector('[data-dropzone]');
  const fileList = document.querySelector('[data-file-list]');
  const status = document.querySelector('[data-form-status]');
  const success = document.querySelector('[data-success]');
  const allowed = new Set(['image/jpeg','image/png','image/webp','application/pdf']);
  let files = [];

  function renderFiles(){
    fileList.innerHTML = files.map((file,index) => `<div><span>${file.type==='application/pdf'?'PDF':'IMG'}</span><p><b>${escapeHtml(file.name)}</b><small>${(file.size/1024/1024).toFixed(1)} МБ</small></p><button type="button" data-remove="${index}" aria-label="Удалить ${escapeHtml(file.name)}">×</button></div>`).join('');
  }
  function escapeHtml(value){ return String(value).replace(/[&<>"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char])); }
  function addFiles(list){
    const next = [...list];
    for(const file of next){
      if(files.length >= 6){ status.textContent='Можно прикрепить не больше 6 файлов.'; break; }
      if(!allowed.has(file.type)){ status.textContent='Поддерживаются JPG, PNG, WebP и PDF.'; continue; }
      if(file.size > 8*1024*1024){ status.textContent=`Файл «${file.name}» больше 8 МБ.`; continue; }
      if(!files.some(item=>item.name===file.name&&item.size===file.size)) files.push(file);
    }
    renderFiles();
  }
  input.addEventListener('change',()=>{ addFiles(input.files); input.value=''; });
  ['dragenter','dragover'].forEach(type=>dropzone.addEventListener(type,event=>{event.preventDefault();dropzone.classList.add('is-dragging');}));
  ['dragleave','drop'].forEach(type=>dropzone.addEventListener(type,event=>{event.preventDefault();dropzone.classList.remove('is-dragging');}));
  dropzone.addEventListener('drop',event=>addFiles(event.dataTransfer.files));
  fileList.addEventListener('click',event=>{const button=event.target.closest('[data-remove]');if(!button)return;files.splice(Number(button.dataset.remove),1);renderFiles();});

  const phone=form.elements.phone;
  phone.addEventListener('input',()=>{
    let digits=phone.value.replace(/\D/g,'');if(digits.startsWith('8'))digits='7'+digits.slice(1);if(!digits.startsWith('7'))digits='7'+digits;digits=digits.slice(0,11);
    let value='+7';if(digits.length>1)value+=` (${digits.slice(1,4)}`;if(digits.length>=4)value+=')';if(digits.length>4)value+=` ${digits.slice(4,7)}`;if(digits.length>7)value+=`-${digits.slice(7,9)}`;if(digits.length>9)value+=`-${digits.slice(9,11)}`;phone.value=value;
  });

  form.addEventListener('submit',async event=>{
    event.preventDefault();status.textContent='';
    if(!form.reportValidity())return;
    if(!files.length && !form.elements.width.value && !form.elements.depth.value){status.textContent='Прикрепите эскиз или укажите хотя бы один размер.';return;}
    const button=form.querySelector('.submit');button.disabled=true;button.firstChild.textContent='Создаём проект ';
    const data=new FormData(form);
    data.delete('files');files.forEach(file=>data.append('files',file,file.name));
    data.set('walls_finished',form.elements.walls_finished.checked?'true':'false');
    data.set('floor_checked',form.elements.floor_checked.checked?'true':'false');
    let cart={};try{cart=JSON.parse(localStorage.getItem('amalgama-components-cart'))||{};}catch(_){cart={};}
    data.set('cart',JSON.stringify(Object.entries(cart).map(([id,quantity])=>({id,quantity}))));
    try{
      const response=await fetch('/api/public-production/intake/',{method:'POST',body:data,headers:{Accept:'application/json'}});
      const result=await response.json().catch(()=>({}));if(!response.ok)throw new Error(result.detail||'Не удалось создать проект.');
      document.querySelector('[data-project-number]').textContent=`№${result.project_number}`;
      form.hidden=true;success.hidden=false;success.scrollIntoView({behavior:'smooth',block:'center'});
    }catch(error){status.textContent=error.message;}finally{button.disabled=false;button.firstChild.textContent='Создать проект ';}
  });
})();
