"""Write .github/workflows/pages.yml with the long-job pattern.

Twenty short fires a day were dropped almost entirely. The same account's
other repository already learned this and settled on two long jobs that poll
internally, and those do fire. This does the same for the bars: a handful of
starts, each holding the line for hours.

The repeated cycles are generated rather than hand-written so they cannot
drift apart.
"""
import io

CYCLES = 7
GAP_MIN = 45

HEAD = '''name: Publish the site

# Deployed straight from the workflow rather than from files committed to the
# repo, because the candles are refreshed through the day and committing them
# would be ruinous. Each refresh rewrites a whole file, so a fresh copy of
# every symbol lands in git history several times an hour: roughly half a
# gigabyte a month, against GitHub's one-gigabyte soft limit. Building the
# site here instead means the bars are never committed at all.
#
# The copies in docs/bars are a seed. They are what gets served if a fetch
# fails, and they are what a fresh clone starts from. They are not updated.

# A FEW LONG RUNS A DAY, each publishing repeatedly. Not a frequent cron.
#
# This asked for two fires an hour through the session and GitHub delivered
# almost none of them. On 8 September four of twenty landed. On the 9th none
# landed at all: the market opened with candles five and a half hours old and
# the Demo tab correctly refused to trade on them, which is the app being
# honest about a problem it cannot fix from the browser.
#
# That is documented behaviour, not a fault. Scheduled workflows are
# best-effort, are dropped under load, and high-frequency crons are the first
# thing throttled. The paper-trading repository on this same account hit the
# identical wall and settled on two long jobs that poll internally, and those
# do fire. So this asks for three starts instead of twenty, and each start
# republishes every %(gap)d minutes for about %(hours).1f hours. Any single one
# that lands covers most of a session on its own.
#
# The staleness that matters is the Demo tab's 240-minute cutoff, so a gap of
# %(gap)d minutes leaves a wide margin for a run that dies early.
#
# THE STARTS LAND THREE TO FOUR HOURS LATE, and consistently. Over 9 and 10
# September the 12:13 slot fired at 16:20, 14:41 at 17:51 and 16:09 at 19:04.
# So a start meant for "before the open" never arrived before the open, and
# the open was only fresh when somebody happened to push. Two answers:
#
#   The early starts are scheduled for the delay, not for the clock. 08:07
#   and 09:37 UTC, landing somewhere around 11:00 to 13:30.
#
#   And a run hands over to a fresh one before it finishes, while the market
#   is open. One start a day that lands at all is then enough to hold the
#   whole session, however late it came. A push hands over too, because a
#   push cancels the run in progress and would otherwise break the chain.
#
# Times are UTC. New York is UTC-4 in summer, so the cash session is
# 13:30 to 20:00 UTC.

on:
  push:
    branches: [main]
  schedule:
    - cron: "7 8 * * 1-5"      # lands around 11:00 to 12:00
    - cron: "37 9 * * 1-5"     # lands around 12:30 to 13:30, before the open
    - cron: "41 14 * * 1-5"    # a spare, in case the chain was broken
  workflow_dispatch:
    inputs:
      cycles:
        description: "How many times to publish before finishing"
        default: "1"
      gap:
        description: "Seconds between publishes, for testing the loop quickly"
        default: "%(sleep)d"
      chain:
        description: "Hand over to a fresh run at the end, while the market is open"
        default: "no"

permissions:
  contents: read
  pages: write
  id-token: write
  # To start the next run in the chain. A workflow_dispatch made with the
  # run's own token is the one kind of event that token is allowed to start.
  actions: write

# Never two deploys at once. A push cancels a publishing run in progress,
# because a code change should go out immediately and the next scheduled start
# picks the candles back up.
concurrency:
  group: pages
  cancel-in-progress: ${{ github.event_name == 'push' }}

jobs:
  publish:
    runs-on: ubuntu-latest
    # GitHub's ceiling is 360. The cycles below need about %(need)d.
    timeout-minutes: %(timeout)d
    env:
      # A scheduled start holds the line. A push or a manual run publishes
      # once and finishes, unless a manual run asks for more.
      CYCLES: ${{ github.event_name == 'schedule' && %(cycles)d || inputs.cycles || 1 }}
      GAP: ${{ github.event_name == 'schedule' && %(sleep)d || inputs.gap || %(sleep)d }}
      # Scheduled starts and pushes keep the chain going; a manual run only
      # does when asked, so testing the loop does not start one by accident.
      CHAIN: ${{ github.event_name == 'schedule' || github.event_name == 'push' || inputs.chain == 'yes' }}
    environment:
      name: github-pages
      url: ${{ steps.deploy1.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
'''

