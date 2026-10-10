import importlib.util
import unittest

from knowledge.documents import DocumentError, chunk_text, parse_document


class KnowledgeDocumentTests(unittest.TestCase):
    def test_parse_utf8_text_and_markdown(self):
        text_doc = parse_document('标题\n正文'.encode(), 'guide.txt', 'text')
        markdown_doc = parse_document('# 标题\n\n正文'.encode(), 'guide.md', 'markdown')
        self.assertEqual(text_doc.text, '标题\n正文')
        self.assertEqual(text_doc.filename, 'guide.txt')
        self.assertEqual(text_doc.media_type, 'text/plain')
        self.assertEqual(markdown_doc.media_type, 'text/markdown')

    def test_chunk_text_is_deterministic_and_overlaps(self):
        value = ''.join(chr(0x4e00 + i) for i in range(250))
        chunks = chunk_text(value, size=200, overlap=120)
        self.assertEqual([len(item) for item in chunks], [200, 170])
        self.assertEqual(chunks[0][-120:], chunks[1][:120])
        self.assertEqual(chunk_text(value, size=200, overlap=120), chunks)

    def test_rejects_empty_input_and_invalid_chunk_options(self):
        with self.assertRaisesRegex(DocumentError, '不能为空'):
            parse_document(b'  \n', 'empty.txt', 'text')
        with self.assertRaises(DocumentError):
            chunk_text('content', size=199, overlap=10)
        with self.assertRaises(DocumentError):
            chunk_text('content', size=200, overlap=200)

    def test_rejects_unknown_format(self):
        with self.assertRaisesRegex(DocumentError, '不支持'):
            parse_document(b'content', 'guide.bin', 'binary')

    def test_optional_pdf_or_docx_dependency_is_reported(self):
        if importlib.util.find_spec('pypdf') is None:
            with self.assertRaisesRegex(DocumentError, 'pypdf'):
                parse_document(b'%PDF-1.7', 'guide.pdf', 'pdf')
        if importlib.util.find_spec('docx') is None:
            with self.assertRaisesRegex(DocumentError, 'python-docx'):
                parse_document(b'not-a-docx', 'guide.docx', 'docx')


if __name__ == '__main__':
    unittest.main()
