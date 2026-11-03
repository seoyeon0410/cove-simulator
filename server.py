# 정적 서버: 코드 파일(html·js·css)은 저장해 두지 않게 해서 고친 것이 바로 보이고,
# 크고 잘 바뀌지 않는 파일(3D 모델 assets/, 라이브러리 lib/)은 브라우저가 하루 동안 저장해 두게 한다.
# (예전에는 전부 저장 금지라, 아이패드가 열 때마다 23MB 3D 모델을 와이파이로 다시 받아서 한참 걸렸다)
import http.server, socketserver, sys

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        path = self.path.split('?', 1)[0]
        if path.startswith('/assets/') or path.startswith('/lib/'):
            self.send_header('Cache-Control', 'public, max-age=86400')
        else:
            self.send_header('Cache-Control', 'no-store')
        super().end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
socketserver.ThreadingTCPServer.allow_reuse_address = True
socketserver.ThreadingTCPServer.daemon_threads = True
with socketserver.ThreadingTCPServer(('', port), Handler) as httpd:
    httpd.serve_forever()
