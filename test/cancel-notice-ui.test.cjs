const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../assets/portal.js'),'utf8');
const ctx={esc:String,yen:n=>n+'円'};vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('function cancelReviewNotice(s)'),source.indexOf('function cancelReviewDetails(s)')),ctx);
test('cancellation guidance follows timing and current reductions',()=>{
 const base={date:'2026-09-26',start:'14:30',source:'external',receivedAt:'2026-09-26T15:00:00+09:00',standardAmount:4500,amount:1000};
 let text=ctx.cancelReviewNotice(base);assert.ok(text.includes('授業開始後'));assert.ok(text.includes('3500円減額'));assert.ok(text.includes('1000円となっています'));assert.ok(text.includes('承認する'));
 text=ctx.cancelReviewNotice({...base,amount:4500});assert.ok(text.includes('4500円発生'));assert.ok(!text.includes('円減額'));
 text=ctx.cancelReviewNotice({...base,amount:0});assert.ok(text.includes('全額免除'));assert.ok(!text.includes('から申請'));
 text=ctx.cancelReviewNotice({...base,receivedAt:'2026-09-26T10:00:00+09:00',standardAmount:1000});assert.ok(text.includes('授業開始前まで'));
 text=ctx.cancelReviewNotice({...base,receivedAt:'2026-09-25T23:00:00+09:00',amount:0,standardAmount:0});assert.ok(text.includes('前日23時まで'));assert.ok(text.includes('かかりません'));
 text=ctx.cancelReviewNotice({...base,source:'noshow'});assert.ok(text.includes('無断欠席'));
 text=ctx.cancelReviewNotice({...base,source:'teacher',amount:0,standardAmount:0});assert.ok(text.includes('教室都合'));
 text=ctx.cancelReviewNotice({...base,relief:{status:'pending'},confirmed:true});assert.ok(text.includes('審査前'));assert.ok(!text.includes('承認する'));
});
