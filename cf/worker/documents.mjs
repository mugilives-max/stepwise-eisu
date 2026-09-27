import { parseDocument } from './document-parse.mjs';
import { createRuntime } from './read.mjs';
import { Buffer } from 'node:buffer';

export const DOCUMENT_ACTIONS = ['documentList', 'documentUpload', 'documentRead', 'documentRemove', 'documentParse'];
const fail = error => ({ error });
async function drive(env, document, fetcher) {
  if (!env.SYNC_KEY || env.SYNC_KEY.length < 24 || !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(env.GAS_URL || '')) throw Error('storage unavailable');
  const r = await fetcher(env.GAS_URL, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'effects',key:env.SYNC_KEY,document}),signal:AbortSignal.timeout(60000)});
  if (!r.ok) throw Error('storage unavailable');
  const data = await r.json();
  if (!data.ok) throw Error('storage unavailable');
  return data;
}
export async function handleDocuments(body, env, options = {}) {
  if (!DOCUMENT_ACTIONS.includes(body.action)) return null;
  const gas = options.gas || await createRuntime(env, options);
  let student, teacher = false;
  if (body.token) {
    if (gas.authMode_() !== 'account' || !gas.tokenOk_(body.token)) return {error:'ログインし直してください',badAuth:true};
    teacher = true; student = gas.findStudent_(String(body.studentId || ''));
  } else if (body.ftoken) {
    const auth = gas.familyChildRequire_(body);
    if (auth.error) return auth;
    student = auth.student;
  } else if (body.k) student = gas.findStudentByCode_(String(body.k));
  if (!student || String(student.active) === 'false') return fail('この生徒の資料は利用できません');
  const sid = String(student.id), db = env.DB;
  if (body.action === 'documentList') {
    const r = await db.prepare("select id, name, size, createdAt, metadata from _studentDocuments where studentId = ? and removedAt = '' order by createdAt desc, id").bind(sid).all();
    return {ok:true,documents:(r.results || []).map(({metadata,...row})=>({...row,details:JSON.parse(metadata || '{}')}))};
  }
  if (body.action === 'documentUpload') {
    if (!teacher) return fail('資料の追加は先生が行います');
    const details=body.details||{};
    const category=String(details.category||'schedule'),title=String(details.title||'').trim(),examDate=String(details.examDate||''),subject=String(details.subject||'').trim(),note=String(details.note||'').trim();
    if(!['schedule','mock','test','other'].includes(category)||title.length>100||subject.length>100||note.length>1000)return fail('資料の区分・タイトル・科目・メモを確認してください');
    if(examDate&&(!/^\d{4}-\d{2}-\d{2}$/.test(examDate)||!Number.isFinite(Date.parse(examDate))||new Date(examDate).toISOString().slice(0,10)!==examDate))return fail('受験日を確認してください');
    const metadata=JSON.stringify({category,title,examDate,subject,note});
    const pdf = body.pdf;
    if (!pdf || pdf.mime !== 'application/pdf' || typeof pdf.base64 !== 'string' || pdf.base64.length > 6990508 || !/^[A-Za-z0-9+/]+={0,2}$/.test(pdf.base64)) return fail('5MB以下のPDFを選んでください');
    const bytes = Buffer.from(pdf.base64, 'base64');
    if (bytes.length > 5*1024*1024 || bytes.subarray(0,5).toString() !== '%PDF-' || bytes.toString('base64') !== pdf.base64) return fail('PDFファイルを確認してください');
    const hash = Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
    const id = Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(sid + ':' + hash))).toString('hex');
    const name = String(pdf.name || '予定表.pdf').replace(/[\x00-\x1f\x7f]/g,'').slice(0,150);
    const old = await db.prepare('select fileId from _studentDocuments where id = ? and studentId = ?').bind(id,sid).first();
    const stored = old || await drive(env,{op:'store',hash,pdf:{...pdf,name}},options.fetcher || fetch);
    if (!stored.fileId) throw Error('storage unavailable');
    // A retry of the same file shares the same id and Drive object.
    await db.prepare("insert into _studentDocuments (id,studentId,name,fileId,fileHash,size,createdAt,removedAt,metadata) values (?,?,?,?,?,?,?,'',?) on conflict(id) do update set removedAt = '', metadata = excluded.metadata").bind(id,sid,name,stored.fileId,hash,bytes.length,new Date().toISOString(),metadata).run();
    return {ok:true,id};
  }
  if (body.action === 'documentParse' && !teacher) return fail('資料の読み取りは先生が行います');
  if (body.action === 'documentRemove' && !teacher) return fail('資料の削除は先生が行います');
  const row = await db.prepare("select * from _studentDocuments where id = ? and studentId = ? and removedAt = ''").bind(String(body.id || ''),sid).first();
  if (!row) return fail('資料が見つかりません');
  if (body.action === 'documentRemove') {
    await db.prepare('update _studentDocuments set removedAt = ? where id = ? and studentId = ?').bind(new Date().toISOString(),row.id,sid).run();
    return {ok:true};
  }
  if (body.action === 'documentParse' && !['schedule',undefined].includes(JSON.parse(row.metadata||'{}').category))return fail('予定表の資料を選んでください');
  if (body.action === 'documentParse') return parseDocument(body,env,row,()=>drive(env,{op:'read',fileId:row.fileId},options.fetcher || fetch),{...options,grade:String((gas.ledgerRows_('生徒台帳').find(p=>String(p['生徒ID'])===sid)||{})['学年'] || '')});
  const file = await drive(env,{op:'read',fileId:row.fileId},options.fetcher || fetch);
  if (typeof file.base64 !== 'string') throw Error('storage unavailable');
  return {ok:true,name:row.name,mime:'application/pdf',base64:file.base64};
}
