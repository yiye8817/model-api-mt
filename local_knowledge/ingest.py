import hashlib
import os
import re
import shutil
import threading
from dataclasses import asdict
from pathlib import Path, PurePosixPath

from .config import stable_hash
from .contracts import Source, ScanResult, ParseLimits
from .jobs import JobQueue
from .model_clients import Budget, Cancelled
from .parsers import TEXT_SUFFIXES, ParseError, parse_file
from .text import chunk_document, keyword_tokens

SKIP_DIRS={'.git','node_modules','.venv','.venv-run','venv','env','dist','build','__pycache__','.cache'}
SENSITIVE=re.compile(r'^(\.env(?:\..*)?|id_(?:rsa|ed25519|ecdsa|dsa)(?:\..*)?|.*\.(?:pem|key|p12|pfx))$',re.I)


def scan_root(root,explicit_files=()):
    root=Path(root).resolve(); result=ScanResult()
    if not root.is_dir(): raise ValueError('Selected root must be a directory')
    def inspect(path,explicit=False):
        try:
            real=path.resolve()
            if not real.is_relative_to(root): reason='outside_root'
            elif SENSITIVE.match(path.name): reason='sensitive_name'
            elif path.name.startswith('.') and not explicit: reason='hidden_file'
            elif path.suffix.lower() not in TEXT_SUFFIXES|{'.pdf','.docx'}: reason='unsupported_extension'
            elif len(result.files)>=2000:
                result.failed.append({'path':str(path),'status':'failed','reason':'file_count_limit'}); return
            else: result.files.append(real); return
            result.skipped.append({'path':str(path),'status':'skipped','reason':reason})
        except OSError as exc: result.failed.append({'path':str(path),'status':'failed','reason':str(exc)[:200]})
    if explicit_files:
        for path in explicit_files: inspect(Path(path),True)
    else:
        for directory,dirs,files in os.walk(root,followlinks=False):
            dirs[:]=sorted(d for d in dirs if d not in SKIP_DIRS and not d.startswith('.') and not Path(directory,d).is_symlink())
            for name in sorted(files): inspect(Path(directory,name))
    return result


def _read_selected(path,root):
    path,root=Path(path),Path(root).resolve()
    relative=path.relative_to(root)
    root_stat=root.stat(); fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        pinned=os.fstat(fd)
        if (pinned.st_dev,pinned.st_ino)!=(root_stat.st_dev,root_stat.st_ino): raise ValueError('Selected root changed')
        for part in relative.parts[:-1]:
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd); fd=child
        file_fd=os.open(relative.name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd)
        with os.fdopen(file_fd,'rb') as handle:
            before=os.fstat(handle.fileno())
            if before.st_size>ParseLimits().max_file_bytes: raise ParseError('file_too_large')
            raw=handle.read(ParseLimits().max_file_bytes+1)
            after=os.fstat(handle.fileno())
            if len(raw)>ParseLimits().max_file_bytes: raise ParseError('file_too_large')
            if (before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_size,after.st_mtime_ns,after.st_ctime_ns): raise ParseError('source_changed')
            return raw,after
    finally: os.close(fd)


def file_source(path,root):
    path=Path(path); root=Path(root).resolve(); raw,stat=_read_selected(path,root)
    return Source(id=stable_hash(['file',str(root),str(path)]),title=path.name,content_hash=hashlib.sha256(raw).hexdigest(),
        locator={'kind':'file','path':str(path),'root':str(root),'file_stat':{'size':stat.st_size,'mtime_ns':stat.st_mtime_ns,'dev':stat.st_dev,'inode':stat.st_ino}})


def check_file_freshness(source):
    if source.locator.get('kind')!='file': return True
    try:
        current=file_source(Path(source.locator['path']),Path(source.locator['root']))
        return current.content_hash==source.content_hash
    except (OSError,ValueError,ParseError): return False


def safe_relative_path(value):
    normalized=value.replace('\\','/')
    path=PurePosixPath(normalized)
    if not normalized or path.is_absolute() or '..' in path.parts or re.match(r'^[A-Za-z]:',normalized) or any(SENSITIVE.match(x) for x in path.parts):
        raise ValueError('Invalid or sensitive upload relative path')
    return path


