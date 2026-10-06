(() => {
  const products = [
    {id:"hinge-wall-90",category:"Петли",name:"Петля стекло — стена 90°",type:"hinge",desc:"Для распашной двери. Подбор по весу полотна и толщине стекла."},
    {id:"hinge-glass-180",category:"Петли",name:"Петля стекло — стекло 180°",type:"hinge",desc:"Соединяет дверь с неподвижным стеклом в одной плоскости."},
    {id:"connector-90",category:"Коннекторы",name:"Коннектор стекло — стена 90°",type:"connector",desc:"Точечное крепление неподвижного стекла без массивного профиля."},
    {id:"connector-135",category:"Коннекторы",name:"Коннектор стекло — стекло 135°",type:"connector",desc:"Для многогранных и угловых стеклянных конструкций."},
    {id:"handle-pull",category:"Ручки",name:"Ручка-скоба двусторонняя",type:"handle",desc:"Удобный хват с двух сторон двери. Длину и отделку уточним."},
    {id:"handle-knob",category:"Ручки",name:"Ручка-кноб компактная",type:"handle",desc:"Минималистичная ручка для лёгких душевых дверей."},
    {id:"stabilizer",category:"Штанги и профили",name:"Стабилизирующая штанга",type:"bar",desc:"Фиксирует неподвижное стекло. Подрезается под размер проекта."},
    {id:"u-profile",category:"Штанги и профили",name:"П-образный профиль",type:"profile",desc:"Аккуратное крепление стекла к стене или полу по всей длине."},
    {id:"bottom-seal",category:"Уплотнители",name:"Нижний водоотводящий уплотнитель",type:"seal",desc:"Снижает выход воды под дверью и направляет её внутрь душевой."},
    {id:"magnetic-seal",category:"Уплотнители",name:"Магнитный уплотнитель",type:"seal",desc:"Плотное и мягкое закрывание двух стеклянных кромок."},
    {id:"slider-straight",category:"Раздвижные системы",name:"Раздвижная система прямая",type:"slide",desc:"Комплект механики для прямой ниши с плавным ходом двери."},
    {id:"slider-corner",category:"Раздвижные системы",name:"Раздвижная система угловая",type:"slide",desc:"Согласованный комплект роликов и направляющих для углового входа."}
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
    const payload={name:form.elements.name.value.trim(),phone:phone.value,service:"Комплексный проект",message:`ЗАПРОС КОМПЛЕКТУЮЩИХ. ${list}${comment?`. Комментарий: ${comment}`:""}`,company:form.elements.company.value};
    try{
      const response=await fetch("/api/site-leads",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
      if(!response.ok)throw new Error("send_failed");
      status.textContent="Заявка отправлена. Мы проверим комплект и свяжемся с вами.";
      form.reset();phone.value="+7";cart={};renderCart();renderProducts();
    }catch(_){status.textContent="Не удалось отправить. Проверьте соединение и попробуйте ещё раз.";}
    finally{button.disabled=false;button.firstChild.textContent="Отправить запрос ";}
  });
  renderFilters();renderProducts();renderCart();
})();