FIRST = '''
      # Cycle 1, with every timeframe. The deeper hourly history only changes
      # slowly, so the later cycles leave it alone.
      - name: Fetch the candles
        run: python tools/publish_bars.py

      - name: Build the page
        # The published HTML is generated, so it is built here rather than
        # trusted to be in step with the modules beside it.
        run: python tools/build_web.py

      - uses: actions/upload-pages-artifact@v3
        with:
          path: docs
          name: github-pages-1

      - id: deploy1
        uses: actions/deploy-pages@v4
        with:
          artifact_name: github-pages-1
'''

CYCLE = '''
      # Cycle %(n)d
      - name: Wait, then refresh again (%(n)d)
        if: fromJSON(env.CYCLES) >= %(n)d
        run: sleep "$GAP"

      - name: Fetch the minute candles (%(n)d)
        # Only the minute bars go stale between cycles. Refetching two years
        # of hourly history every time would be work for nothing.
        if: fromJSON(env.CYCLES) >= %(n)d
        run: python tools/publish_bars.py --only 1m

      - name: Build the page (%(n)d)
        if: fromJSON(env.CYCLES) >= %(n)d
        run: python tools/build_web.py

      - if: fromJSON(env.CYCLES) >= %(n)d
        uses: actions/upload-pages-artifact@v3
        with:
          path: docs
          name: github-pages-%(n)d

      - if: fromJSON(env.CYCLES) >= %(n)d
        uses: actions/deploy-pages@v4
        with:
          artifact_name: github-pages-%(n)d
'''

HANDOVER = '''
      # The hand-over. Runs after a failure too, so one bad fetch does not end
      # the day's publishing, but not after a cancel: a cancel is a push, and
      # the push run hands over itself.
      - name: Hand over to the next run while the market is open
        if: ${{ !cancelled() && env.CHAIN == 'true' }}
        env:
          GH_TOKEN: ${{ github.token }}
          STATUS: ${{ job.status }}
        run: |
          d=$(date -u +%%u)
          h=$(date -u +%%H)
          if [ "$d" -gt 5 ] || [ "$h" -ge 20 ]; then
            echo "session over, not handing on"
            exit 0
          fi
          # A run that failed waits before handing on, so a fetch that keeps
          # failing becomes a few runs an hour rather than hundreds.
          if [ "$STATUS" != "success" ]; then sleep 600; fi
          gh workflow run pages.yml --ref main -f cycles=%(cycles)d -f chain=yes
          echo "handed over"
'''

need = (CYCLES - 1) * GAP_MIN + CYCLES * 3 + 10
out = HEAD % {"gap": GAP_MIN, "hours": (CYCLES - 1) * GAP_MIN / 60.0,
              "cycles": CYCLES, "need": need, "timeout": need + 40,
              "sleep": GAP_MIN * 60}
out += FIRST
for n in range(2, CYCLES + 1):
    out += CYCLE % {"n": n}
out += HANDOVER % {"cycles": CYCLES}

P = r"C:\Users\chris\TradersDiary\.github\workflows\pages.yml"
io.open(P, "w", encoding="utf-8", newline="\n").write(out)
print("wrote %d cycles, %d minutes apart, timeout %d"
      % (CYCLES, GAP_MIN, need + 40))
