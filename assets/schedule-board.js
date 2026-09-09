(function(root){
  'use strict';
  const esc=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const minutes=s=>{const p=String(s).split(':');return +p[0]*60+(+p[1]);};
  const time=m=>String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');
  const day=(d,n)=>{const x=new Date(d+'T12:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10);};
  function warnings(data,d){
    if(!d.date||!d.start)return [];
    const a=minutes(d.start),b=a+Number(d.min||90),out=[];
    if(!Number.isFinite(a)||!Number.isFinite(b)||b>1440||b<=a)return ['開始時刻と長さを確認してください'];
    if(a<420||b>1320)out.push('通常の授業時間（7:00〜22:00）の範囲外です');
    const overlap=s=>s.date===d.date&&(!s.start||minutes(s.start)<b&&minutes(s.end||time(minutes(s.start)+Number(s.min)))>a);
    if((data.teacherOff||[]).some(overlap))out.push('先生の授業不可時間と重なります');
    if((data.blocked||[]).some(s=>String(s.studentId)===String(d.studentId)&&overlap(s)))out.push('この生徒の授業不可時間と重なります');
    const slots=(data.slots||[]).filter(s=>['booked','offered'].includes(s.status)&&overlap(s));
    if(slots.some(s=>String(s.studentId)===String(d.studentId)))out.push('同じ生徒の授業と重なります');
    if(slots.length&&(d.deliveryMode==='online'||slots.some(s=>s.deliveryMode!=='in_person')))out.push('オンラインの1対1枠と重なります');
    else if(d.deliveryMode==='in_person'){
      const points=slots.flatMap(s=>[[Math.max(a,minutes(s.start)),1],[Math.min(b,minutes(s.start)+Number(s.min)),-1]]).sort((x,y)=>x[0]-y[0]||x[1]-y[1]);let count=0;
      if(points.some(p=>(count+=p[1])>=2))out.push('対面の定員2人を超える時間帯があります');
    }
    return out;
  }
  // Give each connected overlap group stable, non-overlapping columns.
  function layout(lessons){
    const result=new Map();let group=[],ends=[],until=-Infinity;
    function flush(){group.forEach(x=>result.set(x.s,{lane:x.lane,count:ends.length}));group=[];ends=[];}
    lessons.slice().sort((a,b)=>minutes(a.start)-minutes(b.start)||String(a.id).localeCompare(String(b.id))).forEach(s=>{
      const a=minutes(s.start),b=a+Number(s.min);
      if(a>=until){flush();until=-Infinity;}
      let lane=ends.findIndex(end=>end<=a);if(lane<0)lane=ends.length;
      ends[lane]=b;group.push({s,lane});until=Math.max(until,b);
    });flush();return result;
  }
  function render(data,opts){
    const start=opts.date||data.today,first=day(start,-((new Date(start+'T12:00:00Z').getUTCDay()+6)%7)),from=opts.full?0:420,to=opts.full?1440:1320,dates=Array.from({length:7},(_,i)=>day(first,i));
    let h='<section class="schedule-board" aria-label="週間予定表"><div class="row"><button data-action="board-prev" class="btn-quiet">前の週</button><button data-action="board-today" class="btn-quiet">今日</button><button data-action="board-next" class="btn-quiet">次の週</button><strong>'+esc(first)+' 〜 '+esc(dates[6])+'</strong><label>表示日 <input type="date" id="board-date" value="'+esc(start)+'"></label><button data-action="board-hours" class="btn-quiet">'+(opts.full?'7:00〜22:00に戻す':'時間外も表示')+'</button><button data-action="board-new" class="btn-primary">授業を案内</button></div><label class="small">生徒の授業不可を重ねる <select id="board-student"><option value="">先生の予定のみ</option>'+ (data.students||[]).filter(x=>x.active).map(x=>'<option value="'+esc(x.id)+'"'+(String(x.id)===String(opts.studentId)?' selected':'')+'>'+esc(x.name)+'</option>').join('')+'</select></label><p class="small muted">空き時間をクリック・タップして案内を作成。マウスでは縦にドラッグして長さを指定できます。授業・授業不可の帯を選ぶと詳細を表示します。</p><div class="board-scroll"><div class="board-grid" style="--board-height:'+((to-from)*1.2)+'px"><div class="board-hours"><div class="board-heading">時刻</div>';
    for(let t=from;t<to;t+=60)h+='<span style="top:'+(44+(t-from)*1.2)+'px">'+time(t)+'</span>';
    h+='</div>';
    dates.forEach(date=>{
      h+='<div class="board-column"><div class="board-heading">'+esc(date.slice(5))+' '+['日','月','火','水','木','金','土'][new Date(date+'T12:00:00Z').getUTCDay()]+'</div><div class="board-track" data-board-day="'+date+'">';
      for(let t=from;t<to;t+=30)h+='<button class="board-cell" data-board-time="'+time(t)+'" data-board-date="'+date+'" style="top:'+((t-from)*1.2)+'px" aria-label="'+date+' '+time(t)+'から授業を案内"></button>';
      const events=[];
      (data.teacherOff||[]).filter(s=>s.date===date).forEach(s=>events.push({s,type:'off',label:'先生・授業不可'}));
      (data.blocked||[]).filter(s=>s.date===date&&(opts.studentId&&String(s.studentId)===String(opts.studentId))).forEach(s=>events.push({s,type:'blocked',label:(s.studentName||'生徒')+'・授業不可'}));
      const lessons=(data.slots||[]).filter(s=>s.date===date&&['booked','offered'].includes(s.status)).sort((a,b)=>minutes(a.start)-minutes(b.start));
      const positions=layout(lessons);
      lessons.forEach(s=>events.push({s,type:'slot',label:(s.studentName||'授業')+' '+(s.subject||'')+(s.status==='offered'?'（案内中）':'')}));
      events.forEach((e,i)=>{const a=e.s.start?minutes(e.s.start):from,b=e.s.start?minutes(e.s.end||time(a+Number(e.s.min))):to;if(b<=from||a>=to)return;const isSlot=e.type==='slot',position=isSlot?positions.get(e.s):null;
        h+='<button class="board-event '+e.type+'" data-action="board-detail" data-kind="'+e.type+'" data-id="'+esc(e.s.id)+'" style="top:'+((Math.max(from,a)-from)*1.2)+'px;height:'+Math.max(25,(Math.min(to,b)-Math.max(from,a))*1.2)+'px;'+(isSlot?'left:calc('+(position.lane*100/position.count)+'% + 2px);width:calc('+(100/position.count)+'% - 4px);':e.type==='blocked'?'left:70%;width:30%;':'left:0;width:100%;')+'" title="'+esc(e.label+' '+(e.s.start||'終日')+' '+(e.s.note||''))+'">'+esc((e.s.start||'終日')+' '+e.label)+'</button>';
      });
      h+='</div></div>';
    });
    const outside=(data.slots||[]).filter(s=>dates.includes(s.date)&&['booked','offered'].includes(s.status)&&(minutes(s.start)<420||minutes(s.start)+Number(s.min)>1320));
    return h+'</div></div>'+(!opts.full&&outside.length?'<p role="status">この週に時間外の授業が'+outside.length+'件あります。「時間外も表示」で確認できます。</p>':'')+'</section>';
  }
  function bind(host,select,document){
    let drag=null,suppress=false;
    host.addEventListener('pointerdown',e=>{const b=e.target.closest('[data-board-time]');if(!b||e.pointerType==='touch'||e.button!==0)return;drag={date:b.dataset.boardDate,start:minutes(b.dataset.boardTime),end:minutes(b.dataset.boardTime),id:e.pointerId};});
    host.addEventListener('pointerover',e=>{const b=e.target.closest('[data-board-time]');if(drag&&b&&b.dataset.boardDate===drag.date){drag.end=Math.max(drag.start-90,Math.min(drag.start+90,minutes(b.dataset.boardTime)));host.querySelectorAll('.board-cell').forEach(c=>c.classList.toggle('selecting',c.dataset.boardDate===drag.date&&minutes(c.dataset.boardTime)>=Math.min(drag.start,drag.end)&&minutes(c.dataset.boardTime)<=Math.max(drag.start,drag.end)));}});
    document.addEventListener('pointerup',()=>{if(!drag)return;const d=drag;drag=null;if(d.end!==d.start){suppress=true;select(d.date,time(Math.min(d.start,d.end)),Math.abs(d.end-d.start)+30);setTimeout(()=>{suppress=false;},0);}});
    document.addEventListener('pointercancel',()=>{drag=null;});
    host.addEventListener('click',e=>{const b=e.target.closest('[data-board-time]');if(b&&!suppress)select(b.dataset.boardDate,b.dataset.boardTime,60);});
  }
  const api={layout,render,warnings,minutes,time,day,bind};if(typeof module!=='undefined')module.exports=api;else root.StepwiseBoard=api;
})(typeof window!=='undefined'?window:globalThis);
