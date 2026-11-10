import { randomUUID, createHash } from 'node:crypto';
import { AppError, assert, errorBody, safeMessage } from './errors.mjs';
import { inspectImageBytes } from './payloads.mjs';
import { readBody, parseJson } from './multipart.mjs';
import { P, has, channelPermissions } from './permissions.mjs';
import { controlNotice, ensureControlNotices } from './control-members.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ID = /^\d{17,20}$/;
const IMAGE = /^gallery_[a-f0-9]{64}$/;
const BOT_ID = process.env.DISCORD_CLIENT_ID || '900000000000000002';
const SETTINGS_KEY = 'gaming_setups_settings_v1';
const SPEC_KEYS = ['cpu','gpu','ram','storage','mainboard','cooling','case','monitor','peripherals'];
const SPEC_LABELS = {cpu:'Prozessor',gpu:'Grafikkarte',ram:'Arbeitsspeicher',storage:'Speicher',mainboard:'Mainboard',cooling:'Kühlung',case:'Gehäuse',monitor:'Monitor',peripherals:'Zubehör'};
export const GAMING_SETUP_ACTIONS = ['setup.state','setup.save','setup.moderate','setup.retry','setup.image'];
export const GAMING_SETUP_LIMITS = Object.freeze({title:100,description:2000,spec:160,maxImages:4,maxImageBytes:8*1024*1024,maxUploads:20});
const NO_MENTIONS = {parse:[],users:[],roles:[],replied_user:false};
const hash = value => createHash('sha256').update(value).digest('hex');

function fields(value, allowed, required = allowed) {
  assert(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key=>allowed.includes(key)) && required.every(key=>Object.hasOwn(value,key)), 'Die Setup-Angaben sind unvollständig oder enthalten unbekannte Felder.');
}
function text(value,max,min=0) {
  assert(typeof value==='string' && value.length<=max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value),'Ein Setup-Text ist ungültig oder zu lang.');
  const result=value.trim();assert(result.length>=min,'Bitte einen Titel für dein Setup angeben.');return result;
}
export function setupDraft(value) {
  fields(value,['title','description','specs','imageIds']);
  const specs=value.specs;fields(specs,SPEC_KEYS,[]);
  assert(Array.isArray(value.imageIds)&&value.imageIds.length<=GAMING_SETUP_LIMITS.maxImages&&new Set(value.imageIds).size===value.imageIds.length&&value.imageIds.every(id=>typeof id==='string'&&IMAGE.test(id)),'Bitte höchstens vier eigene Setup-Bilder auswählen.');
  return {title:text(value.title,100,2),description:text(value.description,2000),specs:Object.fromEntries(SPEC_KEYS.map(key=>[key,text(specs[key]??'',160)])),imageIds:[...value.imageIds]};
}
const safeName=value=>String(value||'Mitglied').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'').slice(0,80);
const defaultSettings=()=>({enabled:false,forumChannelId:'',publicationMode:'review'});

