// Private, resumable backups. No business-data restore or automatic deletion.
var SW_BACKUP_KEY_ = 'STEPWISE_BACKUP_STATE';
function backupHash_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(value)).map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2);}).join('');
}
function backupSnapshot_(book) {
  return book.getSheets().map(function(s){var r=s.getDataRange();return {name:s.getName(),rows:r.getNumRows(),cols:r.getNumColumns(),values:backupHash_(r.getValues()),formulas:backupHash_(r.getFormulas())};});
}
function backupPrivate_(item) {
  if(item.getSharingAccess()!==DriveApp.Access.PRIVATE || item.getEditors().length || item.getViewers().length) throw Error('Backup destination must be owner-only');
  return item;
}
function backupProperties_(){return PropertiesService.getScriptProperties();}
function backupConfig_(){var p=backupProperties_().getProperties();[SW_BACKUP_KEY_,'STEPWISE_BACKUP_LATEST','STEPWISE_BACKUP_RESTORE_CHECK'].forEach(function(k){delete p[k];});return Object.keys(p).sort().map(function(k){return [k,p[k]];});}
function backupPdfList_(){var id=backupProperties_().getProperty('EXAM_PDF_FOLDER_ID'),out=[];if(id){var it=DriveApp.getFolderById(id).getFiles();while(it.hasNext()){var f=it.next();out.push({source:f.getId(),size:f.getSize(),updated:f.getLastUpdated().toISOString()});}}return out.sort(function(a,b){return a.source.localeCompare(b.source);});}
function backupState_(){var raw=backupProperties_().getProperty(SW_BACKUP_KEY_);return raw?JSON.parse(raw):null;}
function backupGuard_(){var p=backupProperties_();if(p.getProperty('STEPWISE_BACKUP_SCRIPT')!==ScriptApp.getScriptId())throw Error('Backup setup required in this script');}
function backupRemoveTriggers_(handler){ScriptApp.getProjectTriggers().forEach(function(t){if(t.getHandlerFunction()===handler)ScriptApp.deleteTrigger(t);});}
function setupStepwiseBackups() {
  var p=backupProperties_(), id=p.getProperty('STEPWISE_BACKUP_SCRIPT');
  if(id && id!==ScriptApp.getScriptId())throw Error('Copied script: setup refused');
  var folder=p.getProperty('STEPWISE_BACKUP_FOLDER');
  if(folder)backupPrivate_(DriveApp.getFolderById(folder));
  else {folder=backupPrivate_(DriveApp.createFolder('ステップワイズ_自動バックアップ')).getId();p.setProperty('STEPWISE_BACKUP_FOLDER',folder);}
  p.setProperty('STEPWISE_BACKUP_SCRIPT',ScriptApp.getScriptId());
  p.setProperty('STEPWISE_BACKUP_BOOK',ss_().getId());
  backupRemoveTriggers_('startStepwiseBackup');
  ScriptApp.newTrigger('startStepwiseBackup').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(3).inTimezone('Asia/Tokyo').create();
  return {ok:true,schedule:'Sunday 03:00-04:00 Asia/Tokyo',retention:'No automatic deletion'};
}
function startStepwiseBackup() {
  backupGuard_();var lock=LockService.getScriptLock();lock.waitLock(10000);
  try {
    var prior=backupState_();if(prior && prior.status==='running'){backupRemoveTriggers_('continueStepwiseBackup');ScriptApp.newTrigger('continueStepwiseBackup').timeBased().everyMinutes(5).create();return {ok:true,status:'resumed'};}
    var p=backupProperties_(), root=backupPrivate_(DriveApp.getFolderById(p.getProperty('STEPWISE_BACKUP_FOLDER')));
    var folder=backupPrivate_(root.createFolder('backup_'+new Date().toISOString().replace(/[:.]/g,'-')));
    var properties=backupConfig_();
    var configFile=backupPrivate_(folder.createFile('script-properties.json',JSON.stringify(properties),MimeType.PLAIN_TEXT));
    if(configFile.getBlob().getDataAsString()!==JSON.stringify(properties))throw Error('Property backup comparison failed');
    var books=[p.getProperty('STEPWISE_BACKUP_BOOK'),LEDGER_ID].map(function(id){return {source:id,snapshot:backupSnapshot_(SpreadsheetApp.openById(id))};});
    var pdfs=backupPdfList_();
    var manifest={status:'running',started:new Date().toISOString(),folder:folder.getId(),books:books,pdfs:pdfs,config:configFile.getId(),configHash:backupHash_(properties)};
    var file=backupPrivate_(folder.createFile('manifest.json',JSON.stringify(manifest),MimeType.PLAIN_TEXT));
    p.setProperty(SW_BACKUP_KEY_,JSON.stringify({status:'running',manifest:file.getId()}));
    backupRemoveTriggers_('continueStepwiseBackup');
    ScriptApp.newTrigger('continueStepwiseBackup').timeBased().everyMinutes(5).create();
    return {ok:true,status:'running',books:books.length,pdfs:pdfs.length};
  } finally {lock.releaseLock();}
}
function backupCopy_(source,folder,name) {
  var existing=folder.getFilesByName(name);
  return backupPrivate_(existing.hasNext()?existing.next():DriveApp.getFileById(source).makeCopy(name,folder));
}
function continueStepwiseBackup() {
  backupGuard_();var lock=LockService.getScriptLock();if(!lock.tryLock(1000))return;
  try {
    var state=backupState_();if(!state || state.status!=='running'){backupRemoveTriggers_('continueStepwiseBackup');return;}
    var file=backupPrivate_(DriveApp.getFileById(state.manifest)),m=JSON.parse(file.getBlob().getDataAsString());
    var folder=backupPrivate_(DriveApp.getFolderById(m.folder));
    var item=m.books.find(function(b){return !b.copy;});
    if(item){
      var copy=backupCopy_(item.source,folder,'book_'+item.source);
      if(backupHash_(backupSnapshot_(SpreadsheetApp.openById(copy.getId())))!==backupHash_(item.snapshot))throw Error('Book changed during backup');
      item.copy=copy.getId();
    } else {
      item=m.pdfs.find(function(b){return !b.copy;});
      if(item){var original=DriveApp.getFileById(item.source), pdf=backupCopy_(item.source,folder,'pdf_'+item.source);item.hash=backupHash_(original.getBlob().getBytes());if(backupHash_(pdf.getBlob().getBytes())!==item.hash)throw Error('PDF comparison failed');item.copy=pdf.getId();}
      else {
        m.books.forEach(function(b){if(backupHash_(backupSnapshot_(SpreadsheetApp.openById(b.source)))!==backupHash_(b.snapshot))throw Error('Source changed during backup');});
        if(backupHash_(backupConfig_())!==m.configHash)throw Error('Configuration changed during backup');
        if(backupHash_(backupPdfList_())!==backupHash_(m.pdfs.map(function(b){return {source:b.source,size:b.size,updated:b.updated};})))throw Error('PDF source set changed during backup');
        m.status='complete';m.completed=new Date().toISOString();
      }
    }
    file.setContent(JSON.stringify(m));
    if(m.status==='complete'){backupProperties_().setProperty('STEPWISE_BACKUP_LATEST',state.manifest);backupProperties_().setProperty(SW_BACKUP_KEY_,JSON.stringify({status:'complete',manifest:state.manifest,completed:m.completed}));backupRemoveTriggers_('continueStepwiseBackup');}
    return {ok:true,status:m.status};
  } catch(e) {
    var failed=backupState_()||{};failed.status='failed';failed.failed=new Date().toISOString();backupProperties_().setProperty(SW_BACKUP_KEY_,JSON.stringify(failed));backupRemoveTriggers_('continueStepwiseBackup');
    throw Error('Stepwise backup failed. Inspect private backup and rerun startStepwiseBackup.');
  } finally {lock.releaseLock();}
}
function stepwiseBackupStatus(){var s=backupState_()||{status:'not started'},result={status:s.status,completed:s.completed||null,failed:s.failed||null};console.log(JSON.stringify(result));return result;}
function stopStepwiseBackups(){backupGuard_();backupRemoveTriggers_('startStepwiseBackup');backupRemoveTriggers_('continueStepwiseBackup');return {ok:true};}
function verifyStepwiseBackupRestore() {
  backupGuard_();var p=backupProperties_(),id=p.getProperty('STEPWISE_BACKUP_LATEST');if(!id)throw Error('No completed backup');
  var m=JSON.parse(backupPrivate_(DriveApp.getFileById(id)).getBlob().getDataAsString());if(m.status!=='complete')throw Error('Incomplete backup');
  var root=backupPrivate_(DriveApp.getFolderById(p.getProperty('STEPWISE_BACKUP_FOLDER'))),folder=backupPrivate_(root.createFolder('【テスト】復元確認_'+Date.now()));
  try {
    m.books.forEach(function(b){var copy=backupCopy_(b.copy,folder,'restore_'+b.copy);if(backupHash_(backupSnapshot_(SpreadsheetApp.openById(copy.getId())))!==backupHash_(b.snapshot))throw Error('Restore comparison failed');});
    m.pdfs.forEach(function(b){if(backupHash_(DriveApp.getFileById(b.copy).getBlob().getBytes())!==b.hash)throw Error('Stored PDF changed');});
    if(backupHash_(JSON.parse(backupPrivate_(DriveApp.getFileById(m.config)).getBlob().getDataAsString()))!==m.configHash)throw Error('Stored properties changed');
    p.setProperty('STEPWISE_BACKUP_RESTORE_CHECK',JSON.stringify({manifest:id,verified:new Date().toISOString()}));
    return {ok:true,books:m.books.length,pdfs:m.pdfs.length};
  } finally {folder.setTrashed(true);}
}
