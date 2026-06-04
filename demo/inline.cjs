const fs = require('fs');
const html = fs.readFileSync('index.html','utf8');
const css = fs.readFileSync('out.css','utf8');
const openTag = '<style id="tw-inlined">';
const closeTag = '</style>';
const start = html.indexOf(openTag);
if(start < 0){ console.error('inlined style block not found'); process.exit(1); }
const end = html.indexOf(closeTag, start) + closeTag.length;
const replacement = `${openTag}\n${css}\n${closeTag}`;
fs.writeFileSync('index.html', html.slice(0, start) + replacement + html.slice(end));
console.log('re-inlined CSS:', css.length, 'bytes');