export class GamingSetups {
  constructor(service,{now=Date.now,setTimer=setInterval,clearTimer=clearInterval}={}) {
    this.service=service;this.accounts=service.accounts;this.store=this.accounts.store;this.storage=this.accounts.imageStorage;
    this.config=service.config;this.discord=service.discord;this.now=now;this.setTimer=setTimer;this.clearTimer=clearTimer;
    this.running=null;this.timer=null;this.stopping=false;this.uploading=new Set();this.pending=new Set();
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS gaming_setups (
      id TEXT PRIMARY KEY,user_id TEXT NOT NULL UNIQUE REFERENCES accounts(id),revision INTEGER NOT NULL DEFAULT 0,
      draft_json TEXT NOT NULL,published_json TEXT,published_revision INTEGER,status TEXT NOT NULL DEFAULT 'draft',
      blocked INTEGER NOT NULL DEFAULT 0,consent_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      forum_id TEXT,thread_id TEXT,message_id TEXT,discord_revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS gaming_setup_images (
        user_id TEXT NOT NULL REFERENCES accounts(id),id TEXT NOT NULL,filename TEXT NOT NULL,mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,id));
      CREATE INDEX IF NOT EXISTS gaming_setup_images_id ON gaming_setup_images(id);
      CREATE TABLE IF NOT EXISTS gaming_setup_outbox (
        id TEXT PRIMARY KEY,setup_id TEXT NOT NULL REFERENCES gaming_setups(id),revision INTEGER NOT NULL,operation TEXT NOT NULL,
        state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL,
        UNIQUE(setup_id,revision,operation));
      CREATE TABLE IF NOT EXISTS gaming_setup_notice_receipts (
        setup_id TEXT NOT NULL REFERENCES gaming_setups(id) ON DELETE CASCADE,revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,PRIMARY KEY(setup_id,revision));`);
    if(!this.store.all('PRAGMA table_info(gaming_setups)').some(column=>column.name==='moderation_reason'))this.store.db.exec("ALTER TABLE gaming_setups ADD COLUMN moderation_reason TEXT NOT NULL DEFAULT ''");
    ensureControlNotices(this.store);
    this.store.run("UPDATE gaming_setup_outbox SET state='uncertain',last_error=? WHERE state='sending'",'Der Versand wurde unterbrochen. Bitte im Control Center prüfen.');
  }
  row(id) { assert(UUID.test(id||''),'Dieses Setup ist nicht vorhanden.','not_found',404);const row=this.store.get('SELECT * FROM gaming_setups WHERE id=?',id);assert(row,'Dieses Setup ist nicht vorhanden.','not_found',404);return row; }
  own(userId) { return this.store.get('SELECT * FROM gaming_setups WHERE user_id=?',userId); }
  account(userId) { return this.store.get('SELECT id,name,confirmed,suspended FROM accounts WHERE id=?',userId); }
  active(row) { const account=this.account(row.user_id);return !!account?.confirmed&&!account.suspended; }
  reviewNoticeState(event) {
    const row=this.store.get('SELECT * FROM gaming_setups WHERE id=?',event.target_id);
    if(!row||row.status!=='pending'||row.blocked||!row.published_json||!row.consent_at||row.published_revision!==event.revision)return 'obsolete';
    return this.active(row)&&this.settings().settings.enabled?'ready':'paused';
  }
  queueReviewNotice(row) {
    if(this.reviewNoticeState({target_id:row.id,revision:row.published_revision})!=='ready')return;
    // Called inside the submission/backfill transaction. This receipt survives
    // event expiry, so restarting or saving a later draft cannot repeat a notice.
    const receipt=this.store.run('INSERT OR IGNORE INTO gaming_setup_notice_receipts(setup_id,revision,created_at) VALUES (?,?,?)',row.id,row.published_revision,this.now());
    if(receipt.changes)controlNotice(this.store,'gaming_setup',row.id,row.published_revision,row.consent_at);
  }
  backfillReviewNotices() {
    this.store.transaction(()=>{
      for(const row of this.store.all("SELECT s.* FROM gaming_setups s LEFT JOIN gaming_setup_notice_receipts r ON r.setup_id=s.id AND r.revision=s.published_revision WHERE s.status='pending' AND r.setup_id IS NULL"))this.queueReviewNotice(row);
    });
  }
  current(context,admin=false) { return this.accounts.assertCurrent(context,{admin}); }
  hasImage(id) { return !!this.store.get('SELECT 1 FROM gaming_setup_images WHERE id=? LIMIT 1',id); }
  image(userId,id) { assert(IMAGE.test(id||''),'Der Bildverweis ist ungültig.');const row=this.store.get('SELECT * FROM gaming_setup_images WHERE user_id=? AND id=?',userId,id);assert(row,'Dieses Bild gehört nicht zu deinem Setup.','forbidden',403);return row; }
  imageView(row,privateView=false) { return {id:row.id,name:row.filename,mimeType:row.mime_type,size:row.size,width:row.width,height:row.height,url:(privateView?'/api/account/gaming-setup/images/':'/api/gaming-setups/images/')+row.id}; }
  settings() {
    const raw=this.store.setting(SETTINGS_KEY);if(!raw)return {revision:0,settings:defaultSettings()};
    let data;try{data=JSON.parse(raw);}catch{throw new AppError('storage','Die Setup-Einstellungen können nicht gelesen werden.',503);}
    assert(Number.isSafeInteger(data.revision)&&data.revision>=0,'Die Setup-Einstellungen sind ungültig.','storage',503);
    this.validateSettings(data.settings);return data;
  }
  validateSettings(value) { fields(value,['enabled','forumChannelId','publicationMode']);assert(typeof value.enabled==='boolean'&&typeof value.forumChannelId==='string'&&(!value.forumChannelId||ID.test(value.forumChannelId))&&['immediate','review'].includes(value.publicationMode),'Die Setup-Einstellungen sind ungültig.');if(value.enabled)assert(ID.test(value.forumChannelId),'Bitte einen Discord-Forumkanal auswählen.');return value; }
  outbox(row) { return this.store.get('SELECT * FROM gaming_setup_outbox WHERE setup_id=? ORDER BY revision DESC,updated_at DESC LIMIT 1',row.id); }
  entry(row,{privateView=false}={}) {
    const content=JSON.parse(privateView?row.draft_json:row.published_json),job=this.outbox(row);
    const result={id:row.id,authorName:safeName(this.account(row.user_id)?.name),...content,images:content.imageIds.map(id=>this.imageView(this.image(row.user_id,id),privateView)),updatedAt:row.updated_at,
      ...(row.thread_id&&row.discord_revision>0?{discordUrl:`https://discord.com/channels/${this.config.discordGuildId}/${row.thread_id}`}:{})};
    delete result.imageIds;
    if(privateView)Object.assign(result,{imageIds:content.imageIds,revision:row.revision,publishedRevision:row.published_revision,hasPublicVersion:this.isPublic(row),status:row.status,blocked:!!row.blocked,discordStatus:job?.state||'none',discordOperation:job?.operation||null,discordError:job?.last_error||''});
    return result;
  }
  isPublic(row) { return row.status==='published'&&!row.blocked&&!!row.published_json&&this.active(row); }
  list() { return {setups:this.store.all("SELECT s.* FROM gaming_setups s JOIN accounts a ON a.id=s.user_id WHERE s.status='published' AND s.blocked=0 AND a.confirmed=1 AND a.suspended=0 ORDER BY s.updated_at DESC,s.id LIMIT 200").map(row=>this.entry(row)),enabled:this.settings().settings.enabled}; }
  detail(id) { const row=this.row(id);assert(this.isPublic(row),'Dieses Setup ist nicht veröffentlicht.','not_found',404);return {setup:this.entry(row)}; }
  view(context) {
    const user=this.current(context),row=this.own(user.id),settings=this.settings().settings;
    return {setup:row?this.entry(row,{privateView:true}):null,images:this.store.all('SELECT * FROM gaming_setup_images WHERE user_id=? ORDER BY created_at DESC,id',user.id).map(row=>this.imageView(row,true)),user:{id:user.id,name:safeName(this.account(user.id)?.name)},limits:GAMING_SETUP_LIMITS,publicationPolicy:settings.publicationMode,enabled:settings.enabled};
  }
  exclusive(userId,fn) { assert(!this.pending.has(userId),'Dein Setup wird gerade verarbeitet. Bitte kurz warten.','conflict',409);this.pending.add(userId);return Promise.resolve().then(fn).finally(()=>this.pending.delete(userId)); }
  reserve(row,operation) {
    this.store.run("UPDATE gaming_setup_outbox SET state='superseded' WHERE setup_id=? AND state IN ('queued','failed')",row.id);
    this.store.run("INSERT INTO gaming_setup_outbox(id,setup_id,revision,operation,state,updated_at) VALUES (?,?,?,?,'queued',?)",randomUUID(),row.id,row.revision,operation,this.now());
  }
  async save(context,body) {
    fields(body,['expectedRevision','title','description','specs','imageIds','publish','consent']);
    assert(Number.isSafeInteger(body.expectedRevision)&&body.expectedRevision>=0&&typeof body.publish==='boolean'&&typeof body.consent==='boolean','Bitte einen gültigen Entwurf und seine Versionsnummer senden.');
    const draft=setupDraft({title:body.title,description:body.description,specs:body.specs,imageIds:body.imageIds}),user=this.current(context);
    return this.exclusive(user.id,()=>this.accounts.gallery.exclusive(async()=>{
      let row=this.own(user.id);assert((row?.revision||0)===body.expectedRevision,'Das Setup wurde inzwischen geändert. Bitte neu laden.','conflict',409);
      if(body.publish){assert(body.consent,'Bitte die Veröffentlichung auf Website und Discord ausdrücklich bestätigen.');assert(this.settings().settings.enabled,'Die Veröffentlichung von Setups ist derzeit ausgeschaltet.','unconfigured',503);assert(!row?.blocked,'Dein Setup wurde vom Team ausgeblendet. Bitte wende dich an das Team.','forbidden',403);}
      for(const id of draft.imageIds){const image=this.image(user.id,id);await this.storage.read(id,{mimeType:image.mime_type,size:image.size,width:image.width,height:image.height});}
      this.current(context);row=this.own(user.id);assert((row?.revision||0)===body.expectedRevision,'Das Setup wurde inzwischen geändert. Bitte neu laden.','conflict',409);
      const settings=this.settings().settings;if(body.publish){assert(settings.enabled&&!row?.blocked,'Die Veröffentlichung ist nicht mehr freigegeben.','forbidden',403);}
      const revision=(row?.revision||0)+1,id=row?.id||randomUUID(),status=body.publish?(settings.publicationMode==='review'?'pending':'published'):(row?.status||'draft');
      this.store.transaction(()=>{
        this.store.run(`INSERT INTO gaming_setups(id,user_id,revision,draft_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,draft_json=excluded.draft_json,status=excluded.status,updated_at=excluded.updated_at`,id,user.id,revision,JSON.stringify(draft),status,this.now(),this.now());
        if(body.publish){this.store.run("UPDATE gaming_setups SET published_json=?,published_revision=?,consent_at=?,moderation_reason='' WHERE id=?",JSON.stringify(draft),revision,this.now(),id);if(status==='published')this.reserve(this.row(id),'publish');else {this.reserve(this.row(id),'redact');this.queueReviewNotice(this.row(id));}}
        this.store.audit(user.id,body.publish?'gaming-setup.submitted':'gaming-setup.draft',id,{revision,status},this.now());
      });
      return this.view(context);
    }));
  }
  async upload(context,req) {
    const user=this.current(context);assert(!this.uploading.has(user.id)&&this.uploading.size<4,'Ein Bild wird bereits übertragen. Bitte kurz warten.','rate_limited',429);
    this.uploading.add(user.id);
    try {
      const mimeType=String(req.headers['content-type']||'').split(';')[0].trim(),length=Number(req.headers['content-length']);
      assert(['image/jpeg','image/png','image/webp'].includes(mimeType)&&!req.headers['content-encoding'],'Bitte JPG, PNG oder WebP verwenden.','validation',415);
      assert(/^\d+$/.test(req.headers['content-length']||'')&&Number.isSafeInteger(length)&&length>0&&length<=GAMING_SETUP_LIMITS.maxImageBytes,'Das Bild darf höchstens 8 MiB groß sein.','validation',413);
      let filename;try{filename=decodeURIComponent(req.headers['x-file-name']||'');}catch{throw new AppError('validation','Der Dateiname ist ungültig.');}
      assert(filename&&filename.length<=160&&!/[\u0000-\u001f\u007f/\\:]/.test(filename),'Bitte einen gültigen Bilddateinamen wählen.');
      const bytes=await readBody(req,GAMING_SETUP_LIMITS.maxImageBytes);assert(bytes.length===length,'Das Bild wurde nicht vollständig übertragen.');
      const dimensions=inspectImageBytes(bytes,mimeType),id='gallery_'+hash(bytes);
      return await this.accounts.gallery.exclusive(async()=>{
        this.current(context);const old=this.store.get('SELECT * FROM gaming_setup_images WHERE user_id=? AND id=?',user.id,id);
        const quota=this.store.get('SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM gaming_setup_images WHERE user_id=?',user.id);
        assert(old||(quota.count<GAMING_SETUP_LIMITS.maxUploads&&quota.bytes+bytes.length<=80*1024*1024),'Dein Setup-Bildspeicher ist voll.','conflict',409);
        await this.storage.put(id,bytes,{mimeType,...dimensions});this.current(context);
        if(!old)this.store.run('INSERT INTO gaming_setup_images VALUES (?,?,?,?,?,?,?,?)',user.id,id,filename,mimeType,bytes.length,dimensions.width,dimensions.height,this.now());
        this.store.audit(user.id,'gaming-setup.image',id,{},this.now());return {image:this.imageView(this.image(user.id,id),true)};
      });
    }finally{this.uploading.delete(user.id);}
  }
  publicImage(id) { assert(IMAGE.test(id||''),'Dieses Bild ist nicht vorhanden.','not_found',404);for(const row of this.store.all("SELECT * FROM gaming_setups WHERE status='published' AND blocked=0 AND published_json IS NOT NULL")){if(this.isPublic(row)&&JSON.parse(row.published_json).imageIds.includes(id))return this.image(row.user_id,id);}throw new AppError('not_found','Dieses Bild ist nicht veröffentlicht.',404); }
  async readImage(id,context=null) {
    const authorize=()=>context?this.image(this.current(context).id,id):this.publicImage(id),row=authorize();
    const bytes=await this.storage.read(id,{mimeType:row.mime_type,size:row.size,width:row.width,height:row.height});authorize();return {bytes,mimeType:row.mime_type};
  }
  async withdraw(context,body) {
    fields(body,['expectedRevision']);const user=this.current(context);
    return this.exclusive(user.id,()=>{
      const row=this.own(user.id);assert(row&&row.revision===body.expectedRevision,'Das Setup wurde inzwischen geändert. Bitte neu laden.','conflict',409);
      this.store.transaction(()=>{this.store.run("UPDATE gaming_setups SET revision=revision+1,status='withdrawn',published_json=NULL,published_revision=NULL,consent_at=NULL,updated_at=? WHERE id=?",this.now(),row.id);this.reserve(this.row(row.id),'redact');this.store.audit(user.id,'gaming-setup.withdrawn',row.id,{},this.now());});return this.view(context);
    });
  }
  adminView(context) { this.current(context,true);return {...this.settings(),entries:this.store.all('SELECT * FROM gaming_setups ORDER BY updated_at DESC LIMIT 200').map(row=>({...this.entry(row.published_json?{...row,draft_json:row.published_json}:row,{privateView:true}),contentKind:row.published_json?'submitted':'draft',hasNewerDraft:!!row.published_json&&row.draft_json!==row.published_json,moderationReason:row.moderation_reason})),limits:GAMING_SETUP_LIMITS}; }
  async forumContext(forumId) {
    assert(this.config.clientId===BOT_ID&&!!this.config.botToken&&ID.test(this.config.discordGuildId||''),'Der vorhandene Crazy_Batto-Bot ist nicht eingerichtet.','unconfigured',503);
    const guildId=this.config.discordGuildId,bot=await this.discord.request('GET','/users/@me');assert(bot?.id===BOT_ID&&bot.bot===true,'Es wurde ein anderer Discord-Bot geliefert.','unconfigured',503);
    const guild=await this.discord.request('GET','/guilds/'+guildId),member=await this.discord.request('GET',`/guilds/${guildId}/members/${BOT_ID}`),forum=await this.discord.request('GET','/channels/'+forumId);
    assert(guild?.id===guildId&&Array.isArray(guild.roles)&&member?.user?.id===BOT_ID&&Array.isArray(member.roles),'Die Discord-Rechte können nicht bestätigt werden.','network',502);
    assert(forum?.guild_id===guildId&&forum.type===15,'Bitte einen Forumkanal auf deinem Discord-Server auswählen.','forbidden',403);
    const permissions=channelPermissions(guild,member,forum,this.now());assert(has(permissions,P.VIEW_CHANNEL|P.SEND_MESSAGES|P.EMBED_LINKS|P.READ_MESSAGE_HISTORY|(1n<<38n)),'Der Bot braucht im Forum Lese-, Schreib-, Einbettungs- und Thread-Schreibrechte.','forbidden',403);
    assert(!(Number(forum.flags||0)&16),'Der Forumkanal verlangt ein Tag. Bitte die Tag-Pflicht für den Setup-Kanal ausschalten.','validation',400);
    return forum;
  }
  async run(context,action,payload={}) {
    this.current(context,true);assert(GAMING_SETUP_ACTIONS.includes(action),'Unbekannte Setup-Aktion.');
    if(payload.guildId)assert(payload.guildId===this.config.discordGuildId,'Falscher Discord-Server.','forbidden',403);
    if(action==='setup.state')return this.adminView(context);
    if(action==='setup.image'){
      const row=this.row(payload.id),image=this.image(row.user_id,payload.imageId);
      const bytes=await this.storage.read(image.id,{mimeType:image.mime_type,size:image.size,width:image.width,height:image.height});
      this.current(context,true);this.row(row.id);this.image(row.user_id,image.id);
      return {dataUrl:`data:${image.mime_type};base64,${bytes.toString('base64')}`,mimeType:image.mime_type};
    }
    if(action==='setup.save'){
      const before=this.settings(),settings=this.validateSettings(payload.settings);assert(payload.expectedRevision===before.revision,'Die Einstellungen wurden inzwischen geändert.','conflict',409);
      if(settings.enabled)await this.forumContext(settings.forumChannelId);this.current(context,true);
      assert(this.settings().revision===before.revision,'Die Einstellungen wurden inzwischen geändert.','conflict',409);
      assert(settings.forumChannelId===before.settings.forumChannelId||!this.store.get("SELECT 1 FROM gaming_setups WHERE thread_id IS NOT NULL UNION SELECT 1 FROM gaming_setup_outbox WHERE state IN ('sending','uncertain') LIMIT 1"),'Der Zielkanal kann nach einer Veröffentlichung nicht automatisch gewechselt werden.','conflict',409);
      this.store.transaction(()=>{this.store.setSetting(SETTINGS_KEY,JSON.stringify({revision:before.revision+1,settings}));this.store.audit(context.user.id,'gaming-setup.settings',null,{enabled:settings.enabled},this.now());});return this.adminView(context);
    }
    assert(payload.confirm===true,'Bitte die Setup-Aktion bestätigen.');const row=this.row(payload.id);
    assert(Number.isSafeInteger(payload.expectedRevision)&&payload.expectedRevision===row.revision,'Das Setup wurde inzwischen geändert. Bitte vor der Entscheidung neu laden.','conflict',409);
    if(action==='setup.moderate')return this.exclusive(row.user_id,()=>{
      this.current(context,true);const latest=this.row(row.id);assert(payload.expectedRevision===latest.revision,'Das Setup wurde inzwischen geändert. Bitte vor der Entscheidung neu laden.','conflict',409);assert(['approve','hide'].includes(payload.operation),'Unbekannte Setup-Entscheidung.');
      const reason=text(payload.reason??'',1000);
      if(payload.operation==='approve')assert(['pending','hidden'].includes(latest.status)&&latest.published_json&&latest.consent_at&&this.active(latest)&&this.settings().settings.enabled,'Das Mitglied muss sein aktuelles Setup erst zur Veröffentlichung einreichen.','conflict',409);
      this.store.transaction(()=>{this.store.run('UPDATE gaming_setups SET revision=revision+1,status=?,blocked=?,updated_at=?,moderation_reason=? WHERE id=?',payload.operation==='approve'?'published':'hidden',payload.operation==='hide'?1:0,this.now(),reason,row.id);const next=this.row(row.id);if(payload.operation==='approve')this.store.run('UPDATE gaming_setups SET published_revision=? WHERE id=?',next.revision,next.id);this.reserve(this.row(row.id),payload.operation==='approve'?'publish':'redact');this.store.audit(context.user.id,'gaming-setup.'+payload.operation,row.id,{reason},this.now());});return this.adminView(context);
    });
    const latest=this.outbox(row);assert(latest&&['failed','uncertain'].includes(latest.state),'Dieser Versand ist nicht zur Wiederholung offen.','conflict',409);
    if(latest.state==='uncertain'&&!row.thread_id)await this.reconcile(row);
    this.current(context,true);assert(this.row(row.id).revision===payload.expectedRevision,'Das Setup wurde inzwischen geändert. Bitte neu laden.','conflict',409);this.store.run("UPDATE gaming_setup_outbox SET state='queued',last_error='',updated_at=? WHERE id=? AND state IN ('failed','uncertain')",this.now(),latest.id);return this.adminView(context);
  }
  message(row) {
    const entry=this.entry(row),url=this.config.publicOrigin+'/eure-gaming-setups.html?setup='+row.id;
    const embed={title:entry.title,description:entry.description||'Mein Gaming-Setup',color:0xd4af37,author:{name:entry.authorName},url,
      fields:SPEC_KEYS.filter(key=>entry.specs[key]).map(key=>({name:SPEC_LABELS[key],value:entry.specs[key],inline:true})),footer:{text:'Eure Gaming Setups · Über die Website eingereicht'},timestamp:new Date(row.updated_at).toISOString()};
    if(entry.images[0])embed.image={url:this.config.publicOrigin+entry.images[0].url};
    const embeds=[embed,...entry.images.slice(1).map(image=>({url,image:{url:this.config.publicOrigin+image.url}}))];
    return {content:'',embeds,allowed_mentions:NO_MENTIONS,components:[{type:1,components:[{type:2,style:5,label:'Setup auf der Website ansehen',url}]}]};
  }
  async reconcile(row) {
    const forumId=row.forum_id||this.settings().settings.forumChannelId;await this.forumContext(forumId);
    const active=await this.discord.request('GET',`/guilds/${this.config.discordGuildId}/threads/active`),archived=await this.discord.request('GET',`/channels/${forumId}/threads/archived/public?limit=100`);
    assert(Array.isArray(active?.threads)&&Array.isArray(archived?.threads),'Discord hat keine gültige Threadliste geliefert.','network',502);
    const matches=[];for(const thread of [...active.threads,...archived.threads].filter((t,i,all)=>t?.parent_id===forumId&&t.owner_id===BOT_ID&&all.findIndex(x=>x.id===t.id)===i).slice(0,150)){
      if(!ID.test(thread.id||''))continue;const message=await this.discord.request('GET',`/channels/${thread.id}/messages/${thread.id}`);
      if(message?.author?.id===BOT_ID&&message.embeds?.some(embed=>embed.url===this.config.publicOrigin+'/eure-gaming-setups.html?setup='+row.id))matches.push({thread,message});
    }
    assert(matches.length===1,'Der frühere Versand ist unklar. Es wurde kein neuer Beitrag erstellt. Bitte den Setup-Beitrag in Discord prüfen und das Team kontaktieren.','uncertain',409);
    const {thread,message}=matches[0];this.store.run('UPDATE gaming_setups SET forum_id=?,thread_id=?,message_id=? WHERE id=? AND thread_id IS NULL',forumId,thread.id,message.id,row.id);
  }
  async deliver(job) {
    if(this.store.get('SELECT state FROM gaming_setup_outbox WHERE id=?',job.id)?.state!=='queued')return;
    let row=this.row(job.setup_id);const settings=this.settings().settings;
    const otherUncertain=this.store.get("SELECT 1 FROM gaming_setup_outbox WHERE setup_id=? AND state='uncertain' AND id<>?",row.id,job.id);
    if(!row.thread_id&&otherUncertain){this.store.run("UPDATE gaming_setup_outbox SET state='uncertain',last_error=?,updated_at=? WHERE id=?",'Ein früherer Versand ist unklar. Bitte zuerst im Control Center prüfen.',this.now(),job.id);return;}
    const publish=job.operation==='publish'&&this.isPublic(row)&&row.published_revision===job.revision;
    if(job.operation==='publish'&&!publish){this.store.run("UPDATE gaming_setup_outbox SET state='superseded',updated_at=? WHERE id=?",this.now(),job.id);return;}
    if(publish&&!settings.enabled)return;
    if(!publish&&!row.thread_id){this.store.run("UPDATE gaming_setup_outbox SET state='sent',updated_at=? WHERE id=?",this.now(),job.id);return;}
    this.store.run("UPDATE gaming_setup_outbox SET state='sending',attempts=attempts+1,updated_at=? WHERE id=? AND state='queued'",this.now(),job.id);
    let mutationAttempted=false;
    const recheck=()=>{
      const fresh=this.row(row.id),current=this.store.get('SELECT state FROM gaming_setup_outbox WHERE id=?',job.id);
      const allowed=current?.state==='sending'&&(publish?this.isPublic(fresh)&&fresh.published_revision===job.revision&&this.settings().settings.enabled:!this.isPublic(fresh));
      if(!allowed)this.store.run("UPDATE gaming_setup_outbox SET state='superseded',updated_at=? WHERE id=? AND state='sending'",this.now(),job.id);
      return allowed?fresh:null;
    };
    try {
      const forumId=row.forum_id||settings.forumChannelId;await this.forumContext(forumId);
      row=recheck();if(!row)return;const stillPublish=publish;
      if(publish)assert(this.settings().settings.enabled&&this.settings().settings.forumChannelId===forumId,'Die Setup-Veröffentlichung wurde ausgeschaltet.','conflict',409);
      const payload=()=>stillPublish?this.message(this.row(job.setup_id)):{content:'Dieser Setup-Beitrag wurde zurückgezogen oder vom Team ausgeblendet.',embeds:[],components:[],attachments:[],allowed_mentions:NO_MENTIONS};
      if(!row.thread_id){
        // Persist the target before a possibly ambiguous create; forum changes
        // remain blocked until the uncertain attempt has been reconciled.
        this.store.run('UPDATE gaming_setups SET forum_id=? WHERE id=?',forumId,row.id);
        if(!recheck())return;mutationAttempted=true;
        const response=await this.discord.request('POST',`/channels/${forumId}/threads`,{payload:{name:(safeName(this.account(row.user_id)?.name)+' · '+JSON.parse(row.published_json).title).slice(0,100),auto_archive_duration:1440,message:payload()}});
        assert(ID.test(response?.id||'')&&response.parent_id===forumId&&response.guild_id===this.config.discordGuildId&&response.owner_id===BOT_ID,'Discord hat den neuen Setup-Beitrag nicht eindeutig bestätigt.','uncertain',502);
        this.store.run('UPDATE gaming_setups SET thread_id=?,message_id=? WHERE id=?',response.id,response.id,row.id);
        assert(response.message?.id===response.id&&response.message.author?.id===BOT_ID,'Discord hat die Startnachricht nicht eindeutig bestätigt.','uncertain',502);
      }else{
        const thread=await this.discord.request('GET','/channels/'+row.thread_id);assert(thread?.parent_id===forumId&&thread.guild_id===this.config.discordGuildId&&thread.owner_id===BOT_ID,'Der Setup-Thread gehört nicht mehr zum erwarteten Forum.','forbidden',403);
        const before=await this.discord.request('GET',`/channels/${row.thread_id}/messages/${row.message_id}`);assert(before?.id===row.message_id&&before.author?.id===BOT_ID,'Die Startnachricht gehört nicht zum Bot.','forbidden',403);
        // Never delete a thread or member replies. Only update this bot's starter.
        if(!recheck())return;
        if(thread.thread_metadata?.archived){mutationAttempted=true;await this.discord.request('PATCH','/channels/'+row.thread_id,{payload:{archived:false}});}
        if(!recheck())return;mutationAttempted=true;
        const after=await this.discord.request('PATCH',`/channels/${row.thread_id}/messages/${row.message_id}`,{payload:payload()});assert(after?.id===row.message_id&&after.channel_id===row.thread_id&&after.author?.id===BOT_ID,'Discord hat die Änderung nicht eindeutig bestätigt.','uncertain',502);
      }
      this.store.transaction(()=>{this.store.run('UPDATE gaming_setups SET discord_revision=? WHERE id=?',stillPublish?job.revision:0,row.id);this.store.run("UPDATE gaming_setup_outbox SET state='sent',last_error='',updated_at=? WHERE id=?",this.now(),job.id);});
    }catch(error){const definiteRejection=error instanceof AppError&&error.status>=400&&error.status<500&&error.kind!=='uncertain';const uncertain=error.kind==='uncertain'||mutationAttempted&&!definiteRejection;this.store.run('UPDATE gaming_setup_outbox SET state=?,last_error=?,updated_at=? WHERE id=?',uncertain?'uncertain':'failed',safeMessage(error.message),this.now(),job.id);}
  }
  tick() {
    if(this.running)return this.running;if(this.stopping)return Promise.resolve();
    this.running=(async()=>{
      this.backfillReviewNotices();
      // Suspension hides public output immediately and schedules redaction of
      // already-published bot content; drafts never create an automatic post.
      for(const row of this.store.all("SELECT s.* FROM gaming_setups s JOIN accounts a ON a.id=s.user_id WHERE (a.suspended=1 OR a.confirmed=0) AND s.status='published'"))this.store.transaction(()=>{this.store.run("UPDATE gaming_setups SET revision=revision+1,status='hidden',blocked=1,updated_at=? WHERE id=?",this.now(),row.id);this.reserve(this.row(row.id),'redact');});
      for(const job of this.store.all("SELECT * FROM gaming_setup_outbox WHERE state='queued' ORDER BY updated_at,id LIMIT 20")){if(this.stopping)break;await this.deliver(job);}
    })().finally(()=>{this.running=null;});return this.running;
  }
  start() { if(this.timer)return;this.stopping=false;this.timer=this.setTimer(()=>{this.tick().catch(()=>{});},15000);this.timer?.unref?.();this.tick().catch(()=>{}); }
  async stop() { this.stopping=true;if(this.timer)this.clearTimer(this.timer);this.timer=null;if(this.running)await this.running; }
  async handle(req,res) {
    const route=new URL(req.url,'http://local.invalid').pathname;
    if(route!=='/api/gaming-setups'&&!route.startsWith('/api/gaming-setups/')&&route!=='/api/account/gaming-setup'&&!route.startsWith('/api/account/gaming-setup/'))return false;
    const send=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
    const body=async()=>{assert(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')&&!req.headers['content-encoding'],'Bitte unkomprimierte JSON-Daten senden.','validation',415);return parseJson(await readBody(req,16*1024));};
    const sendImage=async(id,context)=>{const image=await this.readImage(id,context);res.writeHead(200,{'Content-Type':image.mimeType,'Content-Length':image.bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:image.bytes);};
    try {
      this.accounts.limit('gaming-setups:public:'+(req.socket?.remoteAddress||'unknown'),200);
      if(route==='/api/gaming-setups'&&req.method==='GET'){send(this.list());return true;}
      const publicImage=/^\/api\/gaming-setups\/images\/(gallery_[a-f0-9]{64})$/.exec(route);if(publicImage&&['GET','HEAD'].includes(req.method)){await sendImage(publicImage[1],null);return true;}
      const detail=/^\/api\/gaming-setups\/([a-f0-9-]{36})$/.exec(route);if(detail&&req.method==='GET'){send(this.detail(detail[1]));return true;}
      const context=await this.accounts.authenticateRequest(req,{mutation:!['GET','HEAD'].includes(req.method)});this.accounts.limit('gaming-setups:user:'+context.user.id,80);
      if(route==='/api/account/gaming-setup'){
        if(req.method==='GET'){send(this.view(context));return true;}
        if(req.method==='PUT'){this.accounts.limit('gaming-setups:save:'+context.user.id,30,3600_000);send(await this.save(context,await body()));return true;}
      }
      if(route==='/api/account/gaming-setup/images'&&req.method==='POST'){this.accounts.limit('gaming-setups:image:'+context.user.id,20,3600_000);send(await this.upload(context,req),201);return true;}
      const privateImage=/^\/api\/account\/gaming-setup\/images\/(gallery_[a-f0-9]{64})$/.exec(route);if(privateImage&&['GET','HEAD'].includes(req.method)){await sendImage(privateImage[1],context);return true;}
      if(route==='/api/account/gaming-setup/withdraw'&&req.method==='POST'){send(await this.withdraw(context,await body()));return true;}
      throw new AppError('not_found','Diese Setup-Funktion ist nicht vorhanden.',404);
    }catch(error){const failure=errorBody(error);send({...failure,error:{code:failure.kind,message:failure.message}},error instanceof AppError?error.status:500);return true;}
  }
}
