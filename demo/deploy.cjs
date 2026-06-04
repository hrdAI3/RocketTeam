// One-shot deploy to Vercel via REST API. No CLI required.
// Usage: VERCEL_TOKEN=... node deploy.cjs   (or pass as arg)
const fs = require('fs');
const path = require('path');
const https = require('https');

const TOKEN = process.env.VERCEL_TOKEN || process.argv[2];
if (!TOKEN) { console.error('Missing VERCEL_TOKEN'); process.exit(1); }

const PROJECT = 'rocket-team-demo';
const FILES = ['index.html', 'vercel.json'];

function req(method, urlPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const opts = {
      hostname: 'api.vercel.com',
      path: urlPath,
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': data.length } : {}),
        ...extraHeaders,
      },
    };
    const r = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
        else reject(new Error(`${method} ${urlPath} → ${res.statusCode}: ${text}`));
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  const cwd = __dirname;
  const files = FILES.map((f) => ({
    file: f,
    data: fs.readFileSync(path.join(cwd, f)).toString('base64'),
    encoding: 'base64',
  }));
  console.log(`[deploy] ${files.length} file(s), uploading…`);
  const dep = await req('POST', '/v13/deployments?forceNew=1', {
    name: PROJECT,
    files,
    target: 'production',
    projectSettings: { framework: null, devCommand: null, buildCommand: null, outputDirectory: null, installCommand: null },
  });
  console.log(`[deploy] deployment id  : ${dep.id}`);
  console.log(`[deploy] deployment url : https://${dep.url}`);
  if (dep.alias && dep.alias.length) console.log(`[deploy] aliases        : ${dep.alias.map((a)=>'https://'+a).join('\n                          ')}`);

  // Poll until READY
  const start = Date.now();
  while (true) {
    const status = await req('GET', `/v13/deployments/${dep.id}`);
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`[deploy] state=${status.readyState || status.state} (${elapsed}s)`);
    if (['READY','ERROR','CANCELED'].includes(status.readyState || status.state)) {
      if ((status.readyState || status.state) === 'READY') {
        console.log('\n✅ live: https://' + dep.url);
        if (status.alias && status.alias.length) {
          console.log('   production aliases:');
          for (const a of status.alias) console.log('     https://' + a);
        }
      } else {
        console.error('\n❌ failed:', status);
        process.exit(2);
      }
      break;
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
})().catch((e) => { console.error(e.message || e); process.exit(3); });
