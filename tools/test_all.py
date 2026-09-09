"""Run every test in this project and say honestly what happened.

    python tools/test_all.py

Written because the suite was read by eye, one command per file, and one of
those files sat permanently red. test_engine.mjs needs Chris's own exports,
which are private and live outside this repository, so without arguments it
exits 2 and printed a usage line. Read as a failure every time, which is how
a real failure gets missed: a line that is always red is a line nobody looks
at any more.

So a missing input is SKIPPED and says why, a failure is a failure, and the
exit code is non-zero only when something actually broke.
"""
import functools
import glob
import os
import subprocess
import sys

print = functools.partial(print, flush=True)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# Where Chris's own exports sit on his machine. Deliberately outside this
# repository, which is public: the trade record must never be committed here.
# Anywhere else, including his mate's laptop, this is simply absent and the
# engine test is skipped rather than failed.
PRIVATE = os.path.join(os.path.dirname(ROOT), "AITrader", "journal_data")


def engine_args():
    """The engine test's two inputs, if this machine happens to have them."""
    ref = os.path.join(PRIVATE, "trades.json")
    if not os.path.isdir(PRIVATE) or not os.path.exists(ref):
        return None
    if not glob.glob(os.path.join(PRIVATE, "*.csv")):
        return None
    return [PRIVATE, ref]


# A test that needs something this machine may not have. The value is a
# function returning its arguments, or None when the inputs are not here.
NEEDS = {"test_engine.mjs": engine_args}


def run(path):
    name = os.path.basename(path)
    extra = None
    if name in NEEDS:
        extra = NEEDS[name]()
        if extra is None:
            return "skip", "needs your own exports, which are not on this machine"
    cmd = (["node", path] if name.endswith(".mjs") else [sys.executable, path])
    r = subprocess.run(cmd + (extra or []), cwd=ROOT,
                       capture_output=True, text=True)
    if r.returncode == 0:
        return "pass", ""
    # The last thing a failing test said is the useful part, not the first.
    tail = [ln for ln in (r.stdout + r.stderr).splitlines() if ln.strip()]
    return "FAIL", (tail[-1][:120] if tail else "exit %d" % r.returncode)


def main():
    tests = sorted(glob.glob(os.path.join(HERE, "test_*.mjs"))
                   + glob.glob(os.path.join(HERE, "test_*.py")))
    tests = [t for t in tests if os.path.basename(t) != "test_all.py"]
    counts = {"pass": 0, "FAIL": 0, "skip": 0}
    for t in tests:
        state, why = run(t)
        counts[state] += 1
        print("  %-6s %-22s %s" % (state, os.path.basename(t), why))

    print("\n%d passed, %d failed, %d skipped"
          % (counts["pass"], counts["FAIL"], counts["skip"]))
    if counts["skip"]:
        print("A skip is not a pass. It is a test this machine cannot run.")
    return 1 if counts["FAIL"] else 0


if __name__ == "__main__":
    sys.exit(main())
