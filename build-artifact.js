// index.html と各ソースを1ファイルにまとめる(アーティファクト公開用)。 node build-artifact.js
'use strict';
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const html = read('index.html');
const title = html.match(/<title>[\s\S]*?<\/title>/)[0];
const fonts = (html.match(/<link[^>]+fonts\.googleapis\.com[^>]+>/g) || []).join('\n');
const body = html
  .match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/<script src="([^"]+)"( data-worker)?><\/script>/g, (_, src, attr) => '<script' + (attr || '') + '>\n' + read(src) + '</script>');

const out = [title, fonts, '<style>\n' + read('style.css') + '</style>', body.trim(), ''].join('\n');
const dist = path.join(__dirname, 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, 'ReserveShogi.html'), out);
console.log('dist/ReserveShogi.html ' + (out.length / 1024).toFixed(1) + ' KB');
