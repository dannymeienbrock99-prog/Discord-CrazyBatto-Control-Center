import { createHash, randomUUID } from 'node:crypto';
import { AppError, assert, errorBody } from './errors.mjs';
import { inspectImageBytes } from './payloads.mjs';
import { readBody } from './multipart.mjs';
import { CONTROL_UUID, controlFields as fields, controlText as text, controlBody, controlResponse, ensureControlNotices, controlNotice, controlPage, controlNextCursor } from './control-members.mjs';

const SPECS=['cpu','gpu','mainboard','ram','os','psu'],STATES=['submitted','counter_offer','pending_review','approved','rejected','closed'];
const IMAGE=/^gallery_[a-f0-9]{64}$/;
export const PC_SUPPORT_LIMITS=Object.freeze({subject:120,symptoms:6000,spec:200,maxImages:6,maxImageBytes:8*1024*1024,maxUploads:30,maxUploadBytes:120*1024*1024,minOfferCents:1000,maxOfferCents:10000000});
const hash=value=>createHash('sha256').update(value).digest('hex');
const PRICE=value=>Number.isSafeInteger(value)&&value>=PC_SUPPORT_LIMITS.minOfferCents&&value<=PC_SUPPORT_LIMITS.maxOfferCents;
const safeName=value=>String(value||'Mitglied').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'').slice(0,100);
function technical(value) {
  fields(value,['category','subject','symptoms','specs','drivers']);
  assert(['hardware','software'].includes(value.category)&&['current','outdated','unknown'].includes(value.drivers),'Bitte Art der Hilfe und Treiberstand auswählen.');fields(value.specs,SPECS);
  return {category:value.category,subject:text(value.subject,120,3),symptoms:text(value.symptoms,6000,10),specs:Object.fromEntries(SPECS.map(key=>[key,text(value.specs[key],200,1)])),drivers:value.drivers};
}
function order(value) {
  fields(value,['requested','offerCents','contact','consent']);fields(value.contact,['email','phone']);
  assert(typeof value.requested==='boolean'&&typeof value.consent==='boolean','Bitte die Auftragseinstellung angeben.');
  const email=text(value.contact.email,254),phone=text(value.contact.phone,40);
  if(!value.requested){assert(value.offerCents===null&&!email&&!phone&&!value.consent,'Kontaktdaten und Preis gehören nur zu einer ausdrücklich gewünschten Auftragsanfrage.');return {requested:false,offerCents:null,contact:{email:'',phone:''},consent:false};}
  assert(PRICE(value.offerCents),'Bitte einen Preisvorschlag von mindestens 10 Euro angeben.');
  assert(value.consent,'Bitte die private Weitergabe deiner Kontaktdaten an das Team bestätigen.');
  assert(email||phone,'Bitte eine E-Mail-Adresse oder Telefonnummer für die Rückmeldung angeben.');
  assert(!email||/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),'Bitte eine gültige Kontakt-E-Mail angeben.');
  assert(!phone||(/^[+()0-9 .\/-]+$/.test(phone)&&phone.replace(/\D/g,'').length>=7&&phone.replace(/\D/g,'').length<=20),'Bitte eine gültige Telefonnummer angeben.');
  return {requested:true,offerCents:value.offerCents,contact:{email,phone},consent:true};
}
export function pcSupportDraft(value) {
  fields(value,['category','subject','symptoms','specs','drivers','imageIds','order']);
  assert(Array.isArray(value.imageIds)&&value.imageIds.length<=6&&new Set(value.imageIds).size===value.imageIds.length&&value.imageIds.every(id=>typeof id==='string'&&IMAGE.test(id)),'Bitte höchstens sechs eigene Bilder auswählen.');
  return {...technical({category:value.category,subject:value.subject,symptoms:value.symptoms,specs:value.specs,drivers:value.drivers}),imageIds:[...value.imageIds],order:order(value.order)};
}

