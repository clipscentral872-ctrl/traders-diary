"""Serve docs/ for testing, with caching turned off.

A second folder can be mounted at /_local/ so a real export can be fed to the
app in a browser without ever being copied into the repo. The repo is public
and a trade record is not, so the file stays where it is and only this
development server, bound to this machine, can see it:

    python tools/serve.py 8791 --local "C:/some/folder"


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
from urllib.parse import unquote

print = functools.partial(print, flush=True)

DOCS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs")


LOCAL = None


class NoCache(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=DOCS, **kw)

    def translate_path(self, path):
        # One mounted folder, one level deep, no climbing out of it.
        if LOCAL and path.startswith("/_local/"):
            name = unquote(path.split("?", 1)[0].split("#", 1)[0])
            return os.path.join(LOCAL, os.path.basename(name))
        return super().translate_path(path)

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
    args = sys.argv[1:]
    if "--local" in args:
        i = args.index("--local")
        LOCAL = os.path.abspath(args[i + 1])
        del args[i:i + 2]
        print(f"mounting {LOCAL} at /_local/")
    port = int(args[0]) if args else 8791
    print(f"serving {os.path.abspath(DOCS)} on http://127.0.0.1:{port}")
    # Threading, because a browser holds its connection open and a
    # single-threaded server then answers nobody else, including curl.
    ThreadingHTTPServer(("127.0.0.1", port), NoCache).serve_forever()
