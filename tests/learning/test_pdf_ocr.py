import threading

import pytest
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject, NumberObject, RectangleObject

from learning.contracts import LearningError
from learning.ingest import make_chunks, parse_upload
from local_knowledge.parsers import parse_file
from tests.knowledge.test_pdf_layout import write_text_pdf


def scanned_pdf(path, mixed=False):
    if mixed:
        original=path.with_name('native.pdf');write_text_pdf(original,[['Native first page']])
        writer=PdfWriter(clone_from=original)
    else:
        writer=PdfWriter()
    page=writer.add_blank_page(width=200,height=200)
    image=DecodedStreamObject();image.set_data(b'\xff'*300)
    image.update({NameObject('/Type'):NameObject('/XObject'),NameObject('/Subtype'):NameObject('/Image'),
                  NameObject('/Width'):NumberObject(10),NameObject('/Height'):NumberObject(10),
                  NameObject('/ColorSpace'):NameObject('/DeviceRGB'),NameObject('/BitsPerComponent'):NumberObject(8)})
    page[NameObject('/Resources')]=DictionaryObject({NameObject('/XObject'):DictionaryObject({NameObject('/Scan'):writer._add_object(image)})})
    content=DecodedStreamObject();content.set_data(b'q 200 0 0 200 0 0 cm /Scan Do Q')
    page[NameObject('/Contents')]=writer._add_object(content)
    writer.add_blank_page(width=200,height=200)
    writer.write(path)


def test_scan_detection_preserves_native_and_blank_pages(tmp_path):
    path=tmp_path/'mixed.pdf';scanned_pdf(path,mixed=True)
    parsed=parse_file(path,allow_scan_placeholders=True)
    assert [(unit.position.page,unit.kind) for unit in parsed.units]==[(1,'paragraph'),(2,'scan'),(3,'paragraph')]
    assert 'Native first page' in parsed.units[0].text


def test_scan_text_replaces_placeholder_and_keeps_ocr_positions(tmp_path,monkeypatch):
    from learning import ingest
    path=tmp_path/'mixed.pdf';scanned_pdf(path,mixed=True)
    def recognize(path,pages,cancel,**kwargs):
        assert pages==[2]
        return [{'page':2,'lines':[{'text':'中文扫描知识点','bbox':[.1,.2,.8,.3]},
                                   {'text':'Scan evidence in English','bbox':[.1,.4,.8,.5]}]}]
    monkeypatch.setattr(ingest,'recognize_pdf',recognize,raising=False)
    result=parse_upload(path,threading.Event())
    chunks=make_chunks(result['units'])
    assert 'Native first page' in chunks[0]['text']
    assert chunks[1]['text']=='中文扫描知识点\nScan evidence in English'
    assert chunks[1]['position']['page']==2
    assert chunks[1]['position']['kind']=='pdf_ocr'
    assert chunks[1]['position']['bbox']==[.1,.2,.8,.5]
    assert (chunks[1]['position']['start_line'],chunks[1]['position']['end_line'])==(1,2)
    assert any('OCR' in warning for warning in result['warnings'])


def test_scan_without_any_recognized_text_is_a_clear_failure(tmp_path,monkeypatch):
    from learning import ingest
    path=tmp_path/'scan.pdf';scanned_pdf(path)
    monkeypatch.setattr(ingest,'recognize_pdf',lambda *a,**kw:[{'page':1,'lines':[]}],raising=False)
    with pytest.raises(LearningError,match='OCR.*未识别'):
        parse_upload(path,threading.Event())


