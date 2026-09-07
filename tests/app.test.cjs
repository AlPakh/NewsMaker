'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const root = path.resolve(__dirname, '..');

test('newspaper editor: real browser workflows', {timeout:180000}, async t => {
  const port = 4192;
  const server = spawn(process.execPath, ['scripts/serve.cjs'], {cwd:root,env:{...process.env,PORT:String(port)},windowsHide:true,stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject) => {server.stdout.once('data',resolve);server.once('error',reject);server.once('exit',code=>{if(code)reject(new Error(`Server exited: ${code}`));});});
  let browser;
  try {
    browser = await chromium.launch({headless:true,...(process.env.BROWSER_CHANNEL ? {channel:process.env.BROWSER_CHANNEL} : {})});
    const context = await browser.newContext({viewport:{width:1440,height:1050},deviceScaleFactor:1});
    const page = await context.newPage();
    const errors = [], remote = [];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith(`http://127.0.0.1:${port}/`))remote.push(r.url());});
    const url = `http://127.0.0.1:${port}/`;
    const ready = async () => {await page.waitForFunction(()=>window.GazetteApp);await page.evaluate(()=>GazetteApp.ready());};
    await page.goto(url); await ready();
    await fs.mkdir(path.join(root,'tmp'),{recursive:true});
    const original = await page.evaluate(()=>GazetteApp.getDocument());

    await t.test('document validation, safe HTML, JSON and Markdown round trips',async()=>{
      const checks=await page.evaluate(()=>{
        const d=GazetteDocument,doc=d.createDefault(),out={};
        doc.articles[0].html='<p>Русский <strong>жирный</strong> и <em>курсив</em> &amp; символы.</p>';
        doc.articles[0].image={src:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',caption:'Кириллица — ёж'};
        const normalized=d.normalize(doc);
        out.json=JSON.stringify(d.parseFile(d.toJSON(doc),'газета.json'))===JSON.stringify(normalized);
        out.markdown=JSON.stringify(d.parseFile(d.toMarkdown(doc),'газета.md'))===JSON.stringify(normalized);
        const plain=d.parseFile('# Мой выпуск\n\n## Первая новость\n\n**Важное** событие.\n\n- Один\n- Два\n\n> Цитата\n\n## Вторая новость\n\nТекст.','note.md');
        out.plain=plain.meta.title==='Мой выпуск'&&plain.articles.length===2&&plain.articles[0].html.includes('<strong>Важное</strong>')&&plain.articles[0].html.includes('<ul>');
        const html=d.sanitizeHTML('<p onclick="alert(1)">Текст<script>alert(1)</script><img src=x onerror=alert(1)><svg onload=alert(1)><text>BAD</text></svg><a href="javascript:alert(1)">ссылка</a><b style="color:red">жирный</b></p>');
        out.safe=!/script|onclick|onerror|svg|javascript|style=|<img/.test(html)&&html.includes('<b>жирный</b>');
        out.rejected=[];
        for(const change of [x=>x.version=2,x=>x.settings.columns='3',x=>x.settings.fontSize=500,x=>x.articles[0].image.src='javascript:alert(1)',x=>x.articles[0].image.src='data:image/svg+xml;base64,PHN2Zz4=',x=>x.articles[0].title={text:'bad'}]){
          const bad=JSON.parse(JSON.stringify(doc));change(bad);try{d.normalize(bad);out.rejected.push(false)}catch{out.rejected.push(true)}
        }
        const duplicate=JSON.parse(JSON.stringify(doc));duplicate.articles[1].id=duplicate.articles[0].id;
        const repaired=d.normalize(duplicate);out.unique=new Set(repaired.articles.map(a=>a.id)).size===repaired.articles.length;
        return out;
      });
      assert.equal(checks.json,true);assert.equal(checks.markdown,true);assert.equal(checks.plain,true);assert.equal(checks.safe,true);assert.equal(checks.unique,true);assert.ok(checks.rejected.every(Boolean));
    });

    await t.test('desktop renders without external requests or clipping', async()=>{
      assert.equal(original.articles.length,6);
      assert.equal(await page.locator('.news-article').count(),6);
      const problems=await page.evaluate(()=>[...document.querySelectorAll('.news-article')].filter(n=>n.offsetTop+n.offsetHeight>n.parentElement.clientHeight+1).map(n=>n.textContent));
      assert.deepEqual(problems,[]);assert.deepEqual(remote,[]);assert.deepEqual(errors,[]);
      await page.screenshot({path:path.join(root,'tmp/desktop.png'),fullPage:true});
    });
    await t.test('edit text formatting, duplicate, reorder, undo and redo',async()=>{
      await page.locator('.article-open').first().click();
      await page.locator('#article-title').fill('Новый заголовок для проверки');
      await page.locator('#article-body').fill('Начало новости. Конец новости.');
      await page.evaluate(()=>{const n=document.getElementById('article-body');const r=document.createRange();r.selectNodeContents(n);getSelection().removeAllRanges();getSelection().addRange(r);});
      await page.locator('[data-format="bold"]').click();
      await page.getByRole('button',{name:'Применить',exact:true}).click();await ready();
      assert.match(await page.evaluate(()=>GazetteApp.getDocument().articles[0].html),/<(?:b|strong)>/);
      assert.equal(await page.locator('.news-article h3').first().textContent(),'Новый заголовок для проверки');
      await page.locator('[data-action="duplicate"]').first().click();
      assert.equal(await page.locator('.article-item').count(),7);
      await page.locator('.article-item').nth(1).locator('[data-action="up"]').click();
      assert.match(await page.evaluate(()=>GazetteApp.getDocument().articles[0].title),/копия/);
      await page.locator('#undo-button').click();await page.locator('#undo-button').click();
      assert.equal(await page.locator('.article-item').count(),6);
      await page.locator('#redo-button').click();assert.equal(await page.locator('.article-item').count(),7);
      await page.locator('#undo-button').click();
    });
    await t.test('JSON download, replace confirmation, lossless reimport',async()=>{
      const snapshot=await page.evaluate(()=>GazetteApp.getDocument());
      await page.locator('#export-button').click();
      const downloaded=page.waitForEvent('download');await page.locator('#download-json').click();
      const file=await downloaded; const filePath=path.join(root,'tmp/roundtrip.json'); await file.saveAs(filePath);
      assert.deepEqual(JSON.parse(await fs.readFile(filePath,'utf8')),snapshot);
      await page.locator('#export-dialog [data-close]').click();
      await page.locator('#meta-title').fill('Временный заголовок');
      await page.locator('#import-file').setInputFiles(filePath);
      await page.locator('#confirm-button').click();await ready();
      assert.deepEqual(await page.evaluate(()=>GazetteApp.getDocument()),snapshot);
      await page.locator('#meta-city').fill('Проверочный город');await page.waitForTimeout(500);
      await page.reload();await ready();
      assert.equal(await page.locator('#meta-city').inputValue(),'Проверочный город');
    });
    await t.test('bad import preserves current issue',async()=>{
      const before=await page.evaluate(()=>GazetteApp.getDocument());
      await page.locator('#import-file').setInputFiles({name:'broken.json',mimeType:'application/json',buffer:Buffer.from('{broken')});
      await page.waitForFunction(()=>document.getElementById('toast').textContent.includes('Не удалось открыть'));
      assert.deepEqual(await page.evaluate(()=>GazetteApp.getDocument()),before);
      assert.equal(await page.locator('#confirm-dialog').evaluate(n=>n.open),false);
    });
    await t.test('long styled article continues with all text and author intact',async()=>{
      const result=await page.evaluate(async()=>{
        const doc=GazetteDocument.createDefault();doc.articles=[GazetteDocument.createArticle('article')];
        doc.articles[0].title='Длинная история';doc.articles[0].span=1;doc.articles[0].author='Единственный автор';
        doc.articles[0].html='<p>'+Array.from({length:1800},(_,i)=>`слово${i} `).join('')+'<strong>ПОСЛЕДНЯЯ СТРОКА</strong></p>';
        const holder=document.createElement('div');document.body.append(holder);
        const result=await GazettePagination.render(doc,holder);
        const text=[...holder.querySelectorAll('.article-text')].map(n=>n.textContent).join('');
        const problems=[...holder.querySelectorAll('.news-article')].filter(n=>n.offsetTop+n.offsetHeight>n.parentElement.clientHeight+1).length;
        const out={pages:result.count,words:text.match(/слово\d+/g)?.length,last:text.includes('ПОСЛЕДНЯЯ СТРОКА'),authors:holder.querySelectorAll('.news-author').length,problems};
        holder.remove();return out;
      });
      assert.ok(result.pages>1 && result.pages<10);assert.equal(result.words,1800);assert.equal(result.last,true);assert.equal(result.authors,1);assert.equal(result.problems,0);
    });
    await t.test('mobile layouts at 320, 390, 768 pixels and readable editing',async()=>{
      for(const width of [320,390,768]){
        await page.setViewportSize({width,height:844});await page.waitForTimeout(80);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`overflow at ${width}`);
        await page.locator('button[data-view="materials"]').click();
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`materials overflow at ${width}`);
        await page.locator('.article-open').first().click();
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`dialog overflow at ${width}`);
        assert.ok(await page.locator('#article-title').isVisible());
        const size=await page.locator('#article-body').evaluate(n=>parseFloat(getComputedStyle(n).fontSize));assert.ok(size>=16);
        if(width===390)await page.screenshot({path:path.join(root,'tmp/mobile-editor.png'),fullPage:true});
        await page.locator('#editor-dialog [aria-label="Закрыть редактор"]').click();
        await page.locator('button[data-view="settings"]').click();
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`settings overflow at ${width}`);
        assert.ok(await page.locator('#meta-title').isVisible());
        await page.locator('button[data-view="preview"]').click();
        if(width===390)await page.screenshot({path:path.join(root,'tmp/mobile.png'),fullPage:true});
      }
    });
    await t.test('downloadable PDF and native print PDF',async()=>{
      await page.setViewportSize({width:1440,height:1050});
      await page.locator('#import-file').setInputFiles({name:'original.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(original))});
      await page.locator('#confirm-button').click();await ready();
      await page.pdf({path:path.join(root,'tmp/print.pdf'),preferCSSPageSize:true,printBackground:true,displayHeaderFooter:false});
      await page.locator('#export-button').click();
      const downloaded=page.waitForEvent('download',{timeout:60000});await page.locator('#download-pdf').click();
      const file=await downloaded;await file.saveAs(path.join(root,'tmp/export.pdf'));
      const buffer=await fs.readFile(path.join(root,'tmp/export.pdf'));assert.equal(buffer.subarray(0,5).toString(),'%PDF-');assert.ok(buffer.length>40000);
      assert.equal(await page.locator('#pdf-ready').isVisible(),true);
      assert.deepEqual(errors,[]);
    });
    await t.test('opens directly from disk with no server',async()=>{
      const {pathToFileURL}=require('node:url');
      const local=await context.newPage();const localErrors=[];local.on('pageerror',e=>localErrors.push(e.message));
      await local.goto(pathToFileURL(path.join(root,'index.html')).href);await local.waitForFunction(()=>window.GazetteApp);await local.evaluate(()=>GazetteApp.ready());
      assert.equal(await local.locator('.news-article').count(),6);assert.deepEqual(localErrors,[]);
      await local.close();
    });
    await t.test('image editing, Markdown file reimport, A3 and four columns',async()=>{
      await page.locator('#export-dialog [data-close]').click();
      await page.locator('.article-open').last().click();
      const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=160;c.height=80;const g=c.getContext('2d');g.fillStyle='#c33830';g.fillRect(0,0,80,80);g.fillStyle='#2049ba';g.fillRect(80,0,80,80);return c.toDataURL().split(',')[1]});
      await page.locator('#image-file').setInputFiles({name:'illustration.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
      await page.waitForFunction(()=>!document.querySelector('#article-form [type="submit"]').disabled);
      await page.locator('.image-details summary').click();
      await page.locator('#image-caption').fill('Проверочная иллюстрация');
      await page.getByRole('button',{name:'Применить',exact:true}).click();await ready();
      const snapshot=await page.evaluate(()=>GazetteApp.getDocument());assert.ok(snapshot.articles.at(-1).image.src.startsWith('data:image/jpeg;base64,'));
      await page.locator('#export-button').click();const pending=page.waitForEvent('download');await page.locator('#download-md').click();const file=await pending;
      const mdPath=path.join(root,'tmp/roundtrip.md');await file.saveAs(mdPath);await page.locator('#export-dialog [data-close]').click();
      await page.locator('#import-file').setInputFiles(mdPath);await page.locator('#confirm-button').click();await ready();
      assert.deepEqual(await page.evaluate(()=>GazetteApp.getDocument()),snapshot);
      await page.locator('#page-format').selectOption('A3');await page.locator('[data-columns="4"]').click();await ready();
      const dimensions=await page.locator('.newspaper').first().evaluate(n=>({w:n.offsetWidth,h:n.offsetHeight}));assert.ok(Math.abs(dimensions.w-1123)<2);assert.ok(Math.abs(dimensions.h-1587)<2);
      await page.pdf({path:path.join(root,'tmp/print-a3.pdf'),preferCSSPageSize:true,printBackground:true});
      await page.setViewportSize({width:390,height:844});await page.locator('#export-button').click();
      const downloaded=page.waitForEvent('download',{timeout:60000});await page.locator('#download-pdf').click();const pdf=await downloaded;await pdf.saveAs(path.join(root,'tmp/export-a3-image.pdf'));
      assert.deepEqual(errors,[]);
    });
  } finally {await browser?.close();server.kill();}
});
