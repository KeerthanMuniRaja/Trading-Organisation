import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import autolearn


class HttpSecurityTests(unittest.TestCase):
    def test_redirect_does_not_forward_credentials(self):
        seen = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append(self.path)
                if self.path == '/redirect':
                    self.send_response(302)
                    self.send_header('Location', '/credential-sink')
                    self.end_headers()
                else:
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b'{}')
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            api = autolearn.http_api(f'http://127.0.0.1:{server.server_port}', 'test-only')
            with self.assertRaisesRegex(RuntimeError, 'HTTP 302'):
                api('GET', '/redirect')
            self.assertEqual(seen, ['/redirect'])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_oversized_response_is_rejected(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, limit): return b' ' * limit
        api = autolearn.http_api('http://127.0.0.1', 'test-only', lambda *a, **k: Response())
        with self.assertRaises(RuntimeError):
            api('GET', '/v1/knowledge')


if __name__ == '__main__':
    unittest.main()
