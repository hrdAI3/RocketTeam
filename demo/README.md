# Rocket Team · Customer Preview

Single-file HTML demo. Tailwind compiled + inlined → zero external CSS deps (only Google Fonts).

## Files

- `index.html` — production-ready demo, all CSS + JS inline
- `vercel.json` — security headers + clean URLs
- `.vercelignore` — keeps build sources out of the deploy

Build sources (not deployed, kept for re-compile):
- `tailwind.config.js` · `in.css` · `out.css` · `inline.cjs`

## Rebuild CSS (only if `index.html` markup changes)

```
cd D:/hrdai/team
./node_modules/.bin/tailwindcss -c demo/tailwind.config.js -i demo/in.css -o demo/out.css --minify
cd demo && node inline.cjs
```

## Deploy to Vercel

First time (CLI install + login + first deploy):

```
npm i -g vercel
cd D:/hrdai/team/demo
vercel
```

`vercel` walks through: link / new project / scope / framework (none) / build cmd (none) / output dir (`.`). Confirms a preview URL.

Push to production:

```
vercel --prod
```

Each `vercel --prod` re-uploads `index.html` + assets, returns a stable `*.vercel.app` URL.
