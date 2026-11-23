// Fast drop-in static site generator for makefun-site 1.0.0
// Ultra-optimized FastSite v5:
// 1. Direct compiled templates with inlined child includes & direct property lookups
// 2. Fused single-pass Markdown parser (zero intermediate token objects)
// 3. Fast ASCII character code scanning for lines, headings, blanks and dates
// 4. Memoized card representations & zero redundant word count calculations
// 5. Linear HTML escaper without regex overhead

import { parseFrontMatter } from './vendor/makefun-site/lib/frontmatter.js';
import { parseTemplate, TemplateError } from './vendor/makefun-site/lib/template.js';
import { slugify, uniqueSlug } from './vendor/makefun-site/lib/text.js';

const REPORT_FILE = 'build-report.txt';
const RESERVED = Object.freeze(['posts', 'tags', 'page']);
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const TRIGGER_REGEX = /[\\`*\[&<>"']/;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function fastLongDate(date) {
  const y = date.slice(0, 4);
  const m = (date.charCodeAt(5) - 48) * 10 + (date.charCodeAt(6) - 48);
  const d = (date.charCodeAt(8) - 48) * 10 + (date.charCodeAt(9) - 48);
  return d + ' ' + MONTHS[m - 1] + ' ' + y;
}

function fastEscape(text) {
  if (text === '') return '';
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function wordsOfFast(text) {
  let count = 0;
  let inWord = false;
  const len = text.length;
  for (let i = 0; i < len; i++) {
    const c = text.charCodeAt(i);
    if (c > 32 && c !== 160) {
      if (!inWord) {
        inWord = true;
        count++;
      }
    } else {
      inWord = false;
    }
  }
  return count;
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function isBlankFast(line) {
  const len = line.length;
  for (let i = 0; i < len; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimFast(line) {
  let start = 0;
  const len = line.length;
  while (start < len && (line.charCodeAt(start) === 32 || line.charCodeAt(start) === 9)) start++;
  if (start === len) return '';
  let end = len - 1;
  while (end > start && (line.charCodeAt(end) === 32 || line.charCodeAt(end) === 9)) end--;
  return start === 0 && end === len - 1 ? line : line.slice(start, end + 1);
}

// Fast Markdown Parser
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const QUOTE = /^>/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

function endsParagraph(line) {
  return isBlankFast(line) || FENCE_OPEN.test(line) || headingOf(line) !== null || HR.test(line);
}

function findUnescapedFast(s, what, from) {
  const whatLen = what.length;
  const max = s.length - whatLen;
  for (let j = from; j <= max; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStarFast(s, from) {
  const len = s.length;
  for (let j = from; j < len; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < len && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

function fastInline(s, env) {
  if (!TRIGGER_REGEX.test(s)) return s;

  let out = '';
  let i = 0;
  const len = s.length;
  let normalStart = 0;

  while (i < len) {
    const c = s[i];

    if (c === '\\' && i + 1 < len && ESCAPABLE.has(s[i + 1])) {
      if (i > normalStart) out += fastEscape(s.slice(normalStart, i));
      out += fastEscape(s[i + 1]);
      i += 2;
      normalStart = i;
      continue;
    }

    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > normalStart) out += fastEscape(s.slice(normalStart, i));
        out += `<code>${fastEscape(s.slice(i + 1, j))}</code>`;
        i = j + 1;
        normalStart = i;
      } else {
        i++;
      }
      continue;
    }

    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescapedFast(s, '**', i + 2);
        if (j > i + 2) {
          if (i > normalStart) out += fastEscape(s.slice(normalStart, i));
          out += `<strong>${fastInline(s.slice(i + 2, j), env)}</strong>`;
          i = j + 2;
          normalStart = i;
        } else {
          i += 2;
        }
        continue;
      }
      const j = findSingleStarFast(s, i + 1);
      if (j > i + 1) {
        if (i > normalStart) out += fastEscape(s.slice(normalStart, i));
        out += `<em>${fastInline(s.slice(i + 1, j), env)}</em>`;
        i = j + 1;
        normalStart = i;
      } else {
        i++;
      }
      continue;
    }

    if (c === '[') {
      const k = findUnescapedFast(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        if (i > normalStart) out += fastEscape(s.slice(normalStart, i));
        out += `<a href="${fastEscape(env.link(target))}">${fastInline(s.slice(i + 1, k), env)}</a>`;
        i = m + 1;
        normalStart = i;
        continue;
      }
      i++;
      continue;
    }

    i++;
  }

  if (normalStart < len) {
    out += fastEscape(s.slice(normalStart));
  }
  return out;
}

// Fused Single-Pass Markdown Renderer
function renderMarkdownFast(src, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const lines = src.split('\n');
  const len = lines.length;
  let i = 0;

  while (i < len) {
    const line = lines[i];
    if (isBlankFast(line)) {
      i++;
      continue;
    }

    const fence = FENCE_OPEN.exec(line);
    if (fence !== null) {
      const body = [];
      i++;
      while (i < len && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
      i++;
      const cls = fence[1] === '' ? '' : ` class="language-${fastEscape(fence[1])}"`;
      blocks.push(`<pre><code${cls}>${body.map((l) => `${fastEscape(l)}\n`).join('')}</code></pre>`);
      continue;
    }

    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = fastInline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }

    if (HR.test(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body = [];
      while (i < len && QUOTE.test(lines[i])) body.push(lines[i++].replace(/^> ?/, ''));
      const quoteLines = body.map(trimFast).filter((l) => l !== '');
      blocks.push(quoteLines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${fastInline(quoteLines.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = bullet === null ? ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const items = [];
      while (i < len) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimFast(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (CONTINUED.test(lines[i])) {
          items[items.length - 1].push(trimFast(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered[1] !== '1' ? `<ol start="${ordered[1]}">` : `<${tag}>`;
      blocks.push(`${open}\n${items.map((parts) => `<li>${fastInline(parts.join('\n'), env)}</li>\n`).join('')}</${tag}>`);
      continue;
    }

    const body = [trimFast(line)];
    i++;
    while (i < len && !endsParagraph(lines[i])) body.push(trimFast(lines[i++]));
    const html = fastInline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }

  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// Fast Template Engine & JIT Compiler
function lookupFast(scope, path) {
  let s = scope;
  const p0 = path[0];
  while (s !== null && !Object.hasOwn(s.vars, p0)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[p0];
  const pLen = path.length;
  for (let k = 1; k < pLen; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOfFast(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOfFast).join(', ');
  return '';
}

function truthyFast(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function inlineTemplateIncludes(nodes, templates, depth = 0) {
  const res = [];
  for (const n of nodes) {
    if (n.kind === 'include') {
      const sub = templates.get(n.name);
      if (sub && depth < 8) {
        res.push(...inlineTemplateIncludes(sub, templates, depth + 1));
      } else {
        res.push(n);
      }
    } else if (n.kind === 'if') {
      res.push({
        ...n,
        then: inlineTemplateIncludes(n.then, templates, depth),
        else: n.else ? inlineTemplateIncludes(n.else, templates, depth) : null,
      });
    } else if (n.kind === 'for') {
      res.push({
        ...n,
        body: inlineTemplateIncludes(n.body, templates, depth),
      });
    } else {
      res.push(n);
    }
  }
  return res;
}

function compileAST(nodes) {
  let code = '';
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    switch (n.kind) {
      case 'text':
        code += `out += ${JSON.stringify(n.text)};\n`;
        break;
      case 'var':
        code += `out += escape(textOf(lookup(scope, ${JSON.stringify(n.path)})));\n`;
        break;
      case 'raw':
        code += `out += textOf(lookup(scope, ${JSON.stringify(n.path)}));\n`;
        break;
      case 'if': {
        const cond = n.not
          ? `!truthy(lookup(scope, ${JSON.stringify(n.path)}))`
          : `truthy(lookup(scope, ${JSON.stringify(n.path)}))`;
        code += `if (${cond}) {\n`;
        code += compileAST(n.then);
        if (n.else !== null) {
          code += `} else {\n`;
          code += compileAST(n.else);
        }
        code += `}\n`;
        break;
      }
      case 'for': {
        code += `{\n`;
        code += `  const xs = lookup(scope, ${JSON.stringify(n.path)});\n`;
        code += `  if (Array.isArray(xs)) {\n`;
        code += `    const len = xs.length;\n`;
        code += `    for (let k = 0; k < len; k++) {\n`;
        code += `      const scope2 = { vars: { ${JSON.stringify(n.name)}: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } }, parent: scope };\n`;
        code += `      {\n`;
        code += `        const scope = scope2;\n`;
        code += compileAST(n.body);
        code += `      }\n`;
        code += `    }\n`;
        code += `  }\n`;
        code += `}\n`;
        break;
      }
      case 'include': {
        code += `if (depth < 8) {\n`;
        code += `  const fn = compiled.get(${JSON.stringify(n.name)});\n`;
        code += `  if (fn !== undefined) out += fn(scope, compiled, escape, textOf, lookup, truthy, depth + 1);\n`;
        code += `}\n`;
        break;
      }
    }
  }
  return code;
}

function makeCompiledTemplate(nodes) {
  const body = `let out = "";\n` + compileAST(nodes) + `return out;\n`;
  return new Function('scope', 'compiled', 'escape', 'textOf', 'lookup', 'truthy', 'depth', body);
}

const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : fastLongDate(s.data.date) });
const tagOf = (b, t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });

function createCard(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : fastLongDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOfFast(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

export function buildFast(input) {
  const parsedMap = new Map();
  const report = [];
  const tplKeys = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of tplKeys) {
    try {
      parsedMap.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const compiled = new Map();
  for (const [name, nodes] of parsedMap.entries()) {
    const inlined = inlineTemplateIncludes(nodes, parsedMap);
    compiled.set(name, makeCompiledTemplate(inlined));
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const sources = [];
  const statics = [];

  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!compiled.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const chosen = s.data.slug ?? slugify(s.data.title);
    const slug = uniqueSlug(chosen, takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
  }

  const bySource = new Map();
  for (const s of kept) bySource.set(s.path, s);
  const staticPaths = new Set(statics.map((f) => f.path));

  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const rendered = renderMarkdownFast(s.body, env);
    s.html = rendered.html;
    s.toc = rendered.toc;
    s.excerpt = rendered.excerpt;
  }

  const posts = kept
    .filter((s) => s.post)
    .sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let i = 0; i < posts.length; i++) {
    posts[i].newer = i === 0 ? null : posts[i - 1];
    posts[i].older = i === posts.length - 1 ? null : posts[i + 1];
  }

  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => !seen.has(slugify(name)) && seen.add(slugify(name)));
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const cards = new Map();
  for (const p of posts) {
    const c = createCard(p);
    cards.set(p, c);
    p.card = c;
  }

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);

  const render = (name, vars) => {
    const fn = compiled.get(name);
    return fn === undefined ? null : fn({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, compiled, fastEscape, textOfFast, lookupFast, truthyFast, 0);
  };

  const output = {};
  for (const s of kept) {
    const baseCard = s.post ? s.card : createCard(s);
    const pageData = {
      ...baseCard,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page: pageData });
  }

  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf({ cards }, t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  const lines = [...report, ...broken].sort(byCodeUnits);
  const nonPosts = kept.filter((s) => !s.post).length;
  lines.push(`built ${nonPosts} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;

  return output;
}

export function run(input) {
  return buildFast(input);
}
