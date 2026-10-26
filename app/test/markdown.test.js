'use strict';

/**
 * The renderer takes model output - text written by something that has read the
 * user's files - and turns it into markup in the same process as the IDE. These
 * tests are therefore mostly adversarial: they check that nothing in the input
 * can produce a tag, an attribute or a URL that the renderer did not choose.
 *
 * The module under test is the window's own copy, imported dynamically because
 * it is an ES module (the renderer directory carries `{"type":"module"}` so Node
 * resolves it the same way the browser does). One implementation, tested where
 * it runs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const MODULE = '../src/renderer/js/markdown.js';

test('the markdown renderer', async (t) => {
  const { escapeHtml, renderInline, renderMarkdown, toPlainText } = await import(MODULE);

  await t.test('html in the input is text, not markup', () => {
    assert.equal(escapeHtml('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    assert.equal(html.includes('<img'), false);
    assert.equal(html.includes('&lt;img'), true);
  });

  await t.test('a script tag cannot survive a code fence', () => {
    const html = renderMarkdown('```html\n<script>alert(1)</script>\n```');
    assert.equal(html.includes('<script>'), false);
    assert.equal(html.includes('&lt;script&gt;'), true);
    assert.match(html, /data-lang="html"/);
  });

  await t.test('only http, https and mailto become links', () => {
    assert.match(renderMarkdown('[a](https://example.com/x)'), /href="https:\/\/example.com\/x"/);
    assert.equal(renderMarkdown('[click](javascript:alert(1))').includes('href'), false);
    assert.equal(renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)').includes('href'), false);
  });

  await t.test('an unterminated fence still renders, because streams get cut off', () => {
    const html = renderMarkdown('```js\nconst a = 1;');
    assert.match(html, /<pre class="code" data-lang="js">/);
    assert.match(html, /const a = 1;/);
  });

  await t.test('markup inside a code span stays literal', () => {
    const html = renderInline('use `**not bold**` here');
    assert.equal(html.includes('<strong>'), false);
    assert.equal(html.includes('<code>**not bold**</code>'), true);
  });

  await t.test('emphasis, headings, lists, quotes and rules render', () => {
    assert.match(renderMarkdown('**bold**'), /<strong>bold<\/strong>/);
    assert.match(renderMarkdown('*italic*'), /<em>italic<\/em>/);
    assert.match(renderMarkdown('~~gone~~'), /<del>gone<\/del>/);
    assert.match(renderMarkdown('## Title'), /<h2>Title<\/h2>/);
    assert.match(renderMarkdown('- one\n- two'), /<ul><li class="bullet" data-depth="0">one<\/li>/);
    assert.match(renderMarkdown('1. first\n2. second'), /<ol><li data-depth="0">first<\/li>/);
    assert.match(renderMarkdown('> quoted'), /<blockquote><p>quoted<\/p><\/blockquote>/);
    assert.match(renderMarkdown('---'), /<hr>/);
  });

  await t.test('nested list items carry their depth', () => {
    assert.match(renderMarkdown('- one\n  - nested'), /data-depth="1"/);
  });

  await t.test('paragraphs split on blank lines and keep single newlines as breaks', () => {
    const html = renderMarkdown('first line\nsecond line\n\nnew paragraph');
    assert.equal(html.includes('first line<br>second line'), true);
    assert.equal(html.match(/<p>/g).length, 2);
  });

  await t.test('plain text extraction strips the markup for titles and tooltips', () => {
    assert.equal(toPlainText('# Title\n\n**bold** `code` [link](https://x.y)'), 'Title bold code link');
    assert.equal(toPlainText('x'.repeat(200)).length, 121);
    assert.equal(toPlainText(''), '');
  });

  await t.test('empty and undefined input render as nothing, not as "undefined"', () => {
    assert.equal(renderMarkdown(''), '');
    assert.equal(renderMarkdown(undefined), '');
    assert.equal(renderMarkdown(null), '');
  });
});