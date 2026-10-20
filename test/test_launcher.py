import ast
import io
import queue
import re
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path

# Load only this helper: importing launcher intentionally re-execs in its venv.
source = ast.parse((Path(__file__).resolve().parents[1] / 'launcher.py').read_text(encoding='utf-8'))
function = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == 'wait_for_tunnel_url')
namespace = dict(queue=queue, threading=threading, time=time, re=re)
exec(compile(ast.Module(body=[function], type_ignores=[]), 'launcher.py', 'exec'), namespace)
wait_for_tunnel_url = namespace['wait_for_tunnel_url']


class TunnelOutputTests(unittest.TestCase):
    def test_drains_more_than_pipe_capacity_after_url(self):
        child = subprocess.Popen([sys.executable, '-c',
            "import sys; print('https://demo.trycloudflare.com', flush=True); sys.stdout.write('x' * 2000000); sys.stdout.flush()"],
            stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(wait_for_tunnel_url(child, timeout=3), 'https://demo.trycloudflare.com')
            self.assertEqual(child.wait(timeout=5), 0)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()

    def test_silent_process_respects_deadline(self):
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(5)'], stdout=subprocess.PIPE, text=True)
        try:
            start = time.monotonic()
            with self.assertRaisesRegex(RuntimeError, 'Timed out'):
                wait_for_tunnel_url(child, timeout=0.05)
            self.assertLess(time.monotonic() - start, 1)
        finally:
            child.kill()
            child.wait()

    def test_early_exit_is_reported(self):
        process = type('Process', (), {'stdout': io.StringIO('startup failed\n')})()
        with self.assertRaisesRegex(RuntimeError, 'closed its output'):
            wait_for_tunnel_url(process, timeout=1)


if __name__ == '__main__':
    unittest.main()
