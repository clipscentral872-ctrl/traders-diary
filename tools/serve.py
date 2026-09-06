"""Serve docs/ for testing, with caching turned off.

python -m http.server sends no Cache-Control at all, so a browser is free to
guess, and it guesses "keep it". That turns every edit into a coin toss: the
page reloads, the module does not, and you spend the next twenty minutes
debugging code the browser is not running. It looks exactly like a bug in the
change you just made.

Nothing here is about production. GitHub Pages sends real validators.

    python tools/serve.py [port]
"""
import functools
import os
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

print = functools.partial(print, flush=True)

DOCS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs")


class NoCache(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=DOCS, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # One line per request is noise when a page pulls twenty modules.
        if "404" in (fmt % args):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8791
    print(f"serving {os.path.abspath(DOCS)} on http://127.0.0.1:{port}")
    # Threading, because a browser holds its connection open and a
    # single-threaded server then answers nobody else, including curl.
    ThreadingHTTPServer(("127.0.0.1", port), NoCache).serve_forever()
