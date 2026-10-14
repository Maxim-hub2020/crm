(() => {
  const form = document.querySelector('[data-chat-form]');
  const textarea = form.elements.message;
  const fileInput = form.elements.files;
  const messages = document.querySelector('[data-messages]');
  const status = document.querySelector('[data-chat-status]');
  const send = form.querySelector('.send');
  const fileLabel = document.querySelector('[data-file-label]');
  const onlineText = document.querySelector('[data-online-text]');
  const quick = document.querySelector('[data-quick-replies]');
  const params = new URLSearchParams(location.search);
  const selectedModel = params.get('model') || '';
  const selectedName = params.get('name') || '';
  const storageKey = `amalgama-designer-state:${selectedModel || 'new'}`;
  let stateToken = sessionStorage.getItem(storageKey) || '';
  let pendingOption = '';

  const turnTime = () => new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' }).format(new Date());

  function addMessage(role, text, files = []) {
    const article = document.createElement('article');
    article.className = `message ${role}`;
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = role === 'assistant' ? 'A' : 'Вы';
    const box = document.createElement('div');
    if (files.length) {
      const list = document.createElement('small');
      list.className = 'attachments';
      list.textContent = files.map((file) => file.name).join(' · ');
      box.append(list);
    }
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    box.append(paragraph);
    const time = document.createElement('time');
    time.textContent = role === 'assistant' ? `Технолог AMALGAMA · ${turnTime()}` : turnTime();
    box.append(time);
    article.append(avatar, box);
    messages.append(article);
    messages.scrollTop = messages.scrollHeight;
  }

  function renderOptions(options = []) {
    quick.replaceChildren();
    options.forEach((option) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.value = option.value;
      button.textContent = option.label;
      quick.append(button);
    });
    quick.hidden = !options.length;
  }

  function updateResult(result) {
    const stages = ['intro', 'geometry', 'configuration', 'hardware', 'review', 'complete'];
    const current = Math.max(0, stages.indexOf(result.stage));
    document.querySelectorAll('[data-step]').forEach((element, index) => {
      element.classList.toggle('active', index === Math.min(current, 4));
      element.classList.toggle('done', index < current);
    });
    const names = {
      intro: 'Выбор конструкции', geometry: 'Уточнение размеров', configuration: 'Конструкция',
      hardware: 'Подбор фурнитуры', review: 'Проверочный проект', complete: 'Проект готов',
    };
    document.querySelector('[data-current-stage]').textContent = names[result.stage] || 'Проектирование';
    document.querySelector('[data-project-type]').textContent = result.project_title || 'Новая конструкция';
    document.querySelector('[data-result-title]').textContent = result.project_title || 'Исходные данные';
    const progress = Math.max(0, Math.min(100, result.progress || 0));
    document.querySelector('[data-progress-value]').textContent = `${progress}%`;
    document.querySelector('[data-progress-bar]').value = progress;
    document.querySelector('[data-score]').textContent = `${Math.round(progress / 10)} из 10`;
    document.querySelector('[data-score-caption]').textContent = result.ready_for_final
      ? 'Все критичные данные подтверждены'
      : 'Продолжаем технологическую проверку';

    const missing = document.querySelector('[data-missing]');
    missing.replaceChildren();
    (result.missing || []).slice(0, 5).forEach((text) => {
      const item = document.createElement('li');
      item.textContent = text;
      missing.append(item);
    });
    if (!missing.children.length) {
      const item = document.createElement('li');
      item.textContent = 'Блокирующих вопросов не осталось';
      missing.append(item);
    }

    const hardware = document.querySelector('[data-hardware]');
    hardware.replaceChildren();
    (result.hardware || []).forEach((item) => {
      const row = document.createElement('article');
      const copy = document.createElement('div');
      const name = document.createElement('b');
      const reason = document.createElement('small');
      const links = document.createElement('nav');
      const quantity = document.createElement('span');
      name.textContent = item.label;
      reason.textContent = item.reason;
      links.className = 'hardware-links';
      if (item.drawing_url) {
        const drawing = document.createElement('a');
        drawing.href = item.drawing_url;
        drawing.target = '_blank';
        drawing.rel = 'noopener noreferrer';
        drawing.textContent = 'Техкарта PDF';
        links.append(drawing);
      }
      if (item.source_url) {
        const source = document.createElement('a');
        source.href = item.source_url;
        source.target = '_blank';
        source.rel = 'noopener noreferrer';
        source.textContent = 'Карточка AV24';
        links.append(source);
      }
      quantity.textContent = `${item.quantity} шт.`;
      copy.append(name, reason, links);
      row.append(copy, quantity);
      hardware.append(row);
    });
    if (!hardware.children.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Комплект появится автоматически после выбора конструкции и толщины стекла.';
      hardware.append(empty);
    }
    document.querySelector('[data-downloads]').setAttribute('aria-disabled', String(!result.documents_unlocked));
    renderOptions(result.options);
    textarea.placeholder = result.input_mode === 'pair' || result.input_mode === 'pair_zero'
      ? 'Например: 900 905'
      : result.input_mode === 'number' || result.input_mode === 'number_zero'
        ? 'Размер в миллиметрах'
        : 'Напишите ответ…';
  }

  async function checkConnection() {
    try {
      const response = await fetch('/api/public-production/chat/');
      const data = await response.json();
      onlineText.textContent = data.enabled ? 'Технолог онлайн' : 'Каталог временно недоступен';
      document.body.classList.toggle('ai-offline', !data.enabled);
    } catch (_) {
      onlineText.textContent = 'Связь восстанавливается';
    }
  }

  fileInput.addEventListener('change', () => {
    const count = fileInput.files.length;
    fileLabel.textContent = count ? `${count} файл${count > 1 ? 'а' : ''}` : 'Эскиз / фото';
  });

  quick.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    pendingOption = button.dataset.value || '';
    textarea.value = button.textContent;
    form.requestSubmit();
  });

  textarea.addEventListener('input', () => { pendingOption = ''; });
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = textarea.value.trim();
    const files = [...fileInput.files];
    if (!text && !files.length && !pendingOption) return;
    addMessage('user', text || 'Прикладываю материалы замера.', files);
    textarea.value = '';
    fileInput.value = '';
    fileLabel.textContent = 'Эскиз / фото';
    quick.hidden = true;
    send.disabled = true;
    status.textContent = 'Проверяю данные по производственным правилам…';
    const payload = new FormData();
    payload.set('message', text);
    if (pendingOption) payload.set('option_value', pendingOption);
    if (selectedModel) payload.set('selected_model', selectedModel);
    if (stateToken) payload.set('state_token', stateToken);
    files.forEach((file) => payload.append('files', file));
    pendingOption = '';
    try {
      const response = await fetch('/api/public-production/chat/', { method: 'POST', body: payload, headers: { Accept: 'application/json' } });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.detail || 'Не удалось получить ответ.');
      stateToken = result.state_token || stateToken;
      if (stateToken) sessionStorage.setItem(storageKey, stateToken);
      addMessage('assistant', result.message);
      updateResult(result);
      status.textContent = result.catalog_connected ? 'Конструкция и комплект сверены с каталогом CRM.' : '';
    } catch (error) {
      addMessage('assistant', error.message || 'Связь прервалась. Повторите сообщение.');
      status.textContent = '';
    } finally {
      send.disabled = false;
      textarea.focus();
    }
  });

  if (selectedName) {
    document.querySelector('[data-project-type]').textContent = selectedName;
    textarea.value = `Начать проект «${selectedName}»`;
  }
  checkConnection();
})();
