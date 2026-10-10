import os
import tempfile
import unittest
from pathlib import Path


class RunWrapperTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_bash_wrapper_executes_source_once_instead_of_recursing(self):
        import server
        old_workspace = server.WORKSPACE_DIR
        server.WORKSPACE_DIR = str(self.root)
        try:
            wrapper, exit_file = server._build_run_wrapper('bash', 'printf "hello\\n"')
            source = Path(wrapper).with_suffix('.code.sh')
            self.assertNotEqual(Path(wrapper), source)
            self.assertTrue(source.exists())
            self.assertIn(f'bash {source}', Path(wrapper).read_text(encoding='utf-8'))
            completed = __import__('subprocess').run(
                ['bash', wrapper], cwd=self.root, input='exit\n', text=True,
                capture_output=True, timeout=3,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(completed.stdout.count('执行脚本'), 1, completed.stdout)
            self.assertEqual(completed.stdout.count('hello'), 1, completed.stdout)
        finally:
            server.WORKSPACE_DIR = old_workspace

    def test_other_languages_keep_separate_source_and_wrapper_files(self):
        import server
        old_workspace = server.WORKSPACE_DIR
        server.WORKSPACE_DIR = str(self.root)
        try:
            for language, suffix in [('python', '.py'), ('node', '.js')]:
                wrapper, _ = server._build_run_wrapper(language, 'print("ok")' if language == 'python' else 'console.log("ok")')
                self.assertTrue(Path(wrapper).exists())
                self.assertTrue(Path(wrapper).with_suffix(suffix).exists())
                self.assertNotEqual(Path(wrapper), Path(wrapper).with_suffix(suffix))
        finally:
            server.WORKSPACE_DIR = old_workspace
