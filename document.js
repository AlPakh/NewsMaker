/* Versioned portable document format. No network, storage or application state. */
(function (root) {
  'use strict';
  const FORMAT = 'gazette-studio';
  const MAX_FILE = 30 * 1024 * 1024;
  const SNAPSHOT = 'gazette-studio-snapshot-v1:';
  const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const allowed = new Set(['P','BR','STRONG','B','EM','I','U','S','UL','OL','LI','BLOCKQUOTE']);
  const forbidden = new Set(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','SVG','MATH','IMG','VIDEO','AUDIO','SOURCE','LINK','META','BASE','FORM','INPUT','BUTTON','SELECT','TEXTAREA','TEMPLATE','NOSCRIPT']);
  const metaDefaults = {title:'Валенарский вестник',subtitle:'Газета общественной жизни, торговли и дальних странствий',city:'Таэр Валаэстас',date:'15 Зарантира 997 г.',issue:'№ 14',price:'Цена 2 медяка'};
  const settingDefaults = {columns:3,fontSize:11,paper:'warm',format:'A4',ornaments:true};
  const types = {article:'Новая статья',note:'Короткая заметка',ad:'Объявление'};
  function makeId() {
    return root.crypto?.randomUUID ? root.crypto.randomUUID() : `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,11)}`;
  }
  function sanitizeHTML(html) {
    if (typeof html !== 'string') throw new Error('Текст материала должен быть строкой.');
    const template = document.createElement('template'); template.innerHTML = html;
    const output = document.createElement('div');
    function visit(node, parent, depth) {
      if (depth > 60) throw new Error('Слишком сложное вложенное оформление текста. Вставьте его как обычный текст.');
      if (node.nodeType === 3) { parent.append(document.createTextNode(node.textContent)); return; }
      if (node.nodeType !== 1 || forbidden.has(node.tagName)) return;
      const tag = allowed.has(node.tagName) ? node.tagName.toLowerCase() : /^(DIV|H[1-6]|SECTION|ARTICLE)$/.test(node.tagName) ? 'p' : null;
      const target = tag ? document.createElement(tag) : parent;
      for (const child of node.childNodes) visit(child, target, depth + 1);
      if (tag) parent.append(target);
    }
    for (const node of template.content.childNodes) visit(node, output, 0);
    // Give loose text a paragraph so drop capitals and print spacing are reliable.
    const normalized = document.createElement('div');
    let paragraph = null;
    for (const node of [...output.childNodes]) {
      if (node.nodeType === 1 && ['P','UL','OL','BLOCKQUOTE'].includes(node.tagName)) { paragraph = null; normalized.append(node); }
      else {
        if (!paragraph) { paragraph = document.createElement('p'); normalized.append(paragraph); }
        paragraph.append(node);
      }
    }
    return normalized.innerHTML;
  }
  function htmlToText(html) {
    const node = document.createElement('div'); node.innerHTML = sanitizeHTML(html);
    node.querySelectorAll('br').forEach(n => n.replaceWith('\n'));
    node.querySelectorAll('p,li,blockquote').forEach(n => n.append('\n'));
    return node.textContent.replace(/\n{3,}/g,'\n\n').trim();
  }
  function object(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: ожидался объект.`);
    return value;
  }
  function str(value, fallback, limit, label) {
    if (value === undefined) return fallback;
    if (typeof value !== 'string') throw new Error(`${label}: ожидался текст.`);
    if (value.length > limit) throw new Error(`${label}: не больше ${limit.toLocaleString('ru')} символов.`);
    return value;
  }
  function choice(value, fallback, options, label) {
    if (value === undefined) return fallback;
    if (!options.includes(value)) throw new Error(`${label}: недопустимое значение.`);
    return value;
  }
  function number(value, fallback, min, max, step, label) {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || Math.abs(value / step - Math.round(value / step)) > 1e-8) throw new Error(`${label}: выберите число от ${min} до ${max}.`);
    return value;
  }
  function bool(value, fallback, label) {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') throw new Error(`${label}: ожидалось логическое значение.`);
    return value;
  }
  function image(value) {
    if (value === null || value === undefined) return null;
    object(value,'Иллюстрация');
    const src = str(value.src,'',10 * 1024 * 1024,'Иллюстрация');
    if (!/^data:image\/(?:png|jpeg|webp);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(src) || src.endsWith(',')) throw new Error('Иллюстрация должна быть встроенным изображением PNG, JPEG или WebP.');
    return {src,caption:str(value.caption,'',300,'Подпись к изображению')};
  }
  function normalize(input) {
    object(input,'Выпуск');
    if (input.format !== FORMAT) throw new Error('Это не файл Газетной мастерской. Откройте JSON, экспортированный этим редактором.');
    if (input.version !== 1) throw new Error('Эта версия файла пока не поддерживается.');
    const meta = object(input.meta,'Выходные данные'), settings = object(input.settings,'Оформление');
    if (!Array.isArray(input.articles) || input.articles.length > 200) throw new Error('Список материалов должен содержать не больше 200 записей.');
    const limits = {title:100,subtitle:200,city:100,date:100,issue:40,price:60};
    const result = {format:FORMAT,version:1,meta:{},settings:{},articles:[]};
    for (const key of Object.keys(metaDefaults)) result.meta[key] = str(meta[key],metaDefaults[key],limits[key],`Поле «${key}»`);
    result.settings = {
      columns:number(settings.columns,3,1,4,1,'Количество колонок'),
      fontSize:number(settings.fontSize,11,10,16,.5,'Размер текста'),
      paper:choice(settings.paper,'warm',['warm','white'],'Цвет бумаги'),
      format:choice(settings.format,'A4',['A4','A3'],'Формат бумаги'),
      ornaments:bool(settings.ornaments,true,'Виньетки')
    };
    const ids = new Set();
    result.articles = input.articles.map((raw, i) => {
      object(raw,`Материал ${i+1}`);
      let id = str(raw.id,'',100,'Идентификатор');
      if (!id || ids.has(id)) id = makeId();
      ids.add(id);
      return {
        id,
        type:choice(raw.type,'article',Object.keys(types),'Тип материала'),
        kicker:str(raw.kicker,'',100,'Рубрика'),
        title:str(raw.title,'',240,'Заголовок материала'),
        author:str(raw.author,'',160,'Автор'),
        html:sanitizeHTML(str(raw.html,'',100000,'Текст материала')),
        image:image(raw.image),
        span:number(raw.span,1,1,4,1,'Ширина материала'),
        align:choice(raw.align,'justify',['justify','left','center'],'Выравнивание'),
        dropcap:bool(raw.dropcap,false,'Буквица')
      };
    });
    if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_FILE) throw new Error('Выпуск больше 30 МБ. Уменьшите изображения или разделите материалы.');
    return result;
  }
  function createArticle(type = 'article') {
    if (!Object.hasOwn(types,type)) throw new Error('Неизвестный тип материала.');
    return {id:makeId(),type,kicker:type === 'ad' ? 'Частные объявления' : type === 'note' ? 'Городская хроника' : 'Из редакционной почты',title:types[type],author:'',html:'<p>Начните свою историю здесь…</p>',image:null,span:1,align:type === 'ad' ? 'center' : 'justify',dropcap:type === 'article'};
  }
  function createDefault() {
    const articles = [
      {
        "type": "article",
        "kicker": "Событие недели",
        "title": "Новая дорога —\nновые надежды",
        "author": "Эллиан д’Сивис, наш корреспондент",
        "html": "<p>На рассвете первый почтовый караван отправился из Таэр Валаэстаса к восточной границе. Проводить его собрались торговцы, ремесленники и любопытные горожане. Колокольный звон возвестил об открытии дороги, разговоры о которой занимали наши гостиные всю минувшую зиму.</p><p>Новый тракт соединит столицу с поселениями у подножия гор. Отныне письма достигнут самых отдалённых станций за три дня, а купцам не придётся делать долгий крюк через южные переправы.</p><blockquote><p>«Вместе с товарами по новому пути приходят добрые вести и новые истории».</p></blockquote><p>У первой заставы устроено почтовое отделение. Здесь путник найдёт свежих лошадей, горячий чай и последние известия. Дорожные мастера уверяют, что мосты выдержат и тяжёлые обозы, и весенний разлив.</p>",
        "image": null,
        "span": 2,
        "align": "justify",
        "dropcap": true
      },
      {
        "type": "note",
        "kicker": "Городская хроника",
        "title": "О фонарях и вечерних прогулках",
        "author": "",
        "html": "<p>На Соборной площади установлены двенадцать новых фонарей. Их ровный свет позволяет читать вывески даже в самый поздний час.</p><p>Городской совет обещает продолжить освещение до северных ворот. Владельцы лавок встретили перемену с одобрением: теперь посетителей принимают до девяти часов.</p>",
        "image": null,
        "span": 1,
        "align": "justify",
        "dropcap": false
      },
      {
        "type": "article",
        "kicker": "Письмо издалека",
        "title": "Весна в Серых горах",
        "author": "",
        "html": "<p>В предгорьях уже цветёт миндаль. Воздух прозрачен, снег виден лишь на дальних вершинах. По утрам звон пастушьих колокольчиков разносится над долиной.</p><p>На ярмарке торгуют шерстью, мёдом и глиняными кувшинами. Цены умеренные, приезжих встречают приветливо.</p>",
        "image": null,
        "span": 1,
        "align": "justify",
        "dropcap": true
      },
      {
        "type": "ad",
        "kicker": "Торговый дом",
        "title": "ЧАЙ И ПРЯНОСТИ",
        "author": "",
        "html": "<p><strong>У господина Фаррена</strong></p><p>Отборный кофе, душистый чай, корица и кардамон.</p><p><em>Постоянным покупателям — особая уступка.</em></p><p>Соборная площадь, дом № 7.</p>",
        "image": null,
        "span": 1,
        "align": "center",
        "dropcap": false
      },
      {
        "type": "note",
        "kicker": "Искусства и просвещение",
        "title": "Вечер в читальне",
        "author": "",
        "html": "<p>В четверг капитан Вельран прочтёт путевые записки о южных морях. Рассказ сопровождается показом карт и зарисовок автора.</p><p>Начало в семь часов. Вход свободный. Пожертвования пойдут на новые книги для городской библиотеки.</p>",
        "image": null,
        "span": 1,
        "align": "justify",
        "dropcap": false
      },
      {
        "type": "note",
        "kicker": "От редакции",
        "title": "Нашим читателям",
        "author": "",
        "html": "<p>Письма и воспоминания принимаются в конторе на Почтовой улице. Просим указывать имя и обратный адрес.</p>",
        "image": null,
        "span": 1,
        "align": "justify",
        "dropcap": false
      }
    ].map(fields => ({...createArticle(fields.type),...fields}));
    return {format:FORMAT,version:1,meta:{...metaDefaults},settings:{...settingDefaults},articles};
  }
  function toJSON(doc) { return JSON.stringify(normalize(doc),null,2); }
  function inlineMarkdown(node) {
    if (node.nodeType === 3) return node.textContent.replace(/([\\`*_\[\]])/g,'\\$1');
    if (node.nodeType !== 1) return '';
    const text = [...node.childNodes].map(inlineMarkdown).join('');
    if (['B','STRONG'].includes(node.tagName)) return `**${text}**`;
    if (['I','EM'].includes(node.tagName)) return `*${text}*`;
    if (node.tagName === 'BR') return '  \n';
    if (node.tagName === 'P') return `${text}\n\n`;
    if (node.tagName === 'BLOCKQUOTE') return `${text.trim().split('\n').map(line=>'> '+line).join('\n')}\n\n`;
    if (node.tagName === 'LI') return `- ${text.trim()}\n`;
    if (['UL','OL'].includes(node.tagName)) return `${text}\n`;
    return text;
  }
  function encodeBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let i=0;i<bytes.length;i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192));
    return btoa(binary);
  }
  function decodeBase64(text) {
    try {
      if (text.length > MAX_FILE * 1.4) throw new Error();
      const raw = atob(text);
      return new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(raw,c=>c.charCodeAt(0)));
    } catch { throw new Error('Повреждён снимок выпуска в Markdown.'); }
  }
  function toMarkdown(doc) {
    const clean = normalize(doc);
    const lines = [`# ${clean.meta.title.replace(/\r?\n/g,' ')}`, '',clean.meta.subtitle,'',`${clean.meta.city} · ${clean.meta.date} · ${clean.meta.issue} · ${clean.meta.price}`,''];
    for (const article of clean.articles) {
      const node = document.createElement('div'); node.innerHTML = article.html;
      lines.push(`## ${article.title.replace(/\r?\n/g,' ') || 'Без заголовка'}`, '',article.kicker ? `*${article.kicker}*\n` : '',inlineMarkdown(node).trim(),'');
      if (article.image) lines.push(`![${article.image.caption.replace(/[\[\]\r\n]/g,' ')}](${article.image.src})`,'');
      if (article.author) lines.push(`*${article.author}*`,'');
      lines.push('---','');
    }
    lines.push('<!-- Снимок ниже восстанавливает исходный выпуск целиком. Удалите комментарий со снимком, чтобы импортировать правки обычного Markdown. -->','',`<!-- ${SNAPSHOT}${encodeBase64(JSON.stringify(clean))} -->`,'');
    const markdown = lines.join('\n');
    if (new TextEncoder().encode(markdown).length > MAX_FILE) throw new Error('Markdown превышает 30 МБ из-за встроенных изображений. Скачайте выпуск в JSON.');
    return markdown;
  }
  function markdownInline(text) {
    return esc(text).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/__([^_]+)__/g,'<strong>$1</strong>').replace(/\*([^*]+)\*/g,'<em>$1</em>').replace(/_([^_]+)_/g,'<em>$1</em>');
  }
  function parseMarkdown(text) {
    const marker = text.match(/<!--\s*gazette-studio-snapshot-v1:([\s\S]*?)-->/);
    if (marker) {
      try { return normalize(JSON.parse(decodeBase64(marker[1].trim()))); }
      catch (error) { throw new Error(`Не удалось прочитать снимок Markdown. ${error.message}`); }
    }
    if (text.includes(SNAPSHOT)) throw new Error('Повреждён комментарий со снимком Markdown.');
    const doc = createDefault(); doc.articles = []; doc.meta.title = 'Импортированный выпуск';
    let article = null, paragraph = [], list = [], listType = '', html = [];
    const flushParagraph = () => { if (paragraph.length) { html.push(`<p>${markdownInline(paragraph.join(' '))}</p>`); paragraph = []; } };
    const flushList = () => { if (list.length) { html.push(`<${listType}>${list.map(line=>`<li>${markdownInline(line)}</li>`).join('')}</${listType}>`); list = []; } };
    const ensureArticle = () => { if (!article) { article = createArticle('article'); article.title = 'Из редакционной почты'; } };
    const flushArticle = () => {
      flushParagraph();flushList();
      if (article) {article.html = html.join('');doc.articles.push(article);}
      article = null;html = [];
    };
    for (const line of text.replace(/<!--[^]*?-->/g,'').replace(/\r\n?/g,'\n').split('\n')) {
      if (/^#\s+/.test(line)) {doc.meta.title = line.replace(/^#\s+/,'').trim();continue;}
      if (/^##\s+/.test(line)) {flushArticle();article=createArticle('article');article.title=line.replace(/^##\s+/,'').trim();continue;}
      if (!line.trim() || /^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {flushParagraph();flushList();continue;}
      ensureArticle();
      const img = line.match(/^!\[([^\]]*)\]\((data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+)\)$/);
      if (img) {flushParagraph();flushList();article.image={src:img[2],caption:img[1]};continue;}
      const item = line.match(/^\s*(?:[-*+]\s+|\d+\.\s+)(.+)$/);
      if (item) {flushParagraph();const nextType=/^\s*\d/.test(line)?'ol':'ul';if(listType!==nextType)flushList();listType=nextType;list.push(item[1]);continue;}
      flushList();
      if (/^>\s?/.test(line)) {flushParagraph();html.push(`<blockquote><p>${markdownInline(line.replace(/^>\s?/,''))}</p></blockquote>`);continue;}
      paragraph.push(line.replace(/^#{3,6}\s+/,''));
    }
    flushArticle();
    if (!doc.articles.length) throw new Error('В Markdown нет текста материалов. Используйте заголовки ## и абзацы.');
    return normalize(doc);
  }
  function parseFile(text, filename = 'issue.json') {
    if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_FILE) throw new Error('Файл должен быть текстовым и не больше 30 МБ.');
    text = text.replace(/^\uFEFF/,'');
    if (/\.(md|markdown)$/i.test(filename)) return parseMarkdown(text);
    if (!/\.json$/i.test(filename)) throw new Error('Выберите файл JSON или Markdown (.md).');
    let parsed;
    try {parsed = JSON.parse(text);} catch {throw new Error('Файл содержит некорректный JSON.');}
    return normalize(parsed);
  }
  function wordCount(doc) {
    const text = doc.articles.map(a=>a.title+' '+htmlToText(a.html)).join(' ');
    return (text.match(/[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu)||[]).length;
  }
  const api = {createDefault,createArticle,normalize,parseFile,toJSON,toMarkdown,sanitizeHTML,htmlToText,wordCount,makeId};
  root.GazetteDocument = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
