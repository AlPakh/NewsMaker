(() => {
  'use strict';
  const D = window.GazetteDocument;
  const P = window.GazettePagination;
  const $ = id => document.getElementById(id);
  const STORAGE_KEY = 'gazette-studio.document.v1';
  const typeNames = {article:'Статья', note:'Заметка', ad:'Объявление'};
  const clone = value => JSON.parse(JSON.stringify(value));
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let state = D.createDefault(), selectedId = null, editingId = null, draftImage = null;
  let undo = [], redo = [], lastGroup = '', lastChange = 0;
  let saveTimer, renderTimer, toastTimer, renderPromise = Promise.resolve(), renderError = null;
  let zoom = null, pageSize = P.size('A4'), pdfURL = null, confirmAction = null;
  let exporting = false, loadingImage = false, renderedRevision = -1, revision = 0;
  let storageFailed = false, imageRevision = 0;

  function toast(message, error = false) {
    clearTimeout(toastTimer);
    const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
    if (error && dialog) {
      let feedback = dialog.querySelector('.dialog-feedback');
      if (!feedback) {
        feedback = document.createElement('p'); feedback.className = 'dialog-feedback'; feedback.setAttribute('role','alert');
        const actions = dialog.querySelector('.dialog-actions');
        if (actions) actions.before(feedback); else dialog.append(feedback);
      }
      feedback.textContent = message; feedback.hidden = false;
      feedback.scrollIntoView({block:'nearest'});
      return;
    }
    $('toast').textContent = message;
    $('toast').classList.toggle('error', error);
    $('toast').hidden = false;
    toastTimer = setTimeout(() => $('toast').hidden = true, error ? 8500 : 4200);
  }
  function setSaveState(text, error = false) {
    $('save-label').textContent = text;
    $('save-state').classList.toggle('error', error);
  }
  function save() {
    clearTimeout(saveTimer);
    try {
      localStorage.setItem(STORAGE_KEY, D.toJSON(state));
      setSaveState('Сохранено в браузере'); storageFailed = false;
    } catch {
      setSaveState('Скачайте JSON для сохранения', true);
      if (!storageFailed) toast('Не удалось сохранить выпуск в браузере. Скачайте JSON через «Экспорт», чтобы не потерять работу.', true);
      storageFailed = true;
    }
  }
  function remember(before, group) {
    const now = Date.now();
    if (!group || group !== lastGroup || now - lastChange > 800) {
      undo.push(before);
      let size = undo.reduce((sum, item) => sum + item.length, 0);
      while (undo.length > 30 || (undo.length > 1 && size > 30000000)) size -= undo.shift().length;
    }
    lastGroup = group || ''; lastChange = now; redo = [];
  }
  function commit(change, group) {
    const before = JSON.stringify(state);
    change(state);
    if (before === JSON.stringify(state)) return;
    remember(before, group); changed();
  }
  function changed() {
    revision++;
    setSaveState('Сохранение…');
    clearTimeout(saveTimer); saveTimer = setTimeout(save, 350);
    updateUI(); scheduleRender();
  }
  function history(direction) {
    const from = direction === 'undo' ? undo : redo, to = direction === 'undo' ? redo : undo;
    if (!from.length) return;
    to.push(JSON.stringify(state)); state = JSON.parse(from.pop()); lastGroup = '';
    if (!state.articles.some(a => a.id === selectedId)) selectedId = null;
    changed(); toast(direction === 'undo' ? 'Действие отменено' : 'Действие повторено');
  }
  function updateUI() {
    $('document-label').textContent = state.meta.title || 'Без названия';
    document.title = `${state.meta.title || 'Новый выпуск'} — Газетная мастерская`;
    $('article-count').textContent = state.articles.length;
    $('mobile-count').textContent = state.articles.length;
    $('word-count').textContent = `${D.wordCount(state).toLocaleString('ru')} слов`;
    $('undo-button').disabled = !undo.length; $('redo-button').disabled = !redo.length;
    document.querySelectorAll('[data-meta]').forEach(input => {
      if (document.activeElement !== input) input.value = state.meta[input.dataset.meta];
    });
    document.querySelectorAll('[data-setting]').forEach(input => {
      const value = state.settings[input.dataset.setting];
      if (input.type === 'checkbox') input.checked = value;
      else if (document.activeElement !== input) input.value = value;
    });
    $('font-size-value').textContent = `${state.settings.fontSize} пт`;
    document.querySelectorAll('[data-columns]').forEach(b => b.setAttribute('aria-pressed', Number(b.dataset.columns) === state.settings.columns));
    $('preview-size').textContent = `${state.settings.format} · ${P.size(state.settings.format).mm.join(' × ')} мм`;
    $('article-list').innerHTML = state.articles.map((article, i) => `<li class="article-item${selectedId === article.id ? ' selected' : ''}" data-id="${escape(article.id)}"><button class="article-open" data-action="edit" aria-label="Редактировать: ${escape(article.title || 'Без заголовка')}"><span class="article-meta"><span aria-hidden="true">${article.type === 'ad' ? '❧' : article.type === 'note' ? '¶' : '▤'}</span> ${typeNames[article.type].toUpperCase()}<span>${Math.min(article.span, state.settings.columns)} кол.</span></span><span class="article-name">${escape(article.title || 'Без заголовка')}</span><span class="article-excerpt">${escape(D.htmlToText(article.html).slice(0, 90) || 'Пустой материал')}</span></button><div class="article-item-actions"><span class="item-number">${String(i + 1).padStart(2,'0')}</span><button class="icon-button" data-action="up" aria-label="Переместить выше: ${escape(article.title)}" ${i === 0 ? 'disabled' : ''}>↑</button><button class="icon-button" data-action="down" aria-label="Переместить ниже: ${escape(article.title)}" ${i === state.articles.length - 1 ? 'disabled' : ''}>↓</button><button class="icon-button" data-action="duplicate" aria-label="Дублировать: ${escape(article.title)}">⧉</button></div></li>`).join('');
    if (!state.articles.length) $('article-list').innerHTML = '<li class="panel-description">Пока нет материалов. Добавьте первую статью, заметку или объявление.</li>';
  }
  function applyZoom() {
    if (!$('canvas').clientWidth) return;
    const style = getComputedStyle($('canvas'));
    const available = $('canvas').clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const factor = zoom || Math.min(1, Math.max(.15, available / pageSize.width));
    $('pages').style.width = `${pageSize.width * factor}px`;
    $('pages').querySelectorAll('.page-shell').forEach(shell => {
      shell.style.width = `${pageSize.width * factor}px`;
      shell.style.height = `${pageSize.height * factor}px`;
      shell.firstElementChild.style.transform = `scale(${factor})`;
    });
    $('zoom-fit').textContent = `${Math.round(factor * 100)}%`;
  }
  function renderNow() {
    clearTimeout(renderTimer);
    const currentRevision = revision, snapshot = clone(state);
    renderPromise = renderPromise.catch(() => {}).then(async () => {
      if (currentRevision < revision || renderedRevision === currentRevision) return;
      try {
        pageSize = await P.render(snapshot, $('pages'));
        renderedRevision = currentRevision; renderError = null;
        $('page-count').textContent = `${pageSize.count} ${pageSize.count === 1 ? 'страница' : pageSize.count < 5 ? 'страницы' : 'страниц'}`;
        $('pages').querySelectorAll('[data-article-id]').forEach(node => node.classList.toggle('selected', node.dataset.articleId === selectedId));
        let printStyle = $('print-page-style');
        if (!printStyle) { printStyle = document.createElement('style'); printStyle.id = 'print-page-style'; document.head.append(printStyle); }
        printStyle.textContent = `@media print { @page { size: ${snapshot.settings.format} portrait; margin: 0; } }`;
        applyZoom();
      } catch (error) {
        renderError = error;
        $('page-count').textContent = 'Макет требует исправления';
        toast(error.message, true);
      }
    });
    return renderPromise;
  }
  function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(renderNow, 220); }
  async function ensureRendered() {
    await renderNow();
    if (renderedRevision !== revision && !renderError) await renderNow();
    if (renderError) throw renderError;
  }
  function view(name) {
    $('workspace').dataset.view = name;
    document.querySelectorAll('button[data-view]').forEach(button => button.setAttribute('aria-pressed', button.dataset.view === name));
    if (name === 'preview') requestAnimationFrame(applyZoom);
  }
  function showDialog(id) { $(id).showModal(); }
  function askReplace(message, action) {
    confirmAction = action;
    $('confirm-message').textContent = message;
    showDialog('confirm-dialog');
  }
  function replaceDocument(doc) {
    commit(() => { state = doc; }); selectedId = null; zoom = null;
    updateUI(); view('preview'); save();
  }
  function openEditor(id) {
    const article = state.articles.find(a => a.id === id);
    if (!article) return;
    selectedId = id; editingId = id; draftImage = clone(article.image); imageRevision++;
    updateUI();
    $('pages').querySelectorAll('[data-article-id]').forEach(n => n.classList.toggle('selected', n.dataset.articleId === id));
    for (const key of ['title','kicker','type','author','span','align']) $(`article-${key}`).value = article[key];
    $('editor-type').textContent = typeNames[article.type].toUpperCase();
    $('article-body').innerHTML = article.html;
    $('article-dropcap').checked = article.dropcap;
    $('article-span').querySelectorAll('option').forEach(o => o.disabled = Number(o.value) > state.settings.columns);
    $('article-span').value = Math.min(article.span, state.settings.columns);
    $('image-caption').value = article.image?.caption || '';
    $('image-file').value = '';
    updateImagePreview();
    showDialog('editor-dialog');
  }
  function updateImagePreview() {
    $('image-preview').hidden = !draftImage;
    $('remove-image').hidden = !draftImage;
    $('image-indicator').textContent = draftImage ? '· добавлена' : '';
    if (draftImage) $('image-preview').src = draftImage.src;
    else $('image-preview').removeAttribute('src');
  }
  function add(type) {
    if (state.articles.length >= 200) return toast('В одном выпуске может быть до 200 материалов.', true);
    const article = D.createArticle(type);
    commit(doc => doc.articles.push(article));
    $('add-dialog').close(); openEditor(article.id);
  }
  function download(blob, extension) {
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = filename(extension);
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function filename(extension) {
    const name = (state.meta.title || 'Газета').replace(/[<>:"/\\|?*\x00-\x1f]/g,'').slice(0, 90);
    return `${name}.${extension}`;
  }
  function exportJSON() {
    try { download(new Blob([D.toJSON(state)], {type:'application/json;charset=utf-8'}), 'json'); toast('Редактируемый выпуск сохранён в JSON'); }
    catch (error) { toast(error.message, true); }
  }
  const loadedScripts = new Map();
  function loadScript(src) {
    if (!loadedScripts.has(src)) loadedScripts.set(src, new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = src;
      script.onload = resolve;
      script.onerror = () => { loadedScripts.delete(src); script.remove(); reject(new Error('Не удалось загрузить библиотеку PDF. Проверьте наличие папки vendor рядом с сайтом.')); };
      document.head.append(script);
    }));
    return loadedScripts.get(src);
  }
  async function exportPDF() {
    if (exporting) return;
    exporting = true; $('export-dialog').setAttribute('aria-busy','true');
    $('export-dialog').querySelectorAll('button').forEach(b => b.disabled = true);
    $('pdf-ready').hidden = true;
    $('export-progress').textContent = 'Подготавливаем печатный выпуск…';
    let stage;
    try {
      await ensureRendered();
      await Promise.all([loadScript('vendor/html2canvas.min.js'), loadScript('vendor/jspdf.umd.min.js')]);
      const pdf = new window.jspdf.jsPDF({orientation:'portrait',unit:'mm',format:state.settings.format.toLowerCase(),compress:true});
      pdf.setProperties({title:state.meta.title,subject:state.meta.subtitle,creator:'Газетная мастерская'});
      stage = document.createElement('div'); stage.className = 'exporting';
      stage.style.cssText = 'position:absolute;left:-20000px;top:0;';
      document.body.append(stage);
      const papers = [...$('pages').querySelectorAll('.newspaper')];
      for (let i = 0; i < papers.length; i++) {
        $('export-progress').textContent = `Печатаем страницу ${i + 1} из ${papers.length}…`;
        const paper = papers[i].cloneNode(true);
        paper.style.transform = 'none';
        paper.style.setProperty('--page-width', `${pageSize.width}px`);
        paper.style.setProperty('--page-height', `${pageSize.height}px`);
        stage.replaceChildren(paper);
        // html2canvas does not support CSS filters: turn illustrations into grayscale explicitly.
        for (const img of paper.querySelectorAll('img')) {
          await img.decode();
          const gray = document.createElement('canvas');
          const imageScale = Math.min(1, 1800 / Math.max(img.naturalWidth, img.naturalHeight));
          gray.width = Math.max(1, Math.round(img.naturalWidth * imageScale)); gray.height = Math.max(1, Math.round(img.naturalHeight * imageScale));
          const ctx = gray.getContext('2d'); ctx.drawImage(img, 0, 0, gray.width, gray.height);
          const pixels = ctx.getImageData(0, 0, gray.width, gray.height);
          for (let p = 0; p < pixels.data.length; p += 4) {
            const light = Math.round(pixels.data[p] * .299 + pixels.data[p+1] * .587 + pixels.data[p+2] * .114);
            pixels.data[p] = pixels.data[p+1] = pixels.data[p+2] = light;
          }
          ctx.putImageData(pixels,0,0); img.src = gray.toDataURL('image/png'); await img.decode();
          gray.width = gray.height = 0;
        }
        const scale = state.settings.format === 'A3' ? 1.75 : 2.25;
        const canvas = await window.html2canvas(paper, {scale,backgroundColor:null,logging:false,scrollX:0,scrollY:0,width:pageSize.width,height:pageSize.height,windowWidth:1440,windowHeight:1800});
        if (i) pdf.addPage(state.settings.format.toLowerCase(), 'portrait');
        pdf.addImage(canvas.toDataURL('image/jpeg', .96), 'JPEG', 0, 0, ...pageSize.mm, undefined, 'FAST');
        canvas.width = canvas.height = 0;
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      if (pdfURL) URL.revokeObjectURL(pdfURL);
      pdfURL = URL.createObjectURL(pdf.output('blob'));
      $('pdf-ready').href = pdfURL; $('pdf-ready').download = filename('pdf'); $('pdf-ready').hidden = false;
      $('export-progress').textContent = `Готово. ${papers.length} стр. · ${state.settings.format}. Если загрузка не началась, нажмите кнопку ниже.`;
      $('pdf-ready').click();
    } catch (error) {
      $('export-progress').textContent = `Не удалось создать PDF. ${error.message} Можно использовать кнопку «Печать».`;
    } finally {
      stage?.remove(); exporting = false;
      $('export-dialog').removeAttribute('aria-busy');
      $('export-dialog').querySelectorAll('button').forEach(b => b.disabled = false);
    }
  }
  async function importFile(file) {
    if (!file) return;
    try {
      if (file.size > 30 * 1024 * 1024) throw new Error('Файл больше 30 МБ. Откройте выпуск меньшего размера.');
      const doc = D.parseFile(await file.text(), file.name);
      await Promise.all(doc.articles.filter(a => a.image).map(async a => {
        const img = new Image(); img.src = a.image.src;
        try { await img.decode(); } catch { throw new Error('В файле повреждено изображение. Текущий выпуск сохранён.'); }
        if (img.naturalWidth * img.naturalHeight > 40000000) throw new Error('Изображение в файле превышает 40 мегапикселей. Уменьшите его перед импортом.');
      }));
      askReplace(`Открыть «${doc.meta.title || 'Без названия'}» (${doc.articles.length} материалов)? Текущий выпуск будет заменён. Его можно заранее скачать или вернуть кнопкой отмены.`, () => {
        replaceDocument(doc); toast('Выпуск импортирован');
      });
    } catch (error) { toast(`Не удалось открыть выпуск. ${error.message}`, true); }
    finally { $('import-file').value = ''; }
  }
  async function uploadImage(file) {
    if (!file) return;
    const token = ++imageRevision;
    loadingImage = true; $('upload-image').disabled = true;
    $('article-form').querySelector('[type="submit"]').disabled = true;
    try {
      if (!['image/jpeg','image/png','image/webp'].includes(file.type)) throw new Error('Поддерживаются изображения JPG, PNG и WebP.');
      if (file.size > 10 * 1024 * 1024) throw new Error('Изображение должно быть не больше 10 МБ.');
      const url = URL.createObjectURL(file), img = new Image();
      try {
        img.src = url; await img.decode();
        if (img.naturalWidth * img.naturalHeight > 40000000) throw new Error('Изображение слишком большое. Уменьшите его до 40 мегапикселей.');
        const scale = Math.min(1, 1800 / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.drawImage(img,0,0,canvas.width,canvas.height);
        if (token !== imageRevision || !$('editor-dialog').open) return;
        draftImage = {src:canvas.toDataURL('image/jpeg', .88),caption:$('image-caption').value};
        updateImagePreview();
      } finally { URL.revokeObjectURL(url); }
    } catch (error) { toast(error.message || 'Не удалось прочитать изображение.', true); }
    finally {
      loadingImage = false; $('upload-image').disabled = false;
      $('article-form').querySelector('[type="submit"]').disabled = false;
      $('image-file').value = '';
    }
  }

  $('settings-form').addEventListener('submit', e => e.preventDefault());
  $('settings-form').addEventListener('input', e => {
    const input = e.target;
    if (input.dataset.meta) commit(doc => doc.meta[input.dataset.meta] = input.value, input.id);
    else if (input.dataset.setting) commit(doc => {
      doc.settings[input.dataset.setting] = input.type === 'checkbox' ? input.checked : input.type === 'range' ? Number(input.value) : input.value;
    }, input.id);
  });
  document.querySelectorAll('[data-columns]').forEach(button => button.addEventListener('click', () => commit(doc => doc.settings.columns = Number(button.dataset.columns))));
  document.querySelectorAll('button[data-view]').forEach(button => button.addEventListener('click', () => view(button.dataset.view)));
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('close', () => { const feedback = dialog.querySelector('.dialog-feedback'); if (feedback) feedback.hidden = true; }));
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', e => { if (e.target === dialog && !exporting) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } }));
  $('export-dialog').addEventListener('cancel', e => { if (exporting) e.preventDefault(); });
  $('add-button').addEventListener('click', () => showDialog('add-dialog'));
  document.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => add(b.dataset.add)));
  $('help-button').addEventListener('click', () => showDialog('help-dialog'));
  $('export-button').addEventListener('click', () => showDialog('export-dialog'));
  $('import-button').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', e => importFile(e.target.files[0]));
  $('download-json').addEventListener('click', exportJSON);
  $('backup-button').addEventListener('click', exportJSON);
  $('download-md').addEventListener('click', () => {
    try { download(new Blob([D.toMarkdown(state)], {type:'text/markdown;charset=utf-8'}), 'md'); toast('Выпуск сохранён в Markdown'); }
    catch (error) { toast(error.message, true); }
  });
  $('download-pdf').addEventListener('click', exportPDF);
  $('print-button').addEventListener('click', async () => {
    try { await ensureRendered(); save(); window.print(); }
    catch (error) { toast(error.message, true); }
  });
  $('undo-button').addEventListener('click', () => history('undo'));
  $('redo-button').addEventListener('click', () => history('redo'));
  $('confirm-button').addEventListener('click', () => { $('confirm-dialog').close(); const action = confirmAction; confirmAction = null; action?.(); });
  $('new-button').addEventListener('click', () => askReplace('Начать новый пустой выпуск? Текущую газету можно скачать в JSON перед заменой.', () => {
    const doc = D.createDefault(); doc.articles = []; doc.meta.title = 'Моя газета'; replaceDocument(doc);
  }));
  $('demo-button').addEventListener('click', () => { $('help-dialog').close(); askReplace('Открыть демонстрационный выпуск «Валенарский вестник»? Текущий выпуск будет заменён.', () => replaceDocument(D.createDefault())); });
  $('zoom-fit').addEventListener('click', () => { zoom = null; applyZoom(); });
  function changeZoom(step) { const current = parseFloat($('zoom-fit').textContent) / 100; zoom = Math.min(1.75, Math.max(.2, current + step)); applyZoom(); }
  $('zoom-in').addEventListener('click', () => changeZoom(.15));
  $('zoom-out').addEventListener('click', () => changeZoom(-.15));
  new ResizeObserver(applyZoom).observe($('canvas'));
  $('article-list').addEventListener('click', e => {
    const button = e.target.closest('[data-action]'), item = button?.closest('[data-id]');
    if (!item) return;
    const id = item.dataset.id, index = state.articles.findIndex(a => a.id === id), action = button.dataset.action;
    if (action === 'edit') return openEditor(id);
    if (action === 'duplicate') {
      if (state.articles.length >= 200) return toast('В выпуске уже 200 материалов.', true);
      commit(doc => { const copy = clone(doc.articles[index]); copy.id = D.makeId(); copy.title = `${copy.title.slice(0,230)} (копия)`; doc.articles.splice(index+1,0,copy); selectedId = copy.id; });
      toast('Создана копия материала');
    } else {
      const next = index + (action === 'up' ? -1 : 1);
      if (next < 0 || next >= state.articles.length) return;
      commit(doc => [doc.articles[index], doc.articles[next]] = [doc.articles[next],doc.articles[index]]);
      const focus = [...$('article-list').children].find(n => n.dataset.id === id)?.querySelector(`[data-action="${action}"]:not(:disabled)`);
      focus?.focus();
    }
  });
  function clickArticle(e) { const article = e.target.closest('[data-article-id]'); if (article) openEditor(article.dataset.articleId); }
  $('pages').addEventListener('click', clickArticle);
  $('pages').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); clickArticle(e); } });
  $('article-form').addEventListener('submit', e => {
    e.preventDefault(); if (loadingImage) return;
    try {
      const article = clone(state.articles.find(a => a.id === editingId));
      if (!article) return;
      for (const key of ['title','kicker','type','author','align']) article[key] = $(`article-${key}`).value;
      article.span = Number($('article-span').value); article.dropcap = $('article-dropcap').checked;
      article.html = D.sanitizeHTML($('article-body').innerHTML);
      article.image = draftImage ? {...draftImage,caption:$('image-caption').value} : null;
      const candidate = clone(state); candidate.articles[candidate.articles.findIndex(a => a.id === editingId)] = article;
      const normalized = D.normalize(candidate);
      commit(() => { state = normalized; });
      $('editor-dialog').close(); toast('Материал обновлён');
    } catch (error) { toast(error.message, true); }
  });
  $('editor-dialog').addEventListener('close', () => { imageRevision++; editingId = null; draftImage = null; });
  $('delete-article').addEventListener('click', () => {
    const id = editingId;
    commit(doc => { doc.articles = doc.articles.filter(a => a.id !== id); selectedId = null; });
    $('editor-dialog').close(); toast('Материал удалён. Его можно вернуть кнопкой отмены.');
  });
  $('upload-image').addEventListener('click', () => $('image-file').click());
  $('image-file').addEventListener('change', e => uploadImage(e.target.files[0]));
  $('remove-image').addEventListener('click', () => { draftImage = null; $('image-caption').value = ''; updateImagePreview(); });
  // Native commands preserve text undo; the issue itself has snapshot history.
  let editorRange = null;
  document.addEventListener('selectionchange', () => {
    const selection = window.getSelection();
    if (selection?.rangeCount && $('article-body').contains(selection.anchorNode) && $('article-body').contains(selection.focusNode)) editorRange = selection.getRangeAt(0).cloneRange();
  });
  document.querySelectorAll('[data-format]').forEach(button => {
    button.addEventListener('pointerdown', e => e.preventDefault());
    button.addEventListener('click', () => {
      $('article-body').focus();
      if (editorRange && $('article-body').contains(editorRange.commonAncestorContainer)) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(editorRange); }
      if (button.dataset.format === 'quote') document.execCommand('formatBlock', false, 'blockquote');
      else document.execCommand(button.dataset.format, false, null);
    });
  });
  $('article-body').addEventListener('paste', e => {
    e.preventDefault();
    const html = e.clipboardData.getData('text/html'), plain = e.clipboardData.getData('text/plain');
    const safe = html ? D.sanitizeHTML(html) : escape(plain).replace(/\r?\n/g,'<br>');
    document.execCommand('insertHTML', false, safe);
  });
  $('article-body').addEventListener('drop', e => e.preventDefault());
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = e.key.toLowerCase();
    if (key === 's') { e.preventDefault(); if (!$('editor-dialog').open) exportJSON(); return; }
    if (e.target.closest('input,textarea,[contenteditable="true"]') || document.querySelector('dialog[open]')) return;
    if (key === 'z') { e.preventDefault(); history(e.shiftKey ? 'redo' : 'undo'); }
    if (key === 'y') { e.preventDefault(); history('redo'); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
  window.addEventListener('pagehide', save);
  window.addEventListener('beforeunload', e => { if (storageFailed) { e.preventDefault(); e.returnValue = ''; } });
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) state = D.parseFile(saved, 'saved.json');
    setSaveState(saved ? 'Восстановлено из браузера' : 'Новый демонстрационный выпуск');
  } catch { setSaveState('Локальное сохранение недоступно', true); toast('Не удалось восстановить локальную копию. Можно открыть сохранённый JSON.', true); }
  updateUI(); renderNow();
  window.GazetteApp = {getDocument:() => clone(state), ready:ensureRendered};
})();
