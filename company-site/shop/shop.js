(() => {
  const products = [
    {id:"av24-3382",category:"Петли",name:"Петля Бета FDP-20 · матовая",type:"hinge",desc:"Стена — стекло, боковое крепление. Для распашной двери; совместимость проверяется по массе полотна."},
    {id:"av24-4794",category:"Петли",name:"Петля Бета FDP-20 · чёрная",type:"hinge",desc:"Стена — стекло, боковое крепление. Чёрное исполнение для стеклянной двери."},
    {id:"av24-3489",category:"Коннекторы",name:"Коннектор FDK-24 90° · матовый",type:"connector",desc:"Соединение стекло — стекло под прямым углом. Применяется после проверки толщины и геометрии."},
    {id:"av24-5110",category:"Коннекторы",name:"Коннектор FDK-24 90° · чёрный",type:"connector",desc:"Угловое соединение двух стекол в чёрной отделке."},
    {id:"av24-4493",category:"Профили и треки",name:"Профиль FDPA-50.22 · матовый",type:"profile",desc:"П-образный алюминиевый профиль 20×12,5×2 мм, длина 2,2 м, для стекла 8 мм."},
    {id:"av24-3975",category:"Профили и треки",name:"Профиль FDPA-50.22 · чёрный",type:"profile",desc:"Опорный П-профиль длиной 2,2 м для стекла 8 мм. Подрезается по карте реза проекта."},
    {id:"av24-3997",category:"Профили и треки",name:"Трек FDT-352 · полированный",type:"bar",desc:"Труба 30×10×1,5 мм длиной 2 м для верхней стабилизации стекол."},
    {id:"av24-4001",category:"Профили и треки",name:"Трек FDT-352 · чёрный",type:"bar",desc:"Труба 30×10×1,5 мм длиной 2 м. Итоговая длина задаётся картой реза."},
    {id:"av24-2961",category:"Держатели",name:"Крепление FDC-30 · матовое",type:"connector",desc:"Концевое крепление трубы 30×10 мм к стене."},
    {id:"av24-2956",category:"Держатели",name:"Держатель FDC-33 · матовый",type:"connector",desc:"Торцевой горизонтальный держатель трубы 30×10 мм на стекле."},
    {id:"av24-2953",category:"Держатели",name:"Держатель FDC-35 · матовый",type:"connector",desc:"Сквозной горизонтальный держатель стекла для трубы 30×10 мм."},
    {id:"av24-6876",category:"Держатели",name:"Крепёж FDA-41 для FDC-30",type:"connector",desc:"Настенный крепёж из нержавеющей стали с двумя отверстиями."},
    {id:"av24-4489",category:"Ручки",name:"Ручка-кноб FDR-30 · матовая",type:"handle",desc:"Компактная квадратная ручка для стеклянной душевой двери."},
    {id:"av24-4101",category:"Ручки",name:"Ручка-кноб FDR-30 · чёрная",type:"handle",desc:"Квадратная ручка-кноб в чёрном исполнении."},
    {id:"av24-5573",category:"Уплотнение",name:"Нижний уплотнитель FDPP-406.8",type:"seal",desc:"Прозрачный нижний уплотнитель длиной 2,2 м для стекла 8 мм."},
    {id:"av24-5724",category:"Уплотнение",name:"Нижний уплотнитель FDPP-406.8 · чёрный",type:"seal",desc:"Нижний профиль длиной 2,2 м для двери из стекла 8 мм."},
    {id:"av24-8135",category:"Уплотнение",name:"Магнитный уплотнитель FDPP-202.8",type:"seal",desc:"Прозрачный магнитный профиль 90°/180°, длина 2,2 м, стекло 8 мм."},
    {id:"av24-8136",category:"Уплотнение",name:"Магнитный уплотнитель FDPP-202.8 · чёрный",type:"seal",desc:"Чёрный магнитный профиль 90°/180° для стекла 8 мм."},
    {id:"av24-4732",category:"Пороги",name:"Порог FDPP-10.2 · прозрачный",type:"profile",desc:"Акриловый порог 10×5 мм длиной 2 м для водозащитного контура."},
    {id:"av24-4580",category:"Пороги",name:"Порог FDPA-40.22 · чёрный",type:"profile",desc:"Алюминиевый порог длиной 2,2 м в чёрной отделке."},
    {id:"av24-12375",category:"Раздвижные системы",name:"Комплект Клио FDS-105 · матовый",type:"slide",desc:"Комплект с двумя рельсами для трубы 30×10 мм и стекла 8 мм. Трубы приобретаются отдельно."},
    {id:"av24-8643",category:"Раздвижные системы",name:"Комплект Клио FDS-105 · чёрный",type:"slide",desc:"Раздвижная система с двумя рельсами в чёрном исполнении, без труб."}
  ];
  const categories = ["Все", ...new Set(products.map(p => p.category))];
  const symbols = {hinge:"◫",connector:"⌞",handle:"Ⅱ",bar:"╱",profile:"⊏",seal:"│",slide:"◉"};
  const grid = document.querySelector("[data-products]");
  const filters = document.querySelector("[data-filters]");
  const cartRoot = document.querySelector("[data-cart]");
  const cartItems = document.querySelector("[data-cart-items]");
  const empty = document.querySelector("[data-cart-empty]");
  const footer = document.querySelector("[data-cart-footer]");
  const count = document.querySelector("[data-cart-count]");
  const total = document.querySelector("[data-cart-total]");
  const dialog = document.querySelector("[data-request-dialog]");
  const form = document.querySelector("[data-shop-form]");
  const status = document.querySelector("[data-form-status]");
  const toast = document.querySelector("[data-toast]");
  let active = "Все";
  let cart = {};
  try { cart = JSON.parse(localStorage.getItem("amalgama-components-cart")) || {}; } catch (_) {}

  function renderFilters(){
    filters.innerHTML = categories.map(c => `<button class="filter" type="button" data-filter="${c}" aria-pressed="${c===active}">${c}</button>`).join("");
  }
  function renderProducts(){
    const shown = active === "Все" ? products : products.filter(p => p.category === active);
    grid.innerHTML = shown.map((p,i) => `<article class="product">
      <div class="product-top"><span class="product-number">${String(products.indexOf(p)+1).padStart(2,"0")}</span><span class="product-badge">ПОД ЗАКАЗ</span></div>
      <div class="product-art art-${p.type}" aria-hidden="true"><span class="metal"></span></div>
      <div class="product-info"><small>${p.category.toUpperCase()}</small><h3>${p.name}</h3><p>${p.desc}</p>
      <div class="product-bottom"><strong>Цена по запросу</strong><button class="add" type="button" data-add="${p.id}">${cart[p.id] ? "Добавить ещё" : "В комплект +"}</button></div></div>
    </article>`).join("");
  }
  function save(){ localStorage.setItem("amalgama-components-cart", JSON.stringify(cart)); }
  function cartTotal(){ return Object.values(cart).reduce((a,b)=>a+b,0); }
  function renderCart(){
    const selected = products.filter(p => cart[p.id]);
    const n = cartTotal(); count.textContent = n; total.textContent = n;
    empty.hidden = selected.length > 0; footer.hidden = selected.length === 0;
    cartItems.innerHTML = selected.map(p => `<div class="cart-row"><div class="cart-icon" aria-hidden="true">${symbols[p.type]}</div><div><h3>${p.name}</h3><p>${p.category}</p></div><div class="quantity"><button type="button" data-minus="${p.id}" aria-label="Уменьшить">−</button><span>${cart[p.id]}</span><button type="button" data-plus="${p.id}" aria-label="Увеличить">+</button></div></div>`).join("");
    save();
  }
  function showToast(text){ toast.textContent=text; toast.classList.add("show"); clearTimeout(showToast.timer); showToast.timer=setTimeout(()=>toast.classList.remove("show"),1800); }
  function openCart(){ cartRoot.classList.add("is-open"); cartRoot.setAttribute("aria-hidden","false"); document.body.classList.add("locked"); }
  function closeCart(){ cartRoot.classList.remove("is-open"); cartRoot.setAttribute("aria-hidden","true"); document.body.classList.remove("locked"); }
  function openRequest(projectOnly=false){
    if(projectOnly){location.href='/project/';return;}
    closeCart();
    const selected = products.filter(p=>cart[p.id]);
    document.querySelector("[data-request-summary]").textContent = projectOnly || !selected.length ? "Подбор комплектующих по проекту" : `${cartTotal()} поз. в комплекте · проверим совместимость`;
    dialog.dataset.projectOnly = projectOnly ? "true" : "false";
    if(typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open","");
    setTimeout(()=>form.elements.name.focus(),100);
  }
  filters.addEventListener("click",e=>{const b=e.target.closest("[data-filter]");if(!b)return;active=b.dataset.filter;renderFilters();renderProducts();});
  grid.addEventListener("click",e=>{const b=e.target.closest("[data-add]");if(!b)return;cart[b.dataset.add]=(cart[b.dataset.add]||0)+1;renderCart();renderProducts();showToast("Добавлено в комплект");});
  cartItems.addEventListener("click",e=>{const plus=e.target.closest("[data-plus]"),minus=e.target.closest("[data-minus]");if(plus)cart[plus.dataset.plus]=(cart[plus.dataset.plus]||0)+1;if(minus){cart[minus.dataset.minus]-=1;if(cart[minus.dataset.minus]<=0)delete cart[minus.dataset.minus];}renderCart();renderProducts();});
  document.querySelector("[data-cart-open]").addEventListener("click",openCart);
  document.querySelectorAll("[data-cart-close]").forEach(b=>b.addEventListener("click",closeCart));
  document.querySelector("[data-checkout]").addEventListener("click",()=>openRequest(false));
  document.querySelectorAll("[data-project-help]").forEach(b=>b.addEventListener("click",()=>openRequest(true)));
  document.querySelector("[data-request-close]").addEventListener("click",()=>dialog.close());
  dialog.addEventListener("click",e=>{if(e.target===dialog)dialog.close();});
  document.addEventListener("keydown",e=>{if(e.key==="Escape")closeCart();});
  const phone = form.elements.phone;
  phone.addEventListener("input",()=>{
    let digits=phone.value.replace(/\D/g,"");
    if(digits.startsWith("8"))digits="7"+digits.slice(1);if(!digits.startsWith("7"))digits="7"+digits;digits=digits.slice(0,11);
    let out="+7";if(digits.length>1)out+=` (${digits.slice(1,4)}`;if(digits.length>=4)out+=")";if(digits.length>4)out+=` ${digits.slice(4,7)}`;if(digits.length>7)out+=`-${digits.slice(7,9)}`;if(digits.length>9)out+=`-${digits.slice(9,11)}`;phone.value=out;
  });
  phone.addEventListener("focus",()=>{if(!phone.value)phone.value="+7";});
  form.addEventListener("submit",async e=>{
    e.preventDefault();status.textContent="";
    if(!form.checkValidity()){form.reportValidity();return;}
    const button=form.querySelector("[type=submit]");button.disabled=true;button.firstChild.textContent="Отправляем ";
    const selected=products.filter(p=>cart[p.id]);
    const list=selected.length?selected.map(p=>`${p.name} — ${cart[p.id]} шт.`).join("; "):"нужен подбор по проекту";
    const comment=form.elements.comment.value.trim();
    const payload=new FormData();payload.set('name',form.elements.name.value.trim());payload.set('phone',phone.value);payload.set('topology','other');payload.set('comment',`РУЧНОЙ КАТАЛОГ. ${list}${comment?`. Комментарий: ${comment}`:""}`);payload.set('company',form.elements.company.value);payload.set('cart',JSON.stringify(selected.map(p=>({id:p.id,quantity:cart[p.id]}))));
    try{
      const response=await fetch("/api/public-production/intake/",{method:"POST",body:payload,headers:{Accept:'application/json'}});const result=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(result.detail||"send_failed");
      status.textContent=`Проект №${result.project_number} создан. Проверим совместимость комплекта и свяжемся с вами.`;
      form.reset();phone.value="+7";cart={};renderCart();renderProducts();
    }catch(_){status.textContent="Не удалось отправить. Проверьте соединение и попробуйте ещё раз.";}
    finally{button.disabled=false;button.firstChild.textContent="Отправить запрос ";}
  });
  renderFilters();renderProducts();renderCart();
})();