export class PCSupport {
  constructor(service,{now=service.accounts.now || Date.now}={}) {
    this.service=service;this.accounts=service.accounts;this.store=this.accounts.store;this.storage=this.accounts.imageStorage;this.now=now;this.pending=new Set();this.uploading=new Set();
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS pc_support_tickets(
      id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES accounts(id),request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,
      revision INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('submitted','counter_offer','pending_review','approved','rejected','closed')),
      data_json TEXT NOT NULL,proposed_cents INTEGER,accepted_cents INTEGER,accepted_at INTEGER,admin_note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,reviewed_at INTEGER,reviewed_by TEXT REFERENCES accounts(id),closed_at INTEGER,
      UNIQUE(user_id,request_id));
      CREATE INDEX IF NOT EXISTS pc_support_tickets_user ON pc_support_tickets(user_id,updated_at,id);
      CREATE TABLE IF NOT EXISTS pc_support_images(
        user_id TEXT NOT NULL REFERENCES accounts(id),id TEXT NOT NULL,filename TEXT NOT NULL,mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,id));
      CREATE INDEX IF NOT EXISTS pc_support_images_id ON pc_support_images(id);`);
    ensureControlNotices(this.store);
  }
  current(context,admin=false) { return this.accounts.assertCurrent(context,{admin}); }
  row(id) { assert(CONTROL_UUID.test(id||''),'Dieses Ticket ist nicht vorhanden.','not_found',404);const row=this.store.get('SELECT * FROM pc_support_tickets WHERE id=?',id);assert(row,'Dieses Ticket ist nicht vorhanden.','not_found',404);return row; }
  accessible(context,id,admin=false) { const user=this.current(context,admin),row=this.row(id);assert(user.isAdmin||row.user_id===user.id,'Dieses Ticket ist nicht vorhanden.','not_found',404);return row; }
  revision(row,value) { assert(Number.isSafeInteger(value)&&value>=0&&row.revision===value,'Das Ticket wurde inzwischen geändert. Bitte neu laden.','conflict',409); }
  image(userId,id) { assert(IMAGE.test(id||''),'Dieses Bild ist nicht vorhanden.','not_found',404);const row=this.store.get('SELECT * FROM pc_support_images WHERE user_id=? AND id=?',userId,id);assert(row,'Dieses Bild gehört nicht zu deiner PC-Hilfe.','forbidden',403);return row; }
  hasImage(id) { return !!this.store.get('SELECT 1 FROM pc_support_images WHERE id=? LIMIT 1',id); }
  imageView(row) { return {id:row.id,name:row.filename,mimeType:row.mime_type,size:row.size,width:row.width,height:row.height,url:'/api/account/pc-support/images/'+row.id}; }
  view(row) {
    const data=JSON.parse(row.data_json),author=this.store.get('SELECT id,name,email FROM accounts WHERE id=?',row.user_id);
    return {id:row.id,requestId:row.request_id,userId:row.user_id,author:{id:author.id,name:safeName(author.name),email:author.email},revision:row.revision,status:row.status,
      category:data.category,subject:data.subject,symptoms:data.symptoms,specs:data.specs,drivers:data.drivers,
      images:data.imageIds.map(id=>this.imageView(this.image(row.user_id,id))),
      order:{...data.order,proposedCents:row.proposed_cents,acceptedCents:row.accepted_cents,acceptedAt:row.accepted_at},
      adminNote:row.admin_note,createdAt:row.created_at,updatedAt:row.updated_at,reviewedAt:row.reviewed_at,reviewedBy:row.reviewed_by,closedAt:row.closed_at};
  }
  own(context) { const user=this.current(context);return {tickets:this.store.all('SELECT * FROM pc_support_tickets WHERE user_id=? ORDER BY updated_at DESC,id DESC LIMIT 100',user.id).map(row=>this.view(row)),limits:PC_SUPPORT_LIMITS}; }
  detail(context,id,admin=false) { return {ticket:this.view(this.accessible(context,id,admin))}; }
  async exclusive(key,task) { assert(!this.pending.has(key),'Dieses Ticket wird bereits bearbeitet. Bitte kurz warten.','conflict',409);this.pending.add(key);try{return await task();}finally{this.pending.delete(key);} }
  async checkImages(context,userId,ids) { for(const id of ids){const row=this.image(userId,id);await this.storage.read(id,{mimeType:row.mime_type,size:row.size,width:row.width,height:row.height});this.current(context);this.image(userId,id);} }
  async create(context,input) {
    fields(input,['requestId','category','subject','symptoms','specs','drivers','imageIds','order']);assert(CONTROL_UUID.test(input.requestId),'Die Anfragekennung ist ungültig.');
    const {requestId,...raw}=input,draft=pcSupportDraft(raw),user=this.current(context),fingerprint=hash(JSON.stringify(draft));
    return this.exclusive('user:'+user.id,async()=>{
      const existing=this.store.get('SELECT * FROM pc_support_tickets WHERE user_id=? AND request_id=?',user.id,requestId);
      if(existing){assert(existing.fingerprint===fingerprint,'Diese Anfragekennung gehört zu einem anderen Ticket.','conflict',409);return {ticket:this.view(existing)};}
      assert(this.store.get("SELECT COUNT(*) AS n FROM pc_support_tickets WHERE user_id=? AND status NOT IN ('closed','rejected')",user.id).n<20,'Du hast bereits 20 offene Anfragen. Bitte zuerst vorhandene Tickets klären.','capacity',409);
      await this.checkImages(context,user.id,draft.imageIds);this.current(context);
      const id=randomUUID(),now=this.now();
      this.store.transaction(()=>{
        this.current(context);
        this.store.run("INSERT INTO pc_support_tickets(id,user_id,request_id,fingerprint,revision,status,data_json,accepted_cents,accepted_at,created_at,updated_at) VALUES (?,?,?,?,1,'submitted',?,?,?,?,?)",id,user.id,requestId,fingerprint,JSON.stringify(draft),draft.order.requested?draft.order.offerCents:null,draft.order.requested?now:null,now,now);
        this.store.audit(user.id,'pc-support.submitted',id,{revision:1,paidRequest:draft.order.requested},now);
        controlNotice(this.store,draft.order.requested?'pc_order':'pc_ticket',id,1,now);
      });return {ticket:this.view(this.row(id))};
    });
  }
  async update(context,id,input) {
    fields(input,['expectedRevision','category','subject','symptoms','specs','drivers','imageIds','order']);const {expectedRevision,...raw}=input,draft=pcSupportDraft(raw),user=this.current(context);
    return this.exclusive('ticket:'+id,async()=>{
      let row=this.accessible(context,id);assert(row.user_id===user.id,'Nur das Mitglied kann seine ursprüngliche Anfrage neu einreichen.','forbidden',403);this.revision(row,expectedRevision);assert(['submitted','rejected'].includes(row.status),'Dieses Ticket kann gerade nicht neu eingereicht werden.','conflict',409);
      await this.checkImages(context,user.id,draft.imageIds);row=this.accessible(context,id);this.revision(row,expectedRevision);
      this.store.transaction(()=>{
        this.current(context);const now=this.now();this.revision(this.row(id),expectedRevision);
        this.store.run("UPDATE pc_support_tickets SET revision=revision+1,status='submitted',data_json=?,proposed_cents=NULL,accepted_cents=?,accepted_at=?,admin_note='',reviewed_at=NULL,reviewed_by=NULL,updated_at=? WHERE id=?",JSON.stringify(draft),draft.order.requested?draft.order.offerCents:null,draft.order.requested?now:null,now,id);
        this.store.audit(user.id,'pc-support.resubmitted',id,{revision:expectedRevision+1},now);controlNotice(this.store,draft.order.requested?'pc_order':'pc_ticket',id,expectedRevision+1,now);
      });return this.detail(context,id);
    });
  }
  async respond(context,id,input) {
    fields(input,['expectedRevision','decision','offerCents','confirm']);assert(input.confirm===true&&['accept','decline'].includes(input.decision)&&PRICE(input.offerCents),'Bitte den konkreten Preisvorschlag bestätigen oder ablehnen.');
    return this.exclusive('ticket:'+id,()=>{
      const user=this.current(context),row=this.accessible(context,id);assert(row.user_id===user.id,'Nur das anfragende Mitglied kann diesen Preis annehmen.','forbidden',403);this.revision(row,input.expectedRevision);
      assert(row.status==='counter_offer'&&row.proposed_cents===input.offerCents,'Dieser Gegenvorschlag ist nicht mehr aktuell. Bitte neu laden.','conflict',409);
      this.store.transaction(()=>{
        this.current(context);this.revision(this.row(id),input.expectedRevision);const now=this.now(),accepted=input.decision==='accept';
        this.store.run('UPDATE pc_support_tickets SET status=?,revision=revision+1,accepted_cents=?,accepted_at=?,updated_at=? WHERE id=?',accepted?'pending_review':'rejected',accepted?row.proposed_cents:row.accepted_cents,accepted?now:row.accepted_at,now,id);
        this.store.audit(user.id,'pc-support.offer_'+input.decision,id,{revision:row.revision+1,offerCents:input.offerCents},now);if(accepted)controlNotice(this.store,'pc_order',id,row.revision+1,now);
      });return this.detail(context,id);
    });
  }
  query(context,input={}) {
    this.current(context,true);const query=controlPage(input,{statuses:['all',...STATES],kinds:['all','help','order']}),where=[],args=[];
    if(query.status!=='all'){where.push('t.status=?');args.push(query.status);}
    if(query.kind!=='all'){where.push("json_extract(t.data_json,'$.order.requested')=?");args.push(query.kind==='order'?1:0);}
    if(query.search){where.push("(instr(lower(json_extract(t.data_json,'$.subject')),lower(?))>0 OR instr(lower(a.name),lower(?))>0 OR instr(lower(a.email),lower(?))>0)");args.push(query.search,query.search,query.search);}
    if(query.cursor){where.push('(t.updated_at<? OR (t.updated_at=? AND t.id<?))');args.push(query.cursor[0],query.cursor[0],query.cursor[1]);}
    const rows=this.store.all(`SELECT t.* FROM pc_support_tickets t JOIN accounts a ON a.id=t.user_id ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY t.updated_at DESC,t.id DESC LIMIT ?`,...args,query.limit+1),counts={total:0,...Object.fromEntries(STATES.map(state=>[state,0])),orders:0};
    for(const row of this.store.all('SELECT status,COUNT(*) AS n FROM pc_support_tickets GROUP BY status')){counts[row.status]=row.n;counts.total+=row.n;}
    counts.orders=this.store.get("SELECT COUNT(*) AS n FROM pc_support_tickets WHERE json_extract(data_json,'$.order.requested')=1").n;
    return {tickets:rows.slice(0,query.limit).map(row=>this.view(row)),nextCursor:controlNextCursor(rows,query.limit,'updated_at'),counts,limits:PC_SUPPORT_LIMITS};
  }
  async review(context,id,input) {
    fields(input,['expectedRevision','decision','reason','patch','offerCents','confirm']);assert(input.confirm===true&&['approve','reject','edit','counter_offer'].includes(input.decision),'Bitte eine gültige Entscheidung bestätigen.');
    const note=text(input.reason,2000,['reject','counter_offer'].includes(input.decision)?3:0);fields(input.patch,['category','subject','symptoms','specs','drivers'],[]);
    return this.exclusive('ticket:'+id,()=>{
      const actor=this.current(context,true),row=this.accessible(context,id,true);this.revision(row,input.expectedRevision);assert(!['closed','rejected'].includes(row.status),'Dieses Ticket ist abgeschlossen. Das Mitglied kann eine abgelehnte Anfrage neu einreichen.','conflict',409);
      const old=JSON.parse(row.data_json),next={...old,...technical({...technical({category:old.category,subject:old.subject,symptoms:old.symptoms,specs:old.specs,drivers:old.drivers}),...input.patch})};
      let status=row.status,proposed=row.proposed_cents;
      if(input.decision==='counter_offer') {assert(old.order.requested&&PRICE(input.offerCents)&&input.offerCents!==(row.proposed_cents??row.accepted_cents)&&['submitted','counter_offer','pending_review'].includes(row.status),'Bitte einen geänderten Preis für eine offene Auftragsanfrage angeben.');status='counter_offer';proposed=input.offerCents;}
      else if(input.decision==='approve') {assert(['submitted','pending_review'].includes(row.status),'Diese Anfrage ist noch nicht zur endgültigen Freigabe bereit.','conflict',409);assert(old.order.requested?(PRICE(input.offerCents)&&input.offerCents===row.accepted_cents&&(row.proposed_cents===null||row.proposed_cents===row.accepted_cents)):input.offerCents===null,'Der freizugebende Preis muss genau dem bestätigten Kundenvorschlag entsprechen.','conflict',409);status='approved';}
      else {assert(input.offerCents===null,'Preisänderungen benötigen einen Gegenvorschlag und die Annahme des Mitglieds.');if(input.decision==='reject')status='rejected';}
      this.store.transaction(()=>{
        this.current(context,true);this.revision(this.row(id),input.expectedRevision);const now=this.now();
        this.store.run('UPDATE pc_support_tickets SET status=?,revision=revision+1,data_json=?,proposed_cents=?,admin_note=?,reviewed_at=?,reviewed_by=?,updated_at=? WHERE id=?',status,JSON.stringify(next),proposed,note,now,actor.id,now,id);
        this.store.audit(actor.id,'pc-support.'+input.decision,id,{revision:row.revision+1,...(input.offerCents!==null?{offerCents:input.offerCents}:{})},now);
      });return this.detail(context,id,true);
    });
  }
  async close(context,id,input) {
    fields(input,['expectedRevision','reason','confirm']);assert(input.confirm===true,'Bitte das Schließen bestätigen.');const reason=text(input.reason,2000,3);
    return this.exclusive('ticket:'+id,()=>{
      const actor=this.current(context,true),row=this.accessible(context,id,true);this.revision(row,input.expectedRevision);assert(row.status!=='closed','Dieses Ticket wurde bereits geschlossen.','conflict',409);
      this.store.transaction(()=>{this.current(context,true);this.revision(this.row(id),input.expectedRevision);const now=this.now();this.store.run("UPDATE pc_support_tickets SET status='closed',revision=revision+1,admin_note=?,closed_at=?,updated_at=?,reviewed_at=?,reviewed_by=? WHERE id=?",reason,now,now,now,actor.id,id);this.store.audit(actor.id,'pc-support.closed',id,{revision:row.revision+1},now);});return this.detail(context,id,true);
    });
  }
  async upload(context,req) {
    const user=this.current(context);assert(!this.uploading.has(user.id)&&this.uploading.size<4,'Ein Bild wird bereits übertragen. Bitte kurz warten.','rate_limited',429);this.uploading.add(user.id);
    try {
      const mimeType=String(req.headers['content-type']||'').split(';')[0].trim(),length=Number(req.headers['content-length']);
      assert(['image/jpeg','image/png','image/webp'].includes(mimeType)&&!req.headers['content-encoding'],'Bitte JPG, PNG oder WebP verwenden.','validation',415);
      assert(/^\d+$/.test(req.headers['content-length']||'')&&Number.isSafeInteger(length)&&length>0&&length<=PC_SUPPORT_LIMITS.maxImageBytes,'Das Bild darf höchstens 8 MiB groß sein.','validation',413);
      let name;try{name=decodeURIComponent(req.headers['x-file-name']||'');}catch{throw new AppError('validation','Der Bildname ist ungültig.');}
      assert(typeof name==='string'&&name.length>0&&name.length<=160&&!/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069/\\:]/u.test(name),'Bitte einen gültigen Bilddateinamen wählen.');
      const bytes=await readBody(req,PC_SUPPORT_LIMITS.maxImageBytes);assert(bytes.length===length,'Das Bild wurde nicht vollständig übertragen.');const dimensions=inspectImageBytes(bytes,mimeType),id='gallery_'+hash(bytes);
      return await this.accounts.gallery.exclusive(async()=>{
        this.current(context);const old=this.store.get('SELECT * FROM pc_support_images WHERE user_id=? AND id=?',user.id,id),quota=this.store.get('SELECT COUNT(*) AS n,COALESCE(SUM(size),0) AS size FROM pc_support_images WHERE user_id=?',user.id);
        assert(old||(quota.n<30&&quota.size+bytes.length<=PC_SUPPORT_LIMITS.maxUploadBytes),'Dein PC-Hilfe-Bildspeicher ist voll.','capacity',409);
        await this.storage.put(id,bytes,{mimeType,...dimensions});this.current(context);
        if(!old)this.store.run('INSERT INTO pc_support_images VALUES (?,?,?,?,?,?,?,?)',user.id,id,name,mimeType,bytes.length,dimensions.width,dimensions.height,this.now());
        this.store.audit(user.id,'pc-support.image',id,{},this.now());return {image:this.imageView(this.image(user.id,id))};
      });
    } finally {this.uploading.delete(user.id);}
  }
  async readImage(context,id,{admin=false,preview=false}={}) {
    const authorize=()=>{const user=this.current(context,admin);assert(IMAGE.test(id),'Dieses Bild ist nicht vorhanden.','not_found',404);const row=user.isAdmin?this.store.get('SELECT * FROM pc_support_images WHERE id=? LIMIT 1',id):this.store.get('SELECT * FROM pc_support_images WHERE user_id=? AND id=?',user.id,id);assert(row,'Dieses Bild ist nicht vorhanden.','not_found',404);return row;};
    const row=authorize(),bytes=await this.storage.read(id,{mimeType:row.mime_type,size:row.size,width:row.width,height:row.height});authorize();
    return preview?{mimeType:row.mime_type,dataUrl:`data:${row.mime_type};base64,${bytes.toString('base64')}`}:{bytes,mimeType:row.mime_type};
  }
  async handle(req,res) {
    const route=new URL(req.url,'http://local.invalid').pathname,isAdmin=route.startsWith('/api/admin/pc-support'),own=route.startsWith('/api/account/pc-support');
    if(!isAdmin&&!own)return false;
    try {
      const context=await this.accounts.authenticateRequest(req,{mutation:!['GET','HEAD'].includes(req.method),requireAdmin:isAdmin});this.current(context,isAdmin);this.accounts.limit('pc-support:'+context.user.id,120);
      const root=isAdmin?'/api/admin/pc-support':'/api/account/pc-support',suffix=route.slice(root.length),image=/^\/images\/(gallery_[a-f0-9]{64})(\/preview)?$/.exec(suffix);
      if(image&&['GET','HEAD'].includes(req.method)) {
        assert(!image[2]||isAdmin,'Diese Vorschau ist nicht vorhanden.','not_found',404);
        const data=await this.readImage(context,image[1],{admin:isAdmin,preview:!!image[2]});
        if(image[2])controlResponse(res,data);else{res.writeHead(200,{'Content-Type':data.mimeType,'Content-Length':data.bytes.length,'Cache-Control':'no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:data.bytes);}return true;
      }
      if(!isAdmin&&suffix==='/images'&&req.method==='POST'){this.accounts.limit('pc-support-upload:'+context.user.id,30);controlResponse(res,await this.upload(context,req),201);return true;}
      if(isAdmin&&suffix==='/query'&&req.method==='POST'){controlResponse(res,this.query(context,await controlBody(req)));return true;}
      if(!isAdmin&&suffix===''&&req.method==='GET'){controlResponse(res,this.own(context));return true;}
      if(!isAdmin&&suffix===''&&req.method==='POST'){this.accounts.limit('pc-support-create:'+context.user.id,10,3600_000);controlResponse(res,await this.create(context,await controlBody(req)),201);return true;}
      const ticket=/^\/([0-9a-f-]{36})(?:\/(review|close|respond))?$/i.exec(suffix);
      if(ticket){
        if(!ticket[2]&&req.method==='GET'){controlResponse(res,this.detail(context,ticket[1],isAdmin));return true;}
        if(!isAdmin&&!ticket[2]&&req.method==='PUT'){controlResponse(res,await this.update(context,ticket[1],await controlBody(req)));return true;}
        if(req.method==='POST'&&((isAdmin&&['review','close'].includes(ticket[2]))||(!isAdmin&&ticket[2]==='respond'))){controlResponse(res,await this[ticket[2]](context,ticket[1],await controlBody(req)));return true;}
      }
      throw new AppError('not_found','Diese PC-Hilfe-Funktion ist nicht vorhanden.',404);
    } catch(error) {controlResponse(res,errorBody(error),error instanceof AppError?error.status:500);}
    return true;
  }
}
