import pytest
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject, RectangleObject

from local_knowledge.parsers import parse_file


def write_text_pdf(path,rows):
    writer=PdfWriter();page=writer.add_blank_page(width=612,height=792)
    font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
    page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
    instructions=[]
    for row,columns in enumerate(rows):
        for col,value in enumerate(columns):
            instructions.append(f'BT /F1 12 Tf {50+col*250} {740-row*24} Td ({value}) Tj ET')
    stream=DecodedStreamObject();stream.set_data('\n'.join(instructions).encode())
    page[NameObject('/Contents')]=writer._add_object(stream)
    writer.write(path)


def test_normal_pdf_does_not_report_unverified_table_error(tmp_path):
    path=tmp_path/'plain.pdf'
    write_text_pdf(path,[['A regular document paragraph.']])
    parsed=parse_file(path)
    assert parsed.units[0].position.page==1
    assert parsed.warnings==[]


def test_pdf_columns_keep_visual_separation_without_exposing_internal_warning_code(tmp_path):
    import re
    path=tmp_path/'table.pdf'
    write_text_pdf(path,[['Product','Warranty'],['Model-A','Three years'],['Model-B','One year']])
    parsed=parse_file(path)
    assert re.search(r'Product {2,}Warranty',parsed.units[0].text)
    assert re.search(r'Model-A {2,}Three years',parsed.units[0].text)
    assert 'pdf_tables_require_verified_structure' not in parsed.warnings


def test_readable_pdf_with_blank_page_keeps_its_text_and_page_numbers(tmp_path):
    original=tmp_path/'original.pdf'
    write_text_pdf(original,[['Readable first page']])
    path=tmp_path/'with-blank.pdf'
    writer=PdfWriter(clone_from=original)
    writer.add_blank_page(width=612,height=792)
    writer.write(path)
    parsed=parse_file(path)
    assert 'Readable first page' in parsed.units[0].text
    assert [unit.position.page for unit in parsed.units]==[1,2]
    assert not parsed.units[1].text.strip()


@pytest.mark.parametrize('ordinary_text',[True,False],ids=['mixed','form-only'])
def test_pdf_form_xobject_text_is_preserved(tmp_path,ordinary_text):
    original=tmp_path/'original.pdf'
    write_text_pdf(original,[['REGULAR TEXT']] if ordinary_text else [])
    writer=PdfWriter(clone_from=original);page=writer.pages[0]
    form=DecodedStreamObject()
    form.set_data(b'BT /F1 12 Tf 50 650 Td (FORM TEXT) Tj ET')
    form.update({NameObject('/Type'):NameObject('/XObject'),NameObject('/Subtype'):NameObject('/Form'),
                 NameObject('/BBox'):RectangleObject([0,0,612,792]),NameObject('/Resources'):page['/Resources']})
    page['/Resources'][NameObject('/XObject')]=DictionaryObject({NameObject('/Fm1'):writer._add_object(form)})
    content=DecodedStreamObject();content.set_data(page.get_contents().get_data()+b'\n/Fm1 Do')
    page[NameObject('/Contents')]=writer._add_object(content)
    path=tmp_path/'form.pdf';writer.write(path)
    assert 'FORM TEXT' in PdfReader(path).pages[0].extract_text()
    parsed=parse_file(path)
    assert 'FORM TEXT' in parsed.units[0].text
    if ordinary_text:
        assert 'REGULAR TEXT' in parsed.units[0].text
