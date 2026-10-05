# -*- coding: utf-8 -*-
"""关卡挑战版 · 本地启动器

上游这套东西**不需要任何后端**，但用 file:// 直接打开会有两个小麻烦：
浏览器对本地文件的音频自动播放限制更严、且部分浏览器会拦 file:// 下的相对资源。
所以起一个只读的静态服务器最省事——它只是发文件，没有任何接口、没有任何联机逻辑。

用法（在 工具/ 下跑）:
    python 启动.py            # 起在 8642 端口并自动打开浏览器
    python 启动.py 9000       # 指定端口
    python 启动.py --no-open  # 只起服务，不开浏览器
"""
import functools
import http.server
import os
import socketserver
import sys
import threading
import webbrowser

# 本文件住在 关卡挑战版/工具/ 下；要发的静态文件在**上一层**（成品根）。
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    """把 404 压成一行，别把控制台刷满（上游 index.html 引用了一个仓库里不存在的
    preventInspectElement.js，每次加载必然 404 一次；那是上游自己的问题，不是我们的）。"""

    def log_message(self, fmt, *args):
        if args and str(args[1]).startswith("404"):
            sys.stderr.write("  404 %s\n" % args[0])
            return
        sys.stderr.write("  %s\n" % (fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    port = int(args[0]) if args else 8642
    handler = functools.partial(QuietHandler, directory=HERE)

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", port), handler) as httpd:
        url = f"http://127.0.0.1:{port}/"
        print(f"关卡挑战版 → {url}")
        print("（只有静态文件服务，没有任何接口 / 没有联机）  Ctrl+C 结束")
        if "--no-open" not in sys.argv:
            threading.Timer(0.6, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止")


if __name__ == "__main__":
    main()
