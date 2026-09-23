// Local-only QA of the real UI + GAS handlers using synthetic in-memory data.
// No remote calls, disk ledger, credentials or production configuration used.
// Run: node scripts/preview-lesson-outline.cjs ; stop: Ctrl+C (data is discarded).
const {createServer}=require('node:http');
const {readFileSync}=require('node:fs');
const {resolve}=require('node:path');
const {TEACHER_TOKEN}=require('../test/gas-harness.cjs');
const {createLessonOutlineFixture}=require('../test/helpers/lesson-outline-fixture.cjs');
const homePreview=process.env.STEPWISE_PREVIEW_SCENARIO==='teacher-home';
const {h,ftoken}=homePreview?require('../test/helpers/teacher-home-fixture.cjs').createTeacherHomeFixture():createLessonOutlineFixture();
const root=resolve(__dirname,'..'),port=Number(process.env.STEPWISE_PREVIEW_PORT||8768);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid local preview port');
const routes={'/kanri/':'kanri/index.html','/yoyaku/':'yoyaku/index.html','/hogosha/':'hogosha/index.html'};
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; form-action 'self'; object-src 'none'");
  try{
    const url=new URL(req.url,`http://127.0.0.1:${port}`);
    if(url.pathname==='/api'){
      let body='';for await(const chunk of req){body+=chunk;if(body.length>100000)throw Error('too large');}
      const result=req.method==='POST'?h.request(JSON.parse(body)):h.get(Object.fromEntries(url.searchParams));
      res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(result));return;
    }
    if(url.pathname==='/width'){
      const width=[320,390,1280].includes(Number(url.searchParams.get('w')))?Number(url.searchParams.get('w')):390;
      const target=url.searchParams.get('view')==='home'?'/kanri/?homePreview=1#home':url.searchParams.get('view')==='student'?'/yoyaku/?k=synthetic-link-a#history':'/kanri/#lesson?student=test-a&slot=preview-current';
      res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html lang="ja"><title>架空データの幅確認</title><body style="margin:0;background:#e6e9ec"><iframe title="'+width+'pxの実画面" style="display:block;width:'+width+'px;height:100vh;border:0;margin:auto" src="'+target+'"></iframe></body></html>');return;
    }
    const relative=routes[url.pathname]||(url.pathname.startsWith('/assets/')?url.pathname.slice(1):null);
    if(!relative||relative.split('/').includes('..')){res.writeHead(404);res.end('Not found');return;}
    const file=resolve(root,relative);if(!file.startsWith(root+require('node:path').sep))throw Error('invalid path');
    const ext=require('node:path').extname(file);let data=readFileSync(file);
    if(ext==='.js'||ext==='.html'){
      data=data.toString('utf8').replace(/var API = "[^"]+";/g,'var API = "/api";').replace(/var READ_API = "[^"]+";/g,'var READ_API = "/api";');
      // Use a genuine synthetic family session, not the teacher preview, for receipt QA.
      const familySession=url.pathname==='/hogosha/'&&!url.searchParams.has('preview')?'sessionStorage.setItem("sw_ft_v1",'+JSON.stringify(ftoken)+');':'';
      if(ext==='.html')data=data.replace('</head>','<script>localStorage.setItem("sw_admt",'+JSON.stringify(TEACHER_TOKEN)+');'+familySession+'</script></head>').replace('<body>','<body><div style="padding:8px;background:#fff3c4;text-align:center">【テスト】架空データ・本番接続なし</div>');
    }
    res.setHeader('Content-Type',(mime[ext]||'application/octet-stream')+'; charset=utf-8');res.end(data);
  }catch(e){res.writeHead(500);res.end('Local QA: '+e.message);}
}).listen(port,'127.0.0.1',()=>console.log('Synthetic QA: http://127.0.0.1:'+port+(homePreview?'/kanri/?homePreview=1#home':'/kanri/#lesson?student=test-a&slot=preview-current')+' ; /width?w=390&view=home ; /width?w=320&view=home'));
