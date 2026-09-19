// tests/api/pages.test.js — src/api/pages.js: the server-rendered SEO shell (GET /, GET /:lang/,
// GET /sitemap.xml). Uses the real public/index.html and public/i18n/*.json files (no fixtures) for
// everything except the mtime-cache-invalidation test, which points the module at a throwaway temp
// file via _setPathsForTests() so it never touches the real tree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SUPPORTED } from '../../src/lib/languages.js';
import { _setPathsForTests } from '../../src/api/pages.js';
import { buildTestApp } from './helpers.js';

function hreflangLinks(html) {
  return [...html.matchAll(/<link rel="alternate" href="([^"]*)" hreflang="([^"]*)"[^>]*>/g)]
    .map((m) => ({ href: m[1], hreflang: m[2] }));
}

test('GET /: 200, x-default shell in English by default, canonical stays "/"', async () => {
  const app = buildTestApp({});
  const res = await app.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.equal(res.headers['content-language'], 'en');
  assert.equal(res.headers['vary'], 'Accept-Language');
  assert.equal(res.headers['cache-control'], 'public, max-age=600');

  assert.match(res.body, /<html lang="en">/);
  assert.match(res.body, /<title>[^<]+<\/title>/);
  assert.match(res.body, /<meta name="description" content="[^"]+">/);
  assert.match(res.body, /<link rel="canonical" href="https:\/\/gamegauntlets\.com\/" \/>/);
  assert.ok(res.body.includes('<base href="/">'));
});

test('GET /: x-default picks the language from Accept-Language but canonical stays "/"', async () => {
  const app = buildTestApp({});
  const res = await app.inject({ method: 'GET', url: '/', headers: { 'accept-language': 'ja,en;q=0.5' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-language'], 'ja');
  assert.match(res.body, /<html lang="ja">/);
  assert.match(res.body, /<link rel="canonical" href="https:\/\/gamegauntlets\.com\/" \/>/);
  // og:url should also stay "/" for the x-default page, mirroring canonical.
  assert.match(res.body, /<meta property="og:url" content="https:\/\/gamegauntlets\.com\/" \/>/);
});

for (const lang of SUPPORTED) {
  test(`GET /${lang}/: 200 with its own title/description/lang/canonical`, async () => {
    const app = buildTestApp({});
    const en = await app.inject({ method: 'GET', url: '/en/' });
    const res = lang === 'en' ? en : await app.inject({ method: 'GET', url: `/${lang}/` });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-language'], lang);
    assert.equal(res.headers['cache-control'], 'public, max-age=600');
    assert.match(res.body, new RegExp(`<html lang="${lang}">`));
    assert.match(res.body, new RegExp(`<link rel="canonical" href="https://gamegauntlets\\.com/${lang}/" />`));
    assert.match(res.body, new RegExp(`<meta property="og:url" content="https://gamegauntlets\\.com/${lang}/" />`));

    const title = res.body.match(/<title>([^<]+)<\/title>/)[1];
    const description = res.body.match(/<meta name="description" content="([^"]+)">/)[1];
    assert.ok(title.length > 0);
    assert.ok(description.length > 0);
    if (lang !== 'en') {
      const enTitle = en.body.match(/<title>([^<]+)<\/title>/)[1];
      const enDescription = en.body.match(/<meta name="description" content="([^"]+)">/)[1];
      assert.notEqual(title, enTitle, `${lang} title should differ from English`);
      assert.notEqual(description, enDescription, `${lang} description should differ from English`);
    }
  });
}

test('GET /:lang/: full reciprocal hreflang set is present and identical across every language shell', async () => {
  const app = buildTestApp({});
  const root = await app.inject({ method: 'GET', url: '/' });
  const rootLinks = hreflangLinks(root.body);

  // x-default + 13 languages.
  assert.equal(rootLinks.length, 14);
  assert.ok(rootLinks.some((l) => l.hreflang === 'x-default' && l.href === 'https://gamegauntlets.com/'));
  for (const lang of SUPPORTED) {
    const expectedTag = lang === 'zh' ? 'zh-Hans' : lang;
    assert.ok(
      rootLinks.some((l) => l.hreflang === expectedTag && l.href === `https://gamegauntlets.com/${lang}/`),
      `missing hreflang for ${lang}`,
    );
  }

  for (const lang of SUPPORTED) {
    const res = await app.inject({ method: 'GET', url: `/${lang}/` });
    assert.deepEqual(hreflangLinks(res.body), rootLinks, `hreflang set differs on /${lang}/`);
  }
});

test('GET /:lang/: og:locale is the page language, og:locale:alternate lists the other 12', async () => {
  const app = buildTestApp({});
  const res = await app.inject({ method: 'GET', url: '/ja/' });
  assert.match(res.body, /<meta property="og:locale" content="ja_JP" \/>/);
  const alternates = [...res.body.matchAll(/<meta property="og:locale:alternate" content="([^"]*)" \/>/g)].map((m) => m[1]);
  assert.equal(alternates.length, 12);
  assert.ok(!alternates.includes('ja_JP'));
  assert.ok(alternates.includes('en_US'));
  assert.ok(alternates.includes('zh_CN'));
});

test('GET /:lang/: unsupported language code is a 404', async () => {
  const app = buildTestApp({});
  const res = await app.inject({ method: 'GET', url: '/xx/' });
  assert.equal(res.statusCode, 404);
});

test('GET /:lang (no trailing slash): redirects to /:lang/, unsupported code is still a 404', async () => {
  const app = buildTestApp({});
  const ok = await app.inject({ method: 'GET', url: '/en' });
  assert.equal(ok.statusCode, 301);
  assert.equal(ok.headers.location, '/en/');

  const bad = await app.inject({ method: 'GET', url: '/xx' });
  assert.equal(bad.statusCode, 404);
});

test('GET /:lang/: <base href="/"> is present so relative asset URLs keep working under a sub-path', async () => {
  const app = buildTestApp({});
  const res = await app.inject({ method: 'GET', url: '/de/' });
  assert.ok(res.body.includes('<base href="/">'));
});

test('GET /:lang/: JSON-LD block stays valid JSON and carries the localized name/description/inLanguage', async () => {
  const app = buildTestApp({});
  const res = await app.inject({ method: 'GET', url: '/ru/' });
  const match = res.body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(match);
  const data = JSON.parse(match[1]);
  assert.equal(data['@type'], 'VideoObject');
  assert.equal(data.inLanguage, 'ru');
  assert.equal(typeof data.name, 'string');
  assert.equal(typeof data.description, 'string');
  // Untouched fields survive the round-trip.
  assert.equal(data.publisher.name, 'Hepega Team');
  assert.equal(data.contentUrl, 'https://gamegauntlets.com/img/sgg.mp4');
});

test('GET /:lang/: the noscript fallback block carries the same localized title/description', async () => {
  const app = buildTestApp({});
  const res = await app.inject({ method: 'GET', url: '/fr/' });
  const block = res.body.match(/<div id="seo-noscript">([\s\S]*?)<\/div>/)[1];
  const title = res.body.match(/<title>([^<]+)<\/title>/)[1];
  const description = res.body.match(/<meta name="description" content="([^"]+)">/)[1];
  assert.ok(block.includes(`<h1>${title}</h1>`));
  assert.ok(block.includes(description));
});

