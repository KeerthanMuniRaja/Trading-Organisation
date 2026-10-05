"""Replay a selected journal's saved submission; never execute or regenerate work."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

from artifact_executor import HERE, digest, encode, exclusive, validate_answers
from execution_reporting import publish_execution


def recover(client, journal, state, *, report_only=False):
    if not isinstance(journal, str) or not re.fullmatch(r'[a-f0-9]{64}', journal):
        raise ValueError('Select an exact journal identifier')
    directory = Path(state).resolve(strict=True)
    path = (directory / (journal + '.sqlite')).resolve(strict=True)
    if path.parent != directory or not path.is_file():
        raise ValueError('Journal must remain inside its state directory')
    with exclusive(directory / (journal + '.lock')):
        # mode=rw refuses accidental creation of an empty recovery database.
        db = sqlite3.connect(path.as_uri() + '?mode=rw', uri=True)
        try:
            db.execute('PRAGMA synchronous=FULL')
            row = db.execute('SELECT binding,work,payload,response FROM job WHERE id=1').fetchone()
            if not row or any(value and len(value) > 512 * 1024 for value in row):
                raise ValueError('Missing or oversized journal')
            binding = json.loads(row[0])
            scope = {'origin': client.base, 'credentialHash': hashlib.sha256(client.token.encode()).hexdigest(),
                     'experimentId': binding['experimentId']}
            if any(binding.get(k) != v for k, v in scope.items()) or digest(scope) != journal:
                raise ValueError('Recovery identity mismatch')
            identity = {k: binding[k] for k in ('experimentId', 'baselineHash', 'candidateHash')}
            work = json.loads(row[1]) if row[1] else None
            if work and any(work.get(k) != v for k, v in identity.items()):
                raise ValueError('Saved work identity mismatch')
            image = binding.get('sandboxImage')
            mode = 'docker-linux-container' if image else 'trusted-local-process-only'
            if row[3]:
                response = json.loads(row[3])
                if response.get('experimentId') != identity['experimentId'] or response.get('status') != 'submitted':
                    raise ValueError('Saved acknowledgement mismatch')
                status = 'already-submitted'
            elif report_only:
                status = 'reports-only'
            else:
                if not work or not row[2]:
                    raise ValueError('No complete saved submission; recovery cannot execute work')
                body = json.loads(row[2])
                if (set(body) != {*identity, 'planHash', 'results'}
                        or any(body.get(k) != v for k, v in identity.items())
                        or body.get('planHash') != work.get('planHash')):
                    raise ValueError('Saved submission identity mismatch')
                cases, results = work['cases'], body['results']
                if not isinstance(results, list) or not 8 <= len(results) <= 32 or len(results) != len(cases):
                    raise ValueError('Incomplete saved submission')
                for case, result in zip(cases, results):
                    if set(result) != {'caseId', 'baseline', 'candidate'} or result['caseId'] != case['id']:
                        raise ValueError('Saved case mismatch')
                    validate_answers(result['baseline'])
                    validate_answers(result['candidate'])
                db.execute("INSERT INTO events(kind) VALUES('submission-request')")
                db.commit()
                try:
                    response = client.post('/v1/skills/experiments/submissions', body, 'artifact-submit-' + identity['experimentId'])
                    if response.get('experimentId') != identity['experimentId'] or response.get('status') != 'submitted':
                        raise ValueError('Submission acknowledgement mismatch')
                except Exception:
                    db.execute("INSERT INTO events(kind) VALUES('submission-unconfirmed')")
                    db.commit()
                    publish_execution(db, client, mode, image)
                    raise
                db.execute('UPDATE job SET response=? WHERE id=1', (encode(response),))
                db.execute("INSERT INTO events(kind) VALUES('submission-confirmed')")
                db.commit()
                status = 'submitted'
            reporting = publish_execution(db, client, mode, image)
            return {'status': status, 'experimentId': identity['experimentId'], 'journal': journal,
                    'executionReporting': reporting, 'executedArtifacts': 0}
        finally:
            db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--journal')
    parser.add_argument('--batch', help='JSON array of 1-10 selected journal IDs; perform one recovery pass')
    parser.add_argument('--state', default=str(HERE / '.state' / 'paired-artifacts'))
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--report-only', action='store_true')
    mode.add_argument('--inspect', action='store_true', help='Read a selected journal without contacting the backend')
    mode.add_argument('--list', action='store_true', help='Read up to 100 local journal summaries without contacting the backend')
    args = parser.parse_args()
    if sum(bool(v) for v in (args.journal, args.list, args.batch)) != 1 or (args.batch and (args.inspect or args.report_only)):
        parser.error('Use --list, --batch FILE, or --journal ID with an optional mode')
    sys.path.insert(0, str(HERE.parents[1]))
    from services.research.worker import Client
    client = Client(os.environ['API_URL'], os.environ['API_TOKEN'])
    if args.batch:
        from artifact_executor import bounded_read
        from artifact_batch import recover_batch
        result = recover_batch(client, json.loads(bounded_read(args.batch, 8192)), args.state)
        print(encode(result))
        if result['needsAttention']:
            sys.exit(1)
        return
    if args.inspect or args.list:
        from artifact_inspection import inspect_journal, list_journals
        print(encode(list_journals(client, args.state) if args.list else inspect_journal(client, args.journal, args.state)))
        return
    print(encode(recover(client, args.journal, args.state, report_only=args.report_only)))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        sys.stderr.write('Artifact recovery stopped: ' + type(error).__name__ + '. Saved work has not been re-executed.\n')
        sys.exit(1)
