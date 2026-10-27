# 개발용 정적 서버: 캐시를 끄고 모듈 변경이 바로 반영되게 한다.
import http.server, socketserver, sys

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('', port), Handler) as httpd:
    httpd.serve_forever()
