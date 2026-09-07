/* Physical page layout shared by preview, browser printing and PDF export. */
(() => {
  'use strict';
  const PX_PER_MM = 96 / 25.4;
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function size(format) {
    const mm = format === 'A3' ? [297, 420] : [210, 297];
    return {mm, width:mm[0] * PX_PER_MM, height:mm[1] * PX_PER_MM};
  }
  function makePage(doc, number, container) {
    const dimensions = size(doc.settings.format);
    const shell = element('div', 'page-shell');
    shell.style.setProperty('--page-width', `${dimensions.width}px`);
    shell.style.setProperty('--page-height', `${dimensions.height}px`);
    const paper = element('section', `newspaper${doc.settings.paper === 'white' ? ' white' : ''}`);
    paper.setAttribute('aria-label', `Страница ${number}`);
    paper.style.setProperty('--body-size', `${doc.settings.fontSize * 96 / 72}px`);
    if (number === 1) {
      const head = element('header', 'masthead');
      head.innerHTML = `<div class="masthead-top">${escape(doc.meta.city)}</div><h2 class="masthead-title">${escape(doc.meta.title || 'Без названия')}</h2><div class="masthead-subtitle">${escape(doc.meta.subtitle)}</div>${doc.settings.ornaments ? '<div class="masthead-ornament" aria-hidden="true">❦</div>' : ''}<div class="masthead-edition"><span>${escape(doc.meta.issue)}</span><span>${escape(doc.meta.date)}</span><span>${escape(doc.meta.price)}</span></div>`;
      paper.append(head);
    } else {
      const head = element('header', 'continuation-header');
      head.append(element('span', '', doc.meta.title), element('span', '', doc.meta.date));
      paper.append(head);
    }
    const content = element('div', 'page-content');
    paper.append(content);
    const footer = element('footer', 'page-footer');
    footer.append(element('span', '', `${doc.meta.city} · ${doc.meta.title}`), element('span', '', `Стр. ${number}`));
    paper.append(footer);
    shell.append(paper);
    container.append(shell);
    const capacity = Math.max(150, footer.offsetTop - content.offsetTop - 20);
    content.style.height = `${capacity}px`;
    return {shell, paper, content, capacity, heights:Array(doc.settings.columns).fill(0), count:0};
  }
  function articleNode(article, html, {continued = false, hasImage = true, final = true} = {}) {
    const node = element('article', `news-article ${article.type}${article.span > 1 ? ' wide' : ''}${article.dropcap && !continued ? ' dropcap' : ''}`);
    node.dataset.articleId = article.id;
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    node.setAttribute('aria-label', `Редактировать: ${article.title || 'Без заголовка'}${continued ? ', продолжение' : ''}`);
    node.style.setProperty('--text-align', article.align);
    if (article.kicker && !continued) node.append(element('div', 'article-kicker', article.kicker));
    if (article.title) node.append(element('h3', '', article.title));
    if (continued) node.append(element('p', 'continued', 'Продолжение'));
    if (article.type === 'ad' && !continued && article.ornaments) {
      const ornament = element('div', 'ad-ornament', '❧');
      ornament.setAttribute('aria-hidden', 'true');
      node.append(ornament);
    }
    if (article.image && hasImage) {
      const figure = document.createElement('figure');
      const img = document.createElement('img');
      img.src = article.image.src;
      img.alt = article.image.caption || 'Иллюстрация к материалу';
      figure.append(img);
      if (article.image.caption) figure.append(element('figcaption', '', article.image.caption));
      node.append(figure);
    }
    const body = element('div', 'article-text');
    node.append(body);
    setBody(node, html);
    if (article.author && final) node.append(element('p', 'news-author', article.author));
    return node;
  }
  function setBody(article, html) {
    const body = article.querySelector('.article-text');
    body.innerHTML = html;
    if (!article.classList.contains('dropcap')) return;
    const paragraph = body.querySelector(':scope > p:first-child');
    if (!paragraph) return;
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let text;
    while ((text = walker.nextNode())) {
      const offset = text.textContent.search(/\S/u);
      if (offset < 0) continue;
      const first = Array.from(text.textContent.slice(offset))[0];
      const letter = element('span', 'drop-letter', first);
      const range = document.createRange();
      range.setStart(text, offset); range.setEnd(text, offset + first.length);
      range.deleteContents(); range.insertNode(letter);
      break;
    }
  }
  // Range cloning keeps emphasis/lists intact when a paragraph crosses a page.
  function splitHTML(html, offset) {
    const root = document.createElement('div');
    root.innerHTML = html;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node, remaining = offset, boundary;
    while ((node = walker.nextNode())) {
      if (remaining <= node.length) { boundary = node; break; }
      remaining -= node.length;
    }
    if (!boundary) return [html, ''];
    const before = document.createRange();
    before.selectNodeContents(root);
    before.setEnd(boundary, remaining);
    const after = document.createRange();
    after.selectNodeContents(root);
    after.setStart(boundary, remaining);
    const left = document.createElement('div'), right = document.createElement('div');
    left.append(before.cloneContents()); right.append(after.cloneContents());
    return [left.innerHTML, right.innerHTML];
  }
  function position(page, span, columns) {
    let best = {column:0, top:Infinity};
    for (let column = 0; column <= columns - span; column++) {
      const top = Math.max(...page.heights.slice(column, column + span));
      if (top < best.top) best = {column, top};
    }
    const colWidth = page.content.clientWidth / columns;
    return {...best, left:best.column * colWidth, width:colWidth * span};
  }
  function fitText(node, html, capacity) {
    const root = document.createElement('div'); root.innerHTML = html;
    const text = root.textContent;
    let low = 0, high = text.length, best = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      setBody(node, splitHTML(html, mid)[0]);
      if (node.offsetHeight <= capacity) { best = mid; low = mid + 1; }
      else high = mid - 1;
    }
    if (!best) return null;
    const prefix = text.slice(0, best);
    const boundary = Math.max(prefix.lastIndexOf(' '), prefix.lastIndexOf('\n'));
    // Prefer a word boundary; long unbroken words still have to make progress.
    if (boundary > best * .6) best = boundary + 1;
    const parts = splitHTML(html, best);
    setBody(node, parts[0]);
    return {html:parts[0], rest:parts[1]};
  }
  async function render(doc, container) {
    await document.fonts.ready;
    // Decode before measuring, otherwise image height can shift already placed text.
    await Promise.all(doc.articles.filter(a => a.image).map(async a => {
      const img = new Image(); img.src = a.image.src;
      try { await img.decode(); } catch { throw new Error('Не удалось прочитать иллюстрацию. Удалите её или загрузите заново.'); }
    }));
    const staging = element('div', 'pagination-staging');
    staging.style.cssText = 'position:absolute;left:-20000px;top:0;visibility:hidden;pointer-events:none';
    document.body.append(staging);
    let page, pages = [];
    const nextPage = () => { page = makePage(doc, pages.length + 1, staging); pages.push(page); };
    try {
      nextPage();
      for (const original of doc.articles) {
        const article = {...original, span:Math.min(original.span, doc.settings.columns), ornaments:doc.settings.ornaments};
        let remaining = article.html, continued = false, hasImage = true, done = false;
        while (!done) {
          if (pages.length > 250) throw new Error('В выпуске больше 250 страниц. Разделите его на несколько выпусков.');
          const slot = position(page, article.span, doc.settings.columns);
          const available = page.capacity - slot.top;
          if (available < 160 && page.count) { nextPage(); continue; }
          const node = articleNode(article, remaining, {continued, hasImage});
          node.style.width = `${slot.width}px`;
          node.style.left = `${slot.left}px`;
          node.style.top = `${slot.top}px`;
          if (slot.column + article.span < doc.settings.columns && article.type !== 'ad') node.classList.add('ruled');
          page.content.append(node);
          let rest = '';
          if (node.offsetHeight > available) {
            // Keep ordinary materials whole when there is room on a fresh page.
            if (slot.top > 0 && node.offsetHeight <= page.capacity) { node.remove(); nextPage(); continue; }
            node.querySelector('.news-author')?.remove();
            const split = fitText(node, remaining, available - 2);
            if (!split || !split.html.trim() || node.offsetHeight > available) {
              node.remove();
              if (page.count || pages.length === 1) { nextPage(); continue; }
              throw new Error(`Материал «${article.title}» не помещается: сократите заголовок или подпись к изображению, увеличьте ширину материала.`);
            }
            rest = split.rest;
            // An author alone must never disappear when the last body line fits.
            if (!rest.trim() && article.author) rest = '<p></p>';
          }
          const bottom = slot.top + node.offsetHeight + 19;
          for (let col = slot.column; col < slot.column + article.span; col++) page.heights[col] = bottom;
          page.count++;
          if (rest) { remaining = rest; continued = true; hasImage = false; }
          else done = true;
        }
      }
      if (!doc.articles.length) {
        const empty = element('div', 'empty-newspaper');
        empty.innerHTML = '<span aria-hidden="true">❦</span>Здесь начинается ваша газета.<br>Добавьте первый материал.';
        page.content.append(empty);
      }
      container.replaceChildren(...pages.map(p => p.shell));
      return {count:pages.length, ...size(doc.settings.format)};
    } finally { staging.remove(); }
  }
  window.GazettePagination = {render, size, splitHTML};
})();
