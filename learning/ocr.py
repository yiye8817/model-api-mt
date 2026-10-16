"""Page-scoped local OCR with a Hermes skill fallback and verified positions."""
import math
import multiprocessing
import os
import time

from .contracts import LearningError

MAX_TEXT=10*1024*1024


class LocalOCRError(LearningError):
    pass


def validate_pages(value,pages):
    if not isinstance(value,list) or len(value)!=len(pages):
        raise LearningError('OCR 输出页数不匹配')
    result=[];seen=set();size=0
    for item in value:
        if not isinstance(item,dict) or type(item.get('page')) is not int or item['page'] not in pages or item['page'] in seen:
            raise LearningError('OCR 输出页码无效或重复')
        seen.add(item['page']);lines=item.get('lines')
        if not isinstance(lines,list) or len(lines)>10000:
            raise LearningError('OCR 识别行格式无效')
        clean=[]
        for line in lines:
            if not isinstance(line,dict) or not isinstance(line.get('text'),str) or not line['text'].strip() or len(line['text'])>3000:
                raise LearningError('OCR 文字格式无效')
            box=line.get('bbox')
            if not isinstance(box,list) or len(box)!=4 or any(type(n) not in (int,float) or not math.isfinite(n) or not 0<=n<=1 for n in box) or box[0]>=box[2] or box[1]>=box[3]:
                raise LearningError('OCR 文字位置无效')
            size+=len(line['text'])+1
            if size>MAX_TEXT:raise LearningError('OCR 文字超过解析上限')
            clean.append({'text':line['text'],'bbox':box})
        result.append({'page':item['page'],'lines':clean})
    return sorted(result,key=lambda item:item['page'])


def _local_worker(sender,path,pages):
    try:
        os.environ.update(OMP_NUM_THREADS='1',OPENBLAS_NUM_THREADS='1',MKL_NUM_THREADS='1')
        import resource
        resource.setrlimit(resource.RLIMIT_AS,(2*1024**3,2*1024**3))
        import numpy as np
        import pypdfium2 as pdfium
        from rapidocr_onnxruntime import RapidOCR
        engine=RapidOCR(intra_op_num_threads=1,inter_op_num_threads=1)
        result=[];size=0
        with pdfium.PdfDocument(path) as document:
            for number in pages:
                page=document[number-1]
                try:
                    width,height=page.get_size()
                    scale=min(2.5,2500/max(width,height))
                    bitmap=page.render(scale=scale)
                    try:
                        image=np.asarray(bitmap.to_pil().convert('RGB'))[:,:,::-1].copy()
                        rows,_=engine(image)
                        h,w=image.shape[:2];lines=[]
                        for points,text,score in rows or []:
                            if not text.strip():continue
                            xs=[p[0]/w for p in points];ys=[p[1]/h for p in points]
                            box=[max(0.,min(xs)),max(0.,min(ys)),min(1.,max(xs)),min(1.,max(ys))]
                            lines.append({'text':text,'bbox':box});size+=len(text)+1
                            if size>MAX_TEXT:raise LocalOCRError('OCR 文字超过解析上限')
                        result.append({'page':number,'lines':lines})
                    finally:bitmap.close()
                finally:page.close()
        sender.send((True,result))
    except Exception as exc:sender.send((False,str(exc)[:300]))
    finally:sender.close()


def local_pdf_ocr(path,pages,cancel,timeout=None):
    if cancel.is_set():raise LearningError('任务已取消')
    ctx=multiprocessing.get_context('spawn');receiver,sender=ctx.Pipe(duplex=False)
    worker=ctx.Process(target=_local_worker,args=(sender,str(path),pages),daemon=True)
    deadline=time.monotonic()+(timeout if timeout is not None else min(900,60+15*len(pages)))
    worker.start();sender.close()
    try:
        while not receiver.poll(.03):
            if cancel.is_set():raise LearningError('任务已取消')
            if time.monotonic()>=deadline:raise LocalOCRError('本地 OCR 超时')
            if not worker.is_alive():raise LocalOCRError('本地 OCR 进程退出')
        ok,data=receiver.recv()
        if cancel.is_set():raise LearningError('任务已取消')
        if not ok:raise LocalOCRError('本地 OCR 不可用：'+data)
        try:return validate_pages(data,pages)
        except LearningError as exc:raise LocalOCRError(str(exc)) from exc
    except EOFError as exc:raise LocalOCRError('本地 OCR 进程退出') from exc
    finally:
        receiver.close();worker.join(.05)
        if worker.is_alive():worker.terminate();worker.join(.5)
        if worker.is_alive():worker.kill();worker.join(.5)
        worker.close()


def recognize_pdf(path,pages,cancel,hermes=None,progress=None,options=None):
    progress=progress or (lambda message:None)
    progress(f'正在本地 OCR 识别 {len(pages)} 个扫描页')
    try:return local_pdf_ocr(path,pages,cancel)
    except LocalOCRError as exc:
        if cancel.is_set():raise LearningError('任务已取消') from exc
        if hermes is None:raise
        progress('本地 OCR 不可用，正在通过 Hermes 下载并使用 OCR 技能')
        return validate_pages(hermes.ocr_pdf(path,pages,cancel,progress,**(options or {})),pages)


def page_units(page):
    """Pack recognized lines while retaining their page, line range and enclosing box."""
    result=[];lines=[];start=1;size=0
    def flush():
        if not lines:return
        boxes=[line['bbox'] for line in lines]
        result.append({'text':'\n'.join(line['text'] for line in lines),'kind':'paragraph','continuation_group':None,
            'position':{'kind':'pdf_ocr','page':page['page'],'start_line':start,'end_line':start+len(lines)-1,
                        'bbox':[min(b[0] for b in boxes),min(b[1] for b in boxes),max(b[2] for b in boxes),max(b[3] for b in boxes)]}})
    for number,line in enumerate(page['lines'],1):
        if lines and size+len(line['text'])+1>1440:
            flush();lines=[];size=0;start=number
        lines.append(line);size+=len(line['text'])+1
    flush()
    return result