class ImportManager:
    def __init__(self,store,index_revision=None):
        self.store=store; self.index_revision=index_revision; self.jobs=JobQueue(store)
        self._events=self.jobs.events; self._lock=threading.RLock()

    def close(self):
        for event in self._events.values(): event.set()
        self.jobs.close()

    def enqueue(self,payload):
        kind=payload.get('kind')
        if kind not in ('paths','upload','api_chats','web'): raise ValueError('Invalid import kind')
        if kind=='paths' and (not isinstance(payload.get('roots'),list) or not payload['roots']): raise ValueError('Explicit roots are required')
        job_id=self.store.create_job(kind,payload); self._events[job_id]=threading.Event()
        if kind=='upload': self.store.update_job(job_id,status='uploading',phase='uploading')
        elif kind=='paths': self.jobs.submit(job_id,self._run_paths)
        return job_id

    def snapshot(self,job_id):
        job=self.store.job(job_id)
        if job is None: raise KeyError(job_id)
        return job

    def cancel(self,job_id):
        job=self.snapshot(job_id)
        if job['status'] in ('done','failed','cancelled'): return False
        self._events.setdefault(job_id,threading.Event()).set()
        self.store.update_job(job_id,cancel_requested=True)
        if job['status'] in ('uploading','waiting_index'): self.store.update_job(job_id,status='cancelled',phase='cancelled')
        return True

    def append_upload(self,job_id,files,final,batch_id=None):
        with self._lock:
            job=self.snapshot(job_id)
            if job['cancel_requested']: raise ValueError('Upload cancelled')
            paths=[safe_relative_path(f.relative_path) for f in files]
            raw_files=[]; size=0
            for item in files:
                raw=item.stream.read(20*1024*1024+1)
                if len(raw)>20*1024*1024: raise ParseError('file_too_large')
                size+=len(raw); raw_files.append(raw)
                if size>40*1024*1024: raise ParseError('upload_batch_too_large')
            if size>40*1024*1024: raise ParseError('upload_batch_too_large')
            payload=job['payload']; old=payload.get('files',[]); hashes=payload.get('batches',{})
            digest=stable_hash([(str(p),hashlib.sha256(r).hexdigest()) for p,r in zip(paths,raw_files)])
            if batch_id and batch_id in hashes:
                if hashes[batch_id]!=digest: raise ValueError('Batch ID already has different content')
                return job
            if job['status']!='uploading': raise ValueError('Upload already finalized')
            if len(old)+len(files)>2000: raise ValueError('file_count_limit')
            if len(set(str(p) for p in paths))!=len(paths) or any(str(p) in {x['relative_path'] for x in old} for p in paths): raise ValueError('Duplicate upload path')
            folder=self.store.data_dir/'imports'/job_id; folder.mkdir(parents=True,exist_ok=True)
            for ordinal,(path,raw,item) in enumerate(zip(paths,raw_files,files),len(old)):
                destination=folder/(str(ordinal)+path.suffix)
                destination.write_bytes(raw)
                old.append({'path':str(destination),'relative_path':str(path),'encoding':item.encoding})
            if batch_id: hashes[batch_id]=digest
            payload.update(files=old,batches=hashes)
            job=self.store.update_job(job_id,payload=payload,total=len(old))
            if final:
                self.store.update_job(job_id,status='queued',phase='queued')
                self.jobs.submit(job_id,self._run_upload)
            return job

    def _run_paths(self,job_id):
        job=self.snapshot(job_id); event=self._events.setdefault(job_id,threading.Event())
        files=[]; items=[]
        for value in job['payload']['roots']:
            selected=Path(value).expanduser().resolve()
            root=selected if selected.is_dir() else selected.parent
            explicit=[selected] if selected.is_file() else [Path(x).expanduser().resolve() for x in job['payload'].get('explicit_files',[]) if Path(x).expanduser().resolve().is_relative_to(root)]
            result=scan_root(root,explicit)
            items.extend(result.skipped+result.failed)
            files.extend((path,root) for path in result.files)
        files=list(dict.fromkeys(files))
        if len(files)>2000:
            items.extend({'path':str(p),'status':'failed','reason':'file_count_limit'} for p,_ in files[2000:]); files=files[:2000]
        self._process(job_id,files,items,event,uploaded=False)

    def _run_upload(self,job_id):
        job=self.snapshot(job_id); event=self._events.setdefault(job_id,threading.Event())
        self._process(job_id,job['payload'].get('files',[]),[],event,uploaded=True)

    def _process(self,job_id,files,items,event,uploaded):
        self.store.update_job(job_id,status='running',phase='parsing',total=len(files)+len(items))
        payload=self.snapshot(job_id)['payload']; waiting=False
        for entry in files:
            if event.is_set(): break
            path=Path(entry['path']) if uploaded else entry[0]
            try:
                if uploaded:
                    source=Source(id=stable_hash(['upload',job_id,entry['relative_path']]),title=entry['relative_path'],content_hash=hashlib.sha256(path.read_bytes()).hexdigest(),locator={'kind':'upload','relative_path':entry['relative_path'],'copy_path':str(path)})
                    parse_path=path
                else:
                    root=entry[1]; raw,stat=_read_selected(path,root)
                    source=file_source(path,root)
                    if source.content_hash!=hashlib.sha256(raw).hexdigest(): raise ParseError('source_changed')
                    folder=self.store.data_dir/'imports'/job_id; folder.mkdir(parents=True,exist_ok=True)
                    parse_path=folder/(source.id+path.suffix); parse_path.write_bytes(raw)
                    source.locator['copy_path']=str(parse_path)
                if uploaded and payload.get('purpose')=='evaluation':
                    if path.suffix!='.jsonl': raise ParseError('evaluation_requires_jsonl')
                    source.status='evaluation_dataset'; source.context_complete=False
                    self.store.upsert_pending(source,[])
                    with self.store.connection as conn: conn.execute("UPDATE sources SET status='evaluation_dataset' WHERE id=?",(source.id,))
                    items.append({'path':source.title,'source_id':source.id,'status':'success'})
                    continue
                document=parse_file(parse_path,encoding=entry.get('encoding') if uploaded else payload.get('encoding'),cancel_event=event)
                source.metadata={'units':[asdict(u) for u in document.units],'warnings':document.warnings}
                chunks=chunk_document(document)
                for chunk in chunks: chunk.keyword_text=' '.join(keyword_tokens(chunk.text))
                revision=self.store.upsert_pending(source,chunks)
                if event.is_set(): raise Cancelled('cancelled')
                if self.index_revision:
                    self.store.update_job(job_id,phase='indexing')
                    self.index_revision(source.id,revision,Budget(120,event))
                else: waiting=True
                items.append({'path':str(path),'source_id':source.id,'revision':revision,'status':'success'})
            except (Exception,) as exc:
                if event.is_set(): break
                items.append({'path':str(path),'status':'failed','reason':str(exc)[:300]})
            finally:
                self.store.update_job(job_id,items=items,completed=len(items),succeeded=sum(i['status']=='success' for i in items),skipped=sum(i['status']=='skipped' for i in items),failed=sum(i['status']=='failed' for i in items))
        status='cancelled' if event.is_set() else 'waiting_index' if waiting else 'done'
        self.store.update_job(job_id,status=status,phase=status,items=items,completed=len(items),succeeded=sum(i['status']=='success' for i in items),skipped=sum(i['status']=='skipped' for i in items),failed=sum(i['status']=='failed' for i in items))

    def recover(self):
        for job in self.store.unfinished_jobs():
            self._events[job['id']]=threading.Event()
            if job['cancel_requested']:
                self.store.update_job(job['id'],status='cancelled',phase='cancelled'); continue
            if job['status']=='uploading': continue
            self.store.update_job(job['id'],status='queued',phase='queued')
            if job['kind']=='paths': self.jobs.submit(job['id'],self._run_paths)
            elif job['kind']=='upload': self.jobs.submit(job['id'],self._run_upload)
            elif job['kind'] in ('chat_index','reindex') and self.index_revision:
                def resume_index(job_id):
                    payload=self.store.job(job_id)['payload']
                    self.index_revision(payload['source_id'],payload['revision'],Budget(120,self.jobs.event(job_id)))
                    self.store.update_job(job_id,status='done',phase='done',completed=1,succeeded=1)
                self.jobs.submit(job['id'],resume_index)
            elif job['kind']=='evaluation':
                self.store.update_job(job['id'],status='failed',phase='interrupted',result={'error':'Interrupted evaluation; use a fresh held-out dataset before activation'})
