"""Bounded lifecycle clock; backend owns every policy decision and permission."""
import argparse
import json
import os
import time
from uuid import uuid4
from worker import Client


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--minutes', type=int, default=0, help='0 = one cycle; otherwise 1..360 minutes')
    args = parser.parse_args()
    if not 0 <= args.minutes <= 360:
        parser.error('--minutes must be 0..360')
    client = Client(os.environ.get('API_URL', 'http://127.0.0.1:3000'), os.environ.get('API_TOKEN', ''))
    deadline = time.monotonic() + args.minutes * 60
    previous = None
    while True:
        # Client retries the exact key within a bounded request budget.
        result = client.post('/v1/lifecycle/cycles', {}, 'lifecycle-' + uuid4().hex)
        status = result['status']
        if result.get('actions') or status != previous:
            print(json.dumps({'event': 'lifecycle.cycle', **result}), flush=True)
        previous = status
        if args.minutes == 0 or status in {'disabled', 'halted'}:
            break
        remaining = deadline - time.monotonic()
        if remaining <= 60:
            break
        time.sleep(60)


if __name__ == '__main__':
    main()