def test_recognized_scan_is_evidence_for_the_existing_analyzer(tmp_path,store,source,monkeypatch):
    import json
    from learning import ingest
    from learning.analysis import DocumentAnalyzer
    from tests.learning.test_analysis import analysis_value,context_for
    path=tmp_path/'scan.pdf';scanned_pdf(path)
    monkeypatch.setattr(ingest,'recognize_pdf',lambda *a,**kw:[{'page':1,'lines':[{'text':'扫描知识用于分析和引用。','bbox':[0,0,1,1]}]}],raising=False)
    parsed=parse_upload(path,threading.Event())
    doc=store.upsert_document(source,make_chunks(parsed['units']))
    class Model:
        def request(self,prompt,*args,**kwargs):
            data=json.loads(prompt.split('\nINPUT_JSON\n')[1])
            return json.dumps(analysis_value(data['chunks'][0]),ensure_ascii=False)
    jobs,context=context_for(store,doc)
    try:
        DocumentAnalyzer(store,Model()).run({'document_ids':[doc['id']]},context)
        citation=store.get_analysis(doc['id'])['concepts'][0]['citations'][0]
        assert citation['quote']=='扫描知识用于分析和引用。'
        assert citation['position']['page']==1
        assert citation['position']['bbox']==[0,0,1,1]
    finally:jobs.shutdown()


def test_local_ocr_reads_real_image_pdf_without_hermes(tmp_path):
    pytest.importorskip('rapidocr_onnxruntime');pytest.importorskip('pypdfium2')
    from PIL import Image,ImageDraw,ImageFont
    image=Image.new('RGB',(1200,700),'white');draw=ImageDraw.Draw(image)
    font=ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',48)
    draw.text((80,100),'知识学习：扫描资料用于分析',font=font,fill='black')
    draw.text((80,220),'Knowledge OCR evidence 2026',font=font,fill='black')
    path=tmp_path/'real-scan.pdf';image.save(path,'PDF',resolution=150)
    result=parse_upload(path,threading.Event())
    chunks=make_chunks(result['units'])
    recognized=''.join(chunk['text'] for chunk in chunks)
    assert '知识学习' in recognized
    assert 'Knowledge' in recognized and '2026' in recognized
    assert all(chunk['position']['kind']=='pdf_ocr' and chunk['position']['page']==1 for chunk in chunks)
    assert all(len(chunk['position']['bbox'])==4 for chunk in chunks)


@pytest.mark.parametrize('heading',['Native heading','Native heading '*12])
def test_ocr_preserves_existing_short_text_on_a_scanned_page(tmp_path,monkeypatch,heading):
    from learning import ingest
    path=tmp_path/'scan.pdf';scanned_pdf(path)
    writer=PdfWriter(clone_from=path);page=writer.pages[0]
    page['/Resources'][NameObject('/Font')]=DictionaryObject({NameObject('/F1'):DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})})
    content=DecodedStreamObject();content.set_data(page.get_contents().get_data()+f'\nBT /F1 12 Tf 20 180 Td ({heading}) Tj ET'.encode())
    page[NameObject('/Contents')]=writer._add_object(content)
    out=tmp_path/'headed.pdf';writer.write(out)
    monkeypatch.setattr(ingest,'recognize_pdf',lambda *a,**kw:[{'page':1,'lines':[{'text':'扫描正文','bbox':[.1,.2,.9,.8]}]}],raising=False)
    result=parse_upload(out,threading.Event())
    assert 'Native heading' in ''.join(unit['text'] for unit in result['units'])
    assert '扫描正文' in ''.join(unit['text'] for unit in result['units'])


def test_ocr_timeout_removes_its_worker(tmp_path):
    import multiprocessing
    from learning.ocr import local_pdf_ocr,LocalOCRError
    path=tmp_path/'scan.pdf';scanned_pdf(path)
    before={process.pid for process in multiprocessing.active_children()}
    with pytest.raises(LocalOCRError,match='超时'):
        local_pdf_ocr(path,[1],threading.Event(),timeout=.001)
    assert {process.pid for process in multiprocessing.active_children()}==before


def test_blank_scanned_page_does_not_fail_other_readable_pages(tmp_path):
    pytest.importorskip('rapidocr_onnxruntime');pytest.importorskip('pypdfium2')
    path=tmp_path/'mixed.pdf';scanned_pdf(path,mixed=True)
    parsed=parse_upload(path,threading.Event())
    assert 'Native first page' in ''.join(unit['text'] for unit in parsed['units'])
    assert any('2' in warning and '未识别' in warning for warning in parsed['warnings'])