test('GET /sitemap.xml: lists all 14 URLs, each with the full hreflang alternate set', async () => {
  const app = buildTestApp({});
  const res = await app.inject({ method: 'GET', url: '/sitemap.xml' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /application\/xml/);

  const locs = [...res.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.equal(locs.length, 14);
  assert.ok(locs.includes('https://gamegauntlets.com/'));
  for (const lang of SUPPORTED) assert.ok(locs.includes(`https://gamegauntlets.com/${lang}/`));

  const firstUrlBlock = res.body.split('<url>')[1];
  const altCount = (firstUrlBlock.match(/<xhtml:link rel="alternate"/g) || []).length;
  assert.equal(altCount, 14);
});

test('public/i18n key-set test still green (seo.* / intro.* keys added to every language, same order)', async () => {
  // Re-run of tests/frontend/i18n.test.js's own assertion, scoped to the keys this task added, so a
  // regression here fails fast in this file too.
  const dir = path.join(process.cwd(), 'public/i18n');
  const en = JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8'));
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'en.json')) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    assert.deepEqual(Object.keys(data), Object.keys(en), file);
    assert.ok(data['seo.title'], `${file} missing seo.title`);
    assert.ok(data['seo.description'], `${file} missing seo.description`);
  }
});

test('cache re-reads public/index.html when its mtime changes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-pages-test-'));
  const indexHtmlPath = path.join(dir, 'index.html');
  const i18nDir = path.join(dir, 'i18n');
  fs.mkdirSync(i18nDir);

  // "marker" sits outside anything renderShell() ever rewrites (title/description/etc. all come
  // from the i18n dict, which stays constant across the two writes below) -- it only changes if the
  // module actually re-reads the file off disk instead of serving the cached copy.
  function html(marker) {
    return [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="utf-8">',
      '<title>placeholder</title>',
      '<meta name="description" content="placeholder">',
      '<meta name="application-name" content="placeholder">',
      '<meta name="msapplication-tooltip" content="placeholder">',
      '<meta property="og:title" content="placeholder" />',
      '<meta property="og:description" content="placeholder">',
      '<meta property="og:url" content="https://gamegauntlets.com/" />',
      '<!-- BEGIN og:locale -->',
      '<meta property="og:locale" content="en_US" />',
      '<!-- END og:locale -->',
      '<meta name="twitter:title" content="placeholder">',
      '<meta name="twitter:description" content="placeholder">',
      '<link rel="canonical" href="https://gamegauntlets.com/" />',
      '<script type="application/ld+json">{"@type":"VideoObject","name":"placeholder","description":"placeholder"}</script>',
      '</head>',
      '<body>',
      `<div id="marker">${marker}</div>`,
      '<div id="seo-noscript"><h1>placeholder</h1><p>placeholder</p></div>',
      '</body>',
      '</html>',
      '',
    ].join('\n');
  }

  fs.writeFileSync(indexHtmlPath, html('A'));
  fs.writeFileSync(
    path.join(i18nDir, 'en.json'),
    JSON.stringify({ 'seo.title': 'EN title', 'seo.description': 'EN desc', 'seo.ogTitle': 'EN og' }),
  );

  _setPathsForTests({ indexHtmlPath, i18nDir });
  t.after(() => {
    _setPathsForTests({
      indexHtmlPath: path.join(process.cwd(), 'public/index.html'),
      i18nDir: path.join(process.cwd(), 'public/i18n'),
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const app = buildTestApp({});
  const first = await app.inject({ method: 'GET', url: '/' });
  assert.match(first.body, /<div id="marker">A<\/div>/);
  assert.match(first.body, /<title>EN title<\/title>/); // i18n override still applied on top

  // Bump mtime forward explicitly in case the filesystem's mtime resolution is coarser than this
  // test's runtime.
  fs.writeFileSync(indexHtmlPath, html('B'));
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(indexHtmlPath, future, future);

  const second = await app.inject({ method: 'GET', url: '/' });
  assert.match(second.body, /<div id="marker">B<\/div>/);
});
