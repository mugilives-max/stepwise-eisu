// Local-only interactive verification: actual GAS handlers, synthetic in-memory data.
// Nothing is sent to Google. Each process start creates a fresh dummy dataset.
const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const {createHarness,TEACHER_TOKEN} = require('../test/gas-harness.cjs');
const h = createHarness();
const routes = {'/kanri/':'kanri/index.html','/yoyaku/':'yoyaku/index.html'};
const port = Number(process.env.STEPWISE_PREVIEW_PORT || 8766);
createServer(async (req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-src 'none'");
  try {
    const url = new URL(req.url,`http://127.0.0.1:${port}`);
    if (url.pathname === '/api') {
      let result;
      if (req.method === 'POST') {
        let body=''; for await(const chunk of req){ body+=chunk; if(body.length>100000)throw Error('request too large'); }
        result = h.request(JSON.parse(body));
      } else result = h.get(Object.fromEntries(url.searchParams));
      res.setHeader('Content-Type','application/json; charset=utf-8'); res.end(JSON.stringify(result)); return;
    }
    const file = routes[url.pathname];
    if(!file){res.writeHead(404);res.end('Not found');return;}
    let html=readFileSync(resolve(__dirname,'..',file),'utf8');
    html=html.replace(/var API = "[^"]+";/,'var API = "/api";');
    if(html.includes('https://script.google.com/'))throw Error('Unexpected live API reference');
    // Synthetic teacher session only, scoped to this localhost origin.
    html=html.replace('</head>', `<script>localStorage.setItem('sw_admt',${JSON.stringify(TEACHER_TOKEN)});</script></head>`);
    html=html.replace('<body>', '<body><div style="padding:10px;background:#fff3c4;text-align:center">動作確認用：架空データ・本番接続なし</div>');
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);
  }catch(e){res.writeHead(500);res.end('Local preview error: '+e.message);}
}).listen(port,'127.0.0.1',()=>console.log(`Synthetic preview http://127.0.0.1:${port}/kanri/#s=test-a and /yoyaku/?k=synthetic-link-a#parent`));