def test_full_page_scan_inside_form_is_detected_with_a_native_header(tmp_path):
    path=tmp_path/'scan.pdf';scanned_pdf(path)
    writer=PdfWriter(clone_from=path);page=writer.pages[0]
    form=DecodedStreamObject();form.set_data(page.get_contents().get_data())
    form.update({NameObject('/Type'):NameObject('/XObject'),NameObject('/Subtype'):NameObject('/Form'),
                 NameObject('/BBox'):RectangleObject([0,0,200,200]),NameObject('/Resources'):page['/Resources']})
    font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
    page[NameObject('/Resources')]=DictionaryObject({NameObject('/XObject'):DictionaryObject({NameObject('/Fm'):writer._add_object(form)}),
        NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
    content=DecodedStreamObject();content.set_data(b'/Fm Do\nBT /F1 12 Tf 20 180 Td ('+b'Native header '*15+b') Tj ET')
    page[NameObject('/Contents')]=writer._add_object(content)
    out=tmp_path/'form-scan.pdf';writer.write(out)
    parsed=parse_file(out,allow_scan_placeholders=True)
    assert parsed.units[0].kind=='scan'
    assert 'Native header' in parsed.units[0].text


def test_scan_detection_still_works_without_optional_image_decoders(tmp_path,monkeypatch):
    from pypdf import PageObject
    from local_knowledge.parsers import _parse_worker
    from local_knowledge.contracts import ParseLimits
    path=tmp_path/'scan.pdf';scanned_pdf(path)
    writer=PdfWriter(clone_from=path);page=writer.pages[0]
    content=DecodedStreamObject();content.set_data(b'q 20 0 0 20 0 0 cm /Scan Do Q')
    page[NameObject('/Contents')]=writer._add_object(content)
    small=tmp_path/'small-image.pdf';writer.write(small)
    def no_decoder(*args):raise ImportError('Pillow unavailable')
    monkeypatch.setattr(PageObject,'images',property(no_decoder))
    # Run the worker directly while replacing its process-only resource limit.
    monkeypatch.setattr('resource.setrlimit',lambda *args:None)
    sent=[]
    class Sender:
        def send(self,value):sent.append(value)
        def close(self):pass
    _parse_worker(Sender(),small,ParseLimits(),None,True)
    assert sent[0][0] is True,sent[0][1]
    assert sent[0][1]['units'][0]['kind']=='scan'


def test_retrying_a_legacy_pdf_reparses_its_saved_copy_with_ocr(tmp_path,monkeypatch):
    from learning import ocr
    from learning.runtime import LearningRuntime
    from tests.learning.test_end_to_end import StructuredSession
    from tests.learning.test_jobs import wait_terminal
    path=tmp_path/'legacy.pdf';scanned_pdf(path)
    monkeypatch.setattr(ocr,'local_pdf_ocr',lambda *args,**kwargs:[{'page':1,'lines':[{'text':'新识别的扫描正文','bbox':[0,0,1,1]}]}])
    runtime=LearningRuntime(tmp_path/'learning',StructuredSession,lambda:[],lambda:True)
    try:
        service=runtime.components()
        doc=service.store.upsert_document({'source_id':'legacy-pdf','origin':'learning','title':'旧 PDF','status':'failed','content_hash':'legacy',
            'warnings':['pdf_tables_require_verified_structure'],'locator':{'kind':'upload','copy_path':str(path)}},
            [{'text':'旧解析只提取的部分文字','position':{'kind':'pdf_page','page':1}}])
        job=service.analyze({'mode':'selected','document_ids':[doc['id']]},{})
        done=wait_terminal(service.store,job['id'])
        assert done['status']=='completed',done.get('error')
        current=service.store.get_document(doc['id'])
        chunks=service.store.get_chunks(doc['id'],current['revision'])
        assert chunks[0]['text']=='新识别的扫描正文'
        assert chunks[0]['position']['kind']=='pdf_ocr'
        assert 'pdf_tables_require_verified_structure' not in current['warnings']
    finally:runtime.close()
