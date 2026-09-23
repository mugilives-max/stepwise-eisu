// Cabinet Office published dates only; no estimated equinoxes or runtime network dependency.
import fs from 'node:fs/promises';
const url='https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv';
const response=await fetch(url);
if(!response.ok)throw new Error('Holiday download failed: '+response.status);
const csv=new TextDecoder('shift_jis').decode(await response.arrayBuffer());
const dates={};
for(const line of csv.split(/\r?\n/)){
 const m=line.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2}),([^,]+)/);
 if(m&&+m[1]>=2020)dates[m[1]+'-'+m[2].padStart(2,'0')+'-'+m[3].padStart(2,'0')]=m[4].trim();
}
const keys=Object.keys(dates).sort();
if(keys.length<100||!dates['2026-09-23'])throw new Error('Unexpected holiday data');
// The official CSV calls both substitute holidays and holidays between two holidays 休日.
for(const date of keys)if(dates[date]==='休日'){
 const shift=n=>{const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
 dates[date]=dates[shift(-1)]&&dates[shift(1)]?'国民の休日':'振替休日';
}
const path='assets/calendar.js';let source=await fs.readFile(path,'utf8');
const block='  // HOLIDAYS_START\n  // Source: '+url+' (updated '+new Date().toISOString().slice(0,10)+')\n  var HOLIDAYS = '+JSON.stringify(dates,null,2).replace(/\n/g,'\n  ')+';\n  var HOLIDAY_LAST_YEAR = '+keys.at(-1).slice(0,4)+';\n  // HOLIDAYS_END';
if(!source.includes('// HOLIDAYS_START'))throw new Error('Missing holiday data marker');
source=source.replace(/  \/\/ HOLIDAYS_START[\s\S]*?  \/\/ HOLIDAYS_END/,block);
await fs.writeFile(path,source);console.log(keys.length+' holidays; through '+keys.at(-1));
